// ─────────────────────────────────────────────
// call-chain — unit tests (ADR-0015 Onda 2, D7)
//
// O resolver multi-hop do backend Node: handler → service → repo → tabela
// Drizzle, atravessando arquivos por import resolvido. Cobre a regra de ouro
// (na dúvida, não liga), ciclos e os limites.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBackendCallGraph,
  resolveTouches,
  makeBackendKey,
  resolveBackendModulePath,
} from "../../server/analyzers/node-backend/call-chain.ts";
import {
  extractDrizzleEntities,
  drizzleSymbolIndex,
} from "../../server/analyzers/node-backend/drizzle-schema.ts";

const SCHEMA = {
  filePath: "srv/db/schema.ts",
  content: `import { pgTable, integer, text } from "drizzle-orm/pg-core";
export const webhookEvents = pgTable("webhook_event", { id: integer("id").primaryKey() });
export const contracts = pgTable("contract", { id: integer("id").primaryKey() });
`,
};

function graphOf(files: { filePath: string; content: string }[]) {
  const all = [SCHEMA, ...files];
  const drizzle = drizzleSymbolIndex(extractDrizzleEntities(all));
  return buildBackendCallGraph(all, drizzle);
}

describe("call-chain — 1 hop (função local)", () => {
  it("handler chama função do MESMO arquivo que faz db.insert", () => {
    const g = graphOf([
      {
        filePath: "srv/app.ts",
        content: `import { db } from "./db/client";
import { webhookEvents } from "./db/schema";
async function saveEvent(p: unknown) { await db.insert(webhookEvents).values(p); }
export async function handler(req: any) { await saveEvent(req.body); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "write" }]);
    assert.deepEqual(r.chain, ["srv/app.ts::handler", "srv/app.ts::saveEvent"]);
  });
});

describe("call-chain — 2 hops entre arquivos (o cenário-alvo)", () => {
  const service = {
    filePath: "srv/services/webhook-service.ts",
    content: `import { insertEvent } from "../repos/webhook-repo";
export const webhookService = {
  async processInbound(payload: unknown) { return insertEvent(payload); },
};
`,
  };
  const repo = {
    filePath: "srv/repos/webhook-repo.ts",
    content: `import { db } from "../db/client";
import { webhookEvents } from "../db/schema";
export async function insertEvent(p: unknown) { await db.insert(webhookEvents).values(p); }
`,
  };
  const app = {
    filePath: "srv/app.ts",
    content: `import { webhookService } from "./services/webhook-service";
export async function handler(req: any) { await webhookService.processInbound(req.body); }
`,
  };

  it("handler → webhookService.processInbound (arquivo 2) → insertEvent (arquivo 3) → write", () => {
    const g = graphOf([app, service, repo]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "write" }]);
    assert.deepEqual(r.chain, [
      "srv/app.ts::handler",
      "srv/services/webhook-service.ts::webhookService.processInbound",
      "srv/repos/webhook-repo.ts::insertEvent",
    ]);
  });

  it("entryFiles restringe ao fecho de imports sem perder a cadeia", () => {
    const noise = {
      filePath: "srv/unrelated.ts",
      content: `export function nothing() { return 1; }`,
    };
    const all = [SCHEMA, app, service, repo, noise];
    const drizzle = drizzleSymbolIndex(extractDrizzleEntities(all));
    const g = buildBackendCallGraph(all, drizzle, { entryFiles: ["srv/app.ts"] });
    assert.equal(g.has(makeBackendKey("srv/unrelated.ts", "nothing")), false, "fora do fecho");
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "write" }]);
  });
});

describe("call-chain — variações de import", () => {
  it("import renomeado (as) resolve pelo originalName", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
import { webhookEvents } from "./db/schema";
export async function remove(id: number) { await db.delete(webhookEvents); }
`,
      },
      {
        filePath: "srv/app.ts",
        content: `import { remove as removeEvent } from "./repo";
export async function handler() { await removeEvent(1); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "delete" }]);
  });

  it("namespace import (import * as repo) resolve repo.fn()", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
import { contracts } from "./db/schema";
export async function list() { return db.select().from(contracts); }
`,
      },
      {
        filePath: "srv/app.ts",
        content: `import * as repo from "./repo";
export async function handler() { return repo.list(); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "contract", op: "read" }]);
  });

  it("classe: instância local resolve Class.method; db.query.<sym> é read", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
export class WebhookRepo {
  async latest() { return db.query.webhookEvents.findFirst(); }
}
`,
      },
      {
        filePath: "srv/app.ts",
        content: `import { WebhookRepo } from "./repo";
export async function handler() { const r = new WebhookRepo(); return r.latest(); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "read" }]);
  });
});

describe("call-chain — anti-ciclo e regra de ouro (não liga)", () => {
  it("ciclo A→B→A termina e ainda coleta o toque", () => {
    const g = graphOf([
      {
        filePath: "srv/a.ts",
        content: `import { b } from "./b";
import { db } from "./db/client";
import { webhookEvents } from "./db/schema";
export function a(n: number) { if (n > 0) b(n - 1); return db.select().from(webhookEvents); }
`,
      },
      {
        filePath: "srv/b.ts",
        content: `import { a } from "./a";
export function b(n: number) { return a(n); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/a.ts", "a")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "read" }]);
  });

  it("dynamic dispatch (handlers[k]()) e pacote npm NÃO ligam", () => {
    const g = graphOf([
      {
        filePath: "srv/app.ts",
        content: `import { z } from "zod";
const handlers: Record<string, Function> = {};
export function handler(k: string) { handlers[k](); z.parse(k); }
`,
      },
    ]);
    const node = g.get(makeBackendKey("srv/app.ts", "handler"));
    assert.ok(node);
    assert.equal(node!.callees.size, 0, "nada deveria ligar");
  });

  it("símbolo Drizzle desconhecido no argumento não vira toque", () => {
    const g = graphOf([
      {
        filePath: "srv/app.ts",
        content: `import { db } from "./db/client";
export async function handler() { await db.insert(somethingElse).values({}); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, []);
  });
});

describe("resolveBackendModulePath", () => {
  const paths = new Set([
    "services/gateway/src/repos/webhook-repo.ts",
    "services/gateway/src/services/index.ts",
    "src/util.ts",
  ]);

  it("relativo com .. e extensão implícita", () => {
    assert.equal(
      resolveBackendModulePath(
        "services/gateway/src/services/webhook-service.ts",
        "../repos/webhook-repo",
        paths,
      ),
      "services/gateway/src/repos/webhook-repo.ts",
    );
  });

  it("index file", () => {
    assert.equal(
      resolveBackendModulePath("services/gateway/src/app.ts", "./services", paths),
      "services/gateway/src/services/index.ts",
    );
  });

  it("alias @/ com root derivado do importador", () => {
    assert.equal(
      resolveBackendModulePath(
        "services/gateway/src/app.ts",
        "@/repos/webhook-repo",
        paths,
      ),
      "services/gateway/src/repos/webhook-repo.ts",
    );
  });

  it("pacote npm ⇒ null", () => {
    assert.equal(resolveBackendModulePath("src/app.ts", "express", paths), null);
  });
});

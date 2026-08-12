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


// ── ADR-0018 (pronto-pra-cliente): SQL cru + hop-chain ──
import { sqlTouchesFromText, buildBackendCallChain, resolveTouches as _rt, buildTsconfigPathsIndex } from "../../server/analyzers/node-backend/call-chain.ts";

describe("sqlTouchesFromText (backend pg/knex sem Drizzle)", () => {
  it("detecta tabela em SELECT/INSERT/UPDATE/DELETE com op certa", () => {
    assert.deepEqual(sqlTouchesFromText("SELECT * FROM user_flow_run WHERE id = $1"), [{ entity: "user_flow_run", op: "read" }]);
    assert.deepEqual(sqlTouchesFromText("INSERT INTO api_keys (name) VALUES ($1)"), [{ entity: "api_keys", op: "write" }]);
    assert.deepEqual(sqlTouchesFromText("UPDATE projects SET name = $1 WHERE id = $2"), [{ entity: "projects", op: "write" }]);
    assert.deepEqual(sqlTouchesFromText("DELETE FROM sessions WHERE expired = true"), [{ entity: "sessions", op: "delete" }]);
  });

  it("JOIN vira read; keyword SQL nunca vira tabela; prosa com 'update' sem SET não toca", () => {
    const t = sqlTouchesFromText("SELECT a.x FROM orders a JOIN order_items b ON a.id = b.order_id");
    assert.deepEqual(t.map((x) => x.entity).sort(), ["order_items", "orders"]);
    assert.deepEqual(sqlTouchesFromText("please update the record from yesterday"), []);
    assert.deepEqual(sqlTouchesFromText("SELECT 1"), []);
  });

  it("template SQL multi-parte e texto não-SQL", () => {
    assert.deepEqual(sqlTouchesFromText("nada a ver"), []);
  });
});

describe("hop-chain sem toque (alcance vale por si)", () => {
  it("handler → service → helper SEM persistência ⇒ cadeia de hops reportada", () => {
    const files = [
      { filePath: "routes/a.routes.ts", content: "import { runA } from '../services/a-service';\nexport function handleA(req,res){ return runA(req); }" },
      { filePath: "services/a-service.ts", content: "import { fmt } from './fmt';\nexport function runA(x){ return fmt(x); }" },
      { filePath: "services/fmt.ts", content: "export function fmt(x){ return String(x); }" },
    ];
    const cc = buildBackendCallChain(files, new Map(), { entryFiles: ["routes/a.routes.ts"] })!;
    const seed = cc.seedForName("routes/a.routes.ts", "handleA");
    assert.ok(seed, "seed do handler por nome");
    const r = _rt([seed!], cc.graph);
    assert.deepEqual(r.touches, []);
    assert.ok(r.chain.length >= 2, JSON.stringify(r.chain));
    assert.match(r.chain[0], /a\.routes/);
    assert.match(r.chain[1], /a-service/);
  });

  it("com SQL cru no repo, a cadeia ancora no toque e as ENTIDADES vêm da TABELA", () => {
    const files = [
      { filePath: "routes/b.routes.ts", content: "import { save } from '../services/b-service';\nexport function handleB(req,res){ return save(req.body); }" },
      { filePath: "services/b-service.ts", content: "import { insertRun } from '../repo/run-repo';\nexport function save(x){ return insertRun(x); }" },
      { filePath: "repo/run-repo.ts", content: "export function insertRun(x){ return pool.query('INSERT INTO user_flow_run (a) VALUES ($1)', [x]); }" },
    ];
    const cc = buildBackendCallChain(files, new Map(), { entryFiles: ["routes/b.routes.ts"] })!;
    const seed = cc.seedForName("routes/b.routes.ts", "handleB");
    const r = _rt([seed!], cc.graph);
    assert.deepEqual(r.touches, [{ entity: "user_flow_run", op: "write" }]);
    assert.equal(r.chain.length, 3, JSON.stringify(r.chain));
  });
});

// ── ADR-0026 CM2 upstream fix: aliases tsconfig + barrels + DI por construtor ──
// O que fazia a cadeia parar ANTES da camada de repositórios (a nota de
// honestidade do canonical-model registrava 0/84 módulos repositório): import
// por alias (`@core/repositories`), barrel (`export * from`) e injeção por
// construtor (`this.repo.save()`). Tudo ainda por prova sintática.

describe("tsconfig paths — buildTsconfigPathsIndex + resolução por alias", () => {
  const paths = new Set([
    "packages/core/src/repositories/webhook.repository.ts",
    "packages/core/src/repositories/index.ts",
    "packages/app/src/local/x.ts",
  ]);

  it("JSONC (comentários + vírgula final) e padrão com * resolvem", () => {
    const aliases = buildTsconfigPathsIndex([
      {
        filePath: "tsconfig.json",
        content: `{
  // comentário de linha
  "compilerOptions": {
    /* bloco */
    "baseUrl": ".",
    "paths": {
      "@core/*": ["packages/core/src/*"],
    },
  },
}`,
      },
    ]);
    assert.equal(
      resolveBackendModulePath(
        "services/gateway/src/app.ts",
        "@core/repositories/webhook.repository",
        paths,
        aliases,
      ),
      "packages/core/src/repositories/webhook.repository.ts",
    );
    // barrel via index implícito
    assert.equal(
      resolveBackendModulePath("services/gateway/src/app.ts", "@core/repositories", paths, aliases),
      "packages/core/src/repositories/index.ts",
    );
  });

  it("alias EXATO (sem *) e baseUrl relativo ao dir do tsconfig", () => {
    const aliases = buildTsconfigPathsIndex([
      {
        filePath: "packages/app/tsconfig.json",
        content: `{"compilerOptions":{"baseUrl":"./src","paths":{"#local": ["local/x"]}}}`,
      },
    ]);
    assert.equal(
      resolveBackendModulePath("packages/app/src/main.ts", "#local", paths, aliases),
      "packages/app/src/local/x.ts",
    );
  });

  it("escopo por diretório: config de um pacote NÃO vaza pra importador de fora", () => {
    const aliases = buildTsconfigPathsIndex([
      {
        filePath: "packages/app/tsconfig.json",
        content: `{"compilerOptions":{"baseUrl":".","paths":{"@core/*":["../core/src/*"]}}}`,
      },
    ]);
    assert.equal(
      resolveBackendModulePath("packages/app/src/main.ts", "@core/repositories", paths, aliases),
      "packages/core/src/repositories/index.ts",
      "dentro do pacote o alias resolve",
    );
    assert.equal(
      resolveBackendModulePath("services/gateway/src/app.ts", "@core/repositories", paths, aliases),
      null,
      "fora do dir do tsconfig o alias não se aplica",
    );
  });

  it("tsconfig quebrado é ignorado (fail-soft) e specifier npm segue null", () => {
    const aliases = buildTsconfigPathsIndex([
      { filePath: "tsconfig.json", content: "{ isso não é json" },
    ]);
    assert.deepEqual(aliases.configs, []);
    assert.equal(resolveBackendModulePath("src/app.ts", "express", paths, aliases), null);
  });
});

describe("barrels — re-exports atravessados na resolução de callee", () => {
  it("export * from: função atrás do barrel resolve e o toque chega", () => {
    const g = graphOf([
      {
        filePath: "srv/repos/webhook-repo.ts",
        content: `import { db } from "../db/client";
import { webhookEvents } from "../db/schema";
export async function insertEvent(p: unknown) { await db.insert(webhookEvents).values(p); }
`,
      },
      { filePath: "srv/repos/index.ts", content: `export * from "./webhook-repo";\n` },
      {
        filePath: "srv/app.ts",
        content: `import { insertEvent } from "./repos";
export async function handler(req: any) { await insertEvent(req.body); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "write" }]);
    assert.deepEqual(r.chain, ["srv/app.ts::handler", "srv/repos/webhook-repo.ts::insertEvent"]);
  });

  it("export { a as b } from: re-export RENOMEADO resolve pelo nome de origem", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
import { contracts } from "./db/schema";
export async function list() { return db.select().from(contracts); }
`,
      },
      { filePath: "srv/index.ts", content: `export { list as listContracts } from "./repo";\n` },
      {
        filePath: "srv/app.ts",
        content: `import { listContracts } from "./index";
export async function handler() { return listContracts(); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "contract", op: "read" }]);
  });

  it("export * as ns from: ns.fn() resolve na origem", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
import { webhookEvents } from "./db/schema";
export async function latest() { return db.query.webhookEvents.findFirst(); }
`,
      },
      { filePath: "srv/index.ts", content: `export * as repo from "./repo";\n` },
      {
        filePath: "srv/app.ts",
        content: `import { repo } from "./index";
export async function handler() { return repo.latest(); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "read" }]);
  });

  it("import + export { x } (barrel de duas linhas) resolve; ciclo de barrel não trava", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
import { contracts } from "./db/schema";
export async function count() { return db.select().from(contracts); }
`,
      },
      {
        filePath: "srv/index.ts",
        content: `import { count } from "./repo";
export * from "./other"; // barrel circular de propósito
export { count };
`,
      },
      { filePath: "srv/other.ts", content: `export * from "./index";\n` },
      {
        filePath: "srv/app.ts",
        content: `import { count } from "./index";
export async function handler() { return count(); }
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "contract", op: "read" }]);
  });
});

describe("DI simples por construtor — this.<membro>.<método>() por tipo declarado", () => {
  it("parameter property (private repo: Repo) resolve this.repo.save()", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
import { webhookEvents } from "./db/schema";
export class WebhookRepository {
  async save(p: unknown) { await db.insert(webhookEvents).values(p); }
}
`,
      },
      {
        filePath: "srv/service.ts",
        content: `import { WebhookRepository } from "./repo";
export class WebhookService {
  constructor(private readonly repo: WebhookRepository) {}
  async process(p: unknown) { return this.repo.save(p); }
}
`,
      },
      {
        filePath: "srv/app.ts",
        content: `import { WebhookService } from "./service";
export async function handler(req: any) {
  const svc = new WebhookService(null as any);
  return svc.process(req.body);
}
`,
      },
    ]);
    const r = resolveTouches([makeBackendKey("srv/app.ts", "handler")], g);
    assert.deepEqual(r.touches, [{ entity: "webhook_event", op: "write" }]);
    assert.deepEqual(r.chain, [
      "srv/app.ts::handler",
      "srv/service.ts::WebhookService.process",
      "srv/repo.ts::WebhookRepository.save",
    ]);
  });

  it("this.x = param tipado e propriedade `= new Classe()` também resolvem", () => {
    const g = graphOf([
      {
        filePath: "srv/repo.ts",
        content: `import { db } from "./db/client";
import { contracts } from "./db/schema";
export class ContractRepo {
  async list() { return db.select().from(contracts); }
}
`,
      },
      {
        filePath: "srv/service-a.ts",
        content: `import { ContractRepo } from "./repo";
export class ServiceA {
  private repo;
  constructor(repo: ContractRepo) { this.repo = repo; }
  run() { return this.repo.list(); }
}
`,
      },
      {
        filePath: "srv/service-b.ts",
        content: `import { ContractRepo } from "./repo";
export class ServiceB {
  private repo = new ContractRepo();
  run() { return this.repo.list(); }
}
`,
      },
    ]);
    for (const file of ["srv/service-a.ts", "srv/service-b.ts"]) {
      const cls = file.includes("-a") ? "ServiceA" : "ServiceB";
      const r = resolveTouches([makeBackendKey(file, `${cls}.run`)], g);
      assert.deepEqual(r.touches, [{ entity: "contract", op: "read" }], `${cls}.run`);
    }
  });

  it("membro SEM tipo declarado não liga (regra de ouro: DI por container fica fora)", () => {
    const g = graphOf([
      {
        filePath: "srv/service.ts",
        content: `export class LooseService {
  private repo;
  constructor(container: any) { this.repo = container.resolve("repo"); }
  run() { return this.repo.list(); }
}
`,
      },
    ]);
    const node = g.get(makeBackendKey("srv/service.ts", "LooseService.run"));
    assert.ok(node);
    assert.equal(node!.callees.size, 0, "sem tipo declarado não pode ligar");
  });
});

describe("cenário-alvo completo: alias + barrel + DI até packages/core/src/repositories", () => {
  const MONOREPO = [
    {
      filePath: "tsconfig.json",
      content: `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@core/*": ["packages/core/src/*"] }
  }
}`,
    },
    {
      filePath: "packages/core/src/db/schema.ts",
      content: `import { pgTable, integer, text } from "drizzle-orm/pg-core";
export const notifications = pgTable("notification", { id: integer("id").primaryKey(), body: text("body") });
`,
    },
    {
      filePath: "packages/core/src/repositories/notification.repository.ts",
      content: `import { db } from "../db/client";
import { notifications } from "../db/schema";
export class NotificationRepository {
  async create(p: unknown) { await db.insert(notifications).values(p); }
}
`,
    },
    {
      filePath: "packages/core/src/repositories/index.ts",
      content: `export * from "./notification.repository";\n`,
    },
    {
      filePath: "services/gateway/src/services/notification.service.ts",
      content: `import { NotificationRepository } from "@core/repositories";
export class NotificationService {
  constructor(private readonly repo: NotificationRepository) {}
  async send(p: unknown) { return this.repo.create(p); }
}
`,
    },
    {
      filePath: "services/gateway/src/routes/notifications.routes.ts",
      content: `import { NotificationService } from "../services/notification.service";
const svc = new NotificationService(null as any);
export async function sendHandler(req: any, res: any) { await svc.send(req.body); res.end(); }
`,
    },
  ];

  it("a cadeia DESCE até o repositório e o toque Drizzle chega (fix da nota de honestidade)", () => {
    const drizzle = drizzleSymbolIndex(extractDrizzleEntities(MONOREPO));
    const cc = buildBackendCallChain(MONOREPO, drizzle, {
      entryFiles: ["services/gateway/src/routes/notifications.routes.ts"],
    });
    const seed = cc.seedForName("services/gateway/src/routes/notifications.routes.ts", "sendHandler");
    assert.ok(seed, "handler por referência vira seed");
    const r = _rt([seed!], cc.graph);
    assert.deepEqual(r.touches, [{ entity: "notification", op: "write" }]);
    assert.deepEqual(r.chain, [
      "services/gateway/src/routes/notifications.routes.ts::sendHandler",
      "services/gateway/src/services/notification.service.ts::NotificationService.send",
      "packages/core/src/repositories/notification.repository.ts::NotificationRepository.create",
    ]);
  });

  it("fecho de imports por entryFiles ATRAVESSA alias+barrel (o repo entra no escopo)", () => {
    const drizzle = drizzleSymbolIndex(extractDrizzleEntities(MONOREPO));
    const g = buildBackendCallGraph(MONOREPO, drizzle, {
      entryFiles: ["services/gateway/src/routes/notifications.routes.ts"],
    });
    assert.ok(
      g.has(
        makeBackendKey(
          "packages/core/src/repositories/notification.repository.ts",
          "NotificationRepository.create",
        ),
      ),
      "o arquivo de repositório precisa estar no grafo (era o furo: closure parava no alias)",
    );
  });
});

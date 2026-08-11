// ─────────────────────────────────────────────
// express-routes — unit tests (ADR-0015 Onda 1, D1 / balde node-backend)
//
// Parser de rotas Express: router.<verbo>('/path', ...mw, handler) + mount por
// app.use('/prefix', router) ⇒ endpoint com path completo e roles do middleware.
// Determinístico, por regex, sem AST.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expressRoutesToImpactEndpoints,
  extractExpressRoutes,
  expressRoutesToCatalogEntries,
} from "../../server/analyzers/node-backend/express-routes.ts";

const GATEWAY_APP = {
  filePath: "services/gateway/src/app.ts",
  content: `import express from "express";
import { requirePermission } from "./middleware/auth";

const app = express();
const webhookRouter = express.Router();

webhookRouter.get("/inbound/:id", requirePermission("webhooks.read"), (req, res) => {
  res.json({ ok: true });
});

app.use("/webhooks", webhookRouter);

export { app };
`,
};

describe("extractExpressRoutes — mount + verbo + permissão (canário C1)", () => {
  it("compõe o prefixo do mount no path completo", () => {
    const routes = extractExpressRoutes([GATEWAY_APP]);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, "/webhooks/inbound/:id");
    assert.equal(routes[0].method, "GET");
    assert.equal(routes[0].routerVar, "webhookRouter");
  });

  it("extrai requiredRoles do requirePermission do próprio callsite", () => {
    const [route] = extractExpressRoutes([GATEWAY_APP]);
    assert.deepEqual(route.requiredRoles, ["webhooks.read"]);
    assert.match(route.permissionExpression ?? "", /requirePermission/);
  });

  it("app.use não é confundido com rota (é mount, não verbo)", () => {
    const routes = extractExpressRoutes([GATEWAY_APP]);
    assert.ok(!routes.some((r) => r.method === "USE"));
  });
});

describe("extractExpressRoutes — declaração de router COM anotação de tipo TS (regressão do ponto cego)", () => {
  // Bug real (NuPIdentify): `const router: Router = express.Router()` fazia o
  // ROUTER_DECL_RE não casar → routerVars vazio → arquivo DESCARTADO inteiro →
  // o PDP `/api/authorize` sumia do grafo. O regex agora tolera a anotação.
  const TYPED = {
    filePath: "server/routes/authorize.routes.ts",
    content: `import express, { type Router, type Request, type Response } from "express";
const router: Router = express.Router();

router.post(
  "/",
  requireValidationAuth,
  async (req: Request, res: Response) => { res.json({ allowed: true }); },
);
router.post("/batch", async (_req, res) => { res.json([]); });

app.use("/api/authorize", router);
export default router;
`,
  };
  it("extrai rotas de um router declarado como `const router: Router = express.Router()`", () => {
    const routes = extractExpressRoutes([TYPED]);
    assert.equal(routes.length, 2, "as 2 rotas do router tipado devem ser extraídas");
    assert.ok(routes.some((r) => r.method === "POST" && r.path === "/api/authorize"), "POST / compõe com o mount → /api/authorize");
    assert.ok(routes.some((r) => r.method === "POST" && r.path === "/api/authorize/batch"));
  });
  it("o router SEM anotação segue funcionando (não regride)", () => {
    const routes = extractExpressRoutes([GATEWAY_APP]);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, "/webhooks/inbound/:id");
  });
});

describe("extractExpressRoutes — middleware de autorização BARE (anti falso-positivo SF-019/020)", () => {
  // NuPIdentify usa `router.patch(path, requireAuth, requireAdmin, handler)`:
  // `requireAdmin` é middleware bare (role implícita), não `requireRole("admin")`.
  // Sem reconhecê-lo, o omission-engine acusava PRIVILEGE_ESCALATION numa rota que
  // EXIGE admin (falso-positivo).
  const IDENTIFY_STYLE = {
    filePath: "server/routes/access-requests.routes.ts",
    content: `import express, { type Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
const router: Router = express.Router();

router.patch("/:id/approve", requireAuth, requireAdmin, async (req, res) => { res.json({ ok: true }); });
router.patch("/:id/reject", requireAuth, requireAdmin, async (req, res) => { res.json({ ok: true }); });

app.use("/api/access-requests", router);
`,
  };
  it("reconhece `requireAdmin` bare como anotação de segurança (role implícita 'admin')", () => {
    const routes = extractExpressRoutes([IDENTIFY_STYLE]);
    const approve = routes.find((r) => r.path.endsWith("/approve"));
    assert.ok(approve, "a rota /approve deve ser extraída");
    assert.deepEqual(approve!.requiredRoles, ["admin"], "requireAdmin ⇒ role 'admin' (limpa o falso-positivo)");
    assert.match(approve!.permissionExpression ?? "", /requireAdmin/);
  });
  it("`requireAuth` SOZINHO NÃO confere role (login ≠ autoridade — segue sinalizável)", () => {
    const onlyAuth = {
      filePath: "server/routes/x.routes.ts",
      content: `import express, { type Router } from "express";
const router: Router = express.Router();
router.post("/danger", requireAuth, async (req, res) => { res.json({}); });
app.use("/api/x", router);
`,
    };
    const [route] = extractExpressRoutes([onlyAuth]);
    assert.deepEqual(route.requiredRoles, [], "requireAuth é autenticação, não autorização");
  });
});

describe("extractExpressRoutes — cobertura de verbos, roles múltiplas e ruído", () => {
  it("reconhece todos os verbos HTTP e várias roles", () => {
    const file = {
      filePath: "src/api.ts",
      content: `import express from "express";
const router = express.Router();
router.post("/orders", requireRole("orders.write", "orders.admin"), h);
router.delete("/orders/:id", h);
router.put("/orders/:id", h);
router.patch("/orders/:id", h);
`,
    };
    const routes = extractExpressRoutes([file]);
    const byMethod = Object.fromEntries(routes.map((r) => [r.method, r]));
    assert.deepEqual(Object.keys(byMethod).sort(), ["DELETE", "PATCH", "POST", "PUT"]);
    assert.deepEqual(byMethod.POST.requiredRoles, ["orders.write", "orders.admin"]);
    assert.deepEqual(byMethod.DELETE.requiredRoles, []);
  });

  it("ignora arquivos sem express/Router e chamadas que não são de router (res.json, fetch)", () => {
    const noise = {
      filePath: "src/component.vue",
      content: `const res = await fetch("/easynup/x.v1");
res.json();
service.get("/not-a-route");
`,
    };
    assert.deepEqual(extractExpressRoutes([noise]), []);
  });

  it("não vaza para arquivos .java", () => {
    const java = { filePath: "A.java", content: `router.get("/x", h); // express() Router()` };
    assert.deepEqual(extractExpressRoutes([java]), []);
  });
});

describe("extractExpressRoutes — liga rota → entidade Drizzle pelo handler (D4/D5)", () => {
  const SCHEMA = {
    filePath: "src/db/schema.ts",
    content: `import { pgTable, integer } from "drizzle-orm/pg-core";
export const orders = pgTable("order", { id: integer("id").primaryKey() });
export const invoices = pgTable("invoice", { id: integer("id").primaryKey() });
`,
  };
  const API = {
    filePath: "src/api.ts",
    content: `import express from "express";
import { orders, invoices } from "./db/schema";
const router = express.Router();
router.get("/orders", async (req, res) => { res.json(await db.select().from(orders)); });
router.post("/orders", async (req, res) => { await db.insert(orders).values(req.body); res.sendStatus(201); });
router.delete("/invoices/:id", async (req, res) => { await db.delete(invoices); res.sendStatus(204); });
`,
  };

  it("select().from(x) ⇒ read; insert(x) ⇒ write; delete(x) ⇒ delete", () => {
    const routes = extractExpressRoutes([SCHEMA, API]);
    const get = routes.find((r) => r.method === "GET")!;
    const post = routes.find((r) => r.method === "POST")!;
    const del = routes.find((r) => r.method === "DELETE")!;
    assert.deepEqual(get.entitiesTouched, ["order"]);
    assert.deepEqual(get.persistenceOperations, ["read"]);
    assert.deepEqual(post.persistenceOperations, ["write"]);
    assert.deepEqual(del.entitiesTouched, ["invoice"]);
    assert.deepEqual(del.persistenceOperations, ["delete"]);
  });

  it("rota sem acesso a tabela ⇒ entitiesTouched vazio", () => {
    const routes = extractExpressRoutes([GATEWAY_APP]);
    // GATEWAY_APP não importa/usa nenhuma tabela Drizzle.
    assert.deepEqual(routes[0].entitiesTouched, []);
    assert.deepEqual(routes[0].persistenceOperations, []);
  });
});

describe("expressRoutesToCatalogEntries — formato de endpoint do catálogo", () => {
  it("materializa entry 'API: <router>' com operação derivada do verbo", () => {
    const routes = extractExpressRoutes([GATEWAY_APP]);
    const [entry] = expressRoutesToCatalogEntries(routes, 1, 1);
    assert.equal(entry.screen, "API: webhookRouter");
    assert.equal(entry.endpoint, "/webhooks/inbound/:id");
    assert.equal(entry.httpMethod, "GET");
    assert.equal(entry.technicalOperation, "READ");
    assert.equal(entry.interactionCategory, "HTTP");
    assert.deepEqual(entry.requiredRoles, ["webhooks.read"]);
    assert.equal(entry.securityAnnotations.length, 1);
    assert.equal(entry.dataSource.requiredRoles, "extracted");
  });

  it("sem permissão ⇒ sem securityAnnotations e sem dataSource.requiredRoles", () => {
    const file = {
      filePath: "src/pub.ts",
      content: `import express from "express";
const r = express.Router();
r.get("/health", (req, res) => res.send("ok"));
`,
    };
    const [entry] = expressRoutesToCatalogEntries(extractExpressRoutes([file]), 1, 1);
    assert.deepEqual(entry.requiredRoles, []);
    assert.equal(entry.securityAnnotations.length, 0);
    assert.equal(entry.dataSource.requiredRoles, undefined);
  });
});

describe("extractExpressRoutes — call-chain multi-hop (ADR-0015 Onda 2 D8)", () => {
  const schema = {
    filePath: "srv/db/schema.ts",
    content: `import { pgTable, integer } from "drizzle-orm/pg-core";
export const webhookEvents = pgTable("webhook_event", { id: integer("id").primaryKey() });
`,
  };
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
    content: `import express from "express";
import { webhookService } from "./services/webhook-service";
const r = express.Router();
r.post("/inbound", async (req, res) => {
  await webhookService.processInbound(req.body);
  res.status(202).end();
});
`,
  };

  it("handler que delega (service → repo em outros arquivos) resolve entidade e operação write", () => {
    const [route] = extractExpressRoutes([schema, service, repo, app]);
    assert.equal(route.path, "/inbound");
    assert.deepEqual(route.entitiesTouched, ["webhook_event"]);
    assert.deepEqual(route.persistenceOperations, ["write"]);
  });

  it("cadeia quebrada (service não importa o repo) ⇒ não liga (regra de ouro)", () => {
    const brokenService = {
      filePath: "srv/services/webhook-service.ts",
      content: `export const webhookService = {
  async processInbound(payload: unknown) { return dispatch("insert", payload); },
};
`,
    };
    const [route] = extractExpressRoutes([schema, brokenService, repo, app]);
    assert.deepEqual(route.entitiesTouched, []);
    assert.deepEqual(route.persistenceOperations, []);
  });

  it("same-file (C1) e multi-hop coexistem: união determinística por rota", () => {
    const both = {
      filePath: "srv/app.ts",
      content: `import express from "express";
import { db } from "./db/client";
import { webhookEvents } from "./db/schema";
import { webhookService } from "./services/webhook-service";
const r = express.Router();
r.get("/all", async (req, res) => {
  const rows = await db.select().from(webhookEvents);
  await webhookService.processInbound(rows);
  res.json(rows);
});
`,
    };
    const [route] = extractExpressRoutes([schema, service, repo, both]);
    assert.deepEqual(route.entitiesTouched, ["webhook_event"]);
    assert.deepEqual(route.persistenceOperations, ["read", "write"]);
  });
});

describe("extractExpressRoutes — handler por referência + telemetria (ADR-0015 Onda 2 D9)", () => {
  const schema = {
    filePath: "srv/db/schema.ts",
    content: `import { pgTable, integer } from "drizzle-orm/pg-core";
export const webhookEvents = pgTable("webhook_event", { id: integer("id").primaryKey() });
`,
  };
  const repo = {
    filePath: "srv/repos/webhook-repo.ts",
    content: `import { db } from "../db/client";
import { webhookEvents } from "../db/schema";
export async function removeEvent(id: number) { await db.delete(webhookEvents); }
`,
  };
  const controller = {
    filePath: "srv/controllers/webhook-controller.ts",
    content: `import { removeEvent } from "../repos/webhook-repo";
export async function deleteHandler(req: any, res: any) { await removeEvent(Number(req.params.id)); res.end(); }
`,
  };
  const app = {
    filePath: "srv/app.ts",
    content: `import express from "express";
import { deleteHandler } from "./controllers/webhook-controller";
const r = express.Router();
r.delete("/inbound/:id", deleteHandler);
`,
  };

  it("identificador nu importado vira seed; entidade, operação e cadeia resolvem", () => {
    const [route] = extractExpressRoutes([schema, repo, controller, app]);
    assert.deepEqual(route.entitiesTouched, ["webhook_event"]);
    assert.deepEqual(route.persistenceOperations, ["delete"]);
    assert.deepEqual(route.callChain, [
      "srv/app.ts::handler",
      "srv/controllers/webhook-controller.ts::deleteHandler",
      "srv/repos/webhook-repo.ts::removeEvent",
    ]);
  });

  it("telemetria na catalog entry: fullCallChain, service/repository methods e resolutionPath", () => {
    const routes = extractExpressRoutes([schema, repo, controller, app]);
    const [entry] = expressRoutesToCatalogEntries(routes, 1, 1);
    assert.deepEqual(entry.fullCallChain, routes[0].callChain);
    assert.deepEqual(entry.serviceMethods, ["deleteHandler"]);
    assert.deepEqual(entry.repositoryMethods, ["removeEvent"]);
    assert.equal(entry.resolutionPath.length, 2);
    assert.equal(entry.resolutionPath[1].tier, "call_chain");
    assert.equal(entry.resolutionPath[1].function, "removeEvent");
  });

  it("same-file (sem cadeia) mantém telemetria vazia — C1 não muda de shape", () => {
    const local = {
      filePath: "srv/app.ts",
      content: `import express from "express";
import { db } from "./db/client";
import { webhookEvents } from "./db/schema";
const r = express.Router();
r.get("/all", async (req, res) => res.json(await db.select().from(webhookEvents)));
`,
    };
    const routes = extractExpressRoutes([schema, local]);
    const [entry] = expressRoutesToCatalogEntries(routes, 1, 1);
    assert.deepEqual(entry.fullCallChain, []);
    assert.deepEqual(entry.serviceMethods, []);
    assert.deepEqual(entry.repositoryMethods, []);
    assert.equal(entry.resolutionPath.length, 1);
  });

  it("identificador que não resolve (handler de pacote npm) não vira seed", () => {
    const npmHandler = {
      filePath: "srv/app.ts",
      content: `import express from "express";
import { serveStatic } from "some-npm-package";
const r = express.Router();
r.get("/assets", serveStatic);
`,
    };
    const [route] = extractExpressRoutes([schema, npmHandler]);
    assert.deepEqual(route.entitiesTouched, []);
    assert.deepEqual(route.callChain, []);
  });
});


// ── ADR-0018 (pronto-pra-cliente): rotas → espelho RICO impactEndpoints ──
describe("expressRoutesToImpactEndpoints", () => {
  it("normaliza a cadeia file::fn → arquivo-base.fn (convenção Classe.metodo) e leva entidades", () => {
    const out = expressRoutesToImpactEndpoints([
      {
        method: "POST", path: "/api/user-flows/execute", routerVar: "router",
        requiredRoles: [], permissionExpression: null,
        entitiesTouched: ["user_flow_run"], persistenceOperations: ["write"],
        callChain: [
          "services/gateway/src/routes/user-flows.routes.js::executeHandler",
          "services/gateway/src/services/user-flow-runner.js::runSteps",
        ],
      } as any,
    ]);
    assert.equal(out.length, 1);
    const e = out[0];
    assert.equal(e.runtime, "node");
    assert.equal(e.controller, "user-flows.routes");
    assert.equal(e.controllerMethod, "executeHandler");
    assert.deepEqual(e.fullCallChain, ["user-flows.routes.executeHandler", "user-flow-runner.runSteps"]);
    assert.deepEqual(e.entitiesTouched, ["user_flow_run"]);
  });

  it("rota sem cadeia → controller = routerVar, cadeia vazia (nunca inventa)", () => {
    const out = expressRoutesToImpactEndpoints([
      { method: "GET", path: "/health", routerVar: "app", requiredRoles: [], permissionExpression: null, entitiesTouched: [], persistenceOperations: [], callChain: [] } as any,
    ]);
    assert.equal(out[0].controller, "app");
    assert.deepEqual(out[0].fullCallChain, []);
  });
});

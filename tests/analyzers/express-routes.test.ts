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

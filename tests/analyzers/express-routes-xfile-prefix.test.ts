// ─────────────────────────────────────────────
// express-routes — composição de prefixo de mount CROSS-FILE (ADR-0015)
//
// identify monta cada router num ARQUIVO (server/index.ts:
// `app.use("/api/auth", authRoutes)`) e as rotas vivem no arquivo IMPORTADO
// (server/routes/auth.routes.ts: `router.post("/login")`). Sem a composição
// cross-file o parser gravava `/login` e allowlist por path cheio nunca casava.
// Atrás da opção `crossFilePrefix` (default OFF ⇒ byte-a-byte o atual).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractExpressRoutes } from "../../server/analyzers/node-backend/express-routes.ts";

// Mini-réplica do padrão identify: index monta, o arquivo da rota só declara.
const INDEX = {
  filePath: "server/index.ts",
  content: `import express from "express";
import authRoutes from "./routes/auth.routes";
import { usersRouter } from "./routes/users.routes";
import brandingRoutes from "./routes/branding.routes";
import generalRateLimit from "./middleware/rate-limit";

const app = express();

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRouter);
app.use("/objects", generalRateLimit, brandingRoutes);

export { app };
`,
};

const AUTH_ROUTES = {
  filePath: "server/routes/auth.routes.ts",
  content: `import { Router } from "express";
const router: Router = express.Router();

router.post("/login", (req, res) => res.json({ ok: true }));
router.post("/logout", (req, res) => res.json({ ok: true }));

export default router;
`,
};

const USERS_ROUTES = {
  filePath: "server/routes/users.routes.ts",
  content: `import express from "express";
export const usersRouter = express.Router();

usersRouter.get("/:id", (req, res) => res.json({ ok: true }));

`,
};

const BRANDING_ROUTES = {
  filePath: "server/routes/branding.routes.ts",
  content: `import express from "express";
const router = express.Router();

router.get("/logo", (req, res) => res.json({ ok: true }));

export default router;
`,
};

const FILES = [INDEX, AUTH_ROUTES, USERS_ROUTES, BRANDING_ROUTES];

describe("extractExpressRoutes — cross-file prefix (ADR-0015)", () => {
  it("OFF (default): NÃO compõe prefixo cross-file — path cru do arquivo da rota", () => {
    const routes = extractExpressRoutes(FILES);
    const paths = new Set(routes.map((r) => `${r.method} ${r.path}`));
    assert.ok(paths.has("POST /login"), "sem a opção, /login fica cru");
    assert.ok(paths.has("GET /:id"));
    assert.ok(!paths.has("POST /api/auth/login"), "sem a opção, NÃO prefixa");
  });

  it("ON: compõe o prefixo do mount cross-file (default import → export default)", () => {
    const routes = extractExpressRoutes(FILES, { crossFilePrefix: true });
    const paths = new Set(routes.map((r) => `${r.method} ${r.path}`));
    assert.ok(paths.has("POST /api/auth/login"), "default import resolve o prefixo");
    assert.ok(paths.has("POST /api/auth/logout"));
    assert.ok(!paths.has("POST /login"), "o path cru não deve sobrar");
  });

  it("ON: named export + named import também compõe", () => {
    const routes = extractExpressRoutes(FILES, { crossFilePrefix: true });
    const paths = new Set(routes.map((r) => `${r.method} ${r.path}`));
    assert.ok(paths.has("GET /api/users/:id"), "usersRouter (named) sob /api/users");
  });

  it("ON: mount com middleware entre o prefixo e o router pega o último ident", () => {
    const routes = extractExpressRoutes(FILES, { crossFilePrefix: true });
    const paths = new Set(routes.map((r) => `${r.method} ${r.path}`));
    assert.ok(paths.has("GET /objects/logo"), "ignora generalRateLimit, pega brandingRoutes");
  });

  it("ON é SUPERSET de contagem de rotas (nada some, só muda o path)", () => {
    const off = extractExpressRoutes(FILES);
    const on = extractExpressRoutes(FILES, { crossFilePrefix: true });
    assert.equal(on.length, off.length, "mesma quantidade de rotas, só paths diferentes");
  });

  it("sem mount cross-file, ON == OFF (byte-a-byte no caso same-file)", () => {
    const sameFileOnly = [
      {
        filePath: "services/gateway/src/app.ts",
        content: `import express from "express";
const app = express();
const r = express.Router();
r.get("/ping", (req, res) => res.json({ ok: true }));
app.use("/health", r);
export { app };
`,
      },
    ];
    const off = JSON.stringify(extractExpressRoutes(sameFileOnly));
    const on = JSON.stringify(extractExpressRoutes(sameFileOnly, { crossFilePrefix: true }));
    assert.equal(on, off, "mount same-file não é afetado pela flag");
  });
});

// ─────────────────────────────────────────────
// api-auth fail-closed — unit tests (ADR-0014 D0)
//
// The Manifest API guards persisted source code and triggers 2 GB JVM
// analyses. This suite pins the default-deny posture: anonymous requests
// are rejected when auth is configured, webhooks bypass (they HMAC in
// the handler), and the bootstrap key breaks the first-key chicken-and-egg.
//
// The middleware validates real API keys via storage.getApiKeyByHash;
// we stub that single method (storage is a mutable singleton) so the
// tests stay DB-free.
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// The middleware transitively loads server/db.ts, which requires a
// DATABASE_URL at module load. Set a dummy one (pg.Pool is lazy — it
// never connects because every test stubs the storage method) BEFORE
// dynamic-importing the modules under test.
process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/manifest_test";
const { apiAuthMiddleware, isAuthRequired } = await import("../../server/middleware/api-auth.ts");
const { storage } = await import("../../server/storage.ts");

// ── Fake express req/res/next ──────────────────────────────────────

function makeReq(overrides: any = {}) {
  return {
    headers: {},
    params: {},
    baseUrl: "/api",
    path: "/projects",
    ...overrides,
  };
}

function makeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/** Run the middleware and resolve once next()/res.json has settled. */
function run(req: any, res: any): Promise<{ nexted: boolean }> {
  return new Promise((resolve) => {
    let nexted = false;
    const next = () => {
      nexted = true;
      resolve({ nexted });
    };
    const originalJson = res.json.bind(res);
    res.json = (payload: any) => {
      originalJson(payload);
      resolve({ nexted: false });
      return res;
    };
    apiAuthMiddleware(req as any, res as any, next as any);
    // Synchronous pass-through (no token, not required) resolves via next.
    if (nexted) resolve({ nexted });
  });
}

const ENV_KEYS = ["OIDC_ISSUER_URL", "MANIFEST_REQUIRE_AUTH", "MANIFEST_BOOTSTRAP_API_KEY"];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── isAuthRequired ─────────────────────────────────────────────────

describe("isAuthRequired", () => {
  // Note: the OIDC-configured branch is captured at module load
  // (jwt-auth.ts reads OIDC_ISSUER_URL into a const), so it is not
  // toggleable at runtime here; the runtime-controllable branch is the
  // explicit MANIFEST_REQUIRE_AUTH flag, exercised below.
  it("is false on an unconfigured box (no OIDC, no explicit flag)", () => {
    assert.equal(isAuthRequired(), false);
  });
  it("is true when the operator opts in explicitly", () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    assert.equal(isAuthRequired(), true);
  });
});

// ── default-deny vs pass-through ───────────────────────────────────

describe("apiAuthMiddleware — anonymous request", () => {
  it("DENIES (401) when auth is required and no credential is present", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    const res = makeRes();
    const { nexted } = await run(makeReq(), res);
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  it("passes through when auth is NOT required (loopback-only box)", async () => {
    const res = makeRes();
    const { nexted } = await run(makeReq(), res);
    assert.equal(nexted, true);
    assert.equal(res.statusCode, 0);
  });

  it("DENIES an unknown token format when auth is required", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    const res = makeRes();
    const req = makeReq({ headers: { authorization: "Bearer garbage-not-a-key" } });
    const { nexted } = await run(req, res);
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });
});

// ── webhook bypass ─────────────────────────────────────────────────

describe("apiAuthMiddleware — webhook paths", () => {
  it("bypasses the credential gate for /api/webhook/* even when auth is required", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    const res = makeRes();
    const req = makeReq({ baseUrl: "/api", path: "/webhook/github" });
    const { nexted } = await run(req, res);
    assert.equal(nexted, true, "webhooks authenticate via their own HMAC secret in-handler");
  });
});

// ── bootstrap key ──────────────────────────────────────────────────

describe("apiAuthMiddleware — bootstrap key", () => {
  it("accepts MANIFEST_BOOTSTRAP_API_KEY as a full-access credential", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    process.env.MANIFEST_BOOTSTRAP_API_KEY = "boot-secret-123456";
    const res = makeRes();
    const req = makeReq({ headers: { authorization: "Bearer boot-secret-123456" } });
    const { nexted } = await run(req, res);
    assert.equal(nexted, true);
    assert.equal((req as any).apiKeyAuth, true);
    assert.equal((req as any).apiKey.name, "bootstrap");
  });

  it("also accepts the bootstrap key via the X-API-Key header (Sentinel adapter style)", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    process.env.MANIFEST_BOOTSTRAP_API_KEY = "boot-secret-123456";
    const res = makeRes();
    const req = makeReq({ headers: { "x-api-key": "boot-secret-123456" } });
    const { nexted } = await run(req, res);
    assert.equal(nexted, true);
    assert.equal((req as any).apiKeyAuth, true);
  });

  it("rejects a wrong bootstrap value (constant-time compare, then 401)", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    process.env.MANIFEST_BOOTSTRAP_API_KEY = "boot-secret-123456";
    const res = makeRes();
    const req = makeReq({ headers: { authorization: "Bearer wrong" } });
    const { nexted } = await run(req, res);
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });
});

// ── real API key path (storage stubbed) ────────────────────────────

describe("apiAuthMiddleware — API key via storage", () => {
  let originalGet: any;
  let originalTouch: any;

  beforeEach(() => {
    originalGet = (storage as any).getApiKeyByHash;
    originalTouch = (storage as any).updateApiKeyLastUsed;
    (storage as any).updateApiKeyLastUsed = async () => {};
  });
  afterEach(() => {
    (storage as any).getApiKeyByHash = originalGet;
    (storage as any).updateApiKeyLastUsed = originalTouch;
  });

  it("accepts a valid pk_ key sent as X-API-Key", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    (storage as any).getApiKeyByHash = async () => ({ id: 7, name: "sentinel", keyPrefix: "pk_abc", projectScope: null });
    const res = makeRes();
    const req = makeReq({ headers: { "x-api-key": "pk_deadbeef" } });
    const { nexted } = await run(req, res);
    assert.equal(nexted, true);
    assert.equal((req as any).apiKey.id, 7);
  });

  it("rejects (401) an unknown pk_ key", async () => {
    process.env.MANIFEST_REQUIRE_AUTH = "true";
    (storage as any).getApiKeyByHash = async () => undefined;
    const res = makeRes();
    const req = makeReq({ headers: { authorization: "Bearer pk_unknown" } });
    const { nexted } = await run(req, res);
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });
});

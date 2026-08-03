import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Express } from "express";
import {
  createPkceChallenge,
  normalizeReturnTo,
  registerBrowserOidcRoutes,
} from "../../server/auth/oidc-browser.ts";

type Handler = (req: any, res: any) => void | Promise<void>;

function createAppHarness() {
  const routes = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      routes.set(`GET ${path}`, handler);
      return this;
    },
    post(path: string, handler: Handler) {
      routes.set(`POST ${path}`, handler);
      return this;
    },
  } as unknown as Express;

  return {
    app,
    route(method: "GET" | "POST", path: string): Handler {
      const handler = routes.get(`${method} ${path}`);
      assert.ok(handler, `missing ${method} ${path} handler`);
      return handler;
    },
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    cookie: { maxAge: 60 * 60 * 1000 },
    regenerated: false,
    save(callback: (error?: Error | null) => void) {
      callback();
    },
    regenerate(callback: (error?: Error | null) => void) {
      this.regenerated = true;
      delete (this as any).oidc;
      callback();
    },
    destroy(callback: (error?: Error | null) => void) {
      callback();
    },
    ...overrides,
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: undefined as string | undefined,
    redirectTo: undefined as string | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
    json(body: unknown) {
      this.body = JSON.stringify(body);
      return this;
    },
    redirect(location: string) {
      this.redirectTo = location;
      return this;
    },
    clearCookie() {
      return this;
    },
    end() {
      return this;
    },
  };
}

const OIDC_ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
  "NODE_ENV",
];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of OIDC_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.OIDC_ISSUER_URL = "https://identity.example";
  process.env.OIDC_CLIENT_ID = "manifest-client";
  process.env.OIDC_CLIENT_SECRET = "server-secret";
  process.env.OIDC_REDIRECT_URI = "https://manifest.example/auth/callback";
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  for (const key of OIDC_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("browser OIDC helpers", () => {
  it("creates the RFC 7636 S256 challenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.equal(createPkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("only permits local return paths", () => {
    assert.equal(normalizeReturnTo("/system-map?view=graph"), "/system-map?view=graph");
    assert.equal(normalizeReturnTo("https://attacker.example"), "/system-map");
    assert.equal(normalizeReturnTo("//attacker.example"), "/system-map");
    assert.equal(normalizeReturnTo("/\\attacker.example"), "/system-map");
  });

  it("starts a PKCE login and preserves only a local return path", async () => {
    const harness = createAppHarness();
    registerBrowserOidcRoutes(harness.app);
    const session = makeSession();
    const res = makeResponse();

    await harness.route("GET", "/auth/login")(
      { query: { returnTo: "https://attacker.example" }, session },
      res,
    );

    assert.ok(res.redirectTo);
    const authorizeUrl = new URL(res.redirectTo);
    assert.equal(authorizeUrl.origin, "https://identity.example");
    assert.equal(authorizeUrl.pathname, "/api/oidc/authorize");
    assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://manifest.example/auth/callback");
    assert.equal((session as any).oidc.returnTo, "/system-map");
  });

  it("rejects a malformed state without attempting an exchange", async () => {
    const harness = createAppHarness();
    let exchangeAttempted = false;
    registerBrowserOidcRoutes(harness.app, {
      fetchImpl: async () => {
        exchangeAttempted = true;
        throw new Error("should not exchange");
      },
    });
    const session = makeSession({
      oidc: { state: "a-state-with-a-different-length", verifier: "verifier", returnTo: "/system-map" },
    });
    const res = makeResponse();

    await harness.route("GET", "/auth/callback")(
      { query: { code: "code", state: "short" }, session },
      res,
    );

    assert.equal(res.statusCode, 400);
    assert.equal(exchangeAttempted, false);
    assert.equal((session as any).oidc, undefined);
  });

  it("validates the exchanged access token before storing it in the session", async () => {
    const harness = createAppHarness();
    let exchangedBody: URLSearchParams | undefined;
    let verifiedToken: string | undefined;
    registerBrowserOidcRoutes(harness.app, {
      fetchImpl: async (_url, init) => {
        exchangedBody = init?.body as URLSearchParams;
        return {
          ok: true,
          json: async () => ({ access_token: "eyJ.valid-token", expires_in: 120 }),
        } as Response;
      },
      verifyAccessToken: async (token) => {
        verifiedToken = token;
        return {
          sub: "user-1",
          email: "user@example.com",
          name: "User",
          permissions: [],
          organizationId: null,
          licenseTier: "free",
          raw: {},
        };
      },
    });
    const session = makeSession({
      oidc: { state: "expected-state", verifier: "verifier", returnTo: "/system-map" },
    });
    const res = makeResponse();

    await harness.route("GET", "/auth/callback")(
      { query: { code: "authorization-code", state: "expected-state" }, session },
      res,
    );

    assert.equal(exchangedBody?.get("grant_type"), "authorization_code");
    assert.equal(exchangedBody?.get("code_verifier"), "verifier");
    assert.equal(exchangedBody?.get("client_secret"), "server-secret");
    assert.equal(verifiedToken, "eyJ.valid-token");
    assert.equal((session as any).regenerated, true);
    assert.equal((session as any).oidc, undefined);
    assert.equal((session as any).oidcAccessToken, "eyJ.valid-token");
    assert.equal((session as any).cookie.maxAge, 120_000);
    assert.equal(res.redirectTo, "/system-map");
  });

  it("does not save an access token that fails verification", async () => {
    const harness = createAppHarness();
    registerBrowserOidcRoutes(harness.app, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ access_token: "eyJ.invalid-token" }),
      }) as Response,
      verifyAccessToken: async () => {
        throw new Error("invalid access token");
      },
    });
    const session = makeSession({
      oidc: { state: "expected-state", verifier: "verifier", returnTo: "/system-map" },
    });
    const res = makeResponse();

    await harness.route("GET", "/auth/callback")(
      { query: { code: "authorization-code", state: "expected-state" }, session },
      res,
    );

    assert.equal(res.statusCode, 401);
    assert.equal((session as any).oidc, undefined);
    assert.equal((session as any).oidcAccessToken, undefined);
  });
});
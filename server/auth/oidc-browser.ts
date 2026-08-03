import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { verifyJWT } from "../middleware/jwt-auth";

const INTERNAL_RETURN_PATH = /^\/(?!\/)(?:[^?#]*)(?:\?[^#]*)?$/;

interface OidcTokenResponse {
  access_token: string;
  expires_in?: number;
}

function issuerUrl(): string {
  return (process.env.OIDC_ISSUER_URL || "").replace(/\/$/, "");
}

function redirectUri(): string {
  if (process.env.OIDC_REDIRECT_URI) return process.env.OIDC_REDIRECT_URI;
  return process.env.NODE_ENV === "production" ? "" : "http://localhost:5000/auth/callback";
}

function clientId(): string {
  return process.env.OIDC_CLIENT_ID || "";
}

function clientSecret(): string {
  return process.env.OIDC_CLIENT_SECRET || "";
}

export function isBrowserOidcConfigured(): boolean {
  return Boolean(issuerUrl() && clientId() && clientSecret() && redirectUri());
}

export function normalizeReturnTo(value: unknown): string {
  return typeof value === "string" && !value.includes("\\") && INTERNAL_RETURN_PATH.test(value)
    ? value
    : "/system-map";
}

export function createPkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function createRandomValue(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function statesMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function sessionSave(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function sessionDestroy(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

function sessionRegenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

interface BrowserOidcDependencies {
  fetchImpl?: typeof fetch;
  verifyAccessToken?: typeof verifyJWT;
}

export function registerBrowserOidcRoutes(app: Express, dependencies: BrowserOidcDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const verifyAccessToken = dependencies.verifyAccessToken || verifyJWT;

  app.get("/auth/login", async (req: Request, res: Response) => {
    if (!isBrowserOidcConfigured()) {
      return res.status(503).send("Browser login is not configured");
    }

    const state = createRandomValue();
    const verifier = createRandomValue();
    req.session.oidc = { state, verifier, returnTo: normalizeReturnTo(req.query.returnTo) };

    try {
      await sessionSave(req);
    } catch {
      return res.status(503).send("Unable to start browser login");
    }

    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId(),
      redirect_uri: redirectUri(),
      scope: "openid profile email",
      state,
      code_challenge: createPkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    res.redirect(`${issuerUrl()}/api/oidc/authorize?${params.toString()}`);
  });

  app.get("/auth/callback", async (req: Request, res: Response) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const providerError = typeof req.query.error === "string" ? req.query.error : null;
    const pending = req.session.oidc;

    if (providerError) {
      delete req.session.oidc;
      return res.status(401).send("Browser login was denied by identity provider");
    }

    if (!isBrowserOidcConfigured() || !code || !state || !pending || !statesMatch(state, pending.state)) {
      delete req.session.oidc;
      return res.status(400).send("Invalid or expired browser login request");
    }

    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri(),
        code_verifier: pending.verifier,
      });
      const response = await fetchImpl(`${issuerUrl()}/api/oidc/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const tokens = await response.json().catch(() => null) as OidcTokenResponse | null;
      if (!response.ok || !tokens?.access_token) {
        throw new Error("OIDC token exchange failed");
      }

      await verifyAccessToken(tokens.access_token);

      const returnTo = pending.returnTo;
      await sessionRegenerate(req);
      req.session.oidcAccessToken = tokens.access_token;
      req.session.cookie.maxAge = Math.min((tokens.expires_in ?? 3600) * 1000, 60 * 60 * 1000);
      await sessionSave(req);
      return res.redirect(returnTo);
    } catch {
      delete req.session.oidc;
      return res.status(401).send("Browser login could not be completed");
    }
  });

  app.post("/auth/logout", async (req: Request, res: Response) => {
    try {
      await sessionDestroy(req);
    } catch {
      return res.status(503).json({ message: "Unable to end browser session" });
    }
    res.clearCookie("manifest.sid");
    return res.status(204).end();
  });
}
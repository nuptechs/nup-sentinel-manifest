import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { storage } from "../storage";
import { verifyJWT, isOIDCConfigured, type OIDCUser } from "./jwt-auth";

// ─── API Key helpers ──────────────────────────────────────────────

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `pk_${crypto.randomBytes(32).toString("hex")}`;
  const prefix = raw.slice(0, 11);
  const hash = hashApiKey(raw);
  return { raw, prefix, hash };
}

// ─── Fail-closed posture (ADR-0014 D0) ────────────────────────────
//
// The API guards persisted SOURCE CODE and triggers 2 GB JVM analyses.
// It must NEVER be reachable anonymously on a public network.
//
// "Auth required" is true when the deployment is configured to enforce
// it — i.e. OIDC is wired (the house standard, ADR-0003) OR the operator
// opted in explicitly. When true, every /api/* route without a valid
// credential is rejected (default-deny). When false (an UNCONFIGURED
// box), the server binds to loopback only (see server/index.ts), so
// pass-through is safe because nothing external can reach it.

export function isAuthRequired(): boolean {
  return isOIDCConfigured() || process.env.MANIFEST_REQUIRE_AUTH === "true";
}

/**
 * Webhooks (GitHub/GitLab) authenticate with their own per-project HMAC
 * secret inside the route handler — they never carry a Bearer/API key.
 * They must bypass the credential middleware, not be blanket-denied.
 */
function isWebhookPath(req: Request): boolean {
  const full = `${req.baseUrl}${req.path}`;
  return full.startsWith("/api/webhook/");
}

/** Extract a raw credential from either the Bearer header or X-API-Key. */
function extractCredential(req: Request): string | null {
  const authHeader = req.headers.authorization as string | undefined;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // The Sentinel AnalyzerPort adapter sends the API key as X-API-Key.
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.length > 0) {
    return apiKeyHeader;
  }
  return null;
}

// ─── Dual auth middleware ─────────────────────────────────────────
//
// Supported credentials (via `Authorization: Bearer <tok>` or `X-API-Key`):
//   1. API Key  (pk_ prefix) — CI/CD, headless automation, the Sentinel.
//   2. JWT/OIDC (eyJ prefix)  — interactive users via NuPIdentity.
//
// Missing/unknown credential:
//   - auth required  → 401 (default-deny). This is the ADR-0014 D0 fix.
//   - auth not required (loopback-only box) → pass through.

export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Webhooks carry no Bearer/API key — they are HMAC-verified in-handler.
  if (isWebhookPath(req)) {
    return next();
  }

  const authRequired = isAuthRequired();
  const token = extractCredential(req);

  const denyOrPass = (why: string) => {
    if (authRequired) {
      return res.status(401).json({ message: why });
    }
    return next();
  };

  if (!token) {
    return denyOrPass("Authentication required");
  }

  // ── Path 0: Bootstrap key (breaks the chicken-and-egg) ──
  // When auth is first enabled, there is no scoped key yet — and creating
  // one needs auth. MANIFEST_BOOTSTRAP_API_KEY (an env secret) is accepted
  // as a full-access credential so the operator can provision real keys
  // and wire the Sentinel. Compared in constant time.
  const bootstrap = process.env.MANIFEST_BOOTSTRAP_API_KEY;
  if (bootstrap && bootstrap.length > 0) {
    const a = Buffer.from(token);
    const b = Buffer.from(bootstrap);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      (req as any).apiKeyAuth = true;
      (req as any).apiKey = { id: 0, name: "bootstrap", keyPrefix: "bootstrap", projectScope: null };
      return next();
    }
  }

  // ── Path 1: API Key (pk_ prefix) ──
  if (token.startsWith("pk_")) {
    const keyHash = hashApiKey(token);

    storage.getApiKeyByHash(keyHash).then((apiKey) => {
      if (!apiKey) {
        return res.status(401).json({ message: "Invalid API key" });
      }

      if (apiKey.projectScope) {
        const projectIdParam = (req.params.projectId || req.params.id) as string | undefined;
        if (projectIdParam && parseInt(projectIdParam) !== apiKey.projectScope) {
          return res.status(403).json({ message: "API key does not have access to this project" });
        }
      }

      storage.updateApiKeyLastUsed(apiKey.id).catch(() => {});

      (req as any).apiKeyAuth = true;
      (req as any).apiKey = apiKey;
      next();
    }).catch(() => {
      res.status(500).json({ message: "Authentication error" });
    });
    return;
  }

  // ── Path 2: JWT/OIDC (eyJ... prefix) ──
  if (token.startsWith("eyJ") && isOIDCConfigured()) {
    verifyJWT(token)
      .then((user: OIDCUser) => {
        (req as any).oidcAuth = true;
        (req as any).oidcUser = user;
        next();
      })
      .catch((err: Error) => {
        res.status(401).json({ message: `Invalid token: ${err.message}` });
      });
    return;
  }

  // Unknown token format (or a JWT with OIDC not configured).
  return denyOrPass("Invalid credential");
}

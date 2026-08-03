/**
 * JWT/OIDC authentication module — NuPIdentity integration.
 *
 * Validates JWT access tokens signed by any OIDC-compliant provider
 * (NuPIdentity, Keycloak, Auth0, etc.) using JWKS auto-discovery.
 *
 * Features:
 * - JWKS key rotation handled automatically (jose caches & refreshes)
 * - Permission extraction with system_id prefix normalization
 * - Configurable via environment variables
 * - Zero state — purely stateless token validation
 *
 * Environment variables:
 *   OIDC_ISSUER_URL   — OIDC issuer (e.g. https://nupidentity.nuptechs.com)
 *   OIDC_JWKS_URI     — Optional provider JWKS endpoint override
 *   OIDC_AUDIENCE     — Expected JWT audience (client_id)
 *   OIDC_SYSTEM_ID    — System prefix for permission normalization (e.g. "manifest")
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

// ─── Configuration ─────────────────────────────────────────────────

const OIDC_ISSUER_URL = process.env.OIDC_ISSUER_URL || "";
const OIDC_JWKS_URI = process.env.OIDC_JWKS_URI || "";
const OIDC_AUDIENCE = process.env.OIDC_AUDIENCE || "";
const OIDC_SYSTEM_ID = process.env.OIDC_SYSTEM_ID || "manifest";

/** Cached JWKS fetcher — jose handles key rotation and caching internally. */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export function resolveJwksUrl(issuer: string, configuredJwksUri = ""): URL {
  return new URL(configuredJwksUri || `${issuer.replace(/\/$/, "")}/api/oidc/jwks`);
}

function getJWKS(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    if (!OIDC_ISSUER_URL) {
      throw new Error("OIDC_ISSUER_URL is not configured");
    }
    const jwksUrl = resolveJwksUrl(OIDC_ISSUER_URL, OIDC_JWKS_URI);
    jwks = createRemoteJWKSet(jwksUrl);
  }
  return jwks;
}

// ─── Types ─────────────────────────────────────────────────────────

export interface OIDCUser {
  sub: string;
  email: string;
  name: string;
  permissions: string[];
  organizationId: string | null;
  licenseTier: string;
  raw: JWTPayload;
}

// ─── Core verification ─────────────────────────────────────────────

/**
 * Verify a JWT and extract a normalized user object.
 *
 * @param token — Raw JWT string (without "Bearer " prefix)
 * @returns Normalized user with permissions stripped of system prefix
 * @throws On invalid signature, expired token, or wrong audience/issuer
 */
export async function verifyJWT(token: string): Promise<OIDCUser> {
  const { payload } = await jwtVerify(token, getJWKS(), {
    issuer: OIDC_ISSUER_URL || undefined,
    audience: OIDC_AUDIENCE || undefined,
  });

  const rawPermissions: string[] = Array.isArray(payload.permissions)
    ? payload.permissions
    : [];

  // Normalize: strip "manifest:" prefix so code checks "projects.write" not "manifest:projects.write"
  const prefix = OIDC_SYSTEM_ID ? `${OIDC_SYSTEM_ID}:` : "";
  const permissions = rawPermissions.map((p: string) =>
    typeof p === "string" && p.startsWith(prefix) ? p.slice(prefix.length) : p,
  );

  return {
    sub: (payload.sub as string) || "",
    email: (payload.email as string) || "",
    name: (payload.name as string) || "",
    permissions,
    organizationId: (payload.organization_id as string) || null,
    licenseTier: (payload.license_tier as string) || "free",
    raw: payload,
  };
}

// ─── Permission helpers ────────────────────────────────────────────

/**
 * Check if a user has a specific permission.
 * Supports wildcards: "*", "admin.full", and system-scoped wildcards.
 */
export function hasPermission(user: OIDCUser, permission: string): boolean {
  const perms = user.permissions;
  if (perms.includes("*") || perms.includes("admin.full")) return true;
  if (OIDC_SYSTEM_ID && perms.includes(`${OIDC_SYSTEM_ID}:*`)) return true;
  return perms.includes(permission);
}

/**
 * Whether OIDC authentication is available (issuer URL configured).
 */
export function isOIDCConfigured(): boolean {
  return !!OIDC_ISSUER_URL;
}

/**
 * Reset the cached JWKS (for testing).
 */
export function resetJWKS(): void {
  jwks = null;
}

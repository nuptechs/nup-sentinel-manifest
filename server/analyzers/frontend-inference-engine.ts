import type { InsertCatalogEntry } from "@shared/schema";

interface InferredBackendInfo {
  controller: string;
  entitiesTouched: string[];
  persistenceOperations: string[];
  requiredRoles: string[];
  securityAnnotations: Array<{ type: string; expression: string; roles: string[] }>;
}

const SENSITIVE_ENTITIES = new Set([
  "user", "users", "account", "accounts", "password", "passwords",
  "auth", "authentication", "session", "sessions", "token", "tokens",
  "payment", "payments", "billing", "invoice", "invoices",
  "credential", "credentials", "secret", "secrets",
]);

const ADMIN_PATH_PATTERNS = [
  /\/admin\//i,
  /\/management\//i,
  /\/settings\//i,
  /\/config\//i,
  /\/system\//i,
  /\/users\/.*\/(roles|permissions)/i,
];

const AUTH_PATH_PATTERNS = [
  /\/auth\//i,
  /\/login/i,
  /\/register/i,
  /\/signup/i,
  /\/sso\//i,
  /\/oauth\//i,
  /\/verify/i,
  /\/reset-password/i,
  /\/forgot-password/i,
];

function inferControllerFromUrl(endpoint: string): string {
  if (!endpoint) return "";
  const parts = endpoint.replace(/^\//, "").split("/");
  const apiIndex = parts.indexOf("api");
  const relevantParts = apiIndex >= 0 ? parts.slice(apiIndex + 1) : parts;
  const resourcePart = relevantParts.find(p => p && !p.startsWith("{") && !p.startsWith(":") && p !== "api");
  if (!resourcePart) return "";
  const cleaned = resourcePart.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/ /g, "");
  return cleaned + "Controller";
}

function inferEntityFromUrl(endpoint: string): string[] {
  if (!endpoint) return [];
  const entities: string[] = [];
  const parts = endpoint.replace(/^\//, "").split("/");
  const apiIndex = parts.indexOf("api");
  const relevantParts = apiIndex >= 0 ? parts.slice(apiIndex + 1) : parts;

  for (const part of relevantParts) {
    if (part.startsWith("{") || part.startsWith(":") || part === "api" || !part) continue;
    if (["list", "all", "export", "import", "search", "count", "stats", "available-fields", "duplicate", "set-default", "analyze", "refresh", "chat", "discover-functionalities", "analyze-function-points", "resend-verification", "verify-email", "well-known", "openid-configuration"].includes(part.toLowerCase())) continue;
    const singular = part.endsWith("s") && part.length > 3 ? part.slice(0, -1) : part;
    const entityName = singular.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/ /g, "");
    if (entityName.length > 1) {
      entities.push(entityName);
    }
  }

  return Array.from(new Set(entities));
}

function inferPersistenceOp(httpMethod: string | null): string[] {
  switch (httpMethod?.toUpperCase()) {
    case "GET": return ["READ"];
    case "POST": return ["CREATE"];
    case "PUT": case "PATCH": return ["UPDATE"];
    case "DELETE": return ["DELETE"];
    default: return [];
  }
}

function inferRolesFromUrl(endpoint: string, httpMethod: string | null): string[] {
  if (!endpoint) return [];
  const roles: string[] = [];

  for (const pattern of ADMIN_PATH_PATTERNS) {
    if (pattern.test(endpoint)) {
      roles.push("ADMIN");
      break;
    }
  }

  for (const pattern of AUTH_PATH_PATTERNS) {
    if (pattern.test(endpoint)) {
      if (!roles.includes("AUTHENTICATED")) roles.push("AUTHENTICATED");
      break;
    }
  }

  const method = httpMethod?.toUpperCase();
  if (method === "DELETE" || method === "PUT" || method === "PATCH") {
    if (!roles.includes("AUTHENTICATED")) roles.push("AUTHENTICATED");
  }

  return roles;
}

function inferSecurityAnnotations(endpoint: string, httpMethod: string | null, roles: string[]): Array<{ type: string; expression: string; roles: string[] }> {
  const annotations: Array<{ type: string; expression: string; roles: string[] }> = [];

  if (roles.length > 0) {
    annotations.push({
      type: "INFERRED_ROLE_REQUIREMENT",
      expression: `Requires: ${roles.join(", ")}`,
      roles: [...roles],
    });
  }

  const method = httpMethod?.toUpperCase();
  if (method === "DELETE" || method === "PUT" || method === "POST") {
    annotations.push({
      type: "INFERRED_WRITE_PROTECTION",
      expression: `${method} operation should require authentication`,
      roles: roles.length > 0 ? [...roles] : ["AUTHENTICATED"],
    });
  }

  return annotations;
}

function inferSensitiveFields(endpoint: string, entities: string[]): string[] {
  const sensitive: string[] = [];
  for (const entity of entities) {
    if (SENSITIVE_ENTITIES.has(entity.toLowerCase())) {
      sensitive.push(entity.toLowerCase());
    }
  }
  const lower = endpoint.toLowerCase();
  if (lower.includes("password") || lower.includes("credential") || lower.includes("token") || lower.includes("secret")) {
    sensitive.push("password_data");
  }
  if (lower.includes("payment") || lower.includes("billing") || lower.includes("invoice")) {
    sensitive.push("financial_data");
  }
  return Array.from(new Set(sensitive));
}

export function enrichCatalogEntriesWithInference(entries: InsertCatalogEntry[]): InsertCatalogEntry[] {
  const hasBackend = entries.some(e => e.controllerClass && e.controllerClass.length > 0);
  if (hasBackend) return entries;

  let enrichedCount = 0;

  for (const entry of entries) {
    if (!entry.endpoint) continue;

    const controller = inferControllerFromUrl(entry.endpoint);
    const entities = inferEntityFromUrl(entry.endpoint);
    const persistenceOps = inferPersistenceOp(entry.httpMethod || null);
    const urlRoles = inferRolesFromUrl(entry.endpoint, entry.httpMethod || null);
    const sensitive = inferSensitiveFields(entry.endpoint, entities);

    const existingRoles = entry.requiredRoles as string[] || [];
    const mergedRoles = Array.from(new Set([...existingRoles, ...urlRoles]));
    const annotations = inferSecurityAnnotations(entry.endpoint, entry.httpMethod || null, mergedRoles);
    const existingAnnotations = entry.securityAnnotations as Array<{ type: string; expression: string; roles: string[] }> || [];

    const ds = (entry.dataSource as Record<string, "extracted" | "inferred">) || {};
    if (controller) { entry.controllerClass = controller; ds.controllerClass = ds.controllerClass || "inferred"; }
    if (entities.length > 0) { entry.entitiesTouched = entities; ds.entitiesTouched = ds.entitiesTouched || "inferred"; }
    if (persistenceOps.length > 0) { entry.persistenceOperations = persistenceOps; ds.persistenceOperations = ds.persistenceOperations || "inferred"; }
    if (mergedRoles.length > 0) { entry.requiredRoles = mergedRoles; ds.requiredRoles = ds.requiredRoles || "inferred"; }
    if (annotations.length > 0) { entry.securityAnnotations = [...existingAnnotations, ...annotations]; ds.securityAnnotations = ds.securityAnnotations || "inferred"; }
    if (sensitive.length > 0) { entry.sensitiveFieldsAccessed = sensitive; ds.sensitiveFieldsAccessed = ds.sensitiveFieldsAccessed || "inferred"; }
    entry.dataSource = ds;

    enrichedCount++;
  }

  if (enrichedCount > 0) {
    console.log(`[frontend-inference] Enriched ${enrichedCount} entries with inferred backend structure`);
  }

  return entries;
}

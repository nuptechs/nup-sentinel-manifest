import type { ManifestData } from "./manifest-generator";

// =============================================================================
// NuPIdentity Exporter (Fase 3 — RBAC + ABAC only)
// =============================================================================
//
// Gera 4 artefatos JSON que casam 1:1 com endpoints REAIS do NuPIdentify:
//   1. systems-register.json  → POST /api/systems/register   (requireSystemApiKey)
//   2. profiles.json          → POST /api/profiles           (admin)
//   3. profile-functions.json → POST /api/profiles/:id/functions (admin)
//   4. abac-policies.json     → POST /api/policies           (admin)
//
// EXPLICITAMENTE FORA DE ESCOPO (Fase 3.5):
//   - authorization_models (ReBAC planta) — exige admin HS256 e editor UI
//   - relationship_tuples (ReBAC tuplas)  — dados de runtime, não deriváveis de análise estática
//   Ver: sentinel/FOUR-TOOLS-DEEP-AUDIT.md §9.4.1 e §9.4.4.
//
// Schemas verificados em:
//   - NuPIdentify/server/routes/systems.routes.ts  (function: {key,name,category,description,endpoint})
//   - NuPIdentify/server/routes/profiles.routes.ts (profile: {name,description,color,isDefault})
//   - NuPIdentify/shared/schema/abac.ts            (operator enum: 16 valores)
//   - NuPIdentify/shared/schema/rbac.ts            (profileFunctions: {profileId,functionId,granted})
// =============================================================================

export type AbacOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equal"
  | "less_than_or_equal"
  | "between"
  | "in"
  | "not_in"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "exists"
  | "not_exists";

export interface NupidentityFunction {
  key: string;
  name: string;
  category: string;
  description: string;
  endpoint: string;
}

export interface SystemsRegisterPayload {
  system: {
    id: string;
    name: string;
    description?: string;
    apiUrl?: string;
    callbackUrl?: string;
  };
  functions: NupidentityFunction[];
  organizationId?: string;
}

export interface ProfilePayload {
  name: string;
  description: string;
  color: string;
  isDefault: boolean;
}

export interface ProfileFunctionAssignment {
  profileName: string;      // resolvido pelo runner para profileId após criar o profile
  functionKey: string;       // resolvido pelo runner para functionId ($systemId-$key)
  granted: boolean;
}

export interface AbacCondition {
  field: string;
  operator: AbacOperator;
  value: unknown;
}

export interface AbacPolicyPayload {
  name: string;
  description: string;
  systemId: string;
  functionKey?: string;     // runner resolve para functionId
  effect: "allow" | "deny";
  priority: number;
  conditions: AbacCondition[];
}

export interface NupidentityBundle {
  $schema: string;
  version: string;
  generatedAt: string;
  generator: { name: string; version: string };
  systemId: string;

  // Avisos emitidos durante a geração (mapeadores heurísticos)
  warnings: Array<{ severity: "warn" | "info"; scope: string; message: string }>;

  // Estatísticas para o runner logar
  stats: {
    endpointsScanned: number;
    functionsGenerated: number;
    profilesGenerated: number;
    profileFunctionAssignments: number;
    abacPoliciesGenerated: number;
    unmappedGuards: number;
  };

  // Artefatos (ordem de execução: 1 → 2 → 3 → 4)
  systemsRegister: SystemsRegisterPayload;
  profiles: ProfilePayload[];
  profileFunctions: ProfileFunctionAssignment[];
  abacPolicies: AbacPolicyPayload[];
}

export interface NupidentityExportOptions {
  systemId: string;            // ex: "easynup", "manifest"
  systemName: string;
  systemDescription?: string;
  organizationId?: string;
  apiUrl?: string;
  callbackUrl?: string;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const GENERATOR_VERSION = "1.0.0";
const SCHEMA_VERSION = "https://nuptechs.com/schemas/nupidentity-export-v1.json";

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_:.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inferCategoryFromPath(httpPath: string): string {
  const segments = httpPath.split("/").filter(Boolean);
  const first = segments[0] === "api" ? segments[1] : segments[0];
  return first ? slug(first) : "general";
}

function inferActionFromMethod(method: string): string {
  const m = method.toUpperCase();
  if (m === "GET") return "read";
  if (m === "POST") return "create";
  if (m === "PUT" || m === "PATCH") return "update";
  if (m === "DELETE") return "delete";
  return "access";
}

function buildFunctionKey(systemId: string, httpMethod: string, httpPath: string): string {
  const resource = inferCategoryFromPath(httpPath);
  const action = inferActionFromMethod(httpMethod);
  const cleanPath = slug(httpPath.replace(/\/:?[^/]+/g, "_"));
  return `${systemId}:${resource}:${action}:${cleanPath}`.slice(0, 200);
}

function buildFunctionName(httpMethod: string, httpPath: string, controllerMethod?: string): string {
  if (controllerMethod) return `${httpMethod.toUpperCase()} ${httpPath} (${controllerMethod})`;
  return `${httpMethod.toUpperCase()} ${httpPath}`;
}

function colorForRole(roleName: string): string {
  // Paleta estável derivada de hash simples
  const palette = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
  let h = 0;
  for (let i = 0; i < roleName.length; i++) h = (h * 31 + roleName.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

// -----------------------------------------------------------------------------
// SpEL / guard → ABAC condition mapper (heurístico, casos simples)
// Retorna null quando não consegue mapear.
// -----------------------------------------------------------------------------

interface GuardMapResult {
  condition: AbacCondition | null;
  note: string;
}

function mapGuardToAbac(expression: string): GuardMapResult {
  const expr = expression.trim();

  // Caso 1: hasRole('X') / hasAuthority('X') — isso vira role grant, não ABAC
  if (/^has(Role|Authority)\s*\(/i.test(expr)) {
    return { condition: null, note: "role-grant (não-ABAC)" };
  }

  // Caso 2: #id == principal.id  OU  #id == authentication.principal.id  OU  #userId == principal.id
  const sameUser = expr.match(/^#(\w+)\s*==\s*(?:authentication\.)?principal\.(\w+)$/);
  if (sameUser) {
    return {
      condition: {
        field: `resource.${sameUser[1]}`,
        operator: "equals",
        value: `$user.${sameUser[2]}`,
      },
      note: "same-user policy",
    };
  }

  // Caso 3: #resource.ownerId == principal.id  (variante com property access)
  const sameOwner = expr.match(/^#(\w+)\.(\w+)\s*==\s*(?:authentication\.)?principal\.(\w+)$/);
  if (sameOwner) {
    return {
      condition: {
        field: `resource.${sameOwner[2]}`,
        operator: "equals",
        value: `$user.${sameOwner[3]}`,
      },
      note: "same-owner policy",
    };
  }

  // Caso 4: @<bean>.check(...)  — convenção de guard customizado, não mapeável
  if (/^@\w+\./.test(expr)) {
    return { condition: null, note: "custom guard (bean)" };
  }

  // Caso 5: hasPermission(#obj, 'read')  — direct function, não ABAC
  if (/^hasPermission\s*\(/i.test(expr)) {
    return { condition: null, note: "direct permission (não-ABAC)" };
  }

  return { condition: null, note: "expressão não reconhecida" };
}

// -----------------------------------------------------------------------------
// Main generator
// -----------------------------------------------------------------------------

export function generateNupidentityBundle(
  manifest: ManifestData,
  options: NupidentityExportOptions,
): NupidentityBundle {
  const warnings: NupidentityBundle["warnings"] = [];
  const { systemId } = options;

  // --- 1. Functions ---------------------------------------------------------
  // Uma function por (method, path) único.
  const functionMap = new Map<string, NupidentityFunction>();
  const functionKeyByEndpoint = new Map<string, string>(); // "METHOD path" → functionKey
  let unmappedGuards = 0;

  for (const ep of manifest.endpoints) {
    const fnKey = buildFunctionKey(systemId, ep.method, ep.path);
    const endpointId = `${ep.method.toUpperCase()} ${ep.path}`;
    functionKeyByEndpoint.set(endpointId, fnKey);

    if (!functionMap.has(fnKey)) {
      functionMap.set(fnKey, {
        key: fnKey,
        name: buildFunctionName(ep.method, ep.path, ep.controllerMethod),
        category: inferCategoryFromPath(ep.path),
        description:
          ep.technicalOperation && ep.technicalOperation !== "UNKNOWN"
            ? `${ep.technicalOperation} (criticidade ${ep.criticalityScore}/100)`
            : `Endpoint ${ep.method.toUpperCase()} ${ep.path}`,
        endpoint: `${ep.method.toUpperCase()} ${ep.path}`,
      });
    }
  }

  const functions = Array.from(functionMap.values());

  // --- 2. Profiles (um por role único do manifest) --------------------------
  const profileMap = new Map<string, ProfilePayload>();

  for (const role of manifest.roles) {
    if (!role.name) continue;
    const profileName = role.name;
    if (!profileMap.has(profileName)) {
      profileMap.set(profileName, {
        name: profileName,
        description: `Perfil importado de ${options.systemName}. Criticidade ${role.criticalityRange[0]}-${role.criticalityRange[1]}, ${role.endpoints.length} endpoint(s).`,
        color: colorForRole(profileName),
        isDefault: false,
      });
    }
  }

  const profiles = Array.from(profileMap.values());

  // --- 3. Profile ↔ Function assignments -----------------------------------
  const profileFunctions: ProfileFunctionAssignment[] = [];
  const seenAssignments = new Set<string>();

  for (const role of manifest.roles) {
    for (const ref of role.endpoints) {
      const endpointId = `${ref.method.toUpperCase()} ${ref.path}`;
      const fnKey = functionKeyByEndpoint.get(endpointId);
      if (!fnKey) continue;
      const dedupeKey = `${role.name}|${fnKey}`;
      if (seenAssignments.has(dedupeKey)) continue;
      seenAssignments.add(dedupeKey);
      profileFunctions.push({
        profileName: role.name,
        functionKey: fnKey,
        granted: true,
      });
    }
  }

  // --- 4. ABAC policies (de securityAnnotations que não sejam hasRole) ------
  const abacPolicies: AbacPolicyPayload[] = [];
  const seenPolicies = new Set<string>();

  for (const ep of manifest.endpoints) {
    const endpointId = `${ep.method.toUpperCase()} ${ep.path}`;
    const fnKey = functionKeyByEndpoint.get(endpointId);
    if (!fnKey) continue;

    for (const ann of ep.securityAnnotations) {
      if (!ann.expression) continue;
      // Roles já viram profile-functions acima; pulamos expressões puras de role
      if (ann.roles && ann.roles.length > 0 && /^has(Role|Authority)/i.test(ann.expression)) {
        continue;
      }

      const mapped = mapGuardToAbac(ann.expression);
      if (!mapped.condition) {
        unmappedGuards++;
        warnings.push({
          severity: "warn",
          scope: `${endpointId}`,
          message: `Guard não mapeado para ABAC (${mapped.note}): ${ann.expression}`,
        });
        continue;
      }

      const polName = `${systemId}:${fnKey}:${slug(ann.expression).slice(0, 40)}`;
      if (seenPolicies.has(polName)) continue;
      seenPolicies.add(polName);

      abacPolicies.push({
        name: polName,
        description: `Derivada de ${ann.type} em ${endpointId}. Fonte: \`${ann.expression}\`. Heurística: ${mapped.note}.`,
        systemId,
        functionKey: fnKey,
        effect: "allow",
        priority: ep.criticalityScore || 0,
        conditions: [mapped.condition],
      });
    }
  }

  // --- 5. Monta payloads finais --------------------------------------------
  const systemsRegister: SystemsRegisterPayload = {
    system: {
      id: systemId,
      name: options.systemName,
      description: options.systemDescription,
      apiUrl: options.apiUrl,
      callbackUrl: options.callbackUrl,
    },
    functions,
    organizationId: options.organizationId,
  };

  return {
    $schema: SCHEMA_VERSION,
    version: "1.0",
    generatedAt: new Date().toISOString(),
    generator: { name: "Manifest NuPIdentity Exporter", version: GENERATOR_VERSION },
    systemId,
    warnings,
    stats: {
      endpointsScanned: manifest.endpoints.length,
      functionsGenerated: functions.length,
      profilesGenerated: profiles.length,
      profileFunctionAssignments: profileFunctions.length,
      abacPoliciesGenerated: abacPolicies.length,
      unmappedGuards,
    },
    systemsRegister,
    profiles,
    profileFunctions,
    abacPolicies,
  };
}

// -----------------------------------------------------------------------------
// Runner script — emitido como string para o consumidor executar
// -----------------------------------------------------------------------------

export function generateNupidentityRunnerScript(): string {
  return `#!/usr/bin/env node
/**
 * NuPIdentity Bundle Runner (gerado pelo Manifest)
 *
 * Aplica um bundle gerado por \`generateNupidentityBundle()\` nos endpoints REAIS
 * do NuPIdentify. Idempotente: pode ser rodado várias vezes.
 *
 * Uso:
 *   NUPIDENTITY_BASE_URL=https://nupidentity.example.com \\
 *   NUPIDENTITY_SYSTEM_API_KEY=sk_live_... \\
 *   NUPIDENTITY_ADMIN_TOKEN=eyJ... \\
 *   node nupidentity-runner.js ./nupidentity-bundle.json
 *
 * Fase 3 — RBAC + ABAC apenas. ReBAC é Fase 3.5.
 */
import { readFileSync } from "node:fs";

const baseUrl = process.env.NUPIDENTITY_BASE_URL;
const systemKey = process.env.NUPIDENTITY_SYSTEM_API_KEY;
const adminToken = process.env.NUPIDENTITY_ADMIN_TOKEN;
const bundlePath = process.argv[2];

if (!baseUrl || !systemKey || !adminToken || !bundlePath) {
  console.error("Faltando: NUPIDENTITY_BASE_URL, NUPIDENTITY_SYSTEM_API_KEY, NUPIDENTITY_ADMIN_TOKEN, ou path do bundle.");
  process.exit(2);
}

const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));

async function http(method, path, body, token) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(\`\${method} \${path} → HTTP \${res.status}: \${JSON.stringify(data).slice(0, 300)}\`);
  }
  return data;
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(\`[retry \${attempt}/3] \${label}: \${err.message}\`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

(async () => {
  console.log("[1/4] Registrando sistema + funções...");
  const sysResp = await withRetry(
    () => http("POST", "/api/systems/register", bundle.systemsRegister, systemKey),
    "systems/register",
  );
  console.log(\`  OK: \${sysResp.functionsSync?.created || 0} criadas, \${sysResp.functionsSync?.updated || 0} atualizadas.\`);

  console.log(\`[2/4] Criando \${bundle.profiles.length} profile(s)...\`);
  const profileIdByName = new Map();
  for (const p of bundle.profiles) {
    try {
      const resp = await http("POST", "/api/profiles", p, adminToken);
      profileIdByName.set(p.name, resp.id);
    } catch (err) {
      if (err.message.includes("409") || err.message.toLowerCase().includes("já existe")) {
        // Buscar ID do existente
        const list = await http("GET", "/api/profiles", null, adminToken);
        const found = Array.isArray(list) ? list.find(x => x.name === p.name) : null;
        if (found) profileIdByName.set(p.name, found.id);
        else throw err;
      } else throw err;
    }
  }

  console.log(\`[3/4] Atribuindo \${bundle.profileFunctions.length} função(ões) a perfis...\`);
  for (const assign of bundle.profileFunctions) {
    const profileId = profileIdByName.get(assign.profileName);
    if (!profileId) {
      console.warn(\`  [skip] profile não encontrado: \${assign.profileName}\`);
      continue;
    }
    const functionId = \`\${bundle.systemId}-\${assign.functionKey}\`;
    await withRetry(
      () => http("POST", \`/api/profiles/\${profileId}/functions\`, { functionId, granted: assign.granted }, adminToken),
      \`profile \${assign.profileName} ← \${assign.functionKey}\`,
    );
  }

  console.log(\`[4/4] Criando \${bundle.abacPolicies.length} ABAC policy(ies)...\`);
  for (const pol of bundle.abacPolicies) {
    const functionId = pol.functionKey ? \`\${bundle.systemId}-\${pol.functionKey}\` : undefined;
    const payload = {
      name: pol.name,
      description: pol.description,
      systemId: pol.systemId,
      functionId,
      effect: pol.effect,
      priority: pol.priority,
      conditions: pol.conditions,
    };
    await withRetry(() => http("POST", "/api/policies", payload, adminToken), \`policy \${pol.name}\`);
  }

  console.log("Done. Warnings:", bundle.warnings?.length || 0);
  if (bundle.warnings?.length) {
    for (const w of bundle.warnings.slice(0, 10)) {
      console.log(\`  [\${w.severity}] \${w.scope}: \${w.message}\`);
    }
    if (bundle.warnings.length > 10) console.log(\`  ... +\${bundle.warnings.length - 10} warnings\`);
  }
})().catch(err => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
`;
}

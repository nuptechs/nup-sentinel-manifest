// ─────────────────────────────────────────────
// Modelo Canônico stack-agnóstico (ADR-0026, Onda CM1) — a camada de PAPEL.
//
// O erro que esta camada corrige: hoje o "papel" (CONTROLLER/SERVICE/…) mora no
// TIPO do nó (`application-graph.ts`), cravado por framework — o que impede
// "qualquer stack" de forma estrutural (adicionar um stack exigiria mexer no
// núcleo). A fronteira (Glean codemarkup, jQAssistant Concepts, CodeQL library
// classes; ADR-0026 §3.2) prova o desenho certo: **substrato ≠ arquitetura** —
// o papel é uma FACETA anexada por regra (rule-pack por stack), com evidência e
// confiança graduadas, sobre nós/arestas fechados e neutros.
//
// CM1 (fatia fundação, ADITIVA e não-quebrante): o papel canônico é derivado de
// forma que `projectRoleToLegacyType(role) === node.type` SEMPRE (projeção
// byte-a-byte — a régua anti-meia-bomba do §11). O VALOR novo e NÃO-circular é
// `layer` + `stack` + `evidence` + `confidence`, derivados de evidência
// INDEPENDENTE (path/metadata). Quando o path CORROBORA o produtor → confiança
// alta; quando só o produtor tipou → média; quando o path CONFLITA → baixa
// (registra o conflito; o papel ainda defere ao produtor — precisão sobre
// recall, §10.3 — e o conflito vira gancho de finding de reflexion nas ondas OR).
//
// As 7 facetas futuras (Endpoint/DataCarrier/Port/Adapter/Config/Scheduler/
// Client) estão DECLARADAS no vocabulário mas nenhum pack de CM1 as emite — elas
// entram em CM2/CM3 (Node repo, DTO/Port como faceta). Puro e testável.
// ─────────────────────────────────────────────

/** Vocabulário de papéis canônico — fechado e neutro (§6). */
export type CanonicalRole =
  // ATIVOS em CM1: 1:1 com os tipos atuais da tela (projeção byte-a-byte)
  | "Controller" | "Service" | "Repository" | "Entity"
  | "View" | "UiComponent" | "Composable" | "Route"
  // DECLARADOS p/ packs futuros (CM2/CM3): DTO/porta/adapter/etc. como faceta
  | "Endpoint" | "DataCarrier" | "Port" | "Adapter" | "Config" | "Scheduler" | "Client";

export type CanonicalLayer = "presentation" | "api" | "domain" | "data" | "infra";
export type Stack = "spring" | "express" | "vue" | "node" | "unknown";
export type RoleConfidence = "high" | "medium" | "low";

export interface RoleFacet {
  role: CanonicalRole;
  layer: CanonicalLayer;
  stack: Stack;
  /** de onde veio o papel/camada: path-corroborado, só-produtor, ou conflito */
  evidence: string;
  confidence: RoleConfidence;
}

/** Nó classificável — funciona no raw (metadata.sourceFile) e no shaped (sourceFile). */
export interface ClassifiableNode {
  type: string;
  id?: string;
  className?: string;
  sourceFile?: string;
  metadata?: Record<string, unknown> | null;
}

// ── Mapas do núcleo ──────────────────────────────────────────────────────────

/** Tipo do produtor → papel canônico (o produtor é a autoridade neste nível). */
const LEGACY_TYPE_TO_ROLE: Record<string, CanonicalRole> = {
  CONTROLLER: "Controller",
  SERVICE: "Service",
  REPOSITORY: "Repository",
  ENTITY: "Entity",
  VIEW: "View",
  COMPONENT: "UiComponent",
  COMPOSABLE: "Composable",
  ROUTE: "Route",
};

/** Papel ATIVO → tipo legado (a projeção que garante byte-a-byte na tela). */
const ACTIVE_ROLE_TO_LEGACY: Partial<Record<CanonicalRole, string>> = {
  Controller: "CONTROLLER",
  Service: "SERVICE",
  Repository: "REPOSITORY",
  Entity: "ENTITY",
  View: "VIEW",
  UiComponent: "COMPONENT",
  Composable: "COMPOSABLE",
  Route: "ROUTE",
};

const ROLE_TO_LAYER: Record<CanonicalRole, CanonicalLayer> = {
  Controller: "api", Route: "api", Endpoint: "api",
  Service: "domain", Port: "domain",
  Repository: "data", Entity: "data", DataCarrier: "data",
  View: "presentation", UiComponent: "presentation", Composable: "presentation",
  Adapter: "infra", Config: "infra", Scheduler: "infra", Client: "infra",
};

/**
 * Projeta o papel canônico de volta ao tipo legado da tela. Total sobre os 8
 * papéis ATIVOS do CM1; lança nos 7 futuros (nenhum pack de CM1 os produz — o
 * lançamento é a garantia honesta de que ninguém tenta projetá-los cedo).
 */
export function projectRoleToLegacyType(role: CanonicalRole): string {
  const t = ACTIVE_ROLE_TO_LEGACY[role];
  if (!t) {
    throw new Error(
      `Papel '${role}' é faceta futura (CM2/CM3) e ainda não tem tipo legado — não projete em CM1.`,
    );
  }
  return t;
}

/** Os papéis produzidos em CM1 (para testes e guards). */
export const ACTIVE_ROLES: CanonicalRole[] = Object.keys(ACTIVE_ROLE_TO_LEGACY) as CanonicalRole[];

// ── Evidência independente (stack + corroboração por path) ───────────────────

function sourceFileOf(node: ClassifiableNode): string | undefined {
  if (typeof node.sourceFile === "string" && node.sourceFile) return node.sourceFile;
  const mf = node.metadata?.sourceFile;
  return typeof mf === "string" && mf ? mf : undefined;
}

/** Stack detectado por evidência independente (extensão/path/tipo do produtor). */
function detectStack(node: ClassifiableNode, role: CanonicalRole): Stack {
  const sf = (sourceFileOf(node) || "").toLowerCase();
  if (sf.endsWith(".vue")) return "vue";
  if (sf.endsWith(".java")) return "spring";
  // papéis de frontend só são emitidos pelo extrator Vue
  if (role === "View" || role === "UiComponent" || role === "Composable") return "vue";
  if (role === "Route") return "express";
  if (sf.endsWith(".ts") || sf.endsWith(".js")) return "node";
  if (role === "Controller" || role === "Service" || role === "Repository" || role === "Entity") return "spring";
  return "unknown";
}

/**
 * O path corrobora o papel do produtor? true=corrobora · false=CONFLITA ·
 * null=sem sinal. Convenções independentes do tipo do produtor (§10.2 — o papel
 * é derivado por evidência, não só reafirmado).
 */
function pathCorroborates(role: CanonicalRole, sf: string | undefined): boolean | null {
  if (!sf) return null;
  const p = sf.toLowerCase();
  switch (role) {
    case "Controller":
      if (/controller|\/web\/|wsv1|resource/.test(p)) return true;
      if (/\/service|repositor|\/entit/.test(p)) return false;
      return null;
    case "Service":
      if (/service/.test(p)) return true;
      if (/controller|repositor|\/entit/.test(p)) return false;
      return null;
    case "Repository":
      if (/repositor/.test(p)) return true;
      if (/controller|\/service/.test(p)) return false;
      return null;
    case "Entity":
      if (/\/entit|\/persistence\/|\/domain\/|\/model\//.test(p)) return true;
      return null;
    case "View":
      if (!p.endsWith(".vue")) return false;
      return /\/pages?\/|\/views?\//.test(p) ? true : null;
    case "UiComponent":
      if (!p.endsWith(".vue")) return false;
      return /\/components?\//.test(p) ? true : null;
    case "Composable":
      return /\/composables?\//.test(p) || /\buse[A-Z]/.test(sf) ? true : null;
    case "Route":
      return /route/.test(p) ? true : null;
    default:
      return null;
  }
}

/** Metadata decisiva (endpoint HTTP tem httpMethod/fullPath). */
function hasHttpEndpointEvidence(node: ClassifiableNode): boolean {
  const m = node.metadata || {};
  return !!(m as Record<string, unknown>).httpMethod || !!(m as Record<string, unknown>).fullPath;
}

/**
 * Classifica o nó no modelo canônico. Retorna `null` quando o tipo do produtor
 * está FORA do vocabulário ativo do CM1 (ex.: módulo Node materializado — coberto
 * em CM2), nunca chuta. Garantia: `projectRoleToLegacyType(role) === node.type`.
 */
export function classifyNode(node: ClassifiableNode): RoleFacet | null {
  const role = LEGACY_TYPE_TO_ROLE[node.type];
  if (!role) return null;
  const layer = ROLE_TO_LAYER[role];
  const stack = detectStack(node, role);
  const sf = sourceFileOf(node);

  // metadata decisiva vence (endpoint HTTP corrobora Controller com certeza)
  if (role === "Controller" && hasHttpEndpointEvidence(node)) {
    return { role, layer, stack, evidence: "http-endpoint", confidence: "high" };
  }

  const corrob = pathCorroborates(role, sf);
  if (corrob === true) return { role, layer, stack, evidence: "path-corroborated", confidence: "high" };
  if (corrob === false) return { role, layer, stack, evidence: "path-conflict", confidence: "low" };
  return { role, layer, stack, evidence: "producer-type", confidence: "medium" };
}

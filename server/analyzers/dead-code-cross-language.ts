// ─────────────────────────────────────────────────────────────────────────
// OBS-E03 (ADR-0036 WS-E) — DEAD-CODE CROSS-LANGUAGE (lado MANIFEST/mapeador).
//
// O morto que NENHUMA ferramenta mono-linguagem enxerga: uma tela/componente de
// FRONT morto (JS/TS) deixa ÓRFÃO o endpoint de BACK que só ele chamava — o morto
// ATRAVESSA a costura front↔back. knip/ts-prune veem o front; o engine Java/AST
// veem o back; nenhum vê a propagação pela fronteira. Este módulo vê, cruzando o
// grafo ponta-a-ponta do manifest (VIEW/COMPONENT → CONTROLLER/ROUTE).
//
// REGRA (determinística): uma SUPERFÍCIE de back é morta-cross-language quando
//   (1) TODA aresta cross-stack que nela aterrissa vem de um nó de front MORTO
//       (conjunto injetado pelo produtor de dead-code de front — OBS-E04/codelens);
//   (2) ela NÃO tem outro chamador vivo (same-stack), NÃO roda em runtime, NÃO é
//       gatilho; e
//   (3) existe ≥1 caller cross-stack (senão é "órfã de superfície" pura, OBS-E01,
//       não cross-language).
//
// BLOQUEIO HONESTO (o lado codelens está FORA — repo não está em disco):
//   O conjunto `deadFrontendNodeIds` é PRODUZIDO pelo codelens (adapter knip/
//   ts-prune de `code-index.port`, OBS-E04). Esse repositório NÃO existe neste
//   ambiente, logo o produtor não roda aqui. Sem o conjunto injetado, o detector
//   se declara CEGO (`frontendDeadnessProvided:false`, zero confirmados) — igual
//   à guarda do orphan-surface. O lado manifest está pronto e provado por fixture;
//   a federação viva depende do codelens (ADR-0036 módulo `cl`).
//
// PURO; nunca lança. §2.3: IA não entra — veredito determinístico.
// ─────────────────────────────────────────────────────────────────────────

import type { ShapedGraph, ShapedNode, ShapedEdge } from "./system-graph";

/** Tipos de nó do FRONT (origem possível de uma chamada cross-stack). */
export const FRONTEND_NODE_TYPES = new Set(["VIEW", "COMPONENT", "COMPOSABLE"]);
/** Superfícies de BACK (alvo de uma chamada cross-stack). */
export const BACKEND_SURFACE_TYPES = new Set(["CONTROLLER", "ROUTE"]);
/** Relações que contam como chamada cross-stack front→back (default conservador). */
export const DEFAULT_CROSS_STACK_RELATIONS = new Set(["CALLS", "CALLS_ENDPOINT", "HTTP_CALL", "INVOKES_ENDPOINT"]);

export type CrossLangDeadTier = "cross-language-dead";

export interface CrossLangDeadCandidate {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  tier: CrossLangDeadTier;
  /** 0..1, nunca 1 — montagem dinâmica / chamador não-resolvido permanecem. */
  confidence: number;
  /** ids dos nós de front MORTOS que eram os únicos chamadores desta superfície. */
  deadFrontendCallers: string[];
  reasons: string[];
}

export interface CrossLangDeadExclusions {
  /** superfície com ≥1 chamador cross-stack VIVO (front não-morto). */
  liveFrontendCaller: number;
  /** superfície com chamador same-stack (outro back a usa). */
  sameStackCaller: number;
  /** superfície exercitada por runtime. */
  runtimeObserved: number;
  /** superfície que é gatilho/entry-point legítimo. */
  entryPoint: number;
  /** superfície sem NENHUM chamador cross-stack (é órfã pura — OBS-E01, não cross-lang). */
  noCrossStackCaller: number;
}

export interface CrossLangDeadReport {
  /** false = o produtor de dead-code de front (codelens/E04) não injetou nada → CEGO. */
  frontendDeadnessProvided: boolean;
  candidates: CrossLangDeadCandidate[];
  excluded: CrossLangDeadExclusions;
  backendSurfacesTotal: number;
  summary: string;
}

const CROSS_LANG_CONFIDENCE = 0.7;

function labelOf(n: ShapedNode): string {
  return n.className || n.methodName || (typeof n.id === "string" ? n.id.split(":").pop() || n.id : "?");
}
function isObserved(n: ShapedNode): boolean {
  return n.observed === true || n.runtimeHot === true || n.evidence?.method === "RUNTIME_OBSERVED";
}
function isEntryPoint(n: ShapedNode): boolean {
  return Array.isArray(n.entryPoint) && n.entryPoint.length > 0;
}

/**
 * Detecta superfícies de back mortas POR propagação cross-language. PURO.
 *
 * @param graph  grafo shaped com nós front+back e arestas cross-stack.
 * @param deadFrontendNodeIds  nós de FRONT já provados mortos pelo produtor
 *   JS/TS (codelens/E04). `undefined`/vazio ⇒ detector CEGO (honesto).
 * @param opts.crossStackRelations  relações que contam como chamada cross-stack.
 */
export function findCrossLanguageDead(
  graph: ShapedGraph,
  deadFrontendNodeIds: Set<string> | null | undefined,
  opts: { crossStackRelations?: Set<string> } = {},
): CrossLangDeadReport {
  const rels = opts.crossStackRelations && opts.crossStackRelations.size > 0 ? opts.crossStackRelations : DEFAULT_CROSS_STACK_RELATIONS;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const dead = deadFrontendNodeIds ?? new Set<string>();

  const excluded: CrossLangDeadExclusions = { liveFrontendCaller: 0, sameStackCaller: 0, runtimeObserved: 0, entryPoint: 0, noCrossStackCaller: 0 };
  const nodeById = new Map<string, ShapedNode>();
  for (const n of nodes) if (n && typeof n.id === "string") nodeById.set(n.id, n);

  const backendSurfaces = nodes.filter((n) => n && typeof n.id === "string" && BACKEND_SURFACE_TYPES.has(String(n.type || "")));
  const backendSurfacesTotal = backendSurfaces.length;

  // CEGO sem o produtor de front-deadness (codelens ausente neste ambiente).
  if (dead.size === 0) {
    return {
      frontendDeadnessProvided: false,
      candidates: [],
      excluded,
      backendSurfacesTotal,
      summary: `Detector cego: o produtor de dead-code de front (codelens/OBS-E04, adapter knip/ts-prune) não injetou nós mortos neste ambiente (o repo codelens não está presente). ${backendSurfacesTotal} superfície(s) de back não avaliadas — honesto, nenhuma acusada.`,
    };
  }

  // incoming por nó, separando cross-stack (de front) de same-stack.
  const incomingFrom = new Map<string, ShapedEdge[]>();
  for (const e of edges as ShapedEdge[]) {
    if (!e || typeof e.toNode !== "string" || typeof e.fromNode !== "string") continue;
    const arr = incomingFrom.get(e.toNode) ?? [];
    arr.push(e);
    incomingFrom.set(e.toNode, arr);
  }

  const candidates: CrossLangDeadCandidate[] = [];

  for (const surface of backendSurfaces) {
    if (isObserved(surface)) { excluded.runtimeObserved++; continue; }
    if (isEntryPoint(surface)) { excluded.entryPoint++; continue; }

    const incoming = incomingFrom.get(surface.id) ?? [];
    const crossStackCallers = incoming.filter((e) => {
      if (!rels.has(e.relationType)) return false;
      const from = nodeById.get(e.fromNode);
      return !!from && FRONTEND_NODE_TYPES.has(String(from.type || ""));
    });

    // precisa de ≥1 chamador cross-stack — senão é órfã de superfície pura (E01).
    if (crossStackCallers.length === 0) { excluded.noCrossStackCaller++; continue; }

    // chamador same-stack vivo (outro back a usa) → viva.
    const sameStackCaller = incoming.some((e) => {
      if (!rels.has(e.relationType)) return false;
      const from = nodeById.get(e.fromNode);
      return !!from && !FRONTEND_NODE_TYPES.has(String(from.type || ""));
    });
    if (sameStackCaller) { excluded.sameStackCaller++; continue; }

    // TODOS os chamadores cross-stack precisam estar MORTOS; qualquer vivo → viva.
    const callerIds = crossStackCallers.map((e) => e.fromNode);
    const allDead = callerIds.every((id) => dead.has(id));
    if (!allDead) { excluded.liveFrontendCaller++; continue; }

    const deadCallers = Array.from(new Set(callerIds)).sort();
    candidates.push({
      nodeId: surface.id,
      type: String(surface.type || ""),
      label: labelOf(surface),
      ...(surface.sourceFile ? { sourceFile: surface.sourceFile } : {}),
      tier: "cross-language-dead",
      confidence: CROSS_LANG_CONFIDENCE,
      deadFrontendCallers: deadCallers,
      reasons: [
        "superfície de back cujos ÚNICOS chamadores cross-stack são telas/componentes de front JÁ provados mortos (codelens/knip)",
        "sem chamador same-stack vivo, sem tráfego de runtime, sem gatilho",
        "o morto atravessa a costura front↔back — invisível a ferramenta mono-linguagem",
      ],
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.type.localeCompare(b.type) || a.label.localeCompare(b.label) || a.nodeId.localeCompare(b.nodeId));

  const summary = candidates.length === 0
    ? `Nenhuma superfície morta cross-language: das ${backendSurfacesTotal} superfície(s) de back, nenhuma tem como ÚNICOS chamadores telas de front mortas (excluídas: ${excluded.liveFrontendCaller} com front vivo, ${excluded.sameStackCaller} com chamador same-stack, ${excluded.runtimeObserved} observadas, ${excluded.noCrossStackCaller} sem chamador cross-stack).`
    : `${candidates.length} superfície(s) de back morta(s) por propagação cross-language de ${backendSurfacesTotal} — os únicos chamadores são front morto. Confiança < 1 (chamador dinâmico/não-resolvido permanece como ponto-cego).`;

  return { frontendDeadnessProvided: true, candidates, excluded, backendSurfacesTotal, summary };
}

// ── Adaptador: mortos cross-language → StaticSuspect do tri-eixo (OBS-E06) ──
export interface CrossLangStaticSuspect {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  staticConfidence: number;
  staticReasons: string[];
  staticSource: string;
}

export function suspectsFromCrossLanguageDead(report: CrossLangDeadReport | null | undefined): CrossLangStaticSuspect[] {
  if (!report || !report.frontendDeadnessProvided || !Array.isArray(report.candidates)) return [];
  return report.candidates.map((c) => ({
    nodeId: c.nodeId,
    type: c.type,
    label: c.label,
    ...(c.sourceFile ? { sourceFile: c.sourceFile } : {}),
    staticConfidence: c.confidence,
    staticReasons: c.reasons,
    staticSource: "cross-language-dead",
  }));
}

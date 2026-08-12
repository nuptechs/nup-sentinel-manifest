// ─────────────────────────────────────────────
// Narrative subgraph — ADR-0033 P4.1 (a espinha ANDÁVEL da narrativa).
//
// Antes de qualquer prosa, este passo determinístico monta o material ÚNICO que
// o LLM pode usar: só as arestas VERIFICADAS (RUNTIME_OBSERVED/STATIC_PROVEN) que
// tocam o raio de impacto de um símbolo (o "andável") + as arestas cegas que
// tocam o raio (o "não-andável, NOMEADO") + a partição proven/possible e a
// proveniência (traços/`arquivo:linha` de ADR). O LLM recebe ISSO e só isso —
// nunca o código cru, nunca o grafo inteiro (ADR-0033 §4, pilar 1).
//
// Reuso §2.5: a espinha de evidência JÁ existe — `computeImpactConfidence`
// (raio+partição+blindSpots+disclosure), `resolveSymbolSeeds` (casamento de
// símbolo), `shapeSystemGraph` (`evidence`/`type`/`sensitive`/`layer`/`stack`),
// `buildAdrLinks` (proveniência tácita ADR↔símbolo). Aqui só RECORTAMOS a espinha.
//
// Puro, determinístico, sem I/O. Degrada honestamente: grafo ausente ou símbolo
// fora do grafo → subgrafo vazio (não crasha) → a narrativa se abstém (P4.3).
// ─────────────────────────────────────────────

import type { ShapedGraph, ShapedNode, ShapedEdge, EvidenceMethod, GraphCoverage, EdgeRefutation, RefutationSubtype } from "./system-graph";
import {
  computeImpactConfidence,
  resolveSymbolSeeds,
  type AffectedNode,
  type BlindSpotEdge,
} from "./impact-confidence";
import type { AdrLink } from "./adr-tacit-links";

/** Métodos que a narrativa PODE afirmar como fato (o "andável"). */
const WALKABLE_METHODS: ReadonlySet<EvidenceMethod> = new Set<EvidenceMethod>(["RUNTIME_OBSERVED", "STATIC_PROVEN"]);

/**
 * Facetas dos extremos de uma aresta — o que uma projeção por perspectiva
 * filtra SEM recomputar (§4 pilar 4). Comum à aresta andável e à refutada, para
 * o mesmo predicado de lente valer nas duas.
 */
export interface EdgeFacets {
  relationType: string;
  fromType: string;
  toType: string;
  fromSensitive: boolean;
  toSensitive: boolean;
  fromLayer?: string;
  toLayer?: string;
  fromStack?: string;
  toStack?: string;
}

/** Uma aresta VERIFICADA do subgrafo — a unidade que a narrativa cita por `edgeId`. */
export interface NarrativeEdge extends EdgeFacets {
  /** id estável, casável pelo gate de grounding (§4 pilar 2). */
  edgeId: string;
  fromNode: string;
  toNode: string;
  fromLabel: string;
  toLabel: string;
  method: EvidenceMethod; // RUNTIME_OBSERVED | STATIC_PROVEN (só verificadas entram)
  confidence: number;
  /** nº de traços que exercitaram a aresta (só RUNTIME_OBSERVED). */
  count?: number;
  /** proveniência humana pt-BR: "observada em N traços" | "resolvida pelo compilador". */
  provenance: string;
}

/**
 * ADR-0033 P4.5 — uma aresta REFUTADA pelo laço ativo (ADR-0032 P3): o estático
 * a desenhou, o robô dirigiu tráfego e NÃO a confirmou. FORA da espinha andável
 * (a narrativa nunca a cita como fato); vive no "não-andável, NOMEADO" junto dos
 * blindSpots. Carrega as MESMAS facetas para ser projetável por perspectiva.
 */
export interface RefutedNarrativeEdge extends EdgeFacets {
  edgeId: string;
  fromNode: string;
  toNode: string;
  fromLabel: string;
  toLabel: string;
  /** o método estrutural que o compilador/heurística deu à aresta refutada. */
  method: EvidenceMethod;
  subtype: RefutationSubtype;
  attempts?: number;
  windows?: number;
  reason?: string;
  /** proveniência pt-BR honesta da refutação (dead-candidate × UNKNOWN honesto). */
  provenance: string;
}

/** Ligação de decisão (ADR) que governa um símbolo do subgrafo — proveniência `arquivo:linha`. */
export interface SubgraphAdrLink {
  adrId: string;
  adrTitle: string;
  targetSymbol: string;
  sourceRef: string; // "docs/adr/ADR-063-...md:12"
  confidence: string;
}

export interface NarrativeSubgraph {
  symbol: string;
  symbolLocatedInGraph: boolean;
  evidenceAvailable: boolean;
  /** a espinha ANDÁVEL: só arestas verificadas que tocam o raio. */
  edges: NarrativeEdge[];
  /** os `edgeId` válidos — a lei do gate de grounding (§4 pilar 2). */
  edgeIds: Set<string>;
  /** o "não-andável, NOMEADO": arestas cegas que tocam o raio (reuso de P4). */
  blindSpots: BlindSpotEdge[];
  blindSpotCount: number;
  /**
   * ADR-0033 P4.5 — arestas REFUTADAS pelo laço ativo (P3) que tocam o raio:
   * o estático as previu, o runtime dirigido NÃO as confirmou. FORA da espinha
   * andável (nunca citadas como fato) — a narrativa as NOMEIA como refutadas.
   * Vazio hoje até o P3 popular o campo (dependência honesta, ver §4/§8).
   */
  refutedEdges: RefutedNarrativeEdge[];
  refutedCount: number;
  /** partição já pronta (reuso) para a abertura garante×possível×cego (P4.3). */
  proven: AffectedNode[];
  possible: AffectedNode[];
  disclosure: string;
  overallConfidence: number;
  overallMethod: EvidenceMethod;
  coverage?: GraphCoverage;
  /** decisões (ADR) que governam os símbolos do subgrafo — proveniência tácita. */
  adrLinks: SubgraphAdrLink[];
}

export interface BuildSubgraphOptions {
  /** ligações ADR↔símbolo já extraídas (buildAdrLinks) — filtradas ao subgrafo. */
  adrLinks?: AdrLink[];
  /** raio do manifest para o modo degradado (grafo ausente/símbolo fora). */
  fallbackAffected?: AffectedNode[];
}

function labelOf(node: ShapedNode | undefined, id: string): string {
  if (node?.className) return node.className;
  const afterColon = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return afterColon.split(".").filter(Boolean).pop() || afterColon;
}

/** Proveniência humana de uma aresta verificada. */
function edgeProvenance(e: ShapedEdge): string {
  if (e.evidence?.method === "RUNTIME_OBSERVED") {
    const n = typeof e.count === "number" && e.count > 0 ? e.count : undefined;
    return n ? `observada em ${n} traço(s) de runtime` : "observada em runtime (OTel/Jaeger)";
  }
  const r = e.resolution;
  if (r === "compiler") return "resolvida pelo compilador (scip)";
  if (r === "syntactic-resolved") return "resolvida pelo SymbolSolver sobre a fonte do projeto (Engine A)";
  if (r === "interface-impl") return "resolvida por implementação de interface (compilador)";
  if (r === "type" || r === "import" || r === "exact" || r === "direct") return `resolvida estaticamente (${r})`;
  return "provada estaticamente pela fonte";
}

/** Proveniência humana pt-BR de uma aresta REFUTADA (grau honesto, ADR-0032 §4). */
function refutedProvenance(r: EdgeRefutation): string {
  const tries = r.attempts ? `${r.attempts} tentativa(s) dirigida(s)` : "tentativa(s) dirigida(s)";
  const wins = r.windows ? ` em ${r.windows} janela(s)` : "";
  if (r.subtype === "REFUTED_LIKELY_DEAD") {
    return `refutada pelo laço ativo (provável falso-positivo/código morto — ${tries}${wins}, pai exercitado sem gerá-la${r.reason ? `: ${r.reason}` : ""})`;
  }
  return `não-confirmada pelo robô — UNKNOWN honesto, NÃO é morta${r.reason ? ` (${r.reason})` : ""}`;
}

/**
 * Monta o subgrafo de narrativa de um símbolo. Puro.
 *
 * Passos: (1) partição/blindSpots/disclosure via `computeImpactConfidence`
 * (reuso — fonte única do raio e da honestidade); (2) raio = sementes ∪ afetados;
 * (3) recorta as arestas VERIFICADAS do grafo cujos DOIS extremos estão no raio
 * (a espinha andável); (4) filtra as ADR links aos símbolos presentes no raio.
 */
export function buildNarrativeSubgraph(
  graph: ShapedGraph | null | undefined,
  symbol: string,
  opts: BuildSubgraphOptions = {},
): NarrativeSubgraph {
  const conf = computeImpactConfidence(graph, symbol, opts.fallbackAffected ?? []);

  const base: NarrativeSubgraph = {
    symbol,
    symbolLocatedInGraph: conf.symbolLocatedInGraph,
    evidenceAvailable: conf.evidenceAvailable,
    edges: [],
    edgeIds: new Set<string>(),
    blindSpots: conf.blindSpots,
    blindSpotCount: conf.blindSpotCount,
    refutedEdges: [],
    refutedCount: 0,
    proven: conf.proven,
    possible: conf.possible,
    disclosure: conf.disclosure,
    overallConfidence: conf.overallConfidence,
    overallMethod: conf.overallMethod,
    ...(conf.coverage ? { coverage: conf.coverage } : {}),
    adrLinks: [],
  };

  const hasGraph = !!graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && graph.nodes.length > 0;
  if (!hasGraph || !conf.symbolLocatedInGraph) {
    // Sem grafo verificável para ESTE símbolo — a espinha andável é vazia (a
    // narrativa se abstém em P4.3). As ADR links ainda podem valer pelo símbolo.
    base.adrLinks = filterAdrLinks(opts.adrLinks, new Set(), symbol);
    return base;
  }

  const g = graph as ShapedGraph;
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));

  // raio = sementes (o que muda) ∪ afetados (proven ∪ possible). resolveSymbolSeeds
  // é a MESMA lógica que computeImpactConfidence usa por dentro (fonte única).
  const seeds = resolveSymbolSeeds(g, symbol);
  const radius = new Set<string>(seeds);
  for (const a of conf.proven) radius.add(a.id);
  for (const a of conf.possible) radius.add(a.id);

  // espinha ANDÁVEL: arestas VERIFICADAS com os dois extremos no raio. Dedup por
  // edgeId (compartilhado com o bucket refutado — uma aresta nunca cai nos dois).
  const seen = new Set<string>();
  for (const e of g.edges) {
    if (!radius.has(e.fromNode) || !radius.has(e.toNode)) continue;
    const edgeId = `${e.fromNode}|${e.toNode}|${e.relationType}`;
    if (seen.has(edgeId)) continue;
    const method: EvidenceMethod = e.evidence?.method ?? "UNKNOWN";
    const observed = method === "RUNTIME_OBSERVED";
    const fromN = byId.get(e.fromNode);
    const toN = byId.get(e.toNode);
    const facets = {
      relationType: e.relationType,
      fromType: fromN?.type ?? "UNKNOWN",
      toType: toN?.type ?? "UNKNOWN",
      fromSensitive: fromN?.sensitive === true,
      toSensitive: toN?.sensitive === true,
      ...(fromN?.layer ? { fromLayer: fromN.layer } : {}),
      ...(toN?.layer ? { toLayer: toN.layer } : {}),
      ...(fromN?.stack ? { fromStack: fromN.stack } : {}),
      ...(toN?.stack ? { toStack: toN.stack } : {}),
    };

    // P4.5 — REFUTADA pelo laço ativo: FORA da espinha andável (a narrativa
    // nunca a cita como fato). PROMOÇÃO VENCE REFUTAÇÃO: se a aresta foi
    // OBSERVADA em runtime, a refutação (mais antiga) é ignorada e ela sobe
    // para a espinha PROVADA (POSSÍVEL→PROVADO ao promover a RUNTIME_OBSERVED).
    if (e.refuted && !observed) {
      seen.add(edgeId);
      base.refutedEdges.push({
        edgeId,
        fromNode: e.fromNode,
        toNode: e.toNode,
        fromLabel: labelOf(fromN, e.fromNode),
        toLabel: labelOf(toN, e.toNode),
        method,
        subtype: e.refuted.subtype,
        ...(e.refuted.attempts !== undefined ? { attempts: e.refuted.attempts } : {}),
        ...(e.refuted.windows !== undefined ? { windows: e.refuted.windows } : {}),
        ...(e.refuted.reason ? { reason: e.refuted.reason } : {}),
        provenance: refutedProvenance(e.refuted),
        ...facets,
      });
      continue;
    }

    if (!WALKABLE_METHODS.has(method)) continue;
    seen.add(edgeId);
    base.edges.push({
      edgeId,
      fromNode: e.fromNode,
      toNode: e.toNode,
      fromLabel: labelOf(fromN, e.fromNode),
      toLabel: labelOf(toN, e.toNode),
      method,
      confidence: e.evidence?.confidence ?? (observed ? 0.95 : 0.8),
      ...(observed && typeof e.count === "number" && e.count > 0 ? { count: e.count } : {}),
      provenance: edgeProvenance(e),
      ...facets,
    });
  }
  // ordena por força (runtime antes de estático), depois por label — determinístico.
  base.edges.sort(
    (a, b) =>
      (b.method === "RUNTIME_OBSERVED" ? 1 : 0) - (a.method === "RUNTIME_OBSERVED" ? 1 : 0) ||
      b.confidence - a.confidence ||
      a.fromLabel.localeCompare(b.fromLabel) ||
      a.toLabel.localeCompare(b.toLabel),
  );
  base.edgeIds = new Set(base.edges.map((e) => e.edgeId));
  // refutadas: dead-candidate antes de UNKNOWN-honesto, depois por label — determinístico.
  base.refutedEdges.sort(
    (a, b) =>
      (a.subtype === "REFUTED_LIKELY_DEAD" ? 0 : 1) - (b.subtype === "REFUTED_LIKELY_DEAD" ? 0 : 1) ||
      a.fromLabel.localeCompare(b.fromLabel) ||
      a.toLabel.localeCompare(b.toLabel),
  );
  base.refutedCount = base.refutedEdges.length;

  // proveniência tácita: só as ADR links cujos símbolos aparecem no raio.
  const radiusLabels = new Set<string>();
  for (const id of radius) {
    const n = byId.get(id);
    if (n?.className) radiusLabels.add(n.className.toLowerCase());
    radiusLabels.add(labelOf(n, id).toLowerCase());
  }
  base.adrLinks = filterAdrLinks(opts.adrLinks, radiusLabels, symbol);

  return base;
}

/** Filtra as ligações ADR aos símbolos do raio (ou ao próprio símbolo consultado). */
function filterAdrLinks(links: AdrLink[] | undefined, radiusLabels: Set<string>, symbol: string): SubgraphAdrLink[] {
  if (!Array.isArray(links) || links.length === 0) return [];
  const sym = (symbol || "").trim().toLowerCase();
  const out: SubgraphAdrLink[] = [];
  const seen = new Set<string>();
  for (const l of links) {
    const t = (l.targetSymbol || "").toLowerCase();
    if (!t) continue;
    const relevant = radiusLabels.has(t) || t === sym;
    if (!relevant) continue;
    const k = `${l.adrId}|${l.targetSymbol}|${l.sourceRef}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      adrId: l.adrId,
      adrTitle: l.adrTitle,
      targetSymbol: l.targetSymbol,
      sourceRef: l.sourceRef,
      confidence: l.confidence,
    });
  }
  return out;
}

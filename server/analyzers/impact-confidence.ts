// ─────────────────────────────────────────────
// Impact confidence — ADR-0028 P4 (colheita do contrato epistêmico P0.1).
//
// A análise de impacto (impact-analyzer) responde "quem é afetado por mudar X?".
// Até aqui a resposta vinha como uma lista, COMO SE fosse completa. Esta camada
// aditiva colhe o contrato epistêmico que o `shapeSystemGraph` (P0.1) já emite —
// toda aresta declara `evidence:{method,confidence}` e o grafo tem `coverage` —
// e transforma a resposta em algo HONESTO:
//
//   • por afetado: o MÉTODO DE EVIDÊNCIA MAIS FRACO no caminho até ele (uma cadeia
//     só é tão confiável quanto seu elo mais fraco) + a confiança agregada;
//   • partição PROVEN (caminho todo RUNTIME_OBSERVED/STATIC_PROVEN) × POSSIBLE
//     (caminho passa por STATIC_UNRESOLVED/UNKNOWN);
//   • blindSpots: as arestas STATIC_UNRESOLVED/UNKNOWN que TOCAM o raio e podem
//     ESCONDER impacto adicional (dispatch dinâmico/DI que o estático não resolve);
//   • um `confidence` geral + um `disclosure` textual pt-BR que ADMITE onde é cego.
//
// Não é técnica nova — é reuso do que já está no ar. Puro, determinístico, sem I/O.
// Degrada honestamente: grafo ausente ou sem proveniência → tudo UNKNOWN, sem crashar.
// ─────────────────────────────────────────────

import type { ShapedGraph, ShapedEdge, EvidenceMethod, GraphCoverage } from "./system-graph";

/** Um alvo do raio de impacto, anotado com a força da evidência até ele. */
export interface AffectedNode {
  /** id do nó no systemGraph (class-level) OU chave sintética no modo degradado. */
  id: string;
  /** rótulo curto legível (className / "METHOD path" / nome de entidade). */
  label: string;
  type: string;
  /**
   * Método de evidência do ELO MAIS FRACO no melhor caminho seed→afetado.
   * Uma cadeia é tão confiável quanto seu elo mais fraco: se qualquer hop é
   * STATIC_UNRESOLVED, o alvo inteiro é "possível", não "provado".
   */
  weakestMethod: EvidenceMethod;
  /** Confiança do elo mais fraco (gargalo) no melhor caminho — 0..1. */
  confidence: number;
  /** nº de hops no caminho (0 = o próprio símbolo; afetados têm ≥1). */
  depth: number;
}

/** Uma aresta cega: não-resolvida/desconhecida, tocando o raio, capaz de esconder impacto. */
export interface BlindSpotEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  /** STATIC_UNRESOLVED | UNKNOWN — as duas classes que admitem que não sabemos. */
  method: EvidenceMethod;
  confidence: number;
  /** por que é ponto cego (dispatch dinâmico/DI × sem proveniência). */
  reason: string;
}

export interface ImpactConfidence {
  /** true quando o grafo carrega ≥1 aresta com método ≠ UNKNOWN (proveniência real). */
  evidenceAvailable: boolean;
  /** o símbolo resolveu para ≥1 nó do systemGraph (senão, raio veio do manifest). */
  symbolLocatedInGraph: boolean;
  /** confiança geral da resposta (piso do raio: tão forte quanto o afetado mais fraco). */
  overallConfidence: number;
  /** método de evidência mais fraco presente no raio (o piso epistêmico da resposta). */
  overallMethod: EvidenceMethod;
  /** afetados por CAMINHO TODO provado (RUNTIME_OBSERVED/STATIC_PROVEN). */
  proven: AffectedNode[];
  /** afetados cujo caminho passa por aresta não-resolvida/desconhecida. */
  possible: AffectedNode[];
  /** arestas não-resolvidas/desconhecidas que tocam o raio (podem esconder impacto). */
  blindSpots: BlindSpotEdge[];
  /** total de blind spots ANTES do cap de `blindSpots` (honestidade do truncamento). */
  blindSpotCount: number;
  /** frase pt-BR honesta: o que garanto, o que é possível, onde estou cego. */
  disclosure: string;
  /** censo epistêmico do grafo (ecoado de P0.1) quando disponível. */
  coverage?: GraphCoverage;
}

// Ranking dos métodos (mais forte = maior). Alimenta o "elo mais fraco".
const METHOD_RANK: Record<EvidenceMethod, number> = {
  UNKNOWN: 0,
  STATIC_UNRESOLVED: 1,
  LLM_CONJECTURED: 2,
  STATIC_PROVEN: 3,
  RUNTIME_OBSERVED: 4,
};
const PROVEN_TIER: ReadonlySet<EvidenceMethod> = new Set<EvidenceMethod>(["RUNTIME_OBSERVED", "STATIC_PROVEN"]);
const BLIND_METHODS: ReadonlySet<EvidenceMethod> = new Set<EvidenceMethod>(["STATIC_UNRESOLVED", "UNKNOWN"]);
const BLINDSPOT_CAP = 60;

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

/** Nome curto de uma classe a partir do id `TYPE:pkg.Classe` (ou já curto). */
function shortName(id: string): string {
  const afterColon = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  return afterColon.split(".").filter(Boolean).pop() || afterColon;
}

/** O nó do grafo casa o símbolo por igualdade de token? (não infla por substring) */
function nodeMatchesExact(node: { id: string; className?: string; methodName?: string }, sym: string): boolean {
  if (lc(node.className) === sym) return true;
  if (lc(node.methodName) === sym) return true;
  if (node.className && node.methodName && `${lc(node.className)}.${lc(node.methodName)}` === sym) return true;
  // nome curto do id (`TYPE:pkg.Classe` → `classe`; method-level `...Classe.m()` → `m()`)
  const short = lc(shortName(node.id));
  if (short === sym) return true;
  // símbolo qualificado `classe.metodo` casa contra className.methodName do nó
  if (node.className && node.methodName && sym.includes(".")) {
    return `${lc(node.className)}.${lc(node.methodName)}` === sym;
  }
  return false;
}

/** Fallback por substring (aproximado) — só quando nada resolveu exato. */
function nodeMatchesSubstring(node: { id: string; className?: string }, sym: string): boolean {
  return lc(node.className).includes(sym) || lc(shortName(node.id)).includes(sym);
}

/**
 * Resolve os nós-semente de um símbolo no grafo (exato; substring como fallback).
 * Extraído de `computeImpactConfidence` para ser reusado pelo subgrafo de
 * narrativa (ADR-0033 P4.1) — MESMA lógica de casamento, fonte única. Puro.
 */
export function resolveSymbolSeeds(
  graph: { nodes?: { id: string; className?: string; methodName?: string }[] } | null | undefined,
  symbol: string,
): Set<string> {
  const sym = (symbol || "").trim().toLowerCase();
  const seeds = new Set<string>();
  const nodes = graph?.nodes;
  if (!Array.isArray(nodes)) return seeds;
  for (const n of nodes) if (nodeMatchesExact(n, sym)) seeds.add(n.id);
  if (seeds.size === 0) {
    for (const n of nodes) if (nodeMatchesSubstring(n, sym)) seeds.add(n.id);
  }
  return seeds;
}

/** Motivo humano de um blind spot conforme o método. */
function blindReason(method: EvidenceMethod): string {
  if (method === "STATIC_UNRESOLVED") {
    return "aresta declarada por convenção/heurística (não provada) — dispatch dinâmico/DI pode esconder chamadores não mapeados";
  }
  return "aresta sem proveniência — a origem do vínculo é desconhecida, o raio pode estar incompleto";
}

/**
 * Widest-path (maximin) reverso: para cada nó, o melhor caminho seed→nó é o que
 * MAXIMIZA o gargalo (a confiança do elo mais fraco). Assim um alvo alcançável por
 * QUALQUER rota provada é "provado"; as arestas fracas viram blind spots à parte.
 *
 * Direção: as arestas do grafo são `from→to` (chamador→chamado, acessor→entidade).
 * "Quem é afetado por mudar X" ⇒ quem DEPENDE de X ⇒ percorre as arestas AO CONTRÁRIO
 * (to==X ⇒ from é afetado), transitivamente.
 */
function widestReverseReachability(
  edges: ShapedEdge[],
  seeds: Set<string>,
): Map<string, { conf: number; method: EvidenceMethod; depth: number }> {
  // adjacência reversa: toNode → [{ from, edge }]
  const rev = new Map<string, { from: string; edge: ShapedEdge }[]>();
  for (const e of edges) {
    const arr = rev.get(e.toNode) || [];
    arr.push({ from: e.fromNode, edge: e });
    rev.set(e.toNode, arr);
  }

  // best[node] = melhor gargalo conhecido (maior confiança-do-elo-mais-fraco).
  const best = new Map<string, { conf: number; method: EvidenceMethod; depth: number }>();
  // seeds: gargalo "infinito" (caminho vazio), depth 0 — não são "afetados".
  const SENTINEL: EvidenceMethod = "RUNTIME_OBSERVED";
  for (const s of seeds) best.set(s, { conf: Infinity, method: SENTINEL, depth: 0 });

  const finalized = new Set<string>();
  // Dijkstra-maximin por seleção linear (grafos class-level são pequenos).
  while (true) {
    let u: string | null = null;
    let uConf = -Infinity;
    for (const [id, v] of best) {
      if (finalized.has(id)) continue;
      if (v.conf > uConf) { uConf = v.conf; u = id; }
    }
    if (u === null) break;
    finalized.add(u);
    const cur = best.get(u)!;
    for (const { from, edge } of rev.get(u) || []) {
      if (finalized.has(from)) continue;
      // gargalo candidato = min(gargalo até u, confiança desta aresta).
      const edgeConf = edge.evidence?.confidence ?? 0.2;
      const edgeMethod: EvidenceMethod = edge.evidence?.method ?? "UNKNOWN";
      let candConf: number;
      let candMethod: EvidenceMethod;
      if (cur.conf <= edgeConf) {
        candConf = cur.conf === Infinity ? edgeConf : cur.conf;
        candMethod = cur.conf === Infinity ? edgeMethod : cur.method;
      } else {
        candConf = edgeConf;
        candMethod = edgeMethod;
      }
      const prev = best.get(from);
      if (!prev || candConf > prev.conf) {
        best.set(from, { conf: candConf, method: candMethod, depth: cur.depth + 1 });
      }
    }
  }
  // remove seeds (não são afetados — são o que você está mudando)
  for (const s of seeds) best.delete(s);
  return best;
}

/** Constrói a camada de confiança a partir do grafo já shaped (P0.1) + o símbolo. */
export function computeImpactConfidence(
  graph: ShapedGraph | null | undefined,
  symbol: string,
  fallbackAffected: AffectedNode[] = [],
): ImpactConfidence {
  const sym = (symbol || "").trim().toLowerCase();
  const hasGraph = !!graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges) && graph.nodes.length > 0;

  // Grafo ausente → modo degradado a partir do raio do manifest (tudo UNKNOWN).
  if (!hasGraph) {
    return degraded(fallbackAffected, /*evidenceAvailable*/ false, /*symbolInGraph*/ false, undefined);
  }
  const g = graph as ShapedGraph;
  const evidenceAvailable =
    g.coverage?.edges?.byMethod
      ? g.coverage.edges.total - (g.coverage.edges.byMethod.UNKNOWN || 0) > 0
      : g.edges.some((e) => (e.evidence?.method ?? "UNKNOWN") !== "UNKNOWN");

  // 1) resolve o símbolo para nós-semente (exato; substring como fallback).
  const seeds = resolveSymbolSeeds(g, sym);

  // Símbolo não localizado no grafo → raio vem do manifest, evidência indisponível
  // para ESTES alvos (honesto): possíveis/UNKNOWN, mas o censo do grafo é ecoado.
  if (seeds.size === 0) {
    return degraded(fallbackAffected, evidenceAvailable, /*symbolInGraph*/ false, g.coverage);
  }

  // 2) reachability reversa maximin → afetados anotados pelo elo mais fraco.
  const reached = widestReverseReachability(g.edges, seeds);
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
  const proven: AffectedNode[] = [];
  const possible: AffectedNode[] = [];
  for (const [id, r] of reached) {
    const node = byId.get(id);
    const affected: AffectedNode = {
      id,
      label: node?.className || shortName(id),
      type: node?.type || "UNKNOWN",
      weakestMethod: r.method,
      confidence: round2(r.conf),
      depth: r.depth,
    };
    (PROVEN_TIER.has(r.method) ? proven : possible).push(affected);
  }
  sortAffected(proven);
  sortAffected(possible);

  // 3) blind spots: arestas não-resolvidas/desconhecidas que TOCAM o raio.
  const radius = new Set<string>([...seeds, ...reached.keys()]);
  const blindAll: BlindSpotEdge[] = [];
  const seen = new Set<string>();
  for (const e of g.edges) {
    const method: EvidenceMethod = e.evidence?.method ?? "UNKNOWN";
    if (!BLIND_METHODS.has(method)) continue;
    if (!radius.has(e.fromNode) && !radius.has(e.toNode)) continue;
    const k = `${e.fromNode} ${e.toNode} ${e.relationType}`;
    if (seen.has(k)) continue;
    seen.add(k);
    blindAll.push({
      fromNode: e.fromNode,
      toNode: e.toNode,
      relationType: e.relationType,
      method,
      confidence: round2(e.evidence?.confidence ?? 0.2),
      reason: blindReason(method),
    });
  }
  // ordena por criticidade (UNKNOWN antes de STATIC_UNRESOLVED — mais cego primeiro)
  blindAll.sort((a, b) => METHOD_RANK[a.method] - METHOD_RANK[b.method] || a.fromNode.localeCompare(b.fromNode));
  const blindSpots = blindAll.slice(0, BLINDSPOT_CAP);

  // 4) confiança geral = piso do raio (elo mais fraco entre os afetados).
  const affectedAll = [...proven, ...possible];
  const overallConfidence = overallOf(affectedAll, seeds.size > 0, blindAll.length);
  const overallMethod = weakestMethodOf(affectedAll, blindAll);

  return {
    evidenceAvailable,
    symbolLocatedInGraph: true,
    overallConfidence,
    overallMethod,
    proven,
    possible,
    blindSpots,
    blindSpotCount: blindAll.length,
    disclosure: buildDisclosure({
      evidenceAvailable,
      symbolLocatedInGraph: true,
      proven,
      possible,
      blindSpotCount: blindAll.length,
      coverage: g.coverage,
    }),
    coverage: g.coverage,
  };
}

/** Modo degradado: raio veio do manifest (ou grafo ausente). Tudo UNKNOWN/possível. */
function degraded(
  fallbackAffected: AffectedNode[],
  evidenceAvailable: boolean,
  symbolInGraphFlag: boolean,
  coverage: GraphCoverage | undefined,
): ImpactConfidence {
  const possible: AffectedNode[] = fallbackAffected.map((a) => ({
    ...a,
    weakestMethod: "UNKNOWN" as EvidenceMethod,
    confidence: 0.2,
  }));
  sortAffected(possible);
  const overallConfidence = possible.length ? 0.2 : (symbolInGraphFlag ? 0.8 : 0);
  return {
    evidenceAvailable,
    symbolLocatedInGraph: symbolInGraphFlag,
    overallConfidence,
    overallMethod: "UNKNOWN",
    proven: [],
    possible,
    blindSpots: [],
    blindSpotCount: 0,
    disclosure: buildDisclosure({
      evidenceAvailable,
      symbolLocatedInGraph: symbolInGraphFlag,
      proven: [],
      possible,
      blindSpotCount: 0,
      coverage,
    }),
    ...(coverage ? { coverage } : {}),
  };
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.round(n * 100) / 100;
}

function sortAffected(list: AffectedNode[]): void {
  list.sort((a, b) => b.confidence - a.confidence || a.depth - b.depth || a.label.localeCompare(b.label));
}

/** Piso de confiança do raio: o afetado mais fraco (a resposta vale seu elo mais fraco). */
function overallOf(affected: AffectedNode[], seedsFound: boolean, blindCount: number): number {
  if (affected.length === 0) {
    // sem dependentes conhecidos: alta confiança SE não há arestas cegas tocando o símbolo.
    if (!seedsFound) return 0;
    return blindCount > 0 ? 0.4 : 0.9;
  }
  return round2(Math.min(...affected.map((a) => a.confidence)));
}

/** Método mais fraco presente no raio (entre afetados e blind spots). */
function weakestMethodOf(affected: AffectedNode[], blind: BlindSpotEdge[]): EvidenceMethod {
  let worst: EvidenceMethod = "RUNTIME_OBSERVED";
  let worstRank = METHOD_RANK[worst];
  const consider = (m: EvidenceMethod) => { if (METHOD_RANK[m] < worstRank) { worst = m; worstRank = METHOD_RANK[m]; } };
  for (const a of affected) consider(a.weakestMethod);
  for (const b of blind) consider(b.method);
  if (affected.length === 0 && blind.length === 0) return "STATIC_PROVEN"; // nada a dizer; neutro
  return worst;
}

/** Frase honesta pt-BR: garante × possível × cego. */
function buildDisclosure(x: {
  evidenceAvailable: boolean;
  symbolLocatedInGraph: boolean;
  proven: AffectedNode[];
  possible: AffectedNode[];
  blindSpotCount: number;
  coverage?: GraphCoverage;
}): string {
  const P = x.proven.length;
  const M = x.possible.length;
  const K = x.blindSpotCount;

  if (!x.evidenceAvailable) {
    const base = x.symbolLocatedInGraph
      ? "Este snapshot não carrega proveniência de evidência (grafo antigo): não posso distinguir impacto provado de conjecturado — trate TODO o raio como aproximado."
      : "Sem grafo de evidência para este símbolo (raio derivado só do manifest): não posso afirmar o impacto com confiança epistêmica.";
    return `${base} Re-rode a análise para popular o mapa epistêmico (P0.1) e obter garantias por rota.`;
  }

  const parts: string[] = [];
  if (P > 0) {
    const obs = x.proven.filter((a) => a.weakestMethod === "RUNTIME_OBSERVED").length;
    const stat = P - obs;
    const detail: string[] = [];
    if (obs) detail.push(`${obs} observada(s) em runtime`);
    if (stat) detail.push(`${stat} provada(s) estaticamente`);
    parts.push(`Posso garantir o impacto sobre ${P} alvo(s) por rota provada${detail.length ? ` (${detail.join(", ")})` : ""}.`);
  } else {
    parts.push("Não há nenhum alvo alcançável por rota inteiramente provada.");
  }
  if (M > 0) {
    parts.push(`Sobre ${M} alvo(s) a rota passa por aresta não-resolvida — impacto POSSÍVEL, não garantido.`);
  }
  if (K > 0) {
    parts.push(
      `Estou CEGO em ${K} aresta(s) não-resolvida(s)/desconhecida(s) que tocam o raio: dispatch dinâmico/DI pode esconder alvos adicionais que este raio NÃO mostra.`,
    );
  } else {
    parts.push("Nenhuma aresta cega toca o raio — o mapa não tem buracos conhecidos aqui.");
  }
  if (x.coverage) {
    const pct = Math.round((x.coverage.edges.observedRatio || 0) * 100);
    parts.push(`(Cobertura do grafo: ${pct}% das arestas observadas em runtime, ${x.coverage.edges.total} arestas no total.)`);
  }
  return parts.join(" ");
}

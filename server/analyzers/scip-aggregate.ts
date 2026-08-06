// ─────────────────────────────────────────────────────────────────────────
// ADR-0031 — Motor de Agregação SCIP→System-Graph.
//
// O deriver (`tools/scip-typescript/derive-edges.mjs`, ADR-0030) produz arestas
// call-graph COMPILER-ACCURATE em nível de SÍMBOLO (função→função):
//   { from: <scip symbol>, to: <scip symbol>, kind:'CALLS',
//     resolution:'compiler'|'interface-impl' }
// O system-graph do Manifest é em nível de SERVIÇO/ROTA/ENTIDADE. Este módulo
// faz a PONTE que faltava (P2.2→P2.5 da ADR-0028): agrega símbolo→nó-de-sistema
// (pela junção por ARQUIVO) e mescla as arestas provadas no `systemGraph` cru
// com `resolution:'compiler'`/'interface-impl' — que o `classifyEdgeEvidence`
// (system-graph.ts:210-224) já classifica como STATIC_PROVEN, sem código novo.
//
// PURO e testável (nenhum I/O). Espelha o `applyRuntimeOverlay`
// (runtime-overlay.ts:193-236): mescla evidência EXTERNA no grafo persistido,
// GATED + fail-soft (sem `scipEdges`, o `/graph` é byte-a-byte ao de hoje).
//
// A régua de honestidade (ADR-0031 §5): nunca inventar nó para símbolo órfão
// (util sem rota/entidade → aresta descartada); nunca colapsar `interface-impl`
// (K adapters → K arestas); intra-nó descartado (espelha o self-loop drop de
// system-graph.ts:383). O muro de Rice permanece: DI concreta / dispatch
// dinâmico / reflexão NÃO aparecem aqui — ficam com o RUNTIME_OBSERVED (ADR-0029).
// ─────────────────────────────────────────────────────────────────────────

import type { RawSystemNode, RawSystemGraph } from "./system-graph";

/** Aresta crua derivada pelo `derive-edges.mjs` (símbolo→símbolo). */
export interface ScipDerivedEdge {
  from: string;
  to: string;
  kind?: string;
  resolution: "compiler" | "interface-impl";
}

/** Payload que o CI POSTa em `/api/projects/:id/scip-edges`. */
export interface ScipEdgesPayload {
  tool?: string;
  schema?: string;
  counts?: unknown;
  edges: ScipDerivedEdge[];
  /** carimbo de ingestão (o servidor preenche). */
  ingestedAt?: string;
}

/** Aresta de SISTEMA agregada (nó→nó), pronta para mesclar no `systemGraph`. */
export interface AggregatedSystemEdge {
  fromNode: string;
  toNode: string;
  relationType: "CALLS";
  resolution: "compiler" | "interface-impl";
}

export interface MergeStats {
  /** arestas derivadas recebidas. */
  derived: number;
  /** arestas de sistema únicas após agregação (nó→nó, dedup). */
  aggregated: number;
  /** pares de nós cuja aresta crua foi PROMOVIDA a compiler/interface-impl. */
  upgraded: number;
  /** arestas de sistema NOVAS adicionadas. */
  added: number;
  /** símbolos cujo arquivo não casou nenhum nó → aresta descartada (§4.1). */
  orphanDropped: number;
  /** aresta intra-nó (mesmo nó nas duas pontas) → descartada (§4.2). */
  intraDropped: number;
}

// Extensões de arquivo TS/JS que um símbolo SCIP pode carregar.
const FILE_EXT = /\.(?:d\.ts|tsx?|mts|cts|jsx?)$/;
// Um símbolo SCIP local é `scip-typescript npm <pkg> <ver> <descritores>`, onde os
// descritores começam com o caminho: `seg/seg/`file.ext`/<Type>#<method>().`.
// Captura o prefixo de diretórios (sem crase) + o nome de arquivo em crases.
const SCIP_FILE_RE = /^((?:[^\s`/]+\/)*)`([^`]+)`/;

/**
 * Extrai o caminho de arquivo (relativo ao repo) embutido num símbolo SCIP.
 * Retorna null para símbolos sem arquivo (`local 0`, símbolos globais) ou cujo
 * componente em crases não é um arquivo TS/JS. NÃO filtra por pacote — símbolos
 * de pacotes externos (typescript, @types/node, clsx) produzem caminhos que não
 * casam nenhum nó do projeto e são naturalmente descartados no índice.
 */
export function fileOfScipSymbol(sym: string): string | null {
  if (typeof sym !== "string" || !sym.startsWith("scip-typescript ")) return null;
  const parts = sym.split(" ");
  if (parts.length < 5) return null;
  const descriptors = parts.slice(4).join(" ");
  const m = SCIP_FILE_RE.exec(descriptors);
  if (!m) return null;
  const file = m[1] + m[2]; // dir/ + nome-de-arquivo (sem crases)
  return FILE_EXT.test(file) ? file : null;
}

function sourceFileOf(n: RawSystemNode): string | undefined {
  const sf = n.metadata?.sourceFile;
  return typeof sf === "string" && sf ? sf : undefined;
}

/**
 * Índice `arquivo → nó de sistema` (ADR-0031 Pilar 1). Um arquivo pode sustentar
 * >1 nó (uma rota `route:M:/p` + o módulo `node:<file>`). Prioridade honesta —
 * granularidade por ARQUIVO (§4.1):
 *   1. o nó-módulo `node:<file>` (representação por-arquivo canônica);
 *   2. senão, um nó ENTITY (tabela por-arquivo);
 *   3. senão, se o arquivo tem EXATAMENTE UM nó, esse nó (rota/view isolada);
 *   4. senão (vários nós, nenhum módulo/entidade — ex.: N rotas por-endpoint no
 *      mesmo arquivo, sem linha para desambiguar) → NÃO indexa (ambíguo; a aresta
 *      será descartada em vez de mis-atribuída).
 */
export function buildFileNodeIndex(nodes: RawSystemNode[]): Map<string, string> {
  const byFile = new Map<string, RawSystemNode[]>();
  for (const n of nodes || []) {
    const sf = sourceFileOf(n);
    if (!sf) continue;
    const arr = byFile.get(sf);
    if (arr) arr.push(n);
    else byFile.set(sf, [n]);
  }
  const index = new Map<string, string>();
  for (const [file, arr] of byFile) {
    const moduleNode = arr.find((n) => n.id === `node:${file}`);
    if (moduleNode) { index.set(file, moduleNode.id); continue; }
    const entity = arr.find((n) => n.type === "ENTITY");
    if (entity) { index.set(file, entity.id); continue; }
    if (arr.length === 1) { index.set(file, arr[0].id); continue; }
    // ambíguo → não indexa
  }
  return index;
}

/**
 * Agregação símbolo→nó→aresta-de-sistema (ADR-0031 Pilar 2). Pura.
 * Para cada aresta derivada `A→B`: resolve o arquivo de A/B e o nó de sistema de
 * cada arquivo. Órfão (arquivo sem nó) ou intra-nó (mesmo nó) → descarta. Dedup
 * por par de nós; quando o MESMO par tem `compiler` e `interface-impl`,
 * `compiler` (resolução única, mais forte) prevalece.
 */
export function aggregateScipEdges(
  nodes: RawSystemNode[],
  derived: ScipDerivedEdge[],
): { edges: AggregatedSystemEdge[]; stats: Omit<MergeStats, "upgraded" | "added"> } {
  const fileIndex = buildFileNodeIndex(nodes);
  // Chave par-de-nós → melhor resolução vista (compiler > interface-impl).
  const best = new Map<string, "compiler" | "interface-impl">();
  let orphanDropped = 0;
  let intraDropped = 0;
  for (const e of derived || []) {
    if (!e || (e.resolution !== "compiler" && e.resolution !== "interface-impl")) continue;
    const fa = fileOfScipSymbol(e.from);
    const fb = fileOfScipSymbol(e.to);
    if (!fa || !fb) { orphanDropped++; continue; }
    const na = fileIndex.get(fa);
    const nb = fileIndex.get(fb);
    if (!na || !nb) { orphanDropped++; continue; }
    if (na === nb) { intraDropped++; continue; }
    const key = pairKey(na, nb);
    const prev = best.get(key);
    if (prev === "compiler") continue; // já é o mais forte
    if (prev === undefined || e.resolution === "compiler") best.set(key, e.resolution);
  }
  const edges: AggregatedSystemEdge[] = [];
  for (const [key, resolution] of best) {
    const [fromNode, toNode] = key.split(EDGE_SEP);
    edges.push({ fromNode, toNode, relationType: "CALLS", resolution });
  }
  return { edges, stats: { derived: (derived || []).length, aggregated: edges.length, orphanDropped, intraDropped } };
}

// Ids de nó não contêm o separador (são `node:<path>` / `route:M:/p` / `table:x`).
const EDGE_SEP = "\t";
function pairKey(from: string, to: string, rel = "CALLS"): string {
  return `${from}${EDGE_SEP}${to}${EDGE_SEP}${rel}`;
}

/**
 * Mescla as arestas provadas no `systemGraph` cru (ADR-0031 Pilar 3, opção "na
 * leitura"). NÃO muta a entrada — opera sobre um CLONE (o snapshot em memória é
 * intocado). Para cada par de nós provado:
 *   - PROMOVE **todas** as arestas cruas CALLS que casam o par (seta
 *     `metadata.resolution`, remove `metadata.synthetic`) — o `shapeClassLevel`
 *     mantém a 1ª aresta vista por par (system-graph.ts:384), então promover só
 *     uma poderia perder a promoção com arestas duplicadas (node-chain);
 *   - senão → ADICIONA aresta nova com `metadata.resolution`.
 * O `shapeSystemGraph` posterior classifica/rola/conta sem mudança (Pilar 4).
 */
export function mergeScipEdges(
  rawGraph: RawSystemGraph,
  payload: ScipEdgesPayload | null | undefined,
): { graph: RawSystemGraph; stats: MergeStats } {
  const zero: MergeStats = { derived: 0, aggregated: 0, upgraded: 0, added: 0, orphanDropped: 0, intraDropped: 0 };
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) {
    return { graph: rawGraph, stats: zero };
  }
  const derived = payload?.edges;
  if (!Array.isArray(derived) || derived.length === 0) {
    return { graph: rawGraph, stats: zero };
  }
  // clone defensivo (não mutar o snapshot persistido/cacheado)
  const graph: RawSystemGraph = {
    ...rawGraph,
    nodes: rawGraph.nodes,
    edges: rawGraph.edges.map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : e.metadata })),
  };
  const { edges: aggregated, stats: aggStats } = aggregateScipEdges(graph.nodes, derived);

  // Resolução provada por par de nós (relationType CALLS).
  const provenByKey = new Map<string, "compiler" | "interface-impl">();
  for (const a of aggregated) provenByKey.set(pairKey(a.fromNode, a.toNode, a.relationType), a.resolution);

  // Promove TODAS as arestas cruas que casam um par provado; conta pares únicos.
  const upgradedKeys = new Set<string>();
  for (const e of graph.edges) {
    const key = pairKey(e.fromNode, e.toNode, e.relationType);
    const res = provenByKey.get(key);
    if (!res) continue;
    const md = (e.metadata || {}) as Record<string, unknown>;
    md.resolution = res;
    delete md.synthetic; // deixa de ser DECLARADA — agora é PROVADA
    md.scipProven = true;
    e.metadata = md;
    upgradedKeys.add(key);
  }

  // Adiciona arestas novas para pares provados sem aresta CALLS crua.
  let added = 0;
  for (const [key, res] of provenByKey) {
    if (upgradedKeys.has(key)) continue;
    const [fromNode, toNode, relationType] = key.split(EDGE_SEP);
    graph.edges.push({ fromNode, toNode, relationType, metadata: { resolution: res, scipProven: true } });
    added++;
  }
  return { graph, stats: { ...aggStats, upgraded: upgradedKeys.size, added } };
}

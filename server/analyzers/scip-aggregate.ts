// ─────────────────────────────────────────────────────────────────────────
// ADR-0031 — Motor de Agregação SCIP→System-Graph (A5: granularidade de FUNÇÃO).
//
// O deriver (`tools/scip-typescript/derive-edges.mjs`, ADR-0030) produz arestas
// call-graph COMPILER-ACCURATE em nível de SÍMBOLO (função→função):
//   { from: <scip symbol>, to: <scip symbol>, kind:'CALLS',
//     resolution:'compiler'|'interface-impl' }
// O system-graph do Manifest é em nível de SERVIÇO/ROTA/ENTIDADE. Este módulo
// faz a PONTE que faltava (P2.2→P2.5 da ADR-0028): agrega símbolo→nó-de-sistema
// e mescla as arestas provadas no `systemGraph` cru com `resolution:'compiler'`/
// 'interface-impl' — que o `classifyEdgeEvidence` (system-graph.ts:210-224) já
// classifica como STATIC_PROVEN, sem tocar a classificação/rollup/censo.
//
// A5 (esta versão) — GRANULARIDADE DE FUNÇÃO. O motor original (PR #128) casava
// símbolo→nó por ARQUIVO, colapsando a agregação a arquivo→arquivo: das 7.327
// arestas provadas do NuPIdentify, 138 caíam como "intra-nó" (duas funções do
// MESMO arquivo, indistinguíveis quando o nó é `node:<file>`) e só 14 pares
// arquivo→arquivo sobravam. Agora o nó-módulo `node:<file>` ganha SUB-NÓS de
// FUNÇÃO `node:<file>::<fn>` (o símbolo SCIP embute arquivo E função). A
// agregação resolve função→função: as 138 intra-nó viram arestas provadas
// legítimas + os pares arquivo→arquivo se abrem por função. O STATIC_PROVEN
// do censo sobe de 14 para 165 (medido no NuPIdentify). Os sub-nós de função
// são paren-free por construção (o sufixo `().` do símbolo é removido), então o
// `classKeyOf` (system-graph.ts:279) os trata ATOMICAMENTE (id sem `(` → é a
// própria "classe") — ZERO mudança em system-graph.ts.
//
// PURO e testável (nenhum I/O). Espelha o `applyRuntimeOverlay`
// (runtime-overlay.ts:193-236): mescla evidência EXTERNA no grafo persistido,
// GATED + fail-soft (sem `scipEdges`, o `/graph` é byte-a-byte ao de hoje).
//
// A régua de honestidade (ADR-0031 §5) permanece: NUNCA inventar nó para
// símbolo cujo arquivo não sustenta um nó de sistema (util puro sem
// rota/entidade → aresta descartada — só se refina o que JÁ é arquitetura);
// nunca colapsar `interface-impl` (K adapters → K arestas); auto-chamada
// (mesma função nas duas pontas) descartada. O muro de Rice permanece: DI
// concreta / dispatch dinâmico / reflexão NÃO aparecem aqui — ficam com o
// RUNTIME_OBSERVED (ADR-0029).
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

/**
 * Sub-nó de FUNÇÃO a materializar sob um nó-módulo (`node:<file>`). Só existe
 * porque o SCIP PROVOU uma chamada resolvida pelo checker que o toca — não é nó
 * inventado (§5). Carrega proveniência de arquivo + rótulo curto para a tela.
 */
export interface FunctionNodeSpec {
  id: string;
  parentModule: string;
  sourceFile: string;
  label: string;
  type: string;
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
  /** sub-nós de função materializados no grafo (A5). */
  functionNodesAdded: number;
  /** símbolos cujo arquivo não casou nenhum nó → aresta descartada (§4.1). */
  orphanDropped: number;
  /** auto-chamada (mesma função/nó nas duas pontas) → descartada (§4.2). */
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
  const r = symbolFileAndFn(sym);
  return r ? r.file : null;
}

/**
 * Extrai `{ file, fn }` de um símbolo SCIP (A5). `fn` é o descritor da FUNÇÃO/
 * método após o nome de arquivo, PAREN-FREE (o sufixo de chamada `().` do SCIP é
 * removido) — garante que o id de sub-nó `node:<file>::<fn>` não contenha `(`, e
 * o `classKeyOf` (system-graph.ts) o trate como nó atômico sem mudança de código.
 * Símbolo sem descritor de função (só o arquivo) → `fn = '<module>'`.
 */
export function functionOfScipSymbol(sym: string): { file: string; fn: string } | null {
  return symbolFileAndFn(sym);
}

function symbolFileAndFn(sym: string): { file: string; fn: string } | null {
  if (typeof sym !== "string" || !sym.startsWith("scip-typescript ")) return null;
  const parts = sym.split(" ");
  if (parts.length < 5) return null;
  const descriptors = parts.slice(4).join(" ");
  const m = SCIP_FILE_RE.exec(descriptors);
  if (!m) return null;
  const file = m[1] + m[2]; // dir/ + nome-de-arquivo (sem crases)
  if (!FILE_EXT.test(file)) return null;
  const fn = normalizeFn(descriptors.slice(m[0].length));
  return { file, fn };
}

/**
 * Normaliza o descritor de função do SCIP num rótulo estável e paren-free:
 *   `/cn().`                          → `cn`
 *   `/ErrorBoundary#componentDidCatch().` → `ErrorBoundary#componentDidCatch`
 *   `` (vazio — símbolo do arquivo)   → `<module>`
 * Remove separador inicial `/`, o sufixo de chamada `()`/`().`, crases residuais
 * e espaços. O resultado NUNCA contém `(` (invariante do id de sub-nó).
 */
function normalizeFn(tail: string): string {
  let s = (tail || "").replace(/^\//, "").replace(/`/g, "").trim();
  s = s.replace(/\(\)\.?$/, ""); // sufixo de chamada `()` ou `().`
  s = s.replace(/[()]/g, ""); // defesa: qualquer `(`/`)` remanescente
  return s || "<module>";
}

function sourceFileOf(n: RawSystemNode): string | undefined {
  const sf = n.metadata?.sourceFile;
  return typeof sf === "string" && sf ? sf : undefined;
}

/**
 * Índice `arquivo → nó de sistema` (ADR-0031 Pilar 1). Um arquivo pode sustentar
 * >1 nó (uma rota `route:M:/p` + o módulo `node:<file>`). Prioridade honesta:
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
 * Índice `id do nó-módulo → tipo` (para herdar o tipo no sub-nó de função).
 * Só nós `node:<file>` (SERVICE/REPOSITORY runtime=node) sustentam função.
 */
function moduleTypeIndex(nodes: RawSystemNode[]): Map<string, string> {
  const t = new Map<string, string>();
  for (const n of nodes || []) if (n.id.startsWith("node:")) t.set(n.id, n.type);
  return t;
}

/**
 * Resolve o id do NÓ-DE-ENDPOINT de um símbolo (A5). Se o arquivo do símbolo
 * mapeia um nó-MÓDULO (`node:<file>`), refina para o SUB-NÓ DE FUNÇÃO
 * `node:<file>::<fn>` (registrando a spec do sub-nó). Se mapeia um nó COARSE
 * (rota/entidade — que não tem "função" no sentido de arquitetura), usa o nó
 * como está. Símbolo cujo arquivo não sustenta nó → null (órfão, §5).
 */
function resolveEndpoint(
  parsed: { file: string; fn: string },
  fileIndex: Map<string, string>,
  moduleTypes: Map<string, string>,
  fnNodes: Map<string, FunctionNodeSpec>,
): string | null {
  const nodeId = fileIndex.get(parsed.file);
  if (!nodeId) return null;
  if (!nodeId.startsWith("node:")) return nodeId; // coarse (rota/entidade): sem função
  const id = `${nodeId}::${parsed.fn}`;
  if (!fnNodes.has(id)) {
    fnNodes.set(id, {
      id,
      parentModule: nodeId,
      sourceFile: parsed.file,
      label: parsed.fn,
      type: moduleTypes.get(nodeId) || "SERVICE",
    });
  }
  return id;
}

/**
 * Agregação símbolo→nó→aresta-de-sistema em granularidade de FUNÇÃO (Pilar 2,
 * A5). Pura. Para cada aresta derivada `A→B`: resolve o endpoint de A/B (sub-nó
 * de função sob o módulo, ou nó coarse). Órfão (arquivo sem nó) ou auto-chamada
 * (mesmo endpoint) → descarta. Dedup por par de endpoints; quando o MESMO par
 * tem `compiler` e `interface-impl`, `compiler` (resolução única) prevalece.
 * Retorna também as specs dos sub-nós de função a materializar no merge.
 */
export function aggregateScipEdges(
  nodes: RawSystemNode[],
  derived: ScipDerivedEdge[],
): {
  edges: AggregatedSystemEdge[];
  functionNodes: FunctionNodeSpec[];
  stats: Omit<MergeStats, "upgraded" | "added" | "functionNodesAdded">;
} {
  const fileIndex = buildFileNodeIndex(nodes);
  const moduleTypes = moduleTypeIndex(nodes);
  const fnNodes = new Map<string, FunctionNodeSpec>();
  // Chave par-de-endpoints → melhor resolução vista (compiler > interface-impl).
  const best = new Map<string, "compiler" | "interface-impl">();
  let orphanDropped = 0;
  let intraDropped = 0;
  for (const e of derived || []) {
    if (!e || (e.resolution !== "compiler" && e.resolution !== "interface-impl")) continue;
    const pa = functionOfScipSymbol(e.from);
    const pb = functionOfScipSymbol(e.to);
    if (!pa || !pb) { orphanDropped++; continue; }
    const na = resolveEndpoint(pa, fileIndex, moduleTypes, fnNodes);
    const nb = resolveEndpoint(pb, fileIndex, moduleTypes, fnNodes);
    if (!na || !nb) { orphanDropped++; continue; }
    if (na === nb) { intraDropped++; continue; }
    const key = pairKey(na, nb);
    const prev = best.get(key);
    if (prev === "compiler") continue; // já é o mais forte
    if (prev === undefined || e.resolution === "compiler") best.set(key, e.resolution);
  }
  const edges: AggregatedSystemEdge[] = [];
  const usedNodes = new Set<string>();
  for (const [key, resolution] of best) {
    const [fromNode, toNode] = key.split(EDGE_SEP);
    edges.push({ fromNode, toNode, relationType: "CALLS", resolution });
    usedNodes.add(fromNode);
    usedNodes.add(toNode);
  }
  // só materializa o sub-nó de função que participa de ao menos 1 aresta final
  // (o dedup pode ter descartado a única aresta que o tocava via auto-chamada).
  const functionNodes: FunctionNodeSpec[] = [];
  for (const spec of fnNodes.values()) if (usedNodes.has(spec.id)) functionNodes.push(spec);
  return {
    edges,
    functionNodes,
    stats: { derived: (derived || []).length, aggregated: edges.length, orphanDropped, intraDropped },
  };
}

// Ids de nó não contêm o separador (são `node:<path>` / `route:M:/p` / `table:x`).
const EDGE_SEP = "\t";
function pairKey(from: string, to: string, rel = "CALLS"): string {
  return `${from}${EDGE_SEP}${to}${EDGE_SEP}${rel}`;
}

/**
 * Mescla as arestas provadas no `systemGraph` cru (ADR-0031 Pilar 3, opção "na
 * leitura"). NÃO muta a entrada — opera sobre um CLONE (o snapshot em memória é
 * intocado). A5:
 *   - MATERIALIZA os sub-nós de função `node:<file>::<fn>` que aparecem nas
 *     arestas provadas (paren-free → o `classKeyOf` os trata atômicos);
 *   - PROMOVE **todas** as arestas cruas CALLS que casam um par provado (seta
 *     `metadata.resolution`, remove `metadata.synthetic`) — cobre o caso coarse
 *     (rota/entidade) em que já havia aresta declarada;
 *   - senão → ADICIONA aresta nova com `metadata.resolution` (o caso comum das
 *     arestas função→função, que não existiam no grafo cru).
 * O `shapeSystemGraph` posterior classifica/rola/conta sem mudança (Pilar 4).
 */
export function mergeScipEdges(
  rawGraph: RawSystemGraph,
  payload: ScipEdgesPayload | null | undefined,
): { graph: RawSystemGraph; stats: MergeStats } {
  const zero: MergeStats = { derived: 0, aggregated: 0, upgraded: 0, added: 0, functionNodesAdded: 0, orphanDropped: 0, intraDropped: 0 };
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) {
    return { graph: rawGraph, stats: zero };
  }
  const derived = payload?.edges;
  if (!Array.isArray(derived) || derived.length === 0) {
    return { graph: rawGraph, stats: zero };
  }
  const { edges: aggregated, functionNodes, stats: aggStats } = aggregateScipEdges(rawGraph.nodes, derived);
  if (aggregated.length === 0) {
    return { graph: rawGraph, stats: { ...aggStats, upgraded: 0, added: 0, functionNodesAdded: 0 } };
  }
  // clone defensivo (não mutar o snapshot persistido/cacheado)
  const graph: RawSystemGraph = {
    ...rawGraph,
    nodes: rawGraph.nodes.slice(),
    edges: rawGraph.edges.map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : e.metadata })),
  };

  // MATERIALIZA os sub-nós de função ausentes (A5). Sub-nó carrega proveniência
  // de arquivo + rótulo curto + `scipProven` (existe porque o checker o provou).
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  let functionNodesAdded = 0;
  for (const spec of functionNodes) {
    if (existingIds.has(spec.id)) continue;
    existingIds.add(spec.id);
    graph.nodes.push({
      id: spec.id,
      type: spec.type,
      className: spec.label,
      metadata: {
        sourceFile: spec.sourceFile,
        runtime: "node",
        scipProven: true,
        parentModule: spec.parentModule,
        function: spec.label,
      },
    });
    functionNodesAdded++;
  }

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

  // Adiciona arestas novas para pares provados sem aresta CALLS crua (o caso
  // comum de A5: as arestas função→função não existiam no grafo cru).
  let added = 0;
  for (const [key, res] of provenByKey) {
    if (upgradedKeys.has(key)) continue;
    const [fromNode, toNode, relationType] = key.split(EDGE_SEP);
    graph.edges.push({ fromNode, toNode, relationType, metadata: { resolution: res, scipProven: true } });
    added++;
  }
  return { graph, stats: { ...aggStats, upgraded: upgradedKeys.size, added, functionNodesAdded } };
}

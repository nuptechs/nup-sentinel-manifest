// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 §4 — Motor de Agregação CONFIG→System-Graph (o CONSUMIDOR da camada
// CONFIG_PROVEN que faltava; irmão do `scip-aggregate.ts`).
//
// O resolvedor `config-proven` do repo-alvo (easynup PR #1403,
// `scripts/config-proven/derive-config-edges.mjs`) lê o WIRING do Spring em
// `src/main/java` — SEM runtime, SEM LLM — e emite as arestas interface→impl cuja
// resolução o container torna DETERMINÍSTICA (1 bean concreto, ou @Primary
// desempatando). POSTa em `/config-edges` (store lateral `projects.configEdges`,
// separado das `scipEdges`). Este módulo faz a PONTE que faltava: agrega
// FQN-de-tipo → nó-de-sistema e mescla as arestas provadas no `systemGraph` cru
// com `resolution:'config'` — que o `classifyEdgeEvidence` (system-graph.ts) agora
// classifica como CONFIG_PROVEN, sem tocar o rollup/censo.
//
// IDENTIDADE (agnóstica à forma). O `derive-config-edges.mjs` POSTa em DUAS formas,
// conforme rode com/sem `--scip-json`:
//   1) FQN pontuado (o que o CI POSTa hoje — sem `--scip-json`):
//        { from:'easynup.services.x.MyPort', to:'easynup...impl.MyAdapter',
//          kind:'DI_RESOLVES', resolution:'config', reason:'spring-single-bean' }
//   2) símbolo scip-java de TIPO (com `--scip-json`), preservando o FQN:
//        { from:'scip-java maven … easynup/services/x/MyPort#', fromFqn:'easynup…MyPort', … }
// O `typeFqnOfConfigEndpoint` resolve o FQN em ambas (usa `fromFqn`/`toFqn` quando
// presentes; senão extrai o descritor de tipo do símbolo; senão trata o próprio
// endpoint como FQN pontuado). O nó Java do Engine A tem id `<STEREOTYPE>:<FQN>`
// (`SERVICE:easynup.services.x.MyPort`) — o `buildFqnNodeIndex` casa por FQN.
//
// Granularidade de CLASSE: DI é class→class por natureza (interface→impl), então —
// ao contrário do scip (que abre sub-nós de FUNÇÃO) — NÃO materializamos nós novos;
// só ligamos nós de classe que JÁ existem no grafo.
//
// PURO e testável (nenhum I/O). Espelha o `mergeScipEdges`: mescla evidência EXTERNA
// no grafo persistido, GATED + fail-soft (sem `configEdges`, o `/graph` é byte-a-byte).
//
// A régua de honestidade (ADR-0031 §5, herdada): NUNCA inventar nó — FQN cujo tipo
// não sustenta um nó de sistema (interface de lib, impl fora do escopo parseado) →
// aresta DESCARTADA (só se refina o que JÁ é arquitetura); auto-referência (mesmo
// nó nas duas pontas) descartada.
//
// PRECEDÊNCIA scip > config: o scip é compiler-accurate; a config é prova de
// wiring. Se o par de nós JÁ tem uma aresta STATIC_PROVEN (scip), NÃO emitimos uma
// aresta CONFIG_PROVEN concorrente e mais fraca para ele (não rebaixa, não duplica).
// ─────────────────────────────────────────────────────────────────────────

import type { RawSystemNode, RawSystemGraph, RawSystemEdge } from "./system-graph";
import { classKeyOf, PRECISE_RESOLUTIONS } from "./system-graph";

/** Aresta crua emitida pelo `derive-config-edges.mjs` (FQN→FQN ou símbolo→símbolo). */
export interface ConfigDerivedEdge {
  from: string;
  to: string;
  kind?: string;
  resolution: "config";
  reason?: string;
  /**
   * FQN pontuado de cada ponta, preservado pelo resolvedor quando ele faz o
   * upgrade dos FQN para símbolos scip-java (`--scip-json`). Quando presentes, são
   * a identidade canônica (mais barata que reparsear o símbolo).
   */
  fromFqn?: string;
  toFqn?: string;
  /**
   * ADR-0035 F1 — arquivo-fonte, se um dia o resolvedor os fornecer. HOJE o
   * config-edge é FQN-based (não file-based), então IGNORADOS no mapeamento (o FQN
   * é canônico). Aceitos e tolerados para não quebrar um payload que os carregue.
   */
  fromFile?: string;
  toFile?: string;
}

/** Payload que o CI POSTa em `/api/projects/:id/config-edges`. */
export interface ConfigEdgesPayload {
  tool?: string;
  schema?: string;
  counts?: unknown;
  edges: ConfigDerivedEdge[];
  ingestedAt?: string;
}

/** Aresta de SISTEMA agregada (nó→nó), pronta para mesclar no `systemGraph`. */
export interface AggregatedConfigEdge {
  fromNode: string;
  toNode: string;
  relationType: "DI_RESOLVES";
  resolution: "config";
  reason?: string;
}

export interface ConfigMergeStats {
  /** arestas derivadas recebidas. */
  derived: number;
  /** arestas de sistema únicas após agregação (nó→nó, dedup). */
  aggregated: number;
  /** arestas de sistema NOVAS adicionadas. */
  added: number;
  /** arestas DI cruas já presentes que foram PROMOVIDAS a `resolution:'config'`. */
  upgraded: number;
  /** pares já provados por scip (STATIC_PROVEN) → aresta config NÃO emitida. */
  supersededByScip: number;
  /** FQN cujo tipo não casou nenhum nó → aresta descartada (§5). */
  orphanDropped: number;
  /** auto-referência (mesmo nó nas duas pontas) → descartada. */
  intraDropped: number;
}

const RELATION = "DI_RESOLVES" as const;
// Um símbolo SCIP com pacote é `scip-<lang> <manager> <pkg> <ver> <descritores>`.
const SCIP_SCHEME_RE = /^scip-[a-z0-9]+ /;
// Descritor de TIPO Java no SCIP: `<seg>/<seg>/…/<Class>#` (segmentos por `/`,
// tipo termina em `#`). Espelha o `buildFqnToScipSymbol` do resolvedor (easynup).
const TYPE_DESC_RE = /((?:[\w$]+\/)+[\w$.]+)#/;

/** Resoluções que representam prova STATIC_PROVEN do scip (precedência sobre config). */
const SCIP_PROVEN_RESOLUTIONS = PRECISE_RESOLUTIONS;

/**
 * Resolve o FQN de TIPO pontuado de um endpoint de config-edge, agnóstico à forma
 * (ADR-0035 §4). Ordem de confiança:
 *   1. `fqnHint` (`fromFqn`/`toFqn`) — o resolvedor já o preservou;
 *   2. símbolo scip-java (`scip-… <pkg>/<Class>#`) → extrai o tipo e `/`→`.`;
 *   3. FQN pontuado cru (o caso do CI hoje) → usado direto.
 * Retorna null para entrada vazia/sem descritor de tipo. Nunca lança.
 */
export function typeFqnOfConfigEndpoint(sym: string, fqnHint?: string | null): string | null {
  if (typeof fqnHint === "string" && fqnHint.trim()) return fqnHint.trim();
  if (typeof sym !== "string" || !sym.trim()) return null;
  const s = sym.trim();
  if (SCIP_SCHEME_RE.test(s)) {
    const parts = s.split(" ");
    if (parts.length < 5) return null;
    const descriptors = parts.slice(4).join(" ");
    const m = TYPE_DESC_RE.exec(descriptors);
    if (!m) return null;
    return m[1].replace(/\//g, ".");
  }
  // FQN pontuado cru (ou qualquer identificador de tipo) — identidade direta.
  return s;
}

/** FQN a partir da chave de classe (`STEREOTYPE:pkg.Class` → `pkg.Class`). */
function fqnOfClassKey(classKey: string): string {
  const i = classKey.indexOf(":");
  return i >= 0 ? classKey.slice(i + 1) : classKey;
}

/**
 * Índice `FQN-de-tipo → id de nó REAL` (o nó de CLASSE, preferido; senão um membro
 * existente). Usar um id que EXISTE no grafo garante que a aresta mesclada
 * sobreviva tanto ao shape method-level (ambas as pontas têm de ser nós) quanto ao
 * class-level (o `keyOf` mapeia o membro → chave de classe). Um FQN pode reduzir de
 * vários nós (a classe + seus métodos): o nó de classe (id sem `.metodo(...)`) vence.
 */
export function buildFqnNodeIndex(nodes: RawSystemNode[]): Map<string, string> {
  const index = new Map<string, string>();
  const hasBareClass = new Set<string>();
  for (const n of nodes || []) {
    if (!n || typeof n.id !== "string") continue;
    const ck = classKeyOf(n.id);
    const fqn = fqnOfClassKey(ck);
    if (!fqn) continue;
    if (n.id === ck) {
      // nó de CLASSE (id === chave de classe) — a melhor representação por-FQN.
      index.set(fqn, n.id);
      hasBareClass.add(fqn);
    } else if (!hasBareClass.has(fqn) && !index.has(fqn)) {
      // fallback: um membro real (colapsa para a classe no rollup class-level).
      index.set(fqn, n.id);
    }
  }
  return index;
}

// Ids de nó não contêm o separador (são `STEREOTYPE:pkg.Class` / `node:<path>`…).
const EDGE_SEP = "\t";
function pairKey(from: string, to: string, rel: string): string {
  return `${from}${EDGE_SEP}${to}${EDGE_SEP}${rel}`;
}
/** Chave direcional de PAR de nós (ignora relationType) — para a precedência scip. */
function dirKey(from: string, to: string): string {
  return `${from}${EDGE_SEP}${to}`;
}

/**
 * Agregação FQN→nó→aresta-de-sistema (nível de CLASSE). Pura. Para cada aresta
 * config `A→B`: resolve o nó de A/B via FQN. Órfão (FQN sem nó) ou auto-referência
 * (mesmo nó) → descarta. Dedup por par de nós (mantém a 1ª razão vista).
 */
export function aggregateConfigEdges(
  nodes: RawSystemNode[],
  derived: ConfigDerivedEdge[],
): { edges: AggregatedConfigEdge[]; stats: Omit<ConfigMergeStats, "added" | "upgraded" | "supersededByScip"> } {
  const fqnIndex = buildFqnNodeIndex(nodes);
  const best = new Map<string, AggregatedConfigEdge>();
  let orphanDropped = 0;
  let intraDropped = 0;
  for (const e of derived || []) {
    if (!e || e.resolution !== "config") continue;
    const fromFqn = typeFqnOfConfigEndpoint(e.from, e.fromFqn);
    const toFqn = typeFqnOfConfigEndpoint(e.to, e.toFqn);
    if (!fromFqn || !toFqn) { orphanDropped++; continue; }
    const na = fqnIndex.get(fromFqn);
    const nb = fqnIndex.get(toFqn);
    if (!na || !nb) { orphanDropped++; continue; }
    if (na === nb) { intraDropped++; continue; }
    const key = pairKey(na, nb, RELATION);
    if (best.has(key)) continue; // dedup — 1ª aresta vence (razão idêntica por par)
    best.set(key, {
      fromNode: na,
      toNode: nb,
      relationType: RELATION,
      resolution: "config",
      ...(typeof e.reason === "string" && e.reason ? { reason: e.reason } : {}),
    });
  }
  const edges = Array.from(best.values());
  return { edges, stats: { derived: (derived || []).length, aggregated: edges.length, orphanDropped, intraDropped } };
}

/**
 * Mescla as arestas config no `systemGraph` cru (opção "na leitura", como o scip).
 * NÃO muta a entrada — opera sobre um CLONE. Para cada par de nós provado por
 * config:
 *   - se o par JÁ tem uma aresta STATIC_PROVEN (scip: `scipProven` ou resolução
 *     precisa) → SUPRIME (precedência scip > config; nunca rebaixa nem duplica);
 *   - senão, se já existe uma aresta DI_RESOLVES crua para o par → PROMOVE
 *     (seta `resolution:'config'` + `configProven`, remove `synthetic`);
 *   - senão → ADICIONA aresta DI_RESOLVES nova com `resolution:'config'`.
 * O `shapeSystemGraph` posterior classifica como CONFIG_PROVEN (0.78) e conta no
 * censo `coverage.byMethod.CONFIG_PROVEN` sem mudança.
 */
export function mergeConfigEdges(
  rawGraph: RawSystemGraph,
  payload: ConfigEdgesPayload | null | undefined,
): { graph: RawSystemGraph; stats: ConfigMergeStats } {
  const zero: ConfigMergeStats = { derived: 0, aggregated: 0, added: 0, upgraded: 0, supersededByScip: 0, orphanDropped: 0, intraDropped: 0 };
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) {
    return { graph: rawGraph, stats: zero };
  }
  const derived = payload?.edges;
  if (!Array.isArray(derived) || derived.length === 0) {
    return { graph: rawGraph, stats: zero };
  }
  const { edges: aggregated, stats: aggStats } = aggregateConfigEdges(rawGraph.nodes, derived);
  if (aggregated.length === 0) {
    return { graph: rawGraph, stats: { ...aggStats, added: 0, upgraded: 0, supersededByScip: 0 } };
  }
  // clone defensivo (não mutar o snapshot persistido/cacheado)
  const graph: RawSystemGraph = {
    ...rawGraph,
    nodes: rawGraph.nodes.slice(),
    edges: rawGraph.edges.map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : e.metadata })),
  };

  // Índices sobre o grafo (pós-scip): pares já provados pelo scip + arestas DI cruas.
  const scipProvenPairs = new Set<string>();
  const diEdgeByKey = new Map<string, RawSystemEdge>();
  for (const e of graph.edges) {
    const md = (e.metadata || {}) as Record<string, unknown>;
    const res = typeof md.resolution === "string" ? md.resolution : undefined;
    if (md.scipProven === true || (res !== undefined && SCIP_PROVEN_RESOLUTIONS.has(res))) {
      scipProvenPairs.add(dirKey(e.fromNode, e.toNode));
    }
    if (e.relationType === RELATION) diEdgeByKey.set(pairKey(e.fromNode, e.toNode, RELATION), e);
  }

  let added = 0;
  let upgraded = 0;
  let supersededByScip = 0;
  for (const a of aggregated) {
    if (scipProvenPairs.has(dirKey(a.fromNode, a.toNode))) { supersededByScip++; continue; }
    const existing = diEdgeByKey.get(pairKey(a.fromNode, a.toNode, RELATION));
    if (existing) {
      const md = (existing.metadata || {}) as Record<string, unknown>;
      md.resolution = "config";
      md.configProven = true;
      if (a.reason) md.reason = a.reason;
      delete md.synthetic; // deixa de ser DECLARADA — agora é PROVADA por config
      existing.metadata = md;
      upgraded++;
    } else {
      graph.edges.push({
        fromNode: a.fromNode,
        toNode: a.toNode,
        relationType: RELATION,
        metadata: { resolution: "config", configProven: true, ...(a.reason ? { reason: a.reason } : {}) },
      });
      added++;
    }
  }
  return { graph, stats: { ...aggStats, added, upgraded, supersededByScip } };
}

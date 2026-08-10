// ─────────────────────────────────────────────
// System Map — modelagem pura do grafo persistido para a tela.
// Recebe o `systemGraph` cru do snapshot (nós tipados + arestas) e devolve o
// shape que o cliente consome: grau de entrada/saída por nó (proxy de
// importância), flags derivadas e contagens por tipo. Puro e testável —
// nenhuma dependência de storage/express.
//
// GRANULARIDADE (revisão 2026-07-31): o Engine A emite o grafo em nível de
// MÉTODO (a classe E cada método dela são nós, todos com o estereótipo da
// classe). Isso é ótimo para call-graph, mas ERRADO para um "mapa de
// arquitetura": infla a contagem (382 "repositories" = 48 classes + métodos),
// duplica nós (ConnectorPollProcessor 29×) e faz a CLASSE parecer isolada
// quando as arestas estão nos métodos. Por isso o default é `level: 'class'`
// — agrega os nós de método na classe dona e rola as arestas para
// classe→classe (o nível correto de um mapa de sistema; CAST/JetBrains/
// Structure101 todos agregam). `level: 'method'` preserva o grafo cru para
// drill-down futuro.
// ─────────────────────────────────────────────

import { classifyNode, type ClassifiableNode } from "./canonical-model";

export interface RawSystemNode {
  id: string;
  type: string;
  className?: string;
  methodName?: string;
  qualifiedSignature?: string;
  metadata?: Record<string, unknown> | null;
}
export interface RawSystemEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  metadata?: Record<string, unknown> | null;
}
export interface RawSystemGraph {
  nodes: RawSystemNode[];
  edges: RawSystemEdge[];
  truncated?: boolean;
  /** Reconciliação: inventário do CÓDIGO (denominador dos chips FE). */
  inventory?: unknown;
}

export interface ShapedNode {
  id: string;
  type: string;
  className?: string;
  methodName?: string;
  qualifiedSignature?: string;
  inDegree: number;
  outDegree: number;
  sensitive: boolean;
  sourceFile?: string;
  /** nº de nós (métodos + a classe) agregados — só em level=class */
  memberCount?: number;
  /**
   * ADR-0025 Onda 4 — gatilhos de fundo (@Scheduled/@EventListener/runner…)
   * presentes no nó (method-level) ou em qualquer membro (class-level).
   * Root LEGÍTIMO: a tela mostra badge e a saúde não o conta como "isolado".
   */
  entryPoint?: string[];
  /**
   * ADR-0026 CM1 — camada de PAPEL canônico (faceta stack-agnóstica, aditiva).
   * `role` projeta byte-a-byte de volta ao `type` legado; `layer`/`stack`/
   * `roleEvidence`/`roleConfidence` são valor NOVO derivado de evidência
   * independente (path/metadata). Ausentes quando o tipo do produtor está fora
   * do vocabulário ativo do CM1 (ex.: módulo Node — coberto em CM2).
   */
  role?: string;
  layer?: string;
  stack?: string;
  roleEvidence?: string;
  roleConfidence?: string;
  /**
   * ADR-0026 costura — nó EXERCITADO por tráfego real (traços OTel/Jaeger).
   * `runtimeHot` = tocado por ≥1 requisição observada; `runtimeCount` = soma de
   * traços. Ausente = FRIO (existe no código, sem tráfego na janela). Habilita
   * a leitura "o que de fato roda × o que só existe".
   */
  runtimeHot?: boolean;
  runtimeCount?: number;
  /**
   * Furo 4 (2026-08-10) — last-known-good: `runtimeStale` = observado numa janela
   * ANTERIOR (herdado por LKG dentro do TTL), NÃO nesta análise. Segue contando como
   * RUNTIME_OBSERVED (foi observado de fato), mas a tela/health mostram "há Xh" em vez
   * de "agora" — reconcilia graph(snapshot) × health(hub) sem apagar o runtime bom.
   * `runtimeLastSeenMs` = epoch (ms) da última observação real. class-level: stale só
   * se TODOS os membros hot forem stale (qualquer membro fresh → classe fresh).
   */
  runtimeStale?: boolean;
  runtimeLastSeenMs?: number;
  /**
   * ADR-0028 P0.1 — nó EXERCITADO por tráfego (espelha `runtimeHot`; presente só
   * quando true). Alimenta o censo `coverage.nodes.observed`.
   */
  observed?: boolean;
  /**
   * ADR-0028 P0.1 — método+confiança de que o nó EXISTE: RUNTIME_OBSERVED quando
   * tocado por tráfego, senão STATIC_PROVEN (existe na fonte parseada pelo
   * Engine A). Sempre presente — todo nó declara como sabemos que ele existe.
   */
  evidence: Evidence;
}
/**
 * ADR-0028 P0.1 — Taxonomia epistêmica. NÃO é técnica nova: é o CONTRATO de que
 * toda aresta/nó do mapa declara COMO sabemos que existe (o MÉTODO de evidência)
 * e com QUE confiança. É a base do "censo de cobertura": o mapa passa a MOSTRAR o
 * que NÃO sabe (arestas UNKNOWN, ratio de runtime) em vez de apagar por omissão a
 * arquitetura fora do molde conhecido (caso NuPIdentify: nós/arestas invisíveis).
 */
export type EvidenceMethod =
  // traço real (OTel/Jaeger) exercitou isto — a evidência mais forte
  | 'RUNTIME_OBSERVED'
  // resolvido pelo compilador/tipo (Engine A emite `compiler` / `interface-impl`)
  | 'STATIC_PROVEN'
  // ADR-0035 §4 — DI resolvida DETERMINISTICAMENTE pelo wiring do container
  // (Spring: interface→impl com 1 bean concreto, ou @Primary desempatando).
  // O resolvedor `config-proven` lê `src/main/java` SEM runtime e SEM LLM e emite
  // `resolution:'config'`. É PROVA, mas de CONFIGURAÇÃO — não compiler-accurate
  // como o scip (K adapters concorrentes sem @Primary NÃO entram; ficam UNKNOWN
  // até o RUNTIME_OBSERVED). Por isso senta ENTRE STATIC_PROVEN e a heurística
  // DECLARADA: mais forte que convenção, mais fraca que o checker.
  | 'CONFIG_PROVEN'
  // convenção/sintaxe/heurística: DECLARADA, não provada
  // (`synthetic:true`, `convention-name`, família `syntactic-*`, `dynamic`)
  | 'STATIC_UNRESOLVED'
  // RESERVADO — nenhum produtor emite aresta assim hoje; entra quando houver
  // inferência por LLM. Documentado aqui para o censo já ter a coluna (=0).
  | 'LLM_CONJECTURED'
  // sem proveniência alguma: o mapa ADMITE que não sabe (em vez de fingir)
  | 'UNKNOWN';

export interface Evidence {
  method: EvidenceMethod;
  /** 0..1 — confiança nominal do método (calibração fina fica para ondas futuras). */
  confidence: number;
}

/**
 * ADR-0033 P4.5 — grau honesto da refutação de uma aresta pelo laço ativo de
 * fechamento (ADR-0032 P3, no `nup-sentinel`). NUNCA destrutivo (não apaga a
 * aresta) — só grada a confiança para baixo e vira entrada advisory (ADR-0032 §4).
 */
export type RefutationSubtype = 'REFUTED_LIKELY_DEAD' | 'REFUTED_UNREACHABLE_BY_ROBOT';

export interface EdgeRefutation {
  /**
   * `REFUTED_LIKELY_DEAD`  = dirigida N×/M-janelas, jamais promovida, pai-OK →
   * forte candidata a falso-positivo/código morto.
   * `REFUTED_UNREACHABLE_BY_ROBOT` = não-dirigível (auth/admin/sem-sandbox) →
   * **UNKNOWN honesto**, NÃO é morta (ADR-0032 §5 muro).
   */
  subtype: RefutationSubtype;
  /** nº de tentativas dirigidas independentes acumuladas. */
  attempts?: number;
  /** nº de janelas distintas em que foi dirigida. */
  windows?: number;
  /** motivo pt-BR (pai-OK-aresta-ausente | auth/admin/sem-sandbox/sem-gatilho). */
  reason?: string;
}

export interface ShapedEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  /** T1 (ADR-0025): proveniência da aresta (compiler|syntactic-*|interface-impl|convention-name) */
  resolution?: string;
  /** aresta de convenção (wsv1-handler/wsv1-name) — não é chamada de código observada */
  synthetic?: boolean;
  /** ADR-0026 costura: aresta OBSERVADA em traço OTel/Jaeger (RUNTIME_OBSERVED). */
  observed?: boolean;
  /** nº de traços que exercitaram a aresta observada. */
  count?: number;
  /** ADR-0035 §4: aresta DI provada pelo wiring do container (CONFIG_PROVEN). */
  configProven?: boolean;
  /**
   * ADR-0028 P0.1 — método+confiança de evidência DESTA aresta, derivado de
   * resolution/synthetic/observed. Sempre presente (aresta sem proveniência =
   * UNKNOWN, não omitida). Aditivo aos campos crus acima.
   */
  evidence: Evidence;
  /**
   * ADR-0033 P4.5 — a aresta foi REFUTADA pelo laço ativo (ADR-0032 P3): o
   * estático a desenhou, o robô dirigiu tráfego e ela NÃO apareceu. É um eixo
   * ORTOGONAL a `evidence` (`evidence` = como sabemos que a aresta EXISTE;
   * `refuted` = evidência de que ela NÃO roda na prática). A narrativa (P4.5)
   * a tira da espinha andável — nunca a cita como fato.
   *
   * DEPENDÊNCIA HONESTA: o produtor (overlay do laço) ainda NÃO popula este
   * campo no manifest — o P3 vive no `nup-sentinel` e está gated OFF. Lido
   * defensivamente do metadata cru (`refuted`/`refutation`); ausente hoje =
   * comportamento byte-a-byte. A convergência VIVA depende do P3 ligado.
   */
  refuted?: EdgeRefutation;
}

/**
 * ADR-0028 P0.1 — censo de cobertura do grafo: quanto do mapa é RUNTIME_OBSERVED
 * vs STATIC_PROVEN vs só DECLARADO vs desconhecido. É o número que torna a
 * incerteza VISÍVEL na tela.
 */
export interface GraphCoverage {
  edges: {
    byMethod: Record<EvidenceMethod, number>;
    total: number;
    /** fração de arestas com evidência RUNTIME_OBSERVED (0..1). */
    observedRatio: number;
  };
  nodes: { observed: number; total: number };
}
export interface ShapedGraph {
  level: 'class' | 'method';
  truncated: boolean;
  inventory?: unknown;
  counts: { nodes: number; edges: number; byType: Record<string, number> };
  /** ADR-0026 CM1 — distribuições canônicas (aditivas): por camada e por stack. */
  byLayer?: Record<string, number>;
  byStack?: Record<string, number>;
  /** ADR-0028 P0.1 — censo epistêmico: quanto do mapa é observado/provado/só-declarado/desconhecido. */
  coverage: GraphCoverage;
  nodes: ShapedNode[];
  edges: ShapedEdge[];
}

function isSensitive(node: RawSystemNode): boolean {
  const meta = node.metadata || {};
  const sensitiveFields = (meta as Record<string, unknown>).sensitiveFields;
  return Array.isArray(sensitiveFields) && sensitiveFields.length > 0;
}
function sourceFileOf(node: RawSystemNode): string | undefined {
  return typeof node.metadata?.sourceFile === 'string' ? (node.metadata.sourceFile as string) : undefined;
}
function edgeProvenance(e: RawSystemEdge): { resolution?: string; synthetic?: boolean; observed?: boolean; count?: number; configProven?: boolean; refuted?: EdgeRefutation } {
  const m = (e.metadata || {}) as Record<string, unknown>;
  const resolution = typeof m.resolution === 'string' ? (m.resolution as string) : undefined;
  const synthetic = m.synthetic === true ? true : undefined;
  const observed = m.observed === true ? true : undefined;
  const count = typeof m.count === 'number' ? (m.count as number) : undefined;
  const configProven = m.configProven === true ? true : undefined;
  const refuted = readRefutation(m);
  return {
    ...(resolution ? { resolution } : {}),
    ...(synthetic ? { synthetic } : {}),
    ...(observed ? { observed } : {}),
    ...(observed && count ? { count } : {}),
    ...(configProven ? { configProven } : {}),
    ...(refuted ? { refuted } : {}),
  };
}

/**
 * ADR-0033 P4.5 — lê a refutação do laço ativo do metadata cru, DEFENSIVAMENTE
 * (o produtor vive no `nup-sentinel`, ainda não popula aqui). Aceita a forma
 * rica `refutation: {subtype, attempts, windows, reason}` (o que o
 * `buildRefutationFinding` do P3 emite) OU um booleano `refuted: true`. Subtype
 * inválido/ausente cai no default HONESTO `REFUTED_UNREACHABLE_BY_ROBOT`
 * (UNKNOWN honesto — "na dúvida entre morta e não-exercitei", ADR-0032 §5),
 * nunca acusa "morta" sem evidência. Nunca lança.
 */
function normalizeRefutationSubtype(raw: unknown): RefutationSubtype {
  return raw === 'REFUTED_LIKELY_DEAD' ? 'REFUTED_LIKELY_DEAD' : 'REFUTED_UNREACHABLE_BY_ROBOT';
}
function readRefutation(m: Record<string, unknown>): EdgeRefutation | undefined {
  const raw = m.refutation ?? m.refuted;
  if (raw === true) return { subtype: 'REFUTED_UNREACHABLE_BY_ROBOT' };
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const subtype = normalizeRefutationSubtype(r.subtype);
  const attempts = typeof r.attempts === 'number' && r.attempts >= 0 ? r.attempts : undefined;
  const windows = typeof r.windows === 'number' && r.windows >= 0 ? r.windows : undefined;
  const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : undefined;
  return {
    subtype,
    ...(attempts !== undefined ? { attempts } : {}),
    ...(windows !== undefined ? { windows } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** Lê os campos de runtime (costura ADR-0026) do metadata cru de um nó. */
function runtimeOf(n: RawSystemNode): { runtimeHot?: boolean; runtimeCount?: number; runtimeStale?: boolean; runtimeLastSeenMs?: number } {
  const m = (n.metadata || {}) as Record<string, unknown>;
  if (m.runtimeHot !== true) return {};
  const count = typeof m.runtimeCount === 'number' ? (m.runtimeCount as number) : undefined;
  // Furo 4 — transparência do last-known-good: `runtimeStale` = observado numa janela
  // ANTERIOR (herdado por LKG), não nesta. `runtimeLastSeenMs` = quando foi visto.
  // Segue RUNTIME_OBSERVED (FOI observado), mas a tela/health mostram "há Xh".
  const stale = m.runtimeStale === true ? true : undefined;
  const lastSeen = typeof m.runtimeLastSeenMs === 'number' ? (m.runtimeLastSeenMs as number) : undefined;
  return { runtimeHot: true, ...(count ? { runtimeCount: count } : {}), ...(stale ? { runtimeStale: true } : {}), ...(lastSeen ? { runtimeLastSeenMs: lastSeen } : {}) };
}
function entryPointOf(node: RawSystemNode): string | undefined {
  const ep = node.metadata?.entryPoint;
  return typeof ep === 'string' && ep ? ep : undefined;
}

// ─── ADR-0028 P0.1 — classificação epistêmica (pura) ───
// `resolution` REAIS observados no código (grep server/analyzers|pipeline):
//   PRECISOS (Engine A, resolvidos por compilador/tipo): `compiler`, `interface-impl`
//   HEURÍSTICOS (Node full-stack-augment): `syntactic-declared` (sempre com
//   synthetic:true), `convention-name`. Os genéricos exact/type/import/direct/
//   dynamic estão previstos no vocabulário T1 mesmo sem produtor atual — mapeados
//   para não cair em UNKNOWN se um analisador novo os emitir.
export const PRECISE_RESOLUTIONS = new Set(['compiler', 'interface-impl', 'exact', 'type', 'import', 'direct']);
function isHeuristicResolution(r: string): boolean {
  return r === 'convention-name' || r === 'dynamic' || r === 'heuristic' || r.startsWith('syntactic');
}

/** Deriva {method, confidence} de uma aresta a partir da proveniência crua. */
function classifyEdgeEvidence(p: { resolution?: string; synthetic?: boolean; observed?: boolean; configProven?: boolean }): Evidence {
  if (p.observed === true) return { method: 'RUNTIME_OBSERVED', confidence: 0.95 };
  // ADR-0035 §4 — CONFIG_PROVEN: DI resolvida pelo wiring do container. Provada
  // (não synthetic), mas por configuração — 0.78 senta entre STATIC_PROVEN (0.80,
  // compiler-accurate) e a heurística DECLARADA (0.40). Checa ANTES do precise
  // porque `config` não está em PRECISE_RESOLUTIONS (cairia em UNKNOWN sem isto).
  if (p.configProven === true || p.resolution === 'config') return { method: 'CONFIG_PROVEN', confidence: 0.78 };
  const r = p.resolution;
  if (p.synthetic === true || (r !== undefined && isHeuristicResolution(r))) {
    return { method: 'STATIC_UNRESOLVED', confidence: 0.40 };
  }
  if (r !== undefined && PRECISE_RESOLUTIONS.has(r)) return { method: 'STATIC_PROVEN', confidence: 0.80 };
  return { method: 'UNKNOWN', confidence: 0.20 };
}

/** Deriva {method, confidence} de um nó: hot=runtime; senão provado pela fonte. */
function classifyNodeEvidence(observed: boolean): Evidence {
  return observed
    ? { method: 'RUNTIME_OBSERVED', confidence: 0.95 }
    : { method: 'STATIC_PROVEN', confidence: 0.80 };
}

/** Record zerado com TODAS as colunas do censo (LLM_CONJECTURED inclusa, hoje =0). */
function emptyEdgeByMethod(): Record<EvidenceMethod, number> {
  return { RUNTIME_OBSERVED: 0, STATIC_PROVEN: 0, CONFIG_PROVEN: 0, STATIC_UNRESOLVED: 0, LLM_CONJECTURED: 0, UNKNOWN: 0 };
}

/**
 * Furo 3 (2026-08-10) — CENSO EPISTÊMICO INVARIANTE DE VIEW.
 *
 * O `coverage.edges.byMethod` (quantas arestas são RUNTIME_OBSERVED/STATIC_PROVEN/…)
 * é um FATO DO CÓDIGO — "quanto do sistema o compilador/tráfego prova" — e NÃO pode
 * depender de como o mapa é desenhado. Antes, o nível `class` computava o censo sobre
 * as arestas JÁ DEDUPADAS (uma `Service→Entity` no lugar de N `Service→Entity#getX`),
 * então trocar de zoom method→class encolhia o STATIC_PROVEN de ~3085 p/ ~1040 — o
 * mesmo número-vitrine mudava só por mudar a lente. Isso era um bug latente do censo.
 *
 * Agora o censo é medido SEMPRE sobre a aresta CRUA do scip (o par função→função /
 * função→membro que o compilador provou), idêntico nos dois níveis. O `counts.edges`
 * segue sendo o MAPA (relações de arquitetura dedupadas no nível class) — são
 * perguntas diferentes: `counts.edges` = "o que aparece na tela"; `coverage.edges.total`
 * = "quantas chamadas o compilador provou". No nível class, `total` ≥ `counts.edges`.
 */
function computeRawCensus(raw: RawSystemGraph): { byMethod: Record<EvidenceMethod, number>; total: number } {
  const nodeIds = new Set(raw.nodes.map((n) => n.id));
  const byMethod = emptyEdgeByMethod();
  let total = 0;
  for (const e of raw.edges || []) {
    if (!nodeIds.has(e.fromNode) || !nodeIds.has(e.toNode)) continue;
    byMethod[classifyEdgeEvidence(edgeProvenance(e)).method] += 1;
    total += 1;
  }
  return { byMethod, total };
}

/** Monta o censo `coverage` (aritmética de divisão-por-zero segura). */
function buildCoverage(
  byMethod: Record<EvidenceMethod, number>,
  edgeTotal: number,
  nodesObserved: number,
  nodesTotal: number,
): GraphCoverage {
  return {
    edges: {
      byMethod,
      total: edgeTotal,
      observedRatio: edgeTotal > 0 ? byMethod.RUNTIME_OBSERVED / edgeTotal : 0,
    },
    nodes: { observed: nodesObserved, total: nodesTotal },
  };
}

/**
 * ADR-0026 CM1 — anexa a faceta canônica (aditiva) e acumula as distribuições
 * por camada/stack. Retorna {} quando o tipo está fora do vocabulário ativo do
 * CM1 (nó não recebe faceta; nunca chuta).
 */
function canonicalFacet(
  node: ClassifiableNode,
  byLayer: Record<string, number>,
  byStack: Record<string, number>,
): Pick<ShapedNode, 'role' | 'layer' | 'stack' | 'roleEvidence' | 'roleConfidence'> | Record<string, never> {
  const f = classifyNode(node);
  if (!f) return {};
  byLayer[f.layer] = (byLayer[f.layer] || 0) + 1;
  byStack[f.stack] = (byStack[f.stack] || 0) + 1;
  return { role: f.role, layer: f.layer, stack: f.stack, roleEvidence: f.evidence, roleConfidence: f.confidence };
}

/**
 * Chave da CLASSE dona de um nó. Id do Engine A:
 *   classe:  `TYPE:pacote.Classe`
 *   método:  `TYPE:pacote.Classe.metodo(args)`
 * Remove o sufixo `.metodo(args)` quando presente (o `(` marca o método),
 * preservando `pacote.Classe`. Sem `(` = já é a classe.
 */
export function classKeyOf(nodeId: string, nodeType?: string): string {
  // ENTITY (Furo 3, auditoria 2026-08-10): os MEMBROS de DADO de uma @Entity
  // vêm do scip como `TYPE:pkg.Classe::Classe#getX` (getter/setter/ctor). No
  // nível "class" eles DEVEM colapsar na classe (`TYPE:pkg.Classe`) — senão cada
  // acessor conta como um "nó ENTITY" distinto: 220 @Entity × ~8 acessores =
  // 1722 nós ENTITY (inflação 7,8× na contagem servida à tela). ASSIMÉTRICO DE
  // PROPÓSITO: só ENTITY colapsa o `::`/`#`. Para SERVICE/CONTROLLER/ROUTE os
  // nós de FUNÇÃO (`file::fn`) são PRESERVADOS, porque as arestas função→função
  // intra-arquivo são STATIC_PROVEN deliberado (ADR-0031 §6 A5 — "o par
  // intra-arquivo conta"). Entidade = dado (acessor não é sub-entidade);
  // serviço = comportamento (a chamada interna importa).
  if (nodeType === "ENTITY") {
    const dc = nodeId.indexOf("::");
    if (dc >= 0) return nodeId.slice(0, dc);
    const hash = nodeId.indexOf("#");
    if (hash >= 0) return nodeId.slice(0, hash);
  }
  const paren = nodeId.indexOf('(');
  if (paren < 0) return nodeId;
  const pre = nodeId.slice(0, paren); // TYPE:pacote.Classe.metodo
  const lastDot = pre.lastIndexOf('.');
  return lastDot > 0 ? pre.slice(0, lastDot) : pre; // tira `.metodo`
}

/** Nome curto de classe a partir da chave (`TYPE:a.b.Classe` → `Classe`). */
function classNameFromKey(key: string): string {
  const afterColon = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  return afterColon.split('.').filter(Boolean).pop() || afterColon;
}

/**
 * Transforma o grafo cru do snapshot no payload da tela. `level='class'`
 * (default) agrega método→classe; `level='method'` mantém o grafo cru.
 * Só considera arestas cujos dois extremos existem entre os nós; em class
 * também descarta self-loops (método→método da MESMA classe não é aresta de
 * arquitetura).
 */
export function shapeSystemGraph(raw: RawSystemGraph, level: 'class' | 'method' = 'class'): ShapedGraph {
  return level === 'method' ? shapeMethodLevel(raw) : shapeClassLevel(raw);
}

function shapeMethodLevel(raw: RawSystemGraph): ShapedGraph {
  const nodeIds = new Set(raw.nodes.map((n) => n.id));
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  const edges: ShapedEdge[] = [];
  for (const e of raw.edges || []) {
    if (!nodeIds.has(e.fromNode) || !nodeIds.has(e.toNode)) continue;
    inDegree[e.toNode] = (inDegree[e.toNode] || 0) + 1;
    outDegree[e.fromNode] = (outDegree[e.fromNode] || 0) + 1;
    const prov = edgeProvenance(e);
    const evidence = classifyEdgeEvidence(prov);
    edges.push({ fromNode: e.fromNode, toNode: e.toNode, relationType: e.relationType, ...prov, evidence });
  }
  const byType: Record<string, number> = {};
  const byLayer: Record<string, number> = {};
  const byStack: Record<string, number> = {};
  let nodesObserved = 0;
  const nodes: ShapedNode[] = raw.nodes.map((n) => {
    byType[n.type] = (byType[n.type] || 0) + 1;
    const ep = entryPointOf(n);
    const rt = runtimeOf(n);
    const observed = rt.runtimeHot === true;
    if (observed) nodesObserved += 1;
    return {
      id: n.id, type: n.type, className: n.className, methodName: n.methodName,
      qualifiedSignature: n.qualifiedSignature,
      inDegree: inDegree[n.id] || 0, outDegree: outDegree[n.id] || 0,
      sensitive: isSensitive(n), sourceFile: sourceFileOf(n),
      ...(ep ? { entryPoint: [ep] } : {}),
      ...rt,
      ...(observed ? { observed: true } : {}),
      ...canonicalFacet(n, byLayer, byStack),
      evidence: classifyNodeEvidence(observed),
    };
  });
  // Furo 3: censo pela mesma fonte do nível class (invariante de view). No method-level
  // o mapa == aresta crua, então `census.total === edges.length` aqui (byte-a-byte).
  const census = computeRawCensus(raw);
  const coverage = buildCoverage(census.byMethod, census.total, nodesObserved, nodes.length);
  return { level: 'method', truncated: !!raw.truncated, ...(raw.inventory ? { inventory: raw.inventory } : {}), counts: { nodes: nodes.length, edges: edges.length, byType }, byLayer, byStack, coverage, nodes, edges };
}

function shapeClassLevel(raw: RawSystemGraph): ShapedGraph {
  interface Agg { id: string; type: string; className: string; sensitive: boolean; sourceFile?: string; members: number; entryPoints: Set<string>; runtimeHot: boolean; runtimeCount: number; runtimeFresh: boolean; runtimeLastSeenMs: number; }
  const classes = new Map<string, Agg>();
  const keyOf = new Map<string, string>();
  for (const n of raw.nodes) {
    const key = classKeyOf(n.id, n.type); // Furo 3: só ENTITY colapsa membros `::`
    keyOf.set(n.id, key);
    let c = classes.get(key);
    if (!c) {
      c = { id: key, type: n.type, className: n.className || classNameFromKey(key), sensitive: false, members: 0, entryPoints: new Set(), runtimeHot: false, runtimeCount: 0, runtimeFresh: false, runtimeLastSeenMs: 0 };
      classes.set(key, c);
    }
    c.members += 1;
    if (isSensitive(n)) c.sensitive = true;
    // costura ADR-0026: qualquer membro exercitado por tráfego marca a classe hot.
    // Furo 4: a classe é STALE só se NENHUM membro hot for fresh (membro visto nesta
    // janela → runtimeStale ausente → fresh). Guarda o lastSeen mais recente.
    const rt = runtimeOf(n);
    if (rt.runtimeHot) {
      c.runtimeHot = true;
      c.runtimeCount += rt.runtimeCount || 0;
      if (rt.runtimeStale !== true) c.runtimeFresh = true;
      if (rt.runtimeLastSeenMs) c.runtimeLastSeenMs = Math.max(c.runtimeLastSeenMs, rt.runtimeLastSeenMs);
    }
    const ep = entryPointOf(n);
    if (ep) c.entryPoints.add(ep); // Onda 4: qualquer método-gatilho marca a classe
    // prefere nome/arquivo do nó de CLASSE (sem parêntese); senão o 1º arquivo visto
    if (!n.id.includes('(')) {
      if (n.className) c.className = n.className;
      const sf = sourceFileOf(n);
      if (sf) c.sourceFile = sf;
    } else if (!c.sourceFile) {
      const sf = sourceFileOf(n);
      if (sf) c.sourceFile = sf;
    }
  }

  const edgeSet = new Set<string>();
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  const edges: ShapedEdge[] = [];
  // O MAPA de classe dedupa `Service→Entity` (self-loops e arestas repetidas somem).
  // O CENSO epistêmico NÃO — ele mede a aresta crua (Furo 3, `computeRawCensus`).
  for (const e of raw.edges || []) {
    const a = keyOf.get(e.fromNode);
    const b = keyOf.get(e.toNode);
    if (!a || !b || a === b) continue; // self-loop (mesma classe) não é aresta de arquitetura
    const k = `${a} ${b} ${e.relationType}`;
    if (edgeSet.has(k)) continue;
    edgeSet.add(k);
    inDegree[b] = (inDegree[b] || 0) + 1;
    outDegree[a] = (outDegree[a] || 0) + 1;
    const prov = edgeProvenance(e);
    const evidence = classifyEdgeEvidence(prov);
    edges.push({ fromNode: a, toNode: b, relationType: e.relationType, ...prov, evidence });
  }

  const byType: Record<string, number> = {};
  const byLayer: Record<string, number> = {};
  const byStack: Record<string, number> = {};
  let nodesObserved = 0;
  const nodes: ShapedNode[] = Array.from(classes.values()).map((c) => {
    byType[c.type] = (byType[c.type] || 0) + 1;
    const observed = c.runtimeHot === true;
    if (observed) nodesObserved += 1;
    return {
      id: c.id, type: c.type, className: c.className,
      inDegree: inDegree[c.id] || 0, outDegree: outDegree[c.id] || 0,
      sensitive: c.sensitive, sourceFile: c.sourceFile, memberCount: c.members,
      ...(c.entryPoints.size ? { entryPoint: Array.from(c.entryPoints) } : {}),
      ...(c.runtimeHot ? { runtimeHot: true, ...(c.runtimeCount ? { runtimeCount: c.runtimeCount } : {}), ...(!c.runtimeFresh ? { runtimeStale: true } : {}), ...(c.runtimeLastSeenMs ? { runtimeLastSeenMs: c.runtimeLastSeenMs } : {}) } : {}),
      ...(observed ? { observed: true } : {}),
      ...canonicalFacet({ id: c.id, type: c.type, className: c.className, sourceFile: c.sourceFile }, byLayer, byStack),
      evidence: classifyNodeEvidence(observed),
    };
  });
  // Furo 3: censo sobre a aresta CRUA (invariante de view), não sobre o mapa dedup.
  const census = computeRawCensus(raw);
  const coverage = buildCoverage(census.byMethod, census.total, nodesObserved, nodes.length);
  return { level: 'class', truncated: !!raw.truncated, ...(raw.inventory ? { inventory: raw.inventory } : {}), counts: { nodes: nodes.length, edges: edges.length, byType }, byLayer, byStack, coverage, nodes, edges };
}

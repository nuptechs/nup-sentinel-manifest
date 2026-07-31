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
}
export interface ShapedEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  /** T1 (ADR-0025): proveniência da aresta (compiler|syntactic-*|interface-impl|convention-name) */
  resolution?: string;
  /** aresta de convenção (wsv1-handler/wsv1-name) — não é chamada de código observada */
  synthetic?: boolean;
}
export interface ShapedGraph {
  level: 'class' | 'method';
  truncated: boolean;
  inventory?: unknown;
  counts: { nodes: number; edges: number; byType: Record<string, number> };
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
function edgeProvenance(e: RawSystemEdge): { resolution?: string; synthetic?: boolean } {
  const m = e.metadata || {};
  const resolution = typeof (m as Record<string, unknown>).resolution === 'string' ? ((m as Record<string, unknown>).resolution as string) : undefined;
  const synthetic = (m as Record<string, unknown>).synthetic === true ? true : undefined;
  return { ...(resolution ? { resolution } : {}), ...(synthetic ? { synthetic } : {}) };
}
function entryPointOf(node: RawSystemNode): string | undefined {
  const ep = node.metadata?.entryPoint;
  return typeof ep === 'string' && ep ? ep : undefined;
}

/**
 * Chave da CLASSE dona de um nó. Id do Engine A:
 *   classe:  `TYPE:pacote.Classe`
 *   método:  `TYPE:pacote.Classe.metodo(args)`
 * Remove o sufixo `.metodo(args)` quando presente (o `(` marca o método),
 * preservando `pacote.Classe`. Sem `(` = já é a classe.
 */
export function classKeyOf(nodeId: string): string {
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
    edges.push({ fromNode: e.fromNode, toNode: e.toNode, relationType: e.relationType, ...edgeProvenance(e) });
  }
  const byType: Record<string, number> = {};
  const nodes: ShapedNode[] = raw.nodes.map((n) => {
    byType[n.type] = (byType[n.type] || 0) + 1;
    const ep = entryPointOf(n);
    return {
      id: n.id, type: n.type, className: n.className, methodName: n.methodName,
      qualifiedSignature: n.qualifiedSignature,
      inDegree: inDegree[n.id] || 0, outDegree: outDegree[n.id] || 0,
      sensitive: isSensitive(n), sourceFile: sourceFileOf(n),
      ...(ep ? { entryPoint: [ep] } : {}),
    };
  });
  return { level: 'method', truncated: !!raw.truncated, ...(raw.inventory ? { inventory: raw.inventory } : {}), counts: { nodes: nodes.length, edges: edges.length, byType }, nodes, edges };
}

function shapeClassLevel(raw: RawSystemGraph): ShapedGraph {
  interface Agg { id: string; type: string; className: string; sensitive: boolean; sourceFile?: string; members: number; entryPoints: Set<string>; }
  const classes = new Map<string, Agg>();
  const keyOf = new Map<string, string>();
  for (const n of raw.nodes) {
    const key = classKeyOf(n.id);
    keyOf.set(n.id, key);
    let c = classes.get(key);
    if (!c) {
      c = { id: key, type: n.type, className: n.className || classNameFromKey(key), sensitive: false, members: 0, entryPoints: new Set() };
      classes.set(key, c);
    }
    c.members += 1;
    if (isSensitive(n)) c.sensitive = true;
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
  for (const e of raw.edges || []) {
    const a = keyOf.get(e.fromNode);
    const b = keyOf.get(e.toNode);
    if (!a || !b || a === b) continue; // self-loop (mesma classe) não é aresta de arquitetura
    const k = `${a} ${b} ${e.relationType}`;
    if (edgeSet.has(k)) continue;
    edgeSet.add(k);
    inDegree[b] = (inDegree[b] || 0) + 1;
    outDegree[a] = (outDegree[a] || 0) + 1;
    edges.push({ fromNode: a, toNode: b, relationType: e.relationType, ...edgeProvenance(e) });
  }

  const byType: Record<string, number> = {};
  const nodes: ShapedNode[] = Array.from(classes.values()).map((c) => {
    byType[c.type] = (byType[c.type] || 0) + 1;
    return {
      id: c.id, type: c.type, className: c.className,
      inDegree: inDegree[c.id] || 0, outDegree: outDegree[c.id] || 0,
      sensitive: c.sensitive, sourceFile: c.sourceFile, memberCount: c.members,
      ...(c.entryPoints.size ? { entryPoint: Array.from(c.entryPoints) } : {}),
    };
  });
  return { level: 'class', truncated: !!raw.truncated, ...(raw.inventory ? { inventory: raw.inventory } : {}), counts: { nodes: nodes.length, edges: edges.length, byType }, nodes, edges };
}

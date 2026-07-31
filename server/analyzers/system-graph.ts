// ─────────────────────────────────────────────
// System Map — modelagem pura do grafo persistido para a tela.
// Recebe o `systemGraph` cru do snapshot (nós tipados + arestas) e devolve o
// shape que o cliente consome: grau de entrada/saída por nó (proxy de
// importância), flags derivadas e contagens por tipo. Puro e testável —
// nenhuma dependência de storage/express.
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
}
export interface ShapedGraph {
  truncated: boolean;
  counts: { nodes: number; edges: number; byType: Record<string, number> };
  nodes: ShapedNode[];
  edges: { fromNode: string; toNode: string; relationType: string }[];
}

function isSensitive(node: RawSystemNode): boolean {
  const meta = node.metadata || {};
  const sensitiveFields = (meta as Record<string, unknown>).sensitiveFields;
  if (Array.isArray(sensitiveFields) && sensitiveFields.length > 0) return true;
  return false;
}

/**
 * Transforma o grafo cru do snapshot no payload da tela. Só considera arestas
 * cujos dois extremos existem entre os nós (arestas órfãs são descartadas —
 * nunca contamos grau contra nó inexistente).
 */
export function shapeSystemGraph(raw: RawSystemGraph): ShapedGraph {
  const nodeIds = new Set(raw.nodes.map((n) => n.id));
  const inDegree: Record<string, number> = {};
  const outDegree: Record<string, number> = {};
  const edges: { fromNode: string; toNode: string; relationType: string }[] = [];

  for (const e of raw.edges || []) {
    if (!nodeIds.has(e.fromNode) || !nodeIds.has(e.toNode)) continue;
    inDegree[e.toNode] = (inDegree[e.toNode] || 0) + 1;
    outDegree[e.fromNode] = (outDegree[e.fromNode] || 0) + 1;
    edges.push({ fromNode: e.fromNode, toNode: e.toNode, relationType: e.relationType });
  }

  const byType: Record<string, number> = {};
  const nodes: ShapedNode[] = raw.nodes.map((n) => {
    byType[n.type] = (byType[n.type] || 0) + 1;
    return {
      id: n.id,
      type: n.type,
      className: n.className,
      methodName: n.methodName,
      qualifiedSignature: n.qualifiedSignature,
      inDegree: inDegree[n.id] || 0,
      outDegree: outDegree[n.id] || 0,
      sensitive: isSensitive(n),
      sourceFile: typeof n.metadata?.sourceFile === "string" ? (n.metadata.sourceFile as string) : undefined,
    };
  });

  return {
    truncated: !!raw.truncated,
    counts: { nodes: nodes.length, edges: edges.length, byType },
    nodes,
    edges,
  };
}

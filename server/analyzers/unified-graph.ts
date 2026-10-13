// ─────────────────────────────────────────────────────────────────────────
// OBS-D11 (lado MANIFEST) (ADR-0036 WS-D) — GRAFO UNIFICADO: uma verdade
// consultável sobre CODE + MANIFEST (+ runtime, onde já vem no shape).
//
// O critério da D11 é "code+manifest+runtime num só modelo consultável". O lado
// SENTINEL/runtime (correlacionar traços vivos entre serviços) é de OUTRO agente
// no repo `nup-sentinel` — NÃO é tocado aqui. ESTE módulo é o lado MANIFEST: uma
// PROJEÇÃO de leitura que normaliza o grafo já shaped (`system-graph.ts`, que no
// `/graph` JÁ vem com os overlays scip/config/runtime mesclados) num modelo
// único, indexado e consultável, onde CADA nó e aresta DECLARA por qual dos
// módulos é atestado (proveniência tri-eixo):
//   • code     — existe no grafo estático (todo nó shaped; toda aresta não-runtime);
//   • manifest — está no catálogo curado do manifesto (conjunto de ids fornecido);
//   • runtime  — foi OBSERVADO em traço (o shape já marca `observed`/RUNTIME_OBSERVED).
// Dobra também as arestas CROSS-SERVICE (OBS-D04) para que o modelo una, de fato,
// mais de um serviço numa "uma verdade" — a junção por símbolo entra aqui.
//
// É a base consultável de cima da qual a detecção cross-stack (OBS-D12) e o
// impacto cross-service perguntam "o que existe, provado por quê, e o que não".
//
// INERTE por construção (régua D2): PURA projeção de leitura, sem I/O e sem
// mutação; NENHUM endpoint/pipeline a serve ainda (o `/unified-graph` é PR
// seguinte). Não altera o `/graph` existente. "Nasce ◐."
// ─────────────────────────────────────────────────────────────────────────

import type { ShapedGraph, ShapedNode, ShapedEdge, Evidence, EvidenceMethod } from "./system-graph";
import type { AggregatedCrossServiceEdge } from "./cross-service-symbol-junction";

/** Em qual dos três módulos o nó/aresta é atestado (tri-eixo da §2 da ADR-0036). */
export interface Provenance {
  code: boolean;
  manifest: boolean;
  runtime: boolean;
}

export interface UnifiedNode {
  id: string;
  type: string;
  label: string;
  sourceFile?: string;
  /** serviço dono (quando o modelo une vários; ausente = projeto único). */
  service?: string;
  provenance: Provenance;
  evidence: Evidence;
  /** grau no modelo unificado (inclui arestas cross-service). */
  inDegree: number;
  outDegree: number;
}

export interface UnifiedEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  provenance: Provenance;
  evidence: Evidence;
  crossService?: boolean;
}

export interface UnifiedCoverage {
  nodes: { total: number; code: number; manifest: number; runtime: number };
  edges: { total: number; code: number; manifest: number; runtime: number; crossService: number; byMethod: Record<EvidenceMethod, number> };
}

export interface BuildUnifiedOptions {
  /** nome do serviço a atribuir aos nós deste grafo (quando se une vários). */
  service?: string;
  /** ids de nó que o CATÁLOGO curado do manifesto contém (eixo `manifest`). */
  manifestNodeIds?: Set<string> | string[];
  /** arestas cross-service (OBS-D04) a dobrar no modelo (ids já qualificados). */
  crossServiceEdges?: AggregatedCrossServiceEdge[];
}

function emptyByMethod(): Record<EvidenceMethod, number> {
  return { RUNTIME_OBSERVED: 0, STATIC_PROVEN: 0, CONFIG_PROVEN: 0, STATIC_UNRESOLVED: 0, LLM_CONJECTURED: 0, UNKNOWN: 0 };
}

function labelOf(n: ShapedNode): string {
  return n.className || n.methodName || (typeof n.id === "string" ? n.id.split(":").pop() || n.id : n.id);
}

function nodeIsRuntime(n: ShapedNode): boolean {
  return n.observed === true || n.runtimeHot === true || n.evidence?.method === "RUNTIME_OBSERVED";
}
function edgeIsRuntime(e: ShapedEdge): boolean {
  return e.observed === true || e.evidence?.method === "RUNTIME_OBSERVED";
}

const CROSS_SERVICE_EVIDENCE: Record<"compiler" | "interface-impl", Evidence> = {
  compiler: { method: "STATIC_PROVEN", confidence: 0.8 },
  "interface-impl": { method: "STATIC_PROVEN", confidence: 0.8 },
};

/**
 * O MODELO UNIFICADO consultável. Índices construídos uma vez; consultas O(1)/O(grau).
 * Imutável por contrato (os getters nunca mutam o estado interno).
 */
export class UnifiedGraph {
  private readonly _nodes: Map<string, UnifiedNode>;
  private readonly _out: Map<string, UnifiedEdge[]>;
  private readonly _in: Map<string, UnifiedEdge[]>;
  private readonly _edges: UnifiedEdge[];

  constructor(nodes: UnifiedNode[], edges: UnifiedEdge[]) {
    this._nodes = new Map(nodes.map((n) => [n.id, n]));
    this._edges = edges;
    this._out = new Map();
    this._in = new Map();
    for (const e of edges) {
      (this._out.get(e.fromNode) ?? this._out.set(e.fromNode, []).get(e.fromNode)!).push(e);
      (this._in.get(e.toNode) ?? this._in.set(e.toNode, []).get(e.toNode)!).push(e);
    }
  }

  node(id: string): UnifiedNode | undefined { return this._nodes.get(id); }
  hasNode(id: string): boolean { return this._nodes.has(id); }
  nodes(): UnifiedNode[] { return Array.from(this._nodes.values()); }
  edges(): UnifiedEdge[] { return this._edges.slice(); }
  out(id: string): UnifiedEdge[] { return (this._out.get(id) ?? []).slice(); }
  in(id: string): UnifiedEdge[] { return (this._in.get(id) ?? []).slice(); }

  /** vizinhos de saída (callees) — ids. */
  neighbors(id: string): string[] { return (this._out.get(id) ?? []).map((e) => e.toNode); }

  byType(type: string): UnifiedNode[] { return this.nodes().filter((n) => n.type === type); }

  /** nós atestados por um eixo (`code`/`manifest`/`runtime`). */
  byProvenance(axis: keyof Provenance): UnifiedNode[] { return this.nodes().filter((n) => n.provenance[axis]); }

  /** arestas que cruzam a fronteira de serviço (OBS-D04). */
  crossServiceEdges(): UnifiedEdge[] { return this._edges.filter((e) => e.crossService === true); }

  /** censo tri-eixo do modelo unificado. */
  coverage(): UnifiedCoverage {
    const nodes = this.nodes();
    const byMethod = emptyByMethod();
    let eCode = 0, eManifest = 0, eRuntime = 0, eCross = 0;
    for (const e of this._edges) {
      byMethod[e.evidence.method] += 1;
      if (e.provenance.code) eCode++;
      if (e.provenance.manifest) eManifest++;
      if (e.provenance.runtime) eRuntime++;
      if (e.crossService) eCross++;
    }
    return {
      nodes: {
        total: nodes.length,
        code: nodes.filter((n) => n.provenance.code).length,
        manifest: nodes.filter((n) => n.provenance.manifest).length,
        runtime: nodes.filter((n) => n.provenance.runtime).length,
      },
      edges: { total: this._edges.length, code: eCode, manifest: eManifest, runtime: eRuntime, crossService: eCross, byMethod },
    };
  }
}

/**
 * Projeta UM grafo shaped (code+manifest+runtime já mesclado pelo `/graph`) no
 * modelo unificado. PURA. Opcionalmente qualifica os ids por serviço e dobra as
 * arestas cross-service (OBS-D04) — o ponto em que "uma verdade" passa a unir
 * mais de um serviço. Para unir N serviços, chame `mergeUnifiedGraphs` com um
 * `buildUnifiedGraph` por serviço (cada um com seu `service`).
 */
export function buildUnifiedGraph(
  shaped: ShapedGraph | null | undefined,
  opts: BuildUnifiedOptions = {},
): UnifiedGraph {
  const service = opts.service;
  const manifestIds = opts.manifestNodeIds instanceof Set
    ? opts.manifestNodeIds
    : new Set(Array.isArray(opts.manifestNodeIds) ? opts.manifestNodeIds : []);
  const qual = (raw: string) => (service ? `${service}::${raw}` : raw);

  const nodes: UnifiedNode[] = [];
  const edges: UnifiedEdge[] = [];

  const shapedNodes = Array.isArray(shaped?.nodes) ? shaped!.nodes : [];
  const shapedEdges = Array.isArray(shaped?.edges) ? shaped!.edges : [];

  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();

  for (const n of shapedNodes) {
    if (!n || typeof n.id !== "string") continue;
    const id = qual(n.id);
    const runtime = nodeIsRuntime(n);
    nodes.push({
      id,
      type: String(n.type || ""),
      label: labelOf(n),
      ...(n.sourceFile ? { sourceFile: n.sourceFile } : {}),
      ...(service ? { service } : {}),
      provenance: { code: true, manifest: manifestIds.has(n.id) || manifestIds.has(id), runtime },
      evidence: n.evidence ?? { method: "STATIC_PROVEN", confidence: 0.8 },
      inDegree: 0,
      outDegree: 0,
    });
  }
  const nodeSet = new Set(nodes.map((n) => n.id));

  for (const e of shapedEdges) {
    if (!e || typeof e.fromNode !== "string" || typeof e.toNode !== "string") continue;
    const fromNode = qual(e.fromNode);
    const toNode = qual(e.toNode);
    if (!nodeSet.has(fromNode) || !nodeSet.has(toNode)) continue;
    const runtime = edgeIsRuntime(e);
    edges.push({
      fromNode, toNode,
      relationType: String(e.relationType || ""),
      provenance: { code: true, manifest: manifestIds.has(e.fromNode) && manifestIds.has(e.toNode), runtime },
      evidence: e.evidence ?? { method: "UNKNOWN", confidence: 0.2 },
    });
    outDeg.set(fromNode, (outDeg.get(fromNode) || 0) + 1);
    inDeg.set(toNode, (inDeg.get(toNode) || 0) + 1);
  }

  // Dobra as arestas cross-service (OBS-D04): ids JÁ qualificados pelo serviço de
  // cada ponta. Só entra a aresta cujas DUAS pontas existem no modelo (honesto —
  // sem nó, não liga). Em `buildUnifiedGraph` de 1 serviço as pontas geralmente
  // apontam p/ outro serviço ausente; a dobra REAL acontece após o merge dos N.
  foldCrossService(opts.crossServiceEdges, nodeSet, edges, inDeg, outDeg);

  for (const n of nodes) { n.inDegree = inDeg.get(n.id) || 0; n.outDegree = outDeg.get(n.id) || 0; }
  return new UnifiedGraph(nodes, edges);
}

function foldCrossService(
  xs: AggregatedCrossServiceEdge[] | undefined,
  nodeSet: Set<string>,
  edges: UnifiedEdge[],
  inDeg: Map<string, number>,
  outDeg: Map<string, number>,
): void {
  if (!Array.isArray(xs)) return;
  const seen = new Set(edges.map((e) => `${e.fromNode}|${e.toNode}|${e.relationType}`));
  for (const x of xs) {
    if (!x || !nodeSet.has(x.fromNode) || !nodeSet.has(x.toNode)) continue;
    const k = `${x.fromNode}|${x.toNode}|${x.relationType}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({
      fromNode: x.fromNode, toNode: x.toNode, relationType: x.relationType,
      provenance: { code: true, manifest: false, runtime: false },
      evidence: CROSS_SERVICE_EVIDENCE[x.resolution] ?? { method: "STATIC_PROVEN", confidence: 0.8 },
      crossService: true,
    });
    outDeg.set(x.fromNode, (outDeg.get(x.fromNode) || 0) + 1);
    inDeg.set(x.toNode, (inDeg.get(x.toNode) || 0) + 1);
  }
}

/**
 * Une VÁRIOS modelos unificados (um por serviço, ids já qualificados) e dobra as
 * arestas cross-service que agora têm AS DUAS pontas presentes — a "uma verdade"
 * de N serviços. PURA. Dedup de nó por id (o primeiro vence) e de aresta por
 * tripla. As cross-service cujas duas pontas existirem no conjunto unido entram;
 * as demais ficam de fora (honesto — sem as duas pontas, não há elo).
 */
export function mergeUnifiedGraphs(
  graphs: UnifiedGraph[] | null | undefined,
  crossServiceEdges?: AggregatedCrossServiceEdge[],
): UnifiedGraph {
  const nodeById = new Map<string, UnifiedNode>();
  const edges: UnifiedEdge[] = [];
  const seenEdge = new Set<string>();
  if (Array.isArray(graphs)) {
    for (const g of graphs) {
      if (!g) continue;
      for (const n of g.nodes()) if (!nodeById.has(n.id)) nodeById.set(n.id, { ...n, inDegree: 0, outDegree: 0 });
      for (const e of g.edges()) {
        const k = `${e.fromNode}|${e.toNode}|${e.relationType}`;
        if (seenEdge.has(k)) continue;
        seenEdge.add(k);
        edges.push({ ...e });
      }
    }
  }
  const nodeSet = new Set(nodeById.keys());
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  // só mantém arestas cujas DUAS pontas existem no conjunto unido.
  const kept: UnifiedEdge[] = [];
  for (const e of edges) {
    if (!nodeSet.has(e.fromNode) || !nodeSet.has(e.toNode)) continue;
    kept.push(e);
    outDeg.set(e.fromNode, (outDeg.get(e.fromNode) || 0) + 1);
    inDeg.set(e.toNode, (inDeg.get(e.toNode) || 0) + 1);
  }
  foldCrossService(crossServiceEdges, nodeSet, kept, inDeg, outDeg);
  const nodes = Array.from(nodeById.values()).map((n) => ({ ...n, inDegree: inDeg.get(n.id) || 0, outDegree: outDeg.get(n.id) || 0 }));
  return new UnifiedGraph(nodes, kept);
}

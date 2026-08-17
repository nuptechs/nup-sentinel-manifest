// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Grafo + Prova" (lógica PURA).
//
// Ego-network 1-hop em layout radial determinístico: o nó-centro no meio, os
// vizinhos num anel, cada aresta CLICÁVEL abrindo o "recibo" (método de
// evidência + confiança + resolution + fontes). Puro, sem I/O, sem React —
// testável isoladamente com fixtures literais.
//
// Honestidade: cap de vizinhos SEMPRE anunciado (shown/total); recência é POR
// NÓ (runtimeLastSeenMs das pontas), nunca da aresta — o shape não a expõe e
// nós não inventamos.
// ─────────────────────────────────────────────
import {
  type EvidenceMethod,
  evidenceMethodOf,
  evidenceConfidenceOf,
} from "./system-map-evidence";
import { humanLabel } from "./evidence-label";

// ── Forma mínima do payload /graph que esta vista consome ─────────────
export interface ProofNode {
  id: string;
  type: string;
  className?: string;
  methodName?: string;
  inDegree: number;
  outDegree: number;
  sensitive?: boolean;
  sourceFile?: string;
  runtimeHot?: boolean;
  runtimeCount?: number;
  runtimeStale?: boolean;
  runtimeLastSeenMs?: number;
}
export interface ProofEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  resolution?: string;
  synthetic?: boolean;
  observed?: boolean;
  count?: number;
  evidence?: { method?: unknown; confidence?: unknown } | null;
}
export interface ProofGraph {
  nodes: ProofNode[];
  edges: ProofEdge[];
}

/** Rótulo curto derivado (o shape NÃO traz `label`; nunca devolve "<module>"). */
export function proofLabel(n: ProofNode): string {
  return humanLabel(n);
}

/** Tipos que valem a pena centrar: mostram um CAMINHO (fan-out), não um sink. */
const ENTRY_TYPES = new Set(["CONTROLLER", "ROUTE", "SERVICE", "VIEW", "COMPONENT"]);

/**
 * Score do candidato a centro do ego. Um bom centro FANA PRA FORA (mostra o que
 * chama) e é um ponto de entrada — não um hub de infraestrutura (logger/util),
 * que só recebe arestas e não ensina nada quando vira o meio do diagrama.
 */
export function centerScore(n: ProofNode): number {
  let s = n.outDegree * 2 + n.inDegree;
  if (ENTRY_TYPES.has(n.type)) s += 100;
  if (n.runtimeHot) s += 60;
  // hub de infra puro (muito dependido, quase não chama ninguém): péssimo centro.
  if (n.outDegree <= 1 && n.inDegree >= 20) s -= 500;
  return s;
}

/**
 * Centro default: o nó de MAIOR score (ponto de entrada com fan-out, não o
 * sink mais dependido). Empate desempatado por id (determinístico). Vazio → null.
 */
export function defaultCenterId(nodes: readonly ProofNode[]): string | null {
  let best: ProofNode | null = null;
  let bestScore = -Infinity;
  for (const n of nodes) {
    const s = centerScore(n);
    if (s > bestScore || (s === bestScore && best !== null && n.id < best.id)) {
      best = n;
      bestScore = s;
    }
  }
  return best ? best.id : null;
}

/**
 * Busca por substring (case-insensitive) em className, methodName e id, na
 * ordem do array (determinístico). Query vazia ou sem match → null.
 */
export function searchNode(nodes: readonly ProofNode[], query: string): ProofNode | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const n of nodes) {
    if (
      (n.className && n.className.toLowerCase().includes(q)) ||
      (n.methodName && n.methodName.toLowerCase().includes(q)) ||
      n.id.toLowerCase().includes(q)
    ) {
      return n;
    }
  }
  return null;
}

// ── Layout radial ─────────────────────────────────────────────────────
export const EGO_VIEW = { width: 820, height: 620, cx: 410, cy: 310, radius: 240 } as const;
export const EGO_NEIGHBOR_CAP = 24;

export interface LaidNeighbor {
  node: ProofNode;
  x: number;
  y: number;
}
export interface LaidEgoEdge {
  edge: ProofEdge;
  /** índice da aresta no array `edges` do layout (chave estável de seleção). */
  index: number;
  /** id do vizinho (a ponta que não é o centro). */
  neighborId: string;
  /** true = sai do centro para o vizinho. */
  outbound: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** ponto de controle da quadrática (separa arestas paralelas do mesmo par). */
  qx: number;
  qy: number;
}
export interface EgoLayout {
  center: { node: ProofNode; x: number; y: number };
  neighbors: LaidNeighbor[];
  edges: LaidEgoEdge[];
  /** vizinhos mostrados (≤ cap) vs. vizinhos reais — truncamento SEMPRE anunciado. */
  shown: number;
  totalNeighbors: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Ego-network 1-hop do `centerId`: vizinhos ordenados por grau (desc, empate
 * por id) com cap anunciado; só arestas INCIDENTES ao centro entram (1-hop
 * estrito — aresta entre dois vizinhos não é prova sobre o centro). Self-loop
 * é descartado (não há como desenhá-lo como raio). Determinístico.
 */
export function buildEgoLayout(
  graph: ProofGraph,
  centerId: string,
  cap: number = EGO_NEIGHBOR_CAP,
): EgoLayout | null {
  const byId = new Map<string, ProofNode>();
  for (const n of graph.nodes) byId.set(n.id, n);
  const center = byId.get(centerId);
  if (!center) return null;

  // arestas incidentes (sem self-loop) + conjunto de vizinhos
  const incident = graph.edges.filter(
    (e) => (e.fromNode === centerId || e.toNode === centerId) && e.fromNode !== e.toNode,
  );
  const neighborIds = new Set<string>();
  for (const e of incident) {
    const other = e.fromNode === centerId ? e.toNode : e.fromNode;
    if (byId.has(other)) neighborIds.add(other);
  }

  const ordered = Array.from(neighborIds)
    .map((id) => byId.get(id)!)
    .sort((a, b) => {
      const da = a.inDegree + a.outDegree;
      const db = b.inDegree + b.outDegree;
      if (db !== da) return db - da;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const kept = ordered.slice(0, Math.max(0, cap));
  const keptIds = new Set(kept.map((n) => n.id));

  const { cx, cy, radius } = EGO_VIEW;
  const n = kept.length;
  const pos = new Map<string, { x: number; y: number }>();
  const neighbors: LaidNeighbor[] = kept.map((node, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    const x = round2(cx + radius * Math.cos(angle));
    const y = round2(cy + radius * Math.sin(angle));
    pos.set(node.id, { x, y });
    return { node, x, y };
  });

  // arestas paralelas do mesmo par recebem controles afastados (recibos distintos)
  const perPair = new Map<string, number>();
  for (const e of incident) {
    const other = e.fromNode === centerId ? e.toNode : e.fromNode;
    if (keptIds.has(other)) perPair.set(other, (perPair.get(other) ?? 0) + 1);
  }
  const pairSeen = new Map<string, number>();

  const edges: LaidEgoEdge[] = [];
  for (const e of incident) {
    const neighborId = e.fromNode === centerId ? e.toNode : e.fromNode;
    const p = pos.get(neighborId);
    if (!p) continue; // vizinho truncado pelo cap — a aresta sai junto (anunciado)
    const outbound = e.fromNode === centerId;
    const x1 = outbound ? cx : p.x;
    const y1 = outbound ? cy : p.y;
    const x2 = outbound ? p.x : cx;
    const y2 = outbound ? p.y : cy;
    const idx = pairSeen.get(neighborId) ?? 0;
    pairSeen.set(neighborId, idx + 1);
    const count = perPair.get(neighborId) ?? 1;
    // deslocamento perpendicular do ponto de controle, centrado no feixe
    const offset = (idx - (count - 1) / 2) * 26;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    edges.push({
      edge: e,
      index: edges.length,
      neighborId,
      outbound,
      x1,
      y1,
      x2,
      y2,
      qx: round2(mx + (-dy / len) * offset),
      qy: round2(my + (dx / len) * offset),
    });
  }

  return {
    center: { node: center, x: cx, y: cy },
    neighbors,
    edges,
    shown: kept.length,
    totalNeighbors: neighborIds.size,
  };
}

// ── O recibo da aresta ────────────────────────────────────────────────
export interface ReceiptEndpoint {
  id: string;
  label: string;
  type?: string;
  sourceFile?: string;
  runtimeHot?: boolean;
  runtimeStale?: boolean;
  /** epoch ms da última observação REAL do NÓ (não da aresta). */
  runtimeLastSeenMs?: number;
}
export interface EdgeReceipt {
  method: EvidenceMethod;
  confidence: number;
  relationType: string;
  resolution?: string;
  synthetic?: boolean;
  observed?: boolean;
  /** nº de traços — `null` quando o payload não trouxe contagem (nunca ×0). */
  count: number | null;
  from: ReceiptEndpoint;
  to: ReceiptEndpoint;
  /** STATIC_UNRESOLVED = heurística de convenção — o recibo manda desconfiar. */
  unresolvedWarning: boolean;
}

function endpointOf(id: string, byId: Map<string, ProofNode>): ReceiptEndpoint {
  const n = byId.get(id);
  if (!n) return { id, label: humanLabel({ id }) };
  return {
    id,
    label: proofLabel(n),
    type: n.type,
    sourceFile: n.sourceFile,
    runtimeHot: n.runtimeHot,
    runtimeStale: n.runtimeStale,
    runtimeLastSeenMs: n.runtimeLastSeenMs,
  };
}

/** Monta o recibo de uma aresta — tudo que o shape REALMENTE traz, nada além. */
export function edgeReceipt(edge: ProofEdge, nodes: readonly ProofNode[]): EdgeReceipt {
  const byId = new Map<string, ProofNode>();
  for (const n of nodes) byId.set(n.id, n);
  const method = evidenceMethodOf(edge);
  return {
    method,
    confidence: evidenceConfidenceOf(edge),
    relationType: edge.relationType,
    resolution: edge.resolution,
    synthetic: edge.synthetic,
    observed: edge.observed,
    count: typeof edge.count === "number" && Number.isFinite(edge.count) ? edge.count : null,
    from: endpointOf(edge.fromNode, byId),
    to: endpointOf(edge.toNode, byId),
    unresolvedWarning: method === "STATIC_UNRESOLVED",
  };
}

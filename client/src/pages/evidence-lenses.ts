// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Uma Geometria, N Lentes" (lógica PURA).
//
// O conceito: a POSIÇÃO dos nós é fixa e determinística (colunas por camada);
// trocar de lente muda SÓ cor/estilo/realce. Assim o olho aprende o mapa uma
// vez e cada lente responde uma pergunta diferente sobre a MESMA geometria.
// A invariância geométrica é travada em teste — é o ponto do conceito.
//
// 4 lentes REAIS (nenhum dado inventado): Evidência · Sensível+Guarda ·
// Calor de runtime · Recência (co-mudança git NÃO existe no Manifest —
// decisão declarada em delivery-risk.ts:284 — então recência é a última
// observação de runtime POR NÓ, com nota na UI).
// ─────────────────────────────────────────────
import {
  EVIDENCE,
  type EvidenceMethod,
  evidenceMethodOf,
  evidenceConfidenceOf,
} from "./system-map-evidence";

// ── Forma mínima do payload /graph que esta vista consome ─────────────
export interface LensNode {
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
export interface LensEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  observed?: boolean;
  count?: number;
  evidence?: { method?: unknown; confidence?: unknown } | null;
}
export interface LensGraph {
  nodes: LensNode[];
  edges: LensEdge[];
}

/** Subconjunto de /permission-governance que a lente Sensível+Guarda usa. */
export interface GovernanceLike {
  unguarded?: Array<{ path?: string; method?: string }>;
}

export type LensId = "evidence" | "sensitive" | "runtime" | "recency";

export const LENSES: readonly { id: LensId; label: string }[] = [
  { id: "evidence", label: "Evidência" },
  { id: "sensitive", label: "Sensível + Guarda" },
  { id: "runtime", label: "Calor de runtime" },
  { id: "recency", label: "Recência" },
] as const;

// ── Geometria fixa: colunas por camada ────────────────────────────────
export const LENS_VIEW = { width: 1000, height: 560 } as const;
export const LENS_NODE_CAP = 400;
const COL_X = [90, 295, 500, 705, 910] as const;
export const LENS_COLUMNS = ["Rotas / Telas", "Controllers", "Services", "Dados", "Outros"] as const;

/** Coluna canônica por tipo de nó (ROUTE/VIEW → CONTROLLER → SERVICE → dados → resto). */
export function lensColumnOf(type: string): number {
  switch (type) {
    case "ROUTE":
    case "VIEW":
      return 0;
    case "CONTROLLER":
      return 1;
    case "SERVICE":
      return 2;
    case "REPOSITORY":
    case "ENTITY":
      return 3;
    default:
      return 4;
  }
}

export interface LaidLensNode {
  node: LensNode;
  column: number;
  x: number;
  y: number;
}
export interface LaidLensEdge {
  edge: LensEdge;
  index: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** ponto de controle da curva quadrática. */
  qx: number;
  qy: number;
}
export interface LensGeometry {
  nodes: LaidLensNode[];
  edges: LaidLensEdge[];
  /** truncamento SEMPRE anunciado: nós mostrados vs. nós reais. */
  shown: number;
  total: number;
  truncated: boolean;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Geometria determinística: cap por grau (anunciado), coluna por camada,
 * espaçamento vertical uniforme dentro da coluna. NÃO recebe a lente — a
 * geometria é a mesma para todas (invariante travada em teste).
 */
export function buildLensGeometry(graph: LensGraph, cap: number = LENS_NODE_CAP): LensGeometry {
  const total = graph.nodes.length;
  const ordered = [...graph.nodes].sort((a, b) => {
    const da = a.inDegree + a.outDegree;
    const db = b.inDegree + b.outDegree;
    if (db !== da) return db - da;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const kept = ordered.slice(0, Math.max(0, cap));

  // agrupa por coluna preservando a ordem determinística (grau desc, id)
  const cols: LensNode[][] = [[], [], [], [], []];
  for (const n of kept) cols[lensColumnOf(n.type)].push(n);

  const { height } = LENS_VIEW;
  const marginY = 48;
  const usable = height - marginY * 2;
  const pos = new Map<string, { x: number; y: number; column: number }>();
  const nodes: LaidLensNode[] = [];
  cols.forEach((colNodes, c) => {
    colNodes.forEach((node, i) => {
      const y =
        colNodes.length === 1
          ? height / 2
          : marginY + (usable * i) / (colNodes.length - 1);
      const laid = { node, column: c, x: COL_X[c], y: round2(y) };
      pos.set(node.id, laid);
      nodes.push(laid);
    });
  });

  const edges: LaidLensEdge[] = [];
  for (const e of graph.edges) {
    const a = pos.get(e.fromNode);
    const b = pos.get(e.toNode);
    if (!a || !b) continue; // ponta truncada pelo cap — a aresta sai junto (anunciado)
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    edges.push({
      edge: e,
      index: edges.length,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      qx: round2(mx),
      qy: round2(my - 36),
    });
  }

  return { nodes, edges, shown: kept.length, total, truncated: kept.length < total };
}

// ── Estilos por lente (cor/realce, NUNCA posição) ─────────────────────
export interface LensNodeStyle {
  fill: string;
  opacity: number;
  /** anel = 2º canal além da cor (WCAG 1.4.1). */
  ring?: { color: string; dash?: string };
  /** raio extra de halo (calor de runtime). */
  halo?: number;
  /** rótulo curto do estado que a lente atribui ao nó. */
  badge?: string;
}
export interface LensEdgeStyle {
  color: string;
  opacity: number;
  dash?: string;
  /** aresta observada em runtime — o componente aplica o pulso (com reduced-motion). */
  pulse?: boolean;
}
export interface LensStyles {
  nodes: LensNodeStyle[];
  edges: LensEdgeStyle[];
}

const NEUTRAL = "#64748b";
const CRITICAL = "#ef4444";
const RUNTIME = "#f43f5e";
const DIMMED = 0.15;

/** Opacidade ∝ confiança: [0.2, 0.95] → [0.28, 0.9] (mesma régua do system-map). */
export function confidenceOpacity(confidence: number): number {
  const c = Math.min(0.95, Math.max(0.2, confidence));
  return round2(0.28 + ((c - 0.2) * (0.9 - 0.28)) / (0.95 - 0.2));
}

/** Tracejado canônico por método (CONFIG 8-3 · UNRESOLVED 4-4 · conjectura pontilhada). */
export function strokeDashOf(method: EvidenceMethod): string | undefined {
  switch (method) {
    case "CONFIG_PROVEN":
      return "8 3";
    case "STATIC_UNRESOLVED":
      return "4 4";
    case "LLM_CONJECTURED":
      return "2 3";
    default:
      return undefined;
  }
}

/** Lente 1 — Evidência: cor da aresta pelo método, opacidade ∝ confiança. */
export function evidenceLens(geom: LensGeometry): LensStyles {
  return {
    nodes: geom.nodes.map(() => ({ fill: NEUTRAL, opacity: 0.85 })),
    edges: geom.edges.map(({ edge }) => {
      const method = evidenceMethodOf(edge);
      return {
        color: EVIDENCE[method].color,
        opacity: confidenceOpacity(evidenceConfidenceOf(edge)),
        dash: strokeDashOf(method),
        pulse: method === "RUNTIME_OBSERVED",
      };
    }),
  };
}

/** O nó ROUTE corresponde a uma rota sem guarda do /permission-governance? */
export function matchesUnguarded(node: LensNode, governance?: GovernanceLike | null): boolean {
  if (node.type !== "ROUTE" || !governance?.unguarded?.length) return false;
  const hay = `${node.className ?? ""} ${node.id}`.toLowerCase();
  return governance.unguarded.some((u) => !!u.path && hay.includes(u.path.toLowerCase()));
}

/**
 * Lente 2 — Sensível + Guarda: nós `sensitive` e rotas sem guarda acesos em
 * anel crítico (traço distinto entre os dois casos — cor nunca é canal único);
 * o resto esmaece. Sem o /permission-governance (degradou), só os sensíveis
 * acendem — nada é inventado.
 */
export function sensitiveLens(geom: LensGeometry, governance?: GovernanceLike | null): LensStyles {
  const lit = new Set<string>();
  const nodes: LensNodeStyle[] = geom.nodes.map(({ node }) => {
    const unguarded = matchesUnguarded(node, governance);
    if (node.sensitive) {
      lit.add(node.id);
      return { fill: CRITICAL, opacity: 1, ring: { color: CRITICAL }, badge: "sensível" };
    }
    if (unguarded) {
      lit.add(node.id);
      return { fill: CRITICAL, opacity: 1, ring: { color: CRITICAL, dash: "4 3" }, badge: "sem guarda" };
    }
    return { fill: NEUTRAL, opacity: DIMMED };
  });
  const edges: LensEdgeStyle[] = geom.edges.map(({ edge }) =>
    lit.has(edge.fromNode) || lit.has(edge.toNode)
      ? { color: CRITICAL, opacity: 0.45 }
      : { color: NEUTRAL, opacity: 0.06 },
  );
  return { nodes, edges };
}

/** Lente 3 — Calor de runtime: halo ∝ nº de traços; quem nunca rodou esmaece. */
export function runtimeLens(geom: LensGeometry): LensStyles {
  const nodes: LensNodeStyle[] = geom.nodes.map(({ node }) => {
    if (node.runtimeHot) {
      const count = node.runtimeCount ?? 0;
      return {
        fill: RUNTIME,
        opacity: 1,
        halo: round2(6 + Math.min(14, Math.log2(count + 1) * 3)),
        badge: count > 0 ? `×${count}` : "tráfego real",
      };
    }
    return { fill: NEUTRAL, opacity: DIMMED };
  });
  const edges: LensEdgeStyle[] = geom.edges.map(({ edge }) => {
    const observed = evidenceMethodOf(edge) === "RUNTIME_OBSERVED" || edge.observed === true;
    return observed
      ? { color: RUNTIME, opacity: 0.75, pulse: true }
      : { color: NEUTRAL, opacity: 0.08 };
  });
  return { nodes, edges };
}

// ── Lente 4 — Recência ────────────────────────────────────────────────
export type RecencyClass = "fresh" | "stale" | "never";

export const RECENCY_META: Record<RecencyClass, { color: string; label: string; ringDash?: string }> = {
  fresh: { color: "#10b981", label: "observado nesta janela" },
  stale: { color: "#f59e0b", label: "visto numa janela anterior", ringDash: "3 3" },
  never: { color: "#94a3b8", label: "nunca observado" },
};

/**
 * Classe de recência POR NÓ, direto do shape: `runtimeStale` = observado numa
 * janela ANTERIOR (last-known-good); hot sem stale = visto nesta janela; o
 * resto NUNCA foi observado (o que é informação, não zero fabricado).
 */
export function recencyClassOf(node: LensNode): RecencyClass {
  if (node.runtimeStale) return "stale";
  if (node.runtimeHot) return "fresh";
  return "never";
}

/** Lente 4 — Recência: fresh saturado, stale âmbar (anel tracejado), nunca-visto cinza. */
export function recencyLens(geom: LensGeometry): LensStyles {
  const nodes: LensNodeStyle[] = geom.nodes.map(({ node }) => {
    const cls = recencyClassOf(node);
    const meta = RECENCY_META[cls];
    return {
      fill: meta.color,
      opacity: cls === "never" ? 0.35 : 1,
      ring: meta.ringDash ? { color: meta.color, dash: meta.ringDash } : undefined,
      badge: meta.label,
    };
  });
  const edges: LensEdgeStyle[] = geom.edges.map(() => ({ color: NEUTRAL, opacity: 0.12 }));
  return { nodes, edges };
}

/** Dispatch único usado pelo componente (e pelos testes de invariância). */
export function applyLens(
  lens: LensId,
  geom: LensGeometry,
  governance?: GovernanceLike | null,
): LensStyles {
  switch (lens) {
    case "evidence":
      return evidenceLens(geom);
    case "sensitive":
      return sensitiveLens(geom, governance);
    case "runtime":
      return runtimeLens(geom);
    case "recency":
      return recencyLens(geom);
  }
}

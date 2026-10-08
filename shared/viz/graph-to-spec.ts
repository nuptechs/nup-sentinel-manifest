/**
 * graph-to-spec.ts — adaptador de dados "grafo/telemetria → spec" (OBS-I02).
 *
 * Fecha a lacuna do ADR-0036 WS-I: hoje os gráficos são alimentados por chat;
 * aqui o GRAFO DE SISTEMA (o payload que a página system-map já renderiza) e a
 * TELEMETRIA de qualidade viram `ChartSpec` validável pela gramática portátil
 * (visual-spec.ts). Funções PURAS, sem React/ECharts/DOM — testáveis sozinhas.
 *
 * Entrada estruturalmente compatível com `GraphPayload` de
 * client/src/pages/system-map.tsx (nós com `type`/`inDegree`, contagens). Não
 * importamos aquele tipo (vive inline no componente); declaramos a FORMA mínima
 * que consumimos, para o adaptador não acoplar à UI.
 */
import {
  chartSpecSchema,
  flowchartSpecSchema,
  type ChartSpec,
  type FlowchartSpec,
  type VisualValidation,
  validateVisualSpec,
} from "./visual-spec";

/* Forma mínima consumida do grafo (subconjunto de GraphPayload). */
export interface GraphNodeLike {
  id: string;
  type: string;
  inDegree?: number;
  outDegree?: number;
  layer?: string;
  label?: string;
}
export interface GraphEdgeLike {
  from: string;
  to: string;
  /** peso/frequência da aresta (nº de chamadas, bytes, latência agregada…). */
  weight?: number;
  label?: string;
}
export interface GraphPayloadLike {
  nodes: GraphNodeLike[];
  edges?: GraphEdgeLike[];
  counts?: { byType?: Record<string, number> };
  byLayer?: Record<string, number>;
}

function countBy<T>(items: T[], key: (t: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function recordToData(rec: Record<string, number>): { label: string; value: number }[] {
  return Object.entries(rec)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));
}

/**
 * Grafo → distribuição de nós por TIPO (barra horizontal). Usa `counts.byType`
 * quando presente (autoritativo); senão conta os nós. Spec já validada.
 */
export function graphNodesByType(payload: GraphPayloadLike): ChartSpec {
  const rec =
    payload.counts?.byType && Object.keys(payload.counts.byType).length > 0
      ? payload.counts.byType
      : countBy(payload.nodes || [], (n) => n.type);
  const data = recordToData(rec);
  return chartSpecSchema.parse({
    type: "horizontalBar",
    title: "Nós por tipo",
    labelKey: "label",
    dataKeys: ["value"],
    data: data.length > 0 ? data : [{ label: "(vazio)", value: 0 }],
    source: payload.counts?.byType ? "system-graph:counts.byType" : "system-graph:nodes",
    format: "integer",
  });
}

/**
 * Grafo → distribuição por CAMADA (barra). Usa `byLayer` quando presente,
 * senão agrega `node.layer`.
 */
export function graphNodesByLayer(payload: GraphPayloadLike): ChartSpec {
  const rec =
    payload.byLayer && Object.keys(payload.byLayer).length > 0
      ? payload.byLayer
      : countBy(payload.nodes || [], (n) => n.layer);
  const data = recordToData(rec);
  return chartSpecSchema.parse({
    type: "bar",
    title: "Nós por camada",
    dataKeys: ["value"],
    data: data.length > 0 ? data : [{ label: "(sem camada)", value: 0 }],
    source: payload.byLayer ? "system-graph:byLayer" : "system-graph:nodes.layer",
    format: "integer",
  });
}

/**
 * Grafo → TOP-N hubs por grau de entrada (os nós mais acoplados). Útil para o
 * painel de saúde: "o que, se quebrar, derruba mais coisa".
 */
export function graphTopHubs(payload: GraphPayloadLike, topN = 10): ChartSpec {
  const data = (payload.nodes || [])
    .map((n) => ({ label: n.id, value: Number(n.inDegree || 0) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(1, topN));
  return chartSpecSchema.parse({
    type: "horizontalBar",
    title: `Top ${Math.max(1, topN)} hubs (grau de entrada)`,
    dataKeys: ["value"],
    data: data.length > 0 ? data : [{ label: "(sem arestas)", value: 0 }],
    source: "system-graph:inDegree",
    format: "integer",
  });
}

/* ----------------------------------------------------------------------------
 * Telemetria de qualidade → gráfico (OBS-I11): taxa rendered/fallback/invalid
 * por família, que é o "corte objetivo" do A/B descrito no ADR.
 * ------------------------------------------------------------------------- */
export interface FamilyQualityRow {
  family: string;
  rendered: number;
  fallback: number;
  invalid: number;
}

export function qualityByFamilySpec(rows: FamilyQualityRow[]): ChartSpec {
  const data = (rows || []).map((r) => ({
    label: r.family,
    rendered: Number(r.rendered || 0),
    fallback: Number(r.fallback || 0),
    invalid: Number(r.invalid || 0),
  }));
  return chartSpecSchema.parse({
    type: "bar",
    title: "Qualidade do visual por família",
    dataKeys: ["rendered", "fallback", "invalid"],
    data: data.length > 0 ? data : [{ label: "(sem telemetria)", rendered: 0, fallback: 0, invalid: 0 }],
    source: "visual-telemetry:quality-by-family",
    format: "integer",
  });
}

/**
 * Grafo → HOT PATHS: as arestas mais pesadas (mais chamadas/tráfego). Barra
 * horizontal rotulada "origem → destino". Entrada é o conjunto de ARESTAS, não
 * só o censo de nós — robustez de I02 (mais tipos de entrada).
 */
export function graphHotPaths(payload: GraphPayloadLike, topN = 10): ChartSpec {
  const data = (payload.edges || [])
    .map((e) => ({ label: `${e.label ? e.label + ": " : ""}${e.from} → ${e.to}`, value: Number(e.weight ?? 0) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(1, topN));
  return chartSpecSchema.parse({
    type: "horizontalBar",
    title: `Top ${Math.max(1, topN)} caminhos quentes`,
    dataKeys: ["value"],
    data: data.length > 0 ? data : [{ label: "(sem arestas com peso)", value: 0 }],
    source: "system-graph:edges.weight",
    format: "integer",
  });
}

/** Um ponto de série temporal: instante ISO + valor (+ nome de série opcional). */
export interface SeriesPoint {
  at: string;
  value: number;
  series?: string;
}

/**
 * Telemetria → SÉRIE TEMPORAL (linha). Agrupa pontos por `series` e usa o
 * instante como rótulo do eixo. Robustez de I02: aceita métrica ao vivo do
 * modelo, não só o censo do grafo. (Dashboards vivos = OBS-I07, bloqueado por
 * infra; aqui entregamos a transformação pura `pontos → spec`.)
 */
export function telemetrySeriesSpec(points: SeriesPoint[], title = "Série temporal"): ChartSpec {
  const seriesNames = Array.from(new Set((points || []).map((p) => p.series || "valor")));
  const byInstant = new Map<string, Record<string, number>>();
  for (const p of points || []) {
    if (!Number.isFinite(p.value)) continue;
    const row = byInstant.get(p.at) || {};
    row[p.series || "valor"] = p.value;
    byInstant.set(p.at, row);
  }
  const data = Array.from(byInstant.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([at, vals]) => {
      const row: Record<string, number | string> = { label: at };
      for (const name of seriesNames) row[name] = Number(vals[name] ?? 0);
      return row;
    });
  return chartSpecSchema.parse({
    type: "line",
    title,
    dataKeys: seriesNames.length > 0 ? seriesNames : ["valor"],
    data: data.length > 0 ? data : [{ label: "(sem pontos)", valor: 0 }],
    source: "telemetry:series",
    format: "number",
  });
}

/**
 * Grafo → FLOWCHART declarativo (ponte I02 → I09): converte nós/arestas do grafo
 * de sistema numa `FlowchartSpec` que o `diagram-compiler` transforma em Mermaid.
 * Limita o tamanho (anti-hairball) usando os `maxNodes` hubs de maior grau.
 */
export function graphToFlowchartSpec(payload: GraphPayloadLike, maxNodes = 40): FlowchartSpec {
  const ranked = [...(payload.nodes || [])].sort(
    (a, b) => Number(b.inDegree ?? 0) + Number(b.outDegree ?? 0) - (Number(a.inDegree ?? 0) + Number(a.outDegree ?? 0)),
  );
  const kept = ranked.slice(0, Math.max(1, maxNodes));
  const keptIds = new Set(kept.map((n) => n.id));
  const nodes = kept.map((n) => ({ id: n.id, label: n.label || n.id, shape: shapeForType(n.type) }));
  const edges = (payload.edges || [])
    .filter((e) => keptIds.has(e.from) && keptIds.has(e.to))
    .map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) }));
  return flowchartSpecSchema.parse({
    kind: "flowchart",
    title: "Grafo de sistema",
    direction: "LR",
    nodes,
    edges,
    source: "system-graph:nodes+edges",
  });
}

function shapeForType(type: string): "box" | "round" | "stadium" | "cylinder" | "diamond" {
  const t = (type || "").toUpperCase();
  if (t.includes("CONTROLLER") || t.includes("ENTRY") || t.includes("ROUTE")) return "stadium";
  if (t.includes("REPOSITORY") || t.includes("DB") || t.includes("TABLE") || t.includes("ENTITY")) return "cylinder";
  if (t.includes("SERVICE") || t.includes("USECASE")) return "round";
  return "box";
}

/**
 * Helper de fronteira: roda um adaptador e devolve o VisualValidation completo
 * (spec + fallback), no mesmo contrato que o host de render consome. Nunca
 * lança — se o adaptador falhar, cai em `invalid` com fallback textual.
 */
export function adaptToValidation(
  build: () => ChartSpec,
  fallback: string,
): VisualValidation<ChartSpec> {
  try {
    const spec = build();
    return validateVisualSpec<ChartSpec>("chart", spec, fallback);
  } catch (err) {
    return {
      family: "chart",
      outcome: "invalid",
      fallback: fallback || "(sem dados)",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

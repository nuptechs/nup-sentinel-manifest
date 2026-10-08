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
import { chartSpecSchema, type ChartSpec, type VisualValidation, validateVisualSpec } from "./visual-spec";

/* Forma mínima consumida do grafo (subconjunto de GraphPayload). */
export interface GraphNodeLike {
  id: string;
  type: string;
  inDegree?: number;
  outDegree?: number;
  layer?: string;
}
export interface GraphPayloadLike {
  nodes: GraphNodeLike[];
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

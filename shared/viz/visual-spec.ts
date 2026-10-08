/**
 * visual-spec.ts — contrato PORTÁTIL da gramática visual (OBS-I01).
 *
 * Extração framework-agnóstica do NÚCLEO da gramática visual do nup-study
 * (client/src/lib/chart-spec.ts, content-detector.ts, visual-telemetry.ts).
 * O que é portátil — e vive AQUI, sem React, sem ECharts, sem DOM:
 *
 *   spec  →  valida  →  (render)  →  fallback
 *   ────     ─────       ──────       ────────
 *   JSON     zod         injetado     texto/alt
 *            (puro)      pelo host     sempre presente
 *
 * A IA (ou, no Sentinel, um ADAPTADOR de dados — ver graph-to-spec.ts) nunca
 * emite código de biblioteca: emite esta SPEC declarativa. O host valida com
 * zod; se válida, entrega ao renderer que ele injetou (Recharts/ECharts no
 * cliente, SVG no servidor); se inválida, usa SEMPRE o `fallback` textual.
 *
 * O que NÃO é portátil (fica no nup-study / no manifest client): os componentes
 * React, os motores (ECharts/Mermaid/Cytoscape), a telemetria via localStorage.
 * Esta lib define o CONTRATO que esses hosts implementam, não os motores.
 *
 * Refs: nup-study docs/adr/ADR-013-gramatica-visual-de-fronteira.md (famílias),
 *       nup-study client/src/lib/chart-spec.ts (união discriminada por `type`).
 */
import { z } from "zod";

/* ----------------------------------------------------------------------------
 * Famílias — eixo de agregação da telemetria de qualidade (OBS-I11).
 * Espelha nup-study visual-telemetry.ts `VisualFamily`.
 * ------------------------------------------------------------------------- */
export const VISUAL_FAMILIES = [
  "chart",
  "mindmap",
  "diagram",
  "math",
  "timeline",
  "table",
  "board",
  "graph",
] as const;
export type VisualFamily = (typeof VISUAL_FAMILIES)[number];

export const CHART_FORMATS = ["number", "percent", "currency", "integer"] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];
const formatSchema = z.enum(CHART_FORMATS).default("number");

/* ----------------------------------------------------------------------------
 * Chart spec — TABULAR, união por `type` (rótulo + séries numéricas).
 * Espelha o subconjunto tabular de nup-study client/src/lib/chart-spec.ts
 * `TABULAR_CHART_TYPES`. Os tipos de FORMA de dado própria (radar/heatmap/
 * treemap/sankey/gauge) têm esquemas dedicados abaixo — juntos fecham o
 * catálogo de 11 tipos (OBS-I03).
 * ------------------------------------------------------------------------- */
export const CHART_TYPES = ["bar", "horizontalBar", "line", "area", "pie", "scatter"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Uma linha de dado tabular: rótulo + uma ou mais séries numéricas. */
const chartDatumSchema = z
  .object({ label: z.string().min(1) })
  .catchall(z.union([z.number(), z.string()]));

export const chartSpecSchema = z.object({
  family: z.literal("chart").default("chart"),
  type: z.enum(CHART_TYPES),
  title: z.string().min(1).max(200),
  /** chave do rótulo em cada datum (default "label"). */
  labelKey: z.string().default("label"),
  /** séries numéricas a plotar (chaves presentes nos data). */
  dataKeys: z.array(z.string().min(1)).min(1),
  data: z.array(chartDatumSchema).min(1),
  /** proveniência: de onde veio o dado (ADR-013 — dado não verificável não renderiza). */
  source: z.string().min(1),
  format: formatSchema,
});
export type ChartSpec = z.infer<typeof chartSpecSchema>;

/* ----------------------------------------------------------------------------
 * Catálogo completo (OBS-I03) — os tipos com FORMA de dado própria. Cada um é
 * uma spec declarativa validável; o compilador puro `echarts-compiler.ts` a
 * transforma em `option` do ECharts SEM tocar no browser.
 * ------------------------------------------------------------------------- */

/** radar — indicadores (eixos) + séries de valores alinhadas aos indicadores. */
export const radarSpecSchema = z.object({
  family: z.literal("chart").default("chart"),
  type: z.literal("radar"),
  title: z.string().min(1).max(200),
  indicators: z.array(z.object({ name: z.string().min(1), max: z.number().positive().optional() })).min(3),
  series: z.array(z.object({ name: z.string().min(1), values: z.array(z.number()).min(3) })).min(1),
  source: z.string().min(1),
  format: formatSchema,
});
export type RadarSpec = z.infer<typeof radarSpecSchema>;

/** heatmap — matriz categórica x/y com célula (x,y,value). */
export const heatmapSpecSchema = z.object({
  family: z.literal("chart").default("chart"),
  type: z.literal("heatmap"),
  title: z.string().min(1).max(200),
  xLabels: z.array(z.string().min(1)).min(1),
  yLabels: z.array(z.string().min(1)).min(1),
  cells: z.array(z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), value: z.number() })).min(1),
  source: z.string().min(1),
  format: formatSchema,
});
export type HeatmapSpec = z.infer<typeof heatmapSpecSchema>;

/** treemap — árvore de nós com valor (hierarquia). */
export interface TreemapNode {
  name: string;
  value?: number;
  children?: TreemapNode[];
}
const treemapNodeSchema: z.ZodType<TreemapNode> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    value: z.number().nonnegative().optional(),
    children: z.array(treemapNodeSchema).optional(),
  }),
);
export const treemapSpecSchema = z.object({
  family: z.literal("chart").default("chart"),
  type: z.literal("treemap"),
  title: z.string().min(1).max(200),
  nodes: z.array(treemapNodeSchema).min(1),
  source: z.string().min(1),
  format: formatSchema,
});
export type TreemapSpec = z.infer<typeof treemapSpecSchema>;

/** sankey — nós nomeados + elos direcionados com valor. */
export const sankeySpecSchema = z.object({
  family: z.literal("chart").default("chart"),
  type: z.literal("sankey"),
  title: z.string().min(1).max(200),
  nodes: z.array(z.object({ name: z.string().min(1) })).min(2),
  links: z.array(z.object({ source: z.string().min(1), target: z.string().min(1), value: z.number().positive() })).min(1),
  source: z.string().min(1),
  format: formatSchema,
});
export type SankeySpec = z.infer<typeof sankeySpecSchema>;

/** gauge — um valor único num intervalo (min..max). */
export const gaugeSpecSchema = z.object({
  family: z.literal("chart").default("chart"),
  type: z.literal("gauge"),
  title: z.string().min(1).max(200),
  value: z.number(),
  min: z.number().default(0),
  max: z.number().default(100),
  unit: z.string().max(20).optional(),
  source: z.string().min(1),
  format: formatSchema,
});
export type GaugeSpec = z.infer<typeof gaugeSpecSchema>;

/** Catálogo completo: 11 tipos de gráfico cobertos pelo compilador puro. */
export const CATALOG_CHART_TYPES = [
  ...CHART_TYPES,
  "radar",
  "heatmap",
  "treemap",
  "sankey",
  "gauge",
] as const;
export type CatalogChartType = (typeof CATALOG_CHART_TYPES)[number];

/** Validador da família `chart` inteira (tabular + formas próprias). */
export const catalogChartSpecSchema = z.union([
  chartSpecSchema,
  radarSpecSchema,
  heatmapSpecSchema,
  treemapSpecSchema,
  sankeySpecSchema,
  gaugeSpecSchema,
]);
export type CatalogChartSpec = z.infer<typeof catalogChartSpecSchema>;

/* ----------------------------------------------------------------------------
 * Diagram spec (OBS-I09) — diagramação DECLARATIVA portátil. A spec vira texto
 * Mermaid/C4 pelo compilador puro `diagram-compiler.ts` (`spec→mermaid/C4`),
 * sem motor de render. Contraparte do gerador server-side a partir do grafo
 * (`server/reasoner/c4/c4-render.ts:toMermaidC4`), mas com o contrato
 * valida→fallback da gramática.
 * ------------------------------------------------------------------------- */
export const DIAGRAM_KINDS = ["flowchart", "c4Context", "c4Container", "sequence"] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

const flowNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  shape: z.enum(["box", "round", "stadium", "cylinder", "diamond"]).default("box"),
});
const flowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  dashed: z.boolean().optional(),
});
export const flowchartSpecSchema = z.object({
  family: z.literal("diagram").default("diagram"),
  kind: z.literal("flowchart"),
  title: z.string().min(1).max(200).optional(),
  direction: z.enum(["TD", "LR", "BT", "RL"]).default("TD"),
  nodes: z.array(flowNodeSchema).min(1),
  edges: z.array(flowEdgeSchema).default([]),
  source: z.string().min(1),
});
export type FlowchartSpec = z.infer<typeof flowchartSpecSchema>;

const c4RelSchema = z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().min(1) });
export const c4ContextSpecSchema = z.object({
  family: z.literal("diagram").default("diagram"),
  kind: z.literal("c4Context"),
  title: z.string().min(1).max(200),
  people: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).default([]),
  systems: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), tag: z.string().optional() })).min(1),
  rels: z.array(c4RelSchema).default([]),
  source: z.string().min(1),
});
export type C4ContextSpec = z.infer<typeof c4ContextSpecSchema>;

export const c4ContainerSpecSchema = z.object({
  family: z.literal("diagram").default("diagram"),
  kind: z.literal("c4Container"),
  title: z.string().min(1).max(200),
  people: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).default([]),
  containers: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1), technology: z.string().optional() }))
    .min(1),
  rels: z.array(c4RelSchema).default([]),
  source: z.string().min(1),
});
export type C4ContainerSpec = z.infer<typeof c4ContainerSpecSchema>;

export const sequenceSpecSchema = z.object({
  family: z.literal("diagram").default("diagram"),
  kind: z.literal("sequence"),
  title: z.string().min(1).max(200).optional(),
  participants: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(1),
  messages: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1), text: z.string().min(1), async: z.boolean().optional() }))
    .min(1),
  source: z.string().min(1),
});
export type SequenceSpec = z.infer<typeof sequenceSpecSchema>;

export const diagramSpecSchema = z.discriminatedUnion("kind", [
  flowchartSpecSchema,
  c4ContextSpecSchema,
  c4ContainerSpecSchema,
  sequenceSpecSchema,
]);
export type DiagramSpec = z.infer<typeof diagramSpecSchema>;

/** Registro de validadores por família. Novas famílias plugam aqui. */
export const SPEC_VALIDATORS: Partial<Record<VisualFamily, z.ZodTypeAny>> = {
  chart: catalogChartSpecSchema,
  diagram: diagramSpecSchema,
};

/* ----------------------------------------------------------------------------
 * Resultado da validação — o contrato spec→valida→fallback.
 * `outcome` é exatamente o eixo da telemetria A/B (OBS-I11): rendered | fallback
 * | invalid, por família.
 * ------------------------------------------------------------------------- */
export type VisualOutcome = "ok" | "invalid";

export interface VisualValidation<T = unknown> {
  family: VisualFamily;
  outcome: VisualOutcome;
  /** spec validada e normalizada (defaults aplicados) quando outcome==="ok". */
  spec?: T;
  /** texto SEMPRE disponível: é o que o host mostra quando não há render. */
  fallback: string;
  /** motivo legível quando outcome==="invalid" (telemetria + log). */
  reason?: string;
}

/**
 * Valida uma spec de uma dada família contra o registro. Nunca lança: devolve
 * sempre um VisualValidation com `fallback` preenchido (contrato: o fallback é
 * obrigatório mesmo em erro — a UI nunca fica em branco).
 *
 * @param family  família da gramática
 * @param raw     objeto candidato (vindo da IA ou de um adaptador de dados)
 * @param fallback texto alternativo obrigatório
 */
export function validateVisualSpec<T = unknown>(
  family: VisualFamily,
  raw: unknown,
  fallback: string,
): VisualValidation<T> {
  const safeFallback = typeof fallback === "string" && fallback.length > 0 ? fallback : "(sem dados)";
  const validator = SPEC_VALIDATORS[family];
  if (!validator) {
    return { family, outcome: "invalid", fallback: safeFallback, reason: `família sem validador: ${family}` };
  }
  const parsed = validator.safeParse(raw);
  if (!parsed.success) {
    return {
      family,
      outcome: "invalid",
      fallback: safeFallback,
      reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { family, outcome: "ok", spec: parsed.data as T, fallback: safeFallback };
}

/* ----------------------------------------------------------------------------
 * Telemetria de qualidade (OBS-I11) — o CONTRATO do evento, não o transporte.
 * O host (cliente via sendBeacon, servidor via métrica) decide como persistir.
 * ------------------------------------------------------------------------- */
export interface VisualQualityEvent {
  family: VisualFamily;
  /** rendered: renderizou; fallback: caiu no texto; invalid: spec rejeitada. */
  outcome: "rendered" | "fallback" | "invalid";
  bucket?: "rich" | "simple";
  reason?: string;
  at: string; // ISO-8601
}

export function makeQualityEvent(
  family: VisualFamily,
  outcome: VisualQualityEvent["outcome"],
  extra: { bucket?: "rich" | "simple"; reason?: string } = {},
): VisualQualityEvent {
  return { family, outcome, at: new Date().toISOString(), ...extra };
}

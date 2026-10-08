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

/* ----------------------------------------------------------------------------
 * Chart spec — subconjunto portátil, união discriminada por `type`.
 * (Catálogo completo de 11 tipos = OBS-I03; aqui selamos o contrato e os tipos
 * tabulares, que é o que o adaptador grafo/telemetria produz.)
 * ------------------------------------------------------------------------- */
export const CHART_TYPES = [
  "bar",
  "horizontalBar",
  "line",
  "area",
  "pie",
  "scatter",
  "heatmap",
  "treemap",
] as const;
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
  format: z.enum(["number", "percent", "currency", "integer"]).default("number"),
});
export type ChartSpec = z.infer<typeof chartSpecSchema>;

/** Registro de validadores por família. Novas famílias plugam aqui. */
export const SPEC_VALIDATORS: Partial<Record<VisualFamily, z.ZodTypeAny>> = {
  chart: chartSpecSchema,
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

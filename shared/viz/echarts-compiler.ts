/**
 * echarts-compiler.ts — compilador PURO `spec → option` do ECharts (OBS-I03).
 *
 * Fecha o catálogo ECharts (11 tipos) como FUNÇÃO PURA: recebe uma spec da
 * gramática portátil (visual-spec.ts), valida com zod e devolve o objeto
 * `option` do ECharts — SEM importar `echarts`, SEM DOM, SEM render no browser.
 * O host (componente React no cliente) injeta o objeto num `<ReactECharts>`; o
 * servidor pode serializá-lo. Aqui vive só a transformação declarativa.
 *
 * Contrato espelha visual-spec.ts: NUNCA lança. Spec inválida → `{ ok:false }`
 * com `fallback` textual SEMPRE presente (a UI nunca fica em branco). É a
 * contraparte, portátil e server-safe, de
 * nup-study client/src/lib/chart-option-compiler.ts:compileChartOption
 * (que importa o TIPO `echarts` e assume paleta de tokens CSS do cliente).
 */
import {
  CATALOG_CHART_TYPES,
  catalogChartSpecSchema,
  type CatalogChartSpec,
  type ChartSpec,
  type GaugeSpec,
  type HeatmapSpec,
  type RadarSpec,
  type SankeySpec,
  type TreemapSpec,
  type TreemapNode,
} from "./visual-spec";

/**
 * Forma estrutural mínima da `option` do ECharts. Deliberadamente um objeto
 * aberto: não importamos os tipos de `echarts` (dependência de browser ausente
 * no manifest) — o host tipa com `EChartsOption` quando injeta.
 */
export type EChartsOption = Record<string, unknown>;

export interface EChartsCompileOptions {
  /** Cores das séries, em ordem. Default: paleta neutra genérica (host sobrescreve). */
  palette?: string[];
  /** Desliga animação (respeita prefers-reduced-motion do host). */
  reducedMotion?: boolean;
  /** A partir de quantos pontos oferecer dataZoom nos cartesianos. */
  dataZoomThreshold?: number;
}

export interface EChartsCompilation {
  ok: boolean;
  type?: string;
  /** `option` pronta para o ECharts quando ok. */
  option?: EChartsOption;
  /** texto alternativo SEMPRE presente (contrato da gramática). */
  fallback: string;
  /** motivo legível quando ok===false. */
  reason?: string;
}

/** Catálogo coberto pelo compilador — espelha CATALOG_CHART_TYPES (11 tipos). */
export const ECHARTS_CATALOG = CATALOG_CHART_TYPES;

const DEFAULT_PALETTE = [
  "#4e79a7",
  "#f28e2b",
  "#59a14f",
  "#e15759",
  "#76b7b2",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
];
const DEFAULT_ZOOM_THRESHOLD = 8;

/* ----------------------------------------------------------------------------
 * Fallback textual — resumo legível de qualquer spec do catálogo. É o que a UI
 * mostra quando não há render (contrato: nunca em branco).
 * ------------------------------------------------------------------------- */
export function chartFallbackText(spec: CatalogChartSpec): string {
  switch (spec.type) {
    case "radar":
      return `${spec.title} — radar com ${spec.indicators.length} eixos e ${spec.series.length} série(s). Fonte: ${spec.source}.`;
    case "heatmap":
      return `${spec.title} — mapa de calor ${spec.xLabels.length}×${spec.yLabels.length} (${spec.cells.length} células). Fonte: ${spec.source}.`;
    case "treemap": {
      const count = countTreeNodes(spec.nodes);
      return `${spec.title} — treemap com ${count} nó(s). Fonte: ${spec.source}.`;
    }
    case "sankey":
      return `${spec.title} — sankey com ${spec.nodes.length} nós e ${spec.links.length} elos. Fonte: ${spec.source}.`;
    case "gauge":
      return `${spec.title} — medidor: ${spec.value}${spec.unit ? " " + spec.unit : ""} (de ${spec.min} a ${spec.max}). Fonte: ${spec.source}.`;
    default: {
      const t = spec as ChartSpec;
      const top = [...t.data]
        .map((d) => `${String(d[t.labelKey] ?? d.label)}: ${t.dataKeys.map((k) => d[k]).join("/")}`)
        .slice(0, 5)
        .join("; ");
      return `${t.title} — ${t.type} com ${t.data.length} ponto(s). ${top}. Fonte: ${t.source}.`;
    }
  }
}

function countTreeNodes(nodes: TreemapNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1 + (node.children ? countTreeNodes(node.children) : 0);
  }
  return n;
}

/* ----------------------------------------------------------------------------
 * Base comum
 * ------------------------------------------------------------------------- */
function baseOption(title: string, opts: Required<EChartsCompileOptions>): EChartsOption {
  return {
    title: { text: title },
    color: opts.palette,
    animation: !opts.reducedMotion,
    tooltip: {},
    aria: { enabled: true, decal: { show: true } },
  };
}

/* ----------------------------------------------------------------------------
 * Compiladores por tipo (puros)
 * ------------------------------------------------------------------------- */
function compileCartesian(spec: ChartSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  const horizontal = spec.type === "horizontalBar";
  const labels = spec.data.map((d) => String(d[spec.labelKey] ?? d.label));
  const categoryAxis = { type: "category", data: labels };
  const valueAxis = { type: "value" };
  const echType = spec.type === "horizontalBar" ? "bar" : spec.type === "area" ? "line" : spec.type;
  const series = spec.dataKeys.map((key) => ({
    name: key,
    type: echType,
    ...(spec.type === "area" ? { areaStyle: {} } : {}),
    data: spec.data.map((d) => Number(d[key] ?? 0)),
  }));
  const option: EChartsOption = {
    ...baseOption(spec.title, opts),
    legend: { data: spec.dataKeys },
    xAxis: horizontal ? valueAxis : categoryAxis,
    yAxis: horizontal ? categoryAxis : valueAxis,
    series,
  };
  if (labels.length >= opts.dataZoomThreshold) {
    option.dataZoom = [{ type: "inside" }, { type: "slider" }];
  }
  return option;
}

function compilePie(spec: ChartSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  const key = spec.dataKeys[0];
  return {
    ...baseOption(spec.title, opts),
    legend: {},
    series: [
      {
        type: "pie",
        radius: "60%",
        data: spec.data.map((d) => ({ name: String(d[spec.labelKey] ?? d.label), value: Number(d[key] ?? 0) })),
      },
    ],
  };
}

function compileScatter(spec: ChartSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  const [xKey, yKey] = spec.dataKeys;
  const yk = yKey ?? xKey;
  return {
    ...baseOption(spec.title, opts),
    xAxis: { type: "value" },
    yAxis: { type: "value" },
    series: [
      {
        type: "scatter",
        data: spec.data.map((d) => [Number(d[xKey] ?? 0), Number(d[yk] ?? 0), String(d[spec.labelKey] ?? d.label)]),
      },
    ],
  };
}

function compileRadar(spec: RadarSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  return {
    ...baseOption(spec.title, opts),
    legend: { data: spec.series.map((s) => s.name) },
    radar: {
      indicator: spec.indicators.map((i) => ({ name: i.name, ...(i.max != null ? { max: i.max } : {}) })),
    },
    series: [{ type: "radar", data: spec.series.map((s) => ({ name: s.name, value: s.values })) }],
  };
}

function compileHeatmap(spec: HeatmapSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  const values = spec.cells.map((c) => c.value);
  return {
    ...baseOption(spec.title, opts),
    xAxis: { type: "category", data: spec.xLabels },
    yAxis: { type: "category", data: spec.yLabels },
    visualMap: { min: Math.min(...values), max: Math.max(...values), calculable: true },
    series: [{ type: "heatmap", data: spec.cells.map((c) => [c.x, c.y, c.value]) }],
  };
}

function compileTreemap(spec: TreemapSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  return {
    ...baseOption(spec.title, opts),
    series: [{ type: "treemap", data: spec.nodes }],
  };
}

function compileSankey(spec: SankeySpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  return {
    ...baseOption(spec.title, opts),
    series: [
      {
        type: "sankey",
        data: spec.nodes.map((n) => ({ name: n.name })),
        links: spec.links.map((l) => ({ source: l.source, target: l.target, value: l.value })),
      },
    ],
  };
}

function compileGauge(spec: GaugeSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  return {
    ...baseOption(spec.title, opts),
    series: [
      {
        type: "gauge",
        min: spec.min,
        max: spec.max,
        data: [{ value: spec.value, name: spec.unit ?? spec.title }],
      },
    ],
  };
}

function buildOption(spec: CatalogChartSpec, opts: Required<EChartsCompileOptions>): EChartsOption {
  switch (spec.type) {
    case "radar":
      return compileRadar(spec, opts);
    case "heatmap":
      return compileHeatmap(spec, opts);
    case "treemap":
      return compileTreemap(spec, opts);
    case "sankey":
      return compileSankey(spec, opts);
    case "gauge":
      return compileGauge(spec, opts);
    case "pie":
      return compilePie(spec, opts);
    case "scatter":
      return compileScatter(spec, opts);
    default:
      return compileCartesian(spec, opts);
  }
}

/**
 * Compila uma spec do catálogo numa `option` do ECharts. Valida com zod; se a
 * spec for inválida (ou a compilação lançar) devolve `{ ok:false }` com
 * `fallback` SEMPRE preenchido. Nunca lança.
 *
 * @param raw      candidato a spec (da IA ou de um adaptador de dados)
 * @param fallback texto alternativo obrigatório (default derivado da spec válida)
 * @param options  paleta/movimento/zoom (host injeta)
 */
export function compileEChartsOption(
  raw: unknown,
  fallback?: string,
  options: EChartsCompileOptions = {},
): EChartsCompilation {
  const opts: Required<EChartsCompileOptions> = {
    palette: options.palette && options.palette.length > 0 ? options.palette : DEFAULT_PALETTE,
    reducedMotion: options.reducedMotion ?? false,
    dataZoomThreshold: options.dataZoomThreshold ?? DEFAULT_ZOOM_THRESHOLD,
  };
  const parsed = catalogChartSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ok: false, fallback: ensureFallback(fallback), reason };
  }
  const spec = parsed.data;
  try {
    const option = buildOption(spec, opts);
    return { ok: true, type: spec.type, option, fallback: ensureFallback(fallback ?? chartFallbackText(spec)) };
  } catch (err) {
    return { ok: false, type: spec.type, fallback: ensureFallback(fallback ?? chartFallbackText(spec)), reason: err instanceof Error ? err.message : String(err) };
  }
}

function ensureFallback(fallback?: string): string {
  return typeof fallback === "string" && fallback.length > 0 ? fallback : "(sem dados)";
}

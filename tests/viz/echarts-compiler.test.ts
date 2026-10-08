/**
 * Testes PUROS do compilador spec→option do ECharts (OBS-I03). Sem motor, sem
 * DOM: só a transformação declarativa e o contrato valida→fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compileEChartsOption,
  chartFallbackText,
  ECHARTS_CATALOG,
} from "../../shared/viz/echarts-compiler.ts";
import { CATALOG_CHART_TYPES, type CatalogChartSpec } from "../../shared/viz/visual-spec.ts";

function opt(res: ReturnType<typeof compileEChartsOption>): Record<string, unknown> {
  assert.equal(res.ok, true, `esperava ok; reason=${res.reason}`);
  assert.ok(res.option, "option presente");
  return res.option as Record<string, unknown>;
}
function seriesOf(option: Record<string, unknown>): Array<Record<string, unknown>> {
  return option.series as Array<Record<string, unknown>>;
}

describe("echarts-compiler — catálogo (11 tipos)", () => {
  it("ECHARTS_CATALOG cobre exatamente os 11 tipos do catálogo", () => {
    assert.equal(ECHARTS_CATALOG.length, 11);
    assert.deepEqual([...ECHARTS_CATALOG], [...CATALOG_CHART_TYPES]);
  });

  const SPECS: Record<string, CatalogChartSpec> = {
    bar: { family: "chart", type: "bar", title: "Barras", labelKey: "label", dataKeys: ["v"], data: [{ label: "a", v: 3 }], source: "t", format: "integer" },
    horizontalBar: { family: "chart", type: "horizontalBar", title: "HB", labelKey: "label", dataKeys: ["v"], data: [{ label: "a", v: 3 }], source: "t", format: "integer" },
    line: { family: "chart", type: "line", title: "Linha", labelKey: "label", dataKeys: ["v"], data: [{ label: "a", v: 3 }], source: "t", format: "number" },
    area: { family: "chart", type: "area", title: "Área", labelKey: "label", dataKeys: ["v"], data: [{ label: "a", v: 3 }], source: "t", format: "number" },
    pie: { family: "chart", type: "pie", title: "Pizza", labelKey: "label", dataKeys: ["v"], data: [{ label: "a", v: 3 }, { label: "b", v: 5 }], source: "t", format: "number" },
    scatter: { family: "chart", type: "scatter", title: "Disp", labelKey: "label", dataKeys: ["x", "y"], data: [{ label: "p", x: 1, y: 2 }], source: "t", format: "number" },
    radar: { family: "chart", type: "radar", title: "Radar", indicators: [{ name: "a" }, { name: "b", max: 10 }, { name: "c" }], series: [{ name: "s1", values: [1, 2, 3] }], source: "t", format: "number" },
    heatmap: { family: "chart", type: "heatmap", title: "Calor", xLabels: ["x1", "x2"], yLabels: ["y1"], cells: [{ x: 0, y: 0, value: 5 }, { x: 1, y: 0, value: 9 }], source: "t", format: "integer" },
    treemap: { family: "chart", type: "treemap", title: "Treemap", nodes: [{ name: "r", value: 10, children: [{ name: "c", value: 4 }] }], source: "t", format: "integer" },
    sankey: { family: "chart", type: "sankey", title: "Sankey", nodes: [{ name: "a" }, { name: "b" }], links: [{ source: "a", target: "b", value: 3 }], source: "t", format: "integer" },
    gauge: { family: "chart", type: "gauge", title: "Medidor", value: 42, min: 0, max: 100, unit: "%", source: "t", format: "percent" },
  };

  for (const type of CATALOG_CHART_TYPES) {
    it(`compila ${type} → option com series e sem lançar`, () => {
      const res = compileEChartsOption(SPECS[type]);
      const option = opt(res);
      assert.equal(res.type, type);
      assert.ok(Array.isArray(option.series), "series é array");
      assert.ok(seriesOf(option).length >= 1);
      assert.ok(typeof res.fallback === "string" && res.fallback.length > 0);
    });
  }

  it("horizontalBar troca os eixos (categoria no y)", () => {
    const option = opt(compileEChartsOption(SPECS.horizontalBar));
    const y = option.yAxis as Record<string, unknown>;
    assert.equal(y.type, "category");
  });

  it("area vira line com areaStyle", () => {
    const option = opt(compileEChartsOption(SPECS.area));
    assert.equal(seriesOf(option)[0].type, "line");
    assert.ok(seriesOf(option)[0].areaStyle);
  });

  it("heatmap carrega visualMap e células [x,y,value]", () => {
    const option = opt(compileEChartsOption(SPECS.heatmap));
    assert.ok(option.visualMap);
    assert.deepEqual((seriesOf(option)[0].data as number[][])[1], [1, 0, 9]);
  });

  it("sankey leva nodes e links", () => {
    const option = opt(compileEChartsOption(SPECS.sankey));
    const s = seriesOf(option)[0];
    assert.equal((s.data as unknown[]).length, 2);
    assert.equal((s.links as unknown[]).length, 1);
  });
});

describe("echarts-compiler — contrato valida→fallback", () => {
  it("spec inválida → ok:false, fallback SEMPRE presente, reason", () => {
    const res = compileEChartsOption({ type: "pizza", title: "" }, "texto alternativo");
    assert.equal(res.ok, false);
    assert.equal(res.fallback, "texto alternativo");
    assert.ok(res.reason && res.reason.length > 0);
    assert.equal(res.option, undefined);
  });

  it("fallback vazio é substituído por marcador", () => {
    const res = compileEChartsOption({}, "");
    assert.equal(res.ok, false);
    assert.equal(res.fallback, "(sem dados)");
  });

  it("gauge inválido (faltando value) não lança", () => {
    assert.doesNotThrow(() => compileEChartsOption({ type: "gauge", title: "x", source: "t" }));
  });

  it("fallback textual derivado quando não passado", () => {
    const res = compileEChartsOption({ type: "gauge", title: "CPU", value: 80, source: "host" });
    assert.equal(res.ok, true);
    assert.match(res.fallback, /CPU/);
    assert.match(res.fallback, /host/);
  });

  it("chartFallbackText resume o sankey", () => {
    const txt = chartFallbackText({ family: "chart", type: "sankey", title: "T", nodes: [{ name: "a" }, { name: "b" }], links: [{ source: "a", target: "b", value: 1 }], source: "s", format: "integer" });
    assert.match(txt, /sankey/);
  });

  it("dataZoom aparece a partir do limiar de pontos", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ label: "p" + i, v: i }));
    const res = compileEChartsOption({ type: "bar", title: "T", dataKeys: ["v"], data: many, source: "t" });
    assert.ok((res.option as Record<string, unknown>).dataZoom);
  });

  it("palette custom é aplicada como color", () => {
    const res = compileEChartsOption(
      { type: "bar", title: "T", dataKeys: ["v"], data: [{ label: "a", v: 1 }], source: "t" },
      undefined,
      { palette: ["#111", "#222"] },
    );
    assert.deepEqual((res.option as Record<string, unknown>).color, ["#111", "#222"]);
  });
});

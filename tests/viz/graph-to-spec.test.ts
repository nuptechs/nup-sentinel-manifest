/**
 * Testes PUROS do adaptador grafo/telemetria→spec e do contrato de validação
 * da gramática visual portátil (OBS-I01/I02). Sem React, sem motor, sem DOM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateVisualSpec,
  chartSpecSchema,
  type ChartSpec,
} from "../../shared/viz/visual-spec.ts";
import {
  graphNodesByType,
  graphNodesByLayer,
  graphTopHubs,
  graphHotPaths,
  telemetrySeriesSpec,
  graphToFlowchartSpec,
  qualityByFamilySpec,
  adaptToValidation,
  type GraphPayloadLike,
} from "../../shared/viz/graph-to-spec.ts";

const SAMPLE: GraphPayloadLike = {
  nodes: [
    { id: "a", type: "CONTROLLER", inDegree: 2, outDegree: 3, layer: "web" },
    { id: "b", type: "SERVICE", inDegree: 5, outDegree: 1, layer: "domain" },
    { id: "c", type: "SERVICE", inDegree: 0, layer: "domain" },
    { id: "d", type: "REPOSITORY", inDegree: 3, layer: "data" },
  ],
  edges: [
    { from: "a", to: "b", weight: 120, label: "chama" },
    { from: "b", to: "d", weight: 40 },
    { from: "a", to: "d", weight: 5 },
  ],
  counts: { byType: { CONTROLLER: 1, SERVICE: 2, REPOSITORY: 1 } },
  byLayer: { web: 1, domain: 2, data: 1 },
};

describe("visual-spec — contrato spec→valida→fallback", () => {
  it("spec válida → outcome ok, defaults aplicados, fallback preservado", () => {
    const res = validateVisualSpec<ChartSpec>(
      "chart",
      { type: "bar", title: "X", dataKeys: ["value"], data: [{ label: "a", value: 1 }], source: "t" },
      "fallback textual",
    );
    assert.equal(res.outcome, "ok");
    assert.equal(res.spec?.labelKey, "label", "default aplicado");
    assert.equal(res.spec?.format, "number");
    assert.equal(res.fallback, "fallback textual");
  });

  it("spec inválida → invalid + fallback SEMPRE presente + reason", () => {
    const res = validateVisualSpec("chart", { type: "pizza", title: "", dataKeys: [] }, "texto alt");
    assert.equal(res.outcome, "invalid");
    assert.equal(res.fallback, "texto alt");
    assert.ok(res.reason && res.reason.length > 0);
    assert.equal(res.spec, undefined);
  });

  it("fallback vazio é substituído por marcador (UI nunca em branco)", () => {
    const res = validateVisualSpec("chart", {}, "");
    assert.equal(res.outcome, "invalid");
    assert.equal(res.fallback, "(sem dados)");
  });

  it("família sem validador → invalid, não lança", () => {
    const res = validateVisualSpec("mindmap" as never, {}, "alt");
    assert.equal(res.outcome, "invalid");
    assert.match(res.reason || "", /sem validador/);
  });
});

describe("graph-to-spec — adaptadores puros", () => {
  it("graphNodesByType usa counts.byType autoritativo, ordenado desc", () => {
    const spec = graphNodesByType(SAMPLE);
    assert.equal(spec.type, "horizontalBar");
    assert.equal(spec.source, "system-graph:counts.byType");
    assert.equal(spec.data[0].label, "SERVICE", "maior contagem primeiro");
    assert.equal(spec.data[0].value, 2);
    // produz spec que a própria gramática valida
    assert.equal(validateVisualSpec("chart", spec, "x").outcome, "ok");
  });

  it("graphNodesByType sem counts → conta os nós", () => {
    const spec = graphNodesByType({ nodes: SAMPLE.nodes });
    assert.equal(spec.source, "system-graph:nodes");
    const svc = spec.data.find((d) => d.label === "SERVICE");
    assert.equal(svc?.value, 2);
  });

  it("graphNodesByLayer agrega por camada", () => {
    const spec = graphNodesByLayer(SAMPLE);
    assert.equal(spec.source, "system-graph:byLayer");
    assert.equal(spec.data.find((d) => d.label === "domain")?.value, 2);
  });

  it("graphTopHubs ordena por inDegree e respeita topN", () => {
    const spec = graphTopHubs(SAMPLE, 2);
    assert.equal(spec.data.length, 2);
    assert.equal(spec.data[0].label, "b");
    assert.equal(spec.data[0].value, 5);
  });

  it("grafo vazio → spec ainda VÁLIDA com placeholder (nunca quebra o host)", () => {
    const spec = graphNodesByType({ nodes: [] });
    assert.doesNotThrow(() => chartSpecSchema.parse(spec));
    assert.equal(spec.data.length, 1);
  });

  it("qualityByFamilySpec vira barra multi-série (rendered/fallback/invalid)", () => {
    const spec = qualityByFamilySpec([
      { family: "chart", rendered: 90, fallback: 8, invalid: 2 },
      { family: "board", rendered: 40, fallback: 55, invalid: 5 },
    ]);
    assert.deepEqual(spec.dataKeys, ["rendered", "fallback", "invalid"]);
    assert.equal((spec.data[0] as Record<string, number>).rendered, 90);
    assert.equal(validateVisualSpec("chart", spec, "x").outcome, "ok");
  });

  it("adaptToValidation encapsula erro do adaptador em invalid+fallback", () => {
    const res = adaptToValidation(() => {
      throw new Error("boom");
    }, "alt");
    assert.equal(res.outcome, "invalid");
    assert.equal(res.fallback, "alt");
    assert.match(res.reason || "", /boom/);
  });

  it("adaptToValidation caminho feliz → ok com spec", () => {
    const res = adaptToValidation(() => graphTopHubs(SAMPLE, 3), "alt");
    assert.equal(res.outcome, "ok");
    assert.equal(res.spec?.title, "Top 3 hubs (grau de entrada)");
  });
});

describe("graph-to-spec — novos tipos de entrada (robustez I02)", () => {
  it("graphHotPaths ranqueia arestas por peso, rótulo origem→destino", () => {
    const spec = graphHotPaths(SAMPLE, 2);
    assert.equal(spec.source, "system-graph:edges.weight");
    assert.equal(spec.data.length, 2);
    assert.equal(spec.data[0].value, 120);
    assert.match(String(spec.data[0].label), /a → b/);
    assert.equal(validateVisualSpec("chart", spec, "x").outcome, "ok");
  });

  it("graphHotPaths sem arestas → placeholder válido", () => {
    const spec = graphHotPaths({ nodes: [] });
    assert.doesNotThrow(() => chartSpecSchema.parse(spec));
    assert.equal(spec.data.length, 1);
  });

  it("telemetrySeriesSpec agrupa por série e ordena por instante", () => {
    const spec = telemetrySeriesSpec([
      { at: "2026-01-01T00:00:00Z", value: 10, series: "cpu" },
      { at: "2026-01-01T00:00:00Z", value: 2, series: "err" },
      { at: "2026-01-01T00:01:00Z", value: 20, series: "cpu" },
    ]);
    assert.equal(spec.type, "line");
    assert.deepEqual(spec.dataKeys.sort(), ["cpu", "err"]);
    assert.equal(spec.data.length, 2, "dois instantes distintos");
    assert.equal((spec.data[1] as Record<string, number>).cpu, 20);
    assert.equal(validateVisualSpec("chart", spec, "x").outcome, "ok");
  });

  it("telemetrySeriesSpec vazio → placeholder válido", () => {
    const spec = telemetrySeriesSpec([]);
    assert.doesNotThrow(() => chartSpecSchema.parse(spec));
  });

  it("graphToFlowchartSpec faz ponte grafo→diagrama (I02→I09), anti-hairball", () => {
    const spec = graphToFlowchartSpec(SAMPLE, 3);
    assert.equal(spec.kind, "flowchart");
    assert.equal(spec.nodes.length, 3, "limita aos 3 maiores hubs");
    // só mantém arestas entre nós mantidos
    for (const e of spec.edges) {
      assert.ok(spec.nodes.some((n) => n.id === e.from));
      assert.ok(spec.nodes.some((n) => n.id === e.to));
    }
    // shape derivado do tipo
    assert.equal(spec.nodes.find((n) => n.id === "a")?.shape, "stadium");
  });
});

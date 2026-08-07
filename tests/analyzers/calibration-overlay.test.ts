import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCalibrationOverlay } from "../../server/analyzers/calibration-overlay";
import type { CalibratableEdge } from "../../server/analyzers/calibration";

// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 — orquestrador fim-a-fim: arestas modeladas → confiança efetiva por
// método + completude. Prova o GATE de honestidade: método calibrado usa a
// MEDIDA; método sem massa/oráculo cai no peso FIXO (byte-a-byte).
// ─────────────────────────────────────────────────────────────────────────

// pesos fixos de projeto (espelham `classifyEdgeEvidence` do system-graph)
const FIXED = {
  RUNTIME_OBSERVED: 0.95,
  STATIC_PROVEN: 0.8,
  CONFIG_PROVEN: 0.78,
  STATIC_UNRESOLVED: 0.4,
  UNKNOWN: 0.2,
};

/** N arestas STATIC_UNRESOLVED, das quais `confirmed` também aparecem como runtime. */
function buildGraph(nStatic: number, confirmed: number): CalibratableEdge[] {
  const edges: CalibratableEdge[] = [];
  for (let i = 0; i < nStatic; i++) {
    const from = `S${i}`;
    const to = `T${i}`;
    edges.push({ fromNode: from, toNode: to, evidence: { method: "STATIC_UNRESOLVED" } });
    if (i < confirmed) {
      // MESMO par observado no runtime → confirma a aresta estática
      edges.push({ fromNode: from, toNode: to, evidence: { method: "RUNTIME_OBSERVED" } });
    }
  }
  return edges;
}

describe("buildCalibrationOverlay — gate de honestidade", () => {
  it("método calibrado usa a MEDIDA (0.3), não o peso fixo (0.4)", () => {
    // 100 estáticas, 30 confirmadas pelo runtime → taxa medida 0.30
    const overlay = buildCalibrationOverlay(buildGraph(100, 30), FIXED, { minSamples: 30 });
    assert.equal(overlay.calibration.hasRuntimeGroundTruth, true);
    const eff = overlay.effectiveConfidenceByMethod["STATIC_UNRESOLVED"];
    assert.equal(eff.source, "calibrated");
    assert.equal(eff.confidence, 0.3, "usa a MEDIDA");
    assert.equal(eff.fixed, 0.4, "guarda o fixo p/ o 'antes'");
    assert.ok(eff.confidence < eff.fixed, "0.30 medido < 0.40 chutado — o ponto da ADR");
  });

  it("sem oráculo de runtime → cai no peso FIXO (byte-a-byte), source='fixed'", () => {
    const overlay = buildCalibrationOverlay(buildGraph(100, 0), FIXED, { minSamples: 30 });
    assert.equal(overlay.calibration.hasRuntimeGroundTruth, false);
    const eff = overlay.effectiveConfidenceByMethod["STATIC_UNRESOLVED"];
    assert.equal(eff.source, "fixed");
    assert.equal(eff.confidence, 0.4, "peso fixo preservado");
  });

  it("amostra rala (n<minSamples) → peso FIXO", () => {
    const overlay = buildCalibrationOverlay(buildGraph(5, 4), FIXED, { minSamples: 30 });
    const eff = overlay.effectiveConfidenceByMethod["STATIC_UNRESOLVED"];
    assert.equal(eff.source, "fixed");
    assert.equal(eff.confidence, 0.4);
  });

  it("RUNTIME_OBSERVED é o oráculo — confiança 1.0/fixa, nunca calibrado contra si", () => {
    const overlay = buildCalibrationOverlay(buildGraph(50, 20), FIXED, { minSamples: 1 });
    const eff = overlay.effectiveConfidenceByMethod["RUNTIME_OBSERVED"];
    assert.equal(eff.source, "fixed");
    assert.equal(eff.confidence, 0.95);
  });

  it("também expõe completude (Chao2) do mesmo grafo", () => {
    const overlay = buildCalibrationOverlay(buildGraph(100, 30), FIXED);
    assert.ok(overlay.completeness.observed > 0);
    assert.equal(overlay.completeness.detail.estimator, "chao2");
    // 2 métodos (STATIC_UNRESOLVED + RUNTIME_OBSERVED); pares confirmados = doubletons
    assert.equal(overlay.completeness.detail.methods, 2);
  });
});

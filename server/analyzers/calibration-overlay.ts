// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 — ORQUESTRADOR (puro) da camada de calibração. É o ÚNICO ponto de
// entrada que o consumidor do `/graph` chama: recebe as arestas JÁ MODELADAS do
// systemGraph, mede a confiabilidade por método contra o oráculo de runtime e
// estima a completude do mapa. NÃO importa nada de `system-graph.ts` (recebe os
// pesos fixos por parâmetro) — assim não acopla ao bloco de classificação que
// está sendo editado em paralelo (WS1). Sem express, sem storage: testável.
// ─────────────────────────────────────────────────────────────────────────

import {
  calibrateMethodReliability,
  deriveSamplesFromEdges,
  type CalibratableEdge,
  type CalibrationResult,
} from "./calibration";
import {
  estimateCompleteness,
  deriveEdgesByMethod,
  type CompletenessResult,
} from "./completeness-estimator";

export interface CalibrationOverlayOptions {
  /** miscoverage do intervalo de calibração; default 0.1 (via calibration.ts). */
  alpha?: number;
  /** n mínimo p/ calibrar um método; default 30 (via calibration.ts). */
  minSamples?: number;
  /** miscoverage do IC de completude; default 0.05 (via completeness-estimator.ts). */
  completenessAlpha?: number;
}

/**
 * Confiança EFETIVA por método: a calibrada (MEDIDA) quando o método passou no
 * gate de honestidade; senão o peso FIXO do método (byte-a-byte). É este número
 * que o cliente usa por aresta — sem tocar o shape de `ShapedEdge`.
 */
export interface EffectiveMethodConfidence {
  /** confiança a usar (∈ [0,1]). */
  confidence: number;
  /** de onde veio: `calibrated` (medido) ou `fixed` (o peso de projeto). */
  source: "calibrated" | "fixed";
  /** peso fixo de referência (para a UI mostrar o "antes"). */
  fixed: number;
}

export interface CalibrationOverlay {
  /** confiabilidade por método + o gate `hasRuntimeGroundTruth`. */
  calibration: CalibrationResult;
  /** completude do conjunto de arestas (Chao2 + IC). */
  completeness: CompletenessResult;
  /**
   * método → confiança efetiva a APLICAR por aresta. O consumidor faz
   * `effectiveConfidenceByMethod[edge.evidence.method]` para exibir a confiança
   * calibrada (ou o fixo) sem alterar `ShapedEdge`.
   */
  effectiveConfidenceByMethod: Record<string, EffectiveMethodConfidence>;
}

/**
 * Compõe calibração + completude a partir das arestas modeladas. `fixedWeights`
 * = os pesos de projeto por método (o caller passa; NÃO importamos de
 * system-graph p/ não acoplar ao bloco em edição). Puro e determinístico.
 */
export function buildCalibrationOverlay(
  edges: CalibratableEdge[],
  fixedWeights: Record<string, number>,
  opts?: CalibrationOverlayOptions,
): CalibrationOverlay {
  const { samples, runtimeOracleSize } = deriveSamplesFromEdges(edges);
  const calibration = calibrateMethodReliability(samples, {
    runtimeOracleSize,
    ...(opts?.alpha !== undefined ? { alpha: opts.alpha } : {}),
    ...(opts?.minSamples !== undefined ? { minSamples: opts.minSamples } : {}),
  });

  const completeness = estimateCompleteness(
    deriveEdgesByMethod(edges),
    opts?.completenessAlpha !== undefined ? { alpha: opts.completenessAlpha } : undefined,
  );

  // confiança efetiva por método presente no grafo (estáticos calibráveis +
  // RUNTIME_OBSERVED, que é o oráculo — confiança 1.0 por definição).
  const methodsPresent = new Set<string>(edges.map((e) => e.evidence.method));
  const effectiveConfidenceByMethod: Record<string, EffectiveMethodConfidence> = {};
  for (const method of methodsPresent) {
    const fixed = fixedWeights[method] ?? 0;
    if (method === "RUNTIME_OBSERVED") {
      // o oráculo não se calibra contra si mesmo — é o ground-truth.
      effectiveConfidenceByMethod[method] = { confidence: fixed || 1, source: "fixed", fixed: fixed || 1 };
      continue;
    }
    const m = calibration.byMethod[method];
    if (m && m.calibrated) {
      effectiveConfidenceByMethod[method] = { confidence: m.reliability, source: "calibrated", fixed };
    } else {
      // gate reprovou (sem oráculo / amostra rala) → peso fixo, byte-a-byte.
      effectiveConfidenceByMethod[method] = { confidence: fixed, source: "fixed", fixed };
    }
  }

  return { calibration, completeness, effectiveConfidenceByMethod };
}

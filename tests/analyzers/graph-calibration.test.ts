import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraphCalibration,
  deriveFixedWeights,
  countComparableOraclePairs,
  type CalibrationInputEdge,
} from "../../server/analyzers/graph-calibration";
import { shapeSystemGraph } from "../../server/analyzers/system-graph";

// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 — a FIAÇÃO da calibração no /graph. O que estes testes protegem:
//  1. o gate de COMPARABILIDADE (o oráculo fragmentado do hub real não pode
//     virar "0% confirmado"), inclusive REBAIXANDO byMethod/effective;
//  2. a calibração de verdade quando o oráculo é comparável;
//  3. os pesos fixos lidos das próprias arestas (anti-drift com system-graph).
// ─────────────────────────────────────────────────────────────────────────

const edge = (from: string, to: string, method: string, confidence: number): CalibrationInputEdge => ({
  fromNode: from,
  toNode: to,
  evidence: { method, confidence },
});

/** N arestas estáticas a partir de origens REAIS; `confirmed` delas repetidas como runtime. */
function comparableGraph(n: number, confirmed: number): CalibrationInputEdge[] {
  const out: CalibrationInputEdge[] = [];
  for (let i = 0; i < n; i++) {
    out.push(edge(`SERVICE:S${i}`, `ENTITY:T${i}`, "STATIC_UNRESOLVED", 0.4));
    if (i < confirmed) out.push(edge(`SERVICE:S${i}`, `ENTITY:T${i}`, "RUNTIME_OBSERVED", 0.95));
  }
  return out;
}

/** O caso REAL do hub: runtime só a partir de fonte sintética `runtime:db:*`. */
function fragmentGraph(nStatic: number, nRuntime: number): CalibrationInputEdge[] {
  const out: CalibrationInputEdge[] = [];
  for (let i = 0; i < nStatic; i++) out.push(edge(`SERVICE:S${i}`, `ENTITY:T${i}`, "STATIC_PROVEN", 0.8));
  for (let i = 0; i < nRuntime; i++) out.push(edge("runtime:db:backend", `ENTITY:T${i}`, "RUNTIME_OBSERVED", 0.95));
  return out;
}

describe("buildGraphCalibration — abstenção honesta", () => {
  it("sem arestas: abstém nomeando o motivo", () => {
    const c = buildGraphCalibration([]);
    assert.equal(c.calibrated, false);
    assert.match(c.reason!, /sem arestas/i);
  });

  it("sem oráculo de runtime: abstém e diz que NÃO é 0% — é não-medido", () => {
    const c = buildGraphCalibration(comparableGraph(50, 0));
    assert.equal(c.calibrated, false);
    assert.equal(c.hasRuntimeGroundTruth, false);
    assert.match(c.reason!, /não-medido/i);
    // e a confiança efetiva volta ao peso FIXO (byte-a-byte)
    assert.equal(c.effectiveConfidenceByMethod.STATIC_UNRESOLVED.source, "fixed");
    assert.equal(c.effectiveConfidenceByMethod.STATIC_UNRESOLVED.confidence, 0.4);
  });

  it("oráculo INCOMPARÁVEL (traço fragmentado) abstém — o gate que faltava", () => {
    // 100 estáticas + 24 runtime a partir de `runtime:db:*` (nenhuma estática
    // parte dali) → o oráculo existe mas não pode confirmar NADA.
    const c = buildGraphCalibration(fragmentGraph(100, 24));
    assert.equal(c.hasRuntimeGroundTruth, true, "o oráculo EXISTE");
    assert.equal(c.runtimeOracleSize, 24);
    assert.equal(c.oracleComparablePairs, 0, "…mas nenhum par é comparável");
    assert.equal(c.calibrated, false);
    assert.match(c.reason!, /incompar/i);
  });

  it("REBAIXA byMethod e a confiança efetiva quando incomparável (não publica 0%)", () => {
    // sem o rebaixamento, STATIC_PROVEN teria n=100 ≥ 30 e reliability=0 →
    // o consumidor aplicaria confiança 0.0. Este é o teste que falha no código ingênuo.
    const c = buildGraphCalibration(fragmentGraph(100, 24));
    const m = c.byMethod.STATIC_PROVEN;
    assert.equal(m.calibrated, false);
    assert.match(m.abstainReason!, /incompar/i);
    assert.equal(m.n, 100, "os números MEDIDOS ficam visíveis — o que muda é o veredito");
    assert.equal(m.reliability, 0);
    assert.equal(c.effectiveConfidenceByMethod.STATIC_PROVEN.source, "fixed");
    assert.equal(c.effectiveConfidenceByMethod.STATIC_PROVEN.confidence, 0.8);
  });

  it("amostra rala com oráculo comparável: abstém por massa insuficiente", () => {
    const c = buildGraphCalibration(comparableGraph(10, 5));
    assert.equal(c.hasRuntimeGroundTruth, true);
    assert.ok(c.oracleComparablePairs > 0);
    assert.equal(c.calibrated, false);
    assert.match(c.reason!, /amostra insuficiente/i);
  });
});

describe("buildGraphCalibration — mede quando PODE medir", () => {
  it("oráculo comparável + massa: publica taxa e intervalo exato", () => {
    // 100 estáticas, 30 confirmadas → p̂ = 0.30 (contra o peso fixo 0.40)
    const c = buildGraphCalibration(comparableGraph(100, 30));
    assert.equal(c.calibrated, true);
    assert.equal(c.reason, undefined);
    assert.equal(c.oracleComparablePairs, 30);
    const m = c.byMethod.STATIC_UNRESOLVED;
    assert.equal(m.calibrated, true);
    assert.equal(m.reliability, 0.3);
    assert.ok(m.lower < 0.3 && m.upper > 0.3, "intervalo contém a taxa pontual");
    assert.ok(m.width > 0 && m.width < 0.4, `intervalo plausível (width=${m.width})`);
    // a confiança EFETIVA passa a ser a medida, não o peso de projeto
    assert.equal(c.effectiveConfidenceByMethod.STATIC_UNRESOLVED.source, "calibrated");
    assert.equal(c.effectiveConfidenceByMethod.STATIC_UNRESOLVED.confidence, 0.3);
    assert.equal(c.effectiveConfidenceByMethod.STATIC_UNRESOLVED.fixed, 0.4);
  });

  it("declara o NÍVEL dos intervalos (90% calibração / 95% completude)", () => {
    const c = buildGraphCalibration(comparableGraph(100, 30));
    assert.equal(c.confidenceLevelPct, 90);
    assert.equal(c.completenessLevelPct, 95);
    const c2 = buildGraphCalibration(comparableGraph(100, 30), { alpha: 0.05, completenessAlpha: 0.1 });
    assert.equal(c2.confidenceLevelPct, 95);
    assert.equal(c2.completenessLevelPct, 90);
  });

  it("completude Chao sai junto, com o próprio selo de confiabilidade", () => {
    const c = buildGraphCalibration(comparableGraph(100, 30));
    assert.equal(c.completeness.observed, 100, "100 pares distintos");
    assert.ok(c.completeness.estimatedTotal >= 100);
    assert.equal(typeof c.completeness.detail.reliable, "boolean");
  });

  it("completude NÃO é publicada quando os métodos são partição (o bug dos 34 milhões)", () => {
    // Forma do grafo REAL: cada aresta tem UM método; nenhum par é detectado por
    // dois métodos. Chao então extrapola f1 e estima milhões de arestas faltando.
    const edges: CalibrationInputEdge[] = [];
    for (let i = 0; i < 2000; i++) edges.push(edge(`S${i}`, `T${i}`, "STATIC_PROVEN", 0.8));
    for (let i = 0; i < 500; i++) edges.push(edge(`U${i}`, `V${i}`, "STATIC_UNRESOLVED", 0.4));
    const c = buildGraphCalibration(edges);
    assert.equal(c.methodOverlapShare, 0, "partição pura: nenhuma aresta vista por 2 métodos");
    assert.equal(c.completenessApplicable, false);
    assert.match(c.completenessReason!, /mutuamente exclusiv/i);
    // o número absurdo continua no payload (inspeção), mas marcado como inaplicável
    assert.ok(c.completeness.estimatedTotal > 1e6, "o estimador de fato explode — por isso o gate existe");
  });

  it("completude ACENDE quando há detecção redundante de verdade", () => {
    // 100 pares; 20 deles detectados por DOIS métodos (redundância real).
    const edges: CalibrationInputEdge[] = [];
    for (let i = 0; i < 100; i++) {
      edges.push(edge(`S${i}`, `T${i}`, "STATIC_PROVEN", 0.8));
      if (i < 20) edges.push(edge(`S${i}`, `T${i}`, "CONFIG_PROVEN", 0.78));
    }
    const c = buildGraphCalibration(edges);
    assert.equal(c.methodOverlapShare, 0.2);
    assert.equal(c.completenessApplicable, true);
    assert.equal(c.completenessReason, undefined);
    assert.ok(c.completeness.estimatedTotal >= c.completeness.observed);
  });

  it("o oráculo nunca se calibra contra si mesmo", () => {
    const c = buildGraphCalibration(comparableGraph(100, 30));
    assert.equal(c.effectiveConfidenceByMethod.RUNTIME_OBSERVED.source, "fixed");
    assert.equal(c.byMethod.RUNTIME_OBSERVED, undefined);
  });
});

describe("pesos fixos — uma fonte só, lida das arestas", () => {
  it("deriveFixedWeights lê a 1ª confiança de cada método", () => {
    const w = deriveFixedWeights([
      edge("a", "b", "STATIC_PROVEN", 0.8),
      edge("c", "d", "STATIC_PROVEN", 0.8),
      edge("e", "f", "CONFIG_PROVEN", 0.78),
    ]);
    assert.deepEqual(w, { STATIC_PROVEN: 0.8, CONFIG_PROVEN: 0.78 });
  });

  it("ANTI-DRIFT: os pesos batem com o que o shapeSystemGraph emite hoje", () => {
    // Se alguém mudar `classifyEdgeEvidence` em system-graph.ts, este teste
    // continua verde (os pesos vêm de lá) — mas prova que a fiação NÃO tem uma
    // 2ª tabela de pesos para apodrecer.
    const shaped = shapeSystemGraph({
      nodes: [
        { id: "A", type: "SERVICE" },
        { id: "B", type: "ENTITY" },
        { id: "C", type: "REPOSITORY" },
      ],
      edges: [
        { fromNode: "A", toNode: "B", relationType: "CALLS", metadata: { resolution: "compiler" } },
        { fromNode: "C", toNode: "B", relationType: "DI_RESOLVES", metadata: { configProven: true } },
        { fromNode: "A", toNode: "C", relationType: "CALLS", metadata: { synthetic: true } },
      ],
    });
    const w = deriveFixedWeights(shaped.edges);
    assert.equal(w.STATIC_PROVEN, 0.8);
    assert.equal(w.CONFIG_PROVEN, 0.78);
    assert.equal(w.STATIC_UNRESOLVED, 0.4);
  });
});

describe("countComparableOraclePairs", () => {
  it("conta só o par observado cuja ORIGEM o estático conhece", () => {
    const edges = [
      edge("SERVICE:S", "ENTITY:T", "STATIC_PROVEN", 0.8),
      edge("SERVICE:S", "ENTITY:T", "RUNTIME_OBSERVED", 0.95), // comparável
      edge("runtime:db:x", "ENTITY:T", "RUNTIME_OBSERVED", 0.95), // não
    ];
    assert.equal(countComparableOraclePairs(edges), 1);
  });
});

describe("contrato ADITIVO do /graph", () => {
  it("a calibração só ACRESCENTA `coverage.calibration` — nada existente muda", () => {
    const shaped = shapeSystemGraph({
      nodes: [
        { id: "A", type: "SERVICE" },
        { id: "B", type: "ENTITY" },
      ],
      edges: [{ fromNode: "A", toNode: "B", relationType: "CALLS", metadata: { resolution: "compiler" } }],
    });
    // exatamente a composição que o handler do /graph faz
    const payload = { ...shaped, coverage: { ...shaped.coverage, calibration: buildGraphCalibration(shaped.edges) } };

    const { calibration, ...coverageSemCalibracao } = payload.coverage as Record<string, unknown>;
    assert.ok(calibration, "a seção nova está lá");
    assert.deepEqual(coverageSemCalibracao, shaped.coverage, "o censo antigo é byte-a-byte");
    const { coverage: _a, ...restoNovo } = payload as Record<string, unknown>;
    const { coverage: _b, ...restoAntigo } = shaped as Record<string, unknown>;
    assert.deepEqual(restoNovo, restoAntigo, "nós, arestas, counts, byLayer/byStack intactos");
  });
});

describe("buildGraphCalibration — nunca lança", () => {
  it("entrada malformada degrada para abstenção", () => {
    for (const bad of [null, undefined, [null, undefined, { fromNode: "a" }] as never]) {
      const c = buildGraphCalibration(bad as never);
      assert.equal(c.calibrated, false);
      assert.ok(c.reason);
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calibrateMethodReliability,
  deriveSamplesFromEdges,
  clopperPearson,
  regularizedIncompleteBeta,
  betaQuantile,
  logGamma,
  type CalibrationSample,
  type CalibratableEdge,
} from "../../server/analyzers/calibration";

// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 — provas SINTÉTICAS de que a matemática da calibração está correta.
// O runtime é o oráculo; cada método estático é medido contra ele. Números
// colados: método 90%→~0.9, 30%→~0.3, amostra rala → intervalo largo + abstém,
// sem oráculo → NUNCA calibra.
// ─────────────────────────────────────────────────────────────────────────

/** Gera n amostras de um método com exatamente `confirmed` confirmações. */
function samples(method: string, n: number, confirmed: number): CalibrationSample[] {
  return Array.from({ length: n }, (_, i) => ({ method, confirmed: i < confirmed }));
}

describe("calibrateMethodReliability — taxa empírica × oráculo de runtime", () => {
  it("método com 90% de confirmação → confiança calibrada ~0.9 (±ε), calibrado", () => {
    const s = samples("STATIC_PROVEN", 100, 90);
    const r = calibrateMethodReliability(s, { runtimeOracleSize: 50, alpha: 0.1 });
    const m = r.byMethod["STATIC_PROVEN"];
    assert.equal(m.n, 100);
    assert.equal(m.confirmed, 90);
    assert.equal(m.reliability, 0.9);
    assert.equal(m.calibrated, true);
    // intervalo de cobertura estreito (n grande) e contendo p̂
    assert.ok(m.lower < 0.9 && m.upper > 0.9, `[${m.lower},${m.upper}]`);
    assert.ok(m.width < 0.15, `largura=${m.width}`);
  });

  it("método com 30% de confirmação → confiança calibrada ~0.3 (o CHUTE 0.40 seria mentira)", () => {
    const s = samples("STATIC_UNRESOLVED", 200, 60); // 60/200 = 0.30
    const r = calibrateMethodReliability(s, { runtimeOracleSize: 80, alpha: 0.1 });
    const m = r.byMethod["STATIC_UNRESOLVED"];
    assert.equal(m.reliability, 0.3);
    assert.equal(m.calibrated, true);
    // a MEDIDA (0.30) fica BEM abaixo do peso fixo (0.40) — é o ponto da ADR
    assert.ok(m.reliability < 0.4);
    assert.ok(m.lower < 0.3 && m.upper > 0.3);
  });

  it("amostra pequena → intervalo LARGO + calibrated:false (abstém, cai no peso fixo)", () => {
    const s = samples("CONFIG_PROVEN", 5, 4); // p̂=0.8 mas n<30
    const r = calibrateMethodReliability(s, { runtimeOracleSize: 10, minSamples: 30 });
    const m = r.byMethod["CONFIG_PROVEN"];
    assert.equal(m.reliability, 0.8);
    assert.equal(m.calibrated, false, "n=5 < minSamples → não calibra");
    assert.ok(m.abstainReason && /rala/.test(m.abstainReason));
    // intervalo genuinamente largo — reconhece a ignorância, não finge precisão
    assert.ok(m.width > 0.5, `largura=${m.width} deveria ser larga`);
  });

  it("SEM oráculo de runtime → NADA calibra, hasRuntimeGroundTruth=false (não inventa 0.0)", () => {
    const s = [...samples("STATIC_PROVEN", 100, 0), ...samples("CONFIG_PROVEN", 40, 0)];
    const r = calibrateMethodReliability(s, { runtimeOracleSize: 0 });
    assert.equal(r.hasRuntimeGroundTruth, false);
    for (const m of Object.values(r.byMethod)) {
      assert.equal(m.calibrated, false, `${m.method} não pode calibrar sem oráculo`);
      assert.ok(m.abstainReason && /sem oráculo/.test(m.abstainReason));
    }
  });

  it("mais confirmações → confiabilidade monotonicamente maior", () => {
    const low = calibrateMethodReliability(samples("M", 100, 20), { runtimeOracleSize: 50 }).byMethod["M"];
    const mid = calibrateMethodReliability(samples("M", 100, 50), { runtimeOracleSize: 50 }).byMethod["M"];
    const high = calibrateMethodReliability(samples("M", 100, 80), { runtimeOracleSize: 50 }).byMethod["M"];
    assert.ok(low.reliability < mid.reliability && mid.reliability < high.reliability);
    assert.ok(low.lower < mid.lower && mid.lower < high.lower);
  });

  it("totalSamples e runtimeOracleSize são propagados", () => {
    const r = calibrateMethodReliability(samples("M", 42, 10), { runtimeOracleSize: 7 });
    assert.equal(r.totalSamples, 42);
    assert.equal(r.runtimeOracleSize, 7);
    assert.equal(r.alpha, 0.1);
    assert.equal(r.minSamples, 30);
  });
});

describe("clopperPearson — intervalo EXATO (garantia de cobertura distribution-free)", () => {
  it("0 sucessos em 10 (95%): lower=0, upper=0.3085 (valor de tabela)", () => {
    const [lo, hi] = clopperPearson(0, 10, 0.05);
    assert.equal(lo, 0);
    assert.ok(Math.abs(hi - 0.3085) < 1e-3, `upper=${hi}`);
  });

  it("10 sucessos em 10 (95%): lower=0.6915 (valor de tabela), upper=1", () => {
    const [lo, hi] = clopperPearson(10, 10, 0.05);
    assert.ok(Math.abs(lo - 0.6915) < 1e-3, `lower=${lo}`);
    assert.equal(hi, 1);
  });

  it("simétrico em k↔n−k (k=3/10 vs k=7/10 são reflexões)", () => {
    const [lo3, hi3] = clopperPearson(3, 10, 0.1);
    const [lo7, hi7] = clopperPearson(7, 10, 0.1);
    assert.ok(Math.abs(lo3 - (1 - hi7)) < 1e-6);
    assert.ok(Math.abs(hi3 - (1 - lo7)) < 1e-6);
  });

  it("n menor → intervalo mais largo (menos dado = mais incerteza)", () => {
    const [loSmall, hiSmall] = clopperPearson(4, 8, 0.1); // p̂=0.5, n=8
    const [loBig, hiBig] = clopperPearson(50, 100, 0.1); // p̂=0.5, n=100
    assert.ok(hiSmall - loSmall > hiBig - loBig);
  });
});

describe("regularizedIncompleteBeta — formas fechadas conhecidas", () => {
  it("I_x(1,1) = x", () => {
    for (const x of [0.1, 0.37, 0.5, 0.9]) {
      assert.ok(Math.abs(regularizedIncompleteBeta(x, 1, 1) - x) < 1e-9, `x=${x}`);
    }
  });
  it("I_x(2,1) = x²", () => {
    for (const x of [0.2, 0.6, 0.85]) {
      assert.ok(Math.abs(regularizedIncompleteBeta(x, 2, 1) - x * x) < 1e-9, `x=${x}`);
    }
  });
  it("I_x(1,2) = 2x − x²", () => {
    for (const x of [0.2, 0.6, 0.85]) {
      assert.ok(Math.abs(regularizedIncompleteBeta(x, 1, 2) - (2 * x - x * x)) < 1e-9, `x=${x}`);
    }
  });
  it("I_0.5(a,a) = 0.5 (simetria)", () => {
    for (const a of [2, 5, 10]) {
      assert.ok(Math.abs(regularizedIncompleteBeta(0.5, a, a) - 0.5) < 1e-9, `a=${a}`);
    }
  });
});

describe("betaQuantile — inversa de I_x", () => {
  it("mediana da Beta(1,1) = 0.5; Beta(3,3) simétrica = 0.5", () => {
    assert.ok(Math.abs(betaQuantile(0.5, 1, 1) - 0.5) < 1e-6);
    assert.ok(Math.abs(betaQuantile(0.5, 3, 3) - 0.5) < 1e-6);
  });
  it("round-trip: I_{Q(p)}(a,b) = p", () => {
    for (const [p, a, b] of [[0.3, 2, 5], [0.8, 4, 2], [0.95, 1, 10]] as const) {
      const q = betaQuantile(p, a, b);
      assert.ok(Math.abs(regularizedIncompleteBeta(q, a, b) - p) < 1e-6, `p=${p}`);
    }
  });
});

describe("logGamma", () => {
  it("valores conhecidos: Γ(1)=1, Γ(5)=24, Γ(0.5)=√π", () => {
    assert.ok(Math.abs(logGamma(1) - 0) < 1e-9);
    assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-9);
    assert.ok(Math.abs(logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-9);
  });
});

describe("deriveSamplesFromEdges — arestas modeladas → amostras + oráculo", () => {
  const edges: CalibratableEdge[] = [
    { fromNode: "A", toNode: "B", evidence: { method: "RUNTIME_OBSERVED" } }, // oráculo
    { fromNode: "C", toNode: "D", evidence: { method: "RUNTIME_OBSERVED" } }, // oráculo
    { fromNode: "A", toNode: "B", evidence: { method: "STATIC_PROVEN" } },    // confirmada
    { fromNode: "E", toNode: "F", evidence: { method: "STATIC_PROVEN" } },    // NÃO confirmada
    { fromNode: "G", toNode: "H", evidence: { method: "STATIC_UNRESOLVED" } },// NÃO confirmada
  ];

  it("arestas RUNTIME_OBSERVED viram oráculo (não amostra); estáticas viram amostra", () => {
    const { samples: s, runtimeOracleSize } = deriveSamplesFromEdges(edges);
    assert.equal(runtimeOracleSize, 2, "2 pares observados distintos");
    assert.equal(s.length, 3, "3 arestas estáticas");
    const staticProven = s.filter((x) => x.method === "STATIC_PROVEN");
    assert.equal(staticProven.filter((x) => x.confirmed).length, 1, "A→B confirmada");
    assert.equal(staticProven.filter((x) => !x.confirmed).length, 1, "E→F não");
    assert.equal(s.find((x) => x.method === "STATIC_UNRESOLVED")!.confirmed, false);
  });

  it("fim-a-fim: deriva samples e calibra — a confirmação estrutural aparece", () => {
    const { samples: s, runtimeOracleSize } = deriveSamplesFromEdges(edges);
    const r = calibrateMethodReliability(s, { runtimeOracleSize, minSamples: 1 });
    assert.equal(r.hasRuntimeGroundTruth, true);
    assert.equal(r.byMethod["STATIC_PROVEN"].reliability, 0.5); // 1 de 2
    assert.equal(r.byMethod["STATIC_UNRESOLVED"].reliability, 0); // 0 de 1
  });
});

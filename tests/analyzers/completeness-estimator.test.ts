import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateCompleteness,
  deriveEdgesByMethod,
  normalQuantile,
} from "../../server/analyzers/completeness-estimator";

// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 — provas SINTÉTICAS de que Chao2 mede a completude do mapa. Cada
// método é um capturador; f1/f2 (singletons/doubletons) carregam a assinatura
// do não-visto. Testes: fórmula exata em fixture conhecido, comportamento
// (bom overlap→missShare pequeno; ruim→grande), e RECUPERAÇÃO de um total
// conhecido dentro do IC.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Constrói `edgesByMethod` a partir de uma especificação {edgeKey: [métodos]}.
 * Deixa f1/f2 controlados e legíveis.
 */
function fromSpec(spec: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [edge, methods] of Object.entries(spec)) {
    for (const m of methods) (out[m] ??= []).push(edge);
  }
  return out;
}

describe("estimateCompleteness — fórmula Chao2 em fixture conhecido", () => {
  it("f1=2, f2=1, S_obs=4, T=3 → chao2 = 4 + (2/3)·0.5 = 4.3333", () => {
    // e1,e2 = singletons (só A) · e3 = doubleton (A,B) · e4 = tripleton (A,B,C)
    const ebm = fromSpec({
      e1: ["A"],
      e2: ["A"],
      e3: ["A", "B"],
      e4: ["A", "B", "C"],
    });
    const r = estimateCompleteness(ebm);
    assert.equal(r.observed, 4);
    assert.equal(r.detail.methods, 3);
    assert.equal(r.detail.f1, 2);
    assert.equal(r.detail.f2, 1);
    // biasTerm = f1(f1-1)/(2(f2+1)) = 2·1/(2·2) = 0.5
    // chao2 = 4 + (2/3)·0.5 = 4.3333 ; chao1 = 4 + 0.5 = 4.5
    assert.ok(Math.abs(r.detail.chao2 - 4.3333) < 1e-3, `chao2=${r.detail.chao2}`);
    assert.ok(Math.abs(r.detail.chao1 - 4.5) < 1e-3, `chao1=${r.detail.chao1}`);
    assert.equal(r.detail.reliable, true);
    // missShare = (4.3333-4)/4.3333 ≈ 0.0769
    assert.ok(Math.abs(r.missShare - 0.0769) < 1e-3, `missShare=${r.missShare}`);
  });

  it("estimatedTotal nunca é menor que observed; missShare ∈ [0,1)", () => {
    const r = estimateCompleteness(fromSpec({ e1: ["A"], e2: ["A"], e3: ["A", "B"] }));
    assert.ok(r.estimatedTotal >= r.observed);
    assert.ok(r.missShare >= 0 && r.missShare < 1);
    assert.ok(r.ci.lower <= r.ci.upper);
  });
});

describe("estimateCompleteness — comportamento (a assinatura de f1/f2)", () => {
  it("MUITO overlap (poucos singletons) → missShare pequeno", () => {
    // 40 arestas vistas por 3 métodos, 10 por 2, 2 por 1 → f1=2, f2=10
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < 40; i++) spec[`t${i}`] = ["A", "B", "C"];
    for (let i = 0; i < 10; i++) spec[`d${i}`] = ["A", "B"];
    for (let i = 0; i < 2; i++) spec[`s${i}`] = ["A"];
    const r = estimateCompleteness(fromSpec(spec));
    assert.equal(r.detail.f1, 2);
    assert.equal(r.detail.f2, 10);
    assert.ok(r.missShare < 0.02, `missShare=${r.missShare} deveria ser pequeno`);
  });

  it("POUCO overlap (muitos singletons) → missShare grande", () => {
    // 30 singletons, 2 doubletons → f1=30, f2=2
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < 15; i++) spec[`s${i}`] = ["A"];
    for (let i = 15; i < 30; i++) spec[`s${i}`] = ["B"];
    for (let i = 0; i < 2; i++) spec[`d${i}`] = ["A", "B"];
    const r = estimateCompleteness(fromSpec(spec));
    assert.equal(r.detail.f1, 30);
    assert.equal(r.detail.f2, 2);
    // biasTerm=30·29/(2·3)=145 ; chao2=32+(2/3)·145≈128.7 ; missShare≈0.75
    assert.ok(r.missShare > 0.6, `missShare=${r.missShare} deveria ser grande`);
  });
});

describe("estimateCompleteness — casos honestos (não inventa)", () => {
  it("T<2 (1 capturador) → reliable:false, estimatedTotal=observed, missShare=0", () => {
    const r = estimateCompleteness(fromSpec({ e1: ["A"], e2: ["A"], e3: ["A"] }));
    assert.equal(r.detail.methods, 1);
    assert.equal(r.detail.reliable, false);
    assert.equal(r.estimatedTotal, r.observed);
    assert.equal(r.missShare, 0);
    assert.ok(r.detail.note && /capturador/.test(r.detail.note));
  });

  it("f1=0 (nenhum singleton) → reliable:false, missShare=0 (leitura honesta)", () => {
    // tudo visto por ≥2 métodos → sem assinatura do não-visto
    const r = estimateCompleteness(fromSpec({ e1: ["A", "B"], e2: ["A", "B", "C"], e3: ["B", "C"] }));
    assert.equal(r.detail.f1, 0);
    assert.equal(r.detail.reliable, false);
    assert.equal(r.missShare, 0);
    assert.ok(r.detail.note && /singleton/.test(r.detail.note));
  });

  it("entrada vazia → tudo zero, sem lançar", () => {
    const r = estimateCompleteness({});
    assert.equal(r.observed, 0);
    assert.equal(r.estimatedTotal, 0);
    assert.equal(r.missShare, 0);
    assert.equal(r.detail.reliable, false);
  });
});

describe("estimateCompleteness — RECUPERA um total conhecido dentro do IC", () => {
  // PRNG determinístico (mulberry32) — fixture estável, sem flakiness.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("universo N=300 com detecção homogênea p=0.4 por 6 métodos → Chao2 ≈ 300 ∈ IC", () => {
    const N = 300;
    const p = 0.4;
    const methods = ["m0", "m1", "m2", "m3", "m4", "m5"];
    const rng = mulberry32(1234567);
    const ebm: Record<string, string[]> = {};
    for (const m of methods) ebm[m] = [];
    for (let e = 0; e < N; e++) {
      const key = `edge${e}`;
      for (const m of methods) {
        if (rng() < p) ebm[m].push(key); // cada método detecta a aresta com prob p
      }
    }
    const r = estimateCompleteness(ebm);
    // detecção homogênea → Chao2 é acurado (heterogeneidade só o tornaria LOWER bound)
    assert.ok(r.observed < N, `observed=${r.observed} deve ser < N (algumas não-vistas)`);
    assert.ok(Math.abs(r.estimatedTotal - N) / N < 0.15, `estimado=${r.estimatedTotal} longe de ${N}`);
    assert.ok(r.ci.lower <= N && N <= r.ci.upper, `IC [${r.ci.lower},${r.ci.upper}] não contém ${N}`);
    assert.ok(r.missShare > 0, "há arestas verdadeiras não observadas");
  });
});

describe("normalQuantile", () => {
  it("z(0.975) ≈ 1.95996 ; z(0.5)=0 ; simetria", () => {
    assert.ok(Math.abs(normalQuantile(0.975) - 1.959964) < 1e-4);
    assert.ok(Math.abs(normalQuantile(0.5)) < 1e-6);
    assert.ok(Math.abs(normalQuantile(0.025) + 1.959964) < 1e-4);
  });
});

describe("deriveEdgesByMethod — arestas modeladas → capturadores", () => {
  it("um par visto por métodos distintos vira doubleton; dedup por (método,par)", () => {
    const edges = [
      { fromNode: "A", toNode: "B", evidence: { method: "STATIC_PROVEN" } },
      { fromNode: "A", toNode: "B", evidence: { method: "RUNTIME_OBSERVED" } },
      { fromNode: "A", toNode: "B", evidence: { method: "STATIC_PROVEN" } }, // dup → ignorada
      { fromNode: "C", toNode: "D", evidence: { method: "STATIC_UNRESOLVED" } },
    ];
    const ebm = deriveEdgesByMethod(edges);
    assert.deepEqual(ebm["STATIC_PROVEN"], ["A B"]); // dedup
    assert.deepEqual(ebm["RUNTIME_OBSERVED"], ["A B"]);
    assert.deepEqual(ebm["STATIC_UNRESOLVED"], ["C D"]);
    const r = estimateCompleteness(ebm);
    assert.equal(r.observed, 2); // A→B e C→D distintos
    assert.equal(r.detail.f1, 1); // C→D visto por 1 método
    assert.equal(r.detail.f2, 1); // A→B visto por 2 métodos
  });
});

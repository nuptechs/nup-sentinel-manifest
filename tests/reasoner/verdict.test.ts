// ─────────────────────────────────────────────
// reasoner/verdict — VEREDITO TRI-EIXO explicável (above-SOTA).
// O tier é DETERMINÍSTICO; a IA só prosa e é REJEITADA se contradiz o tier.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ShapedGraph } from "../../server/analyzers/system-graph.ts";
import { computeEvidenceVerdict, explainVerdict } from "../../server/reasoner/verdict.ts";

function withCoverage(byMethod: Record<string, number>, observedRatio: number, nodes = { observed: 5, total: 10 }): ShapedGraph {
  const total = Object.values(byMethod).reduce((a, b) => a + b, 0);
  return {
    level: "class",
    truncated: false,
    counts: { nodes: nodes.total, edges: total, byType: {} },
    coverage: { edges: { byMethod: byMethod as any, total, observedRatio }, nodes },
    nodes: [],
    edges: [],
  };
}

describe("reasoner/verdict — computeEvidenceVerdict (tier determinístico)", () => {
  it("STRONG quando runtime cobre fatia real (convergência de eixos)", () => {
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 30, STATIC_PROVEN: 70 }, 0.3));
    assert.equal(v.tier, "STRONG");
  });

  it("MODERATE quando estático domina e runtime é ralo", () => {
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 2, STATIC_PROVEN: 98 }, 0.02));
    assert.equal(v.tier, "MODERATE");
  });

  it("WEAK quando muita aresta é só-declarada/UNKNOWN", () => {
    const v = computeEvidenceVerdict(withCoverage({ STATIC_PROVEN: 30, UNKNOWN: 50, STATIC_UNRESOLVED: 20 }, 0));
    assert.equal(v.tier, "WEAK");
  });

  it("reporta observedRatio, byMethod e nós exercitados", () => {
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 1, STATIC_PROVEN: 99 }, 0.01, { observed: 3, total: 40 }));
    assert.equal(v.nodes.observed, 3);
    assert.equal(v.nodes.total, 40);
    assert.ok(v.reasons.some((r) => /exercitados por tráfego/.test(r)));
  });

  it("nunca lança sem coverage", () => {
    assert.doesNotThrow(() => computeEvidenceVerdict({} as any));
  });
});

describe("reasoner/verdict — explainVerdict (IA sob checagem de consistência)", () => {
  it("sem LLM → explicação template com o tier certo", async () => {
    const v = await explainVerdict(withCoverage({ RUNTIME_OBSERVED: 30, STATIC_PROVEN: 70 }, 0.3), null);
    assert.equal(v.mode, "deterministic");
    assert.match(v.explanation, /FORTE/);
  });

  it("aceita a prosa da IA quando NÃO contradiz o tier", async () => {
    const llm = async () => "A leitura é forte: boa parte das arestas foi observada em runtime, então dá pra confiar no que roda.";
    const v = await explainVerdict(withCoverage({ RUNTIME_OBSERVED: 30, STATIC_PROVEN: 70 }, 0.3), llm);
    assert.equal(v.mode, "llm-grounded");
    assert.match(v.explanation, /observada em runtime/);
  });

  it("REJEITA a prosa da IA que contradiz o tier (juiz é o determinístico)", async () => {
    // deterministicamente WEAK; a IA tenta dizer 'forte' → prosa descartada, fica o template
    const llm = async () => "A leitura é forte e totalmente confiável.";
    const v = await explainVerdict(withCoverage({ UNKNOWN: 60, STATIC_PROVEN: 40 }, 0), llm);
    assert.equal(v.tier, "WEAK");
    assert.equal(v.mode, "deterministic"); // prosa rejeitada
    assert.match(v.explanation, /FRACA/);
  });
});

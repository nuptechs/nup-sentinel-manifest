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

describe("reasoner/verdict — computeEvidenceVerdict (tier PROVEN-AWARE)", () => {
  it("STRONG quando runtime cobre fatia real (convergência de eixos)", () => {
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 30, STATIC_PROVEN: 70 }, 0.3));
    assert.equal(v.tier, "STRONG");
  });

  it("MODERATE quando estático domina e runtime é ralo (sabe estrutura, não o que roda)", () => {
    // 100% provado, mas só 2% observado → NÃO é STRONG (convergência dinâmica quase nula)
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 2, STATIC_PROVEN: 98 }, 0.02));
    assert.equal(v.tier, "MODERATE");
  });

  it("WEAK quando pouco está provado por QUALQUER método (grafo quase todo heurístico)", () => {
    // provenRatio 15% (< 20%) → WEAK, mesmo com 15 arestas provadas
    const v = computeEvidenceVerdict(withCoverage({ STATIC_PROVEN: 15, UNKNOWN: 55, STATIC_UNRESOLVED: 30 }, 0));
    assert.equal(v.tier, "WEAK");
  });

  it("MONOTONIA: adicionar prova NUNCA rebaixa o tier (o bug que motivou o proven-aware)", () => {
    // grafo CRU: runtime domina o pouco que existe → STRONG
    const cru = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 198, STATIC_UNRESOLVED: 1018 }, 0.163));
    // grafo MESCLADO (scip adiciona 643 provadas): observedRatio CAI p/ 10.7%, mas provado SOBE p/ 45%
    const merged = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 198, STATIC_PROVEN: 643, STATIC_UNRESOLVED: 1018 }, 0.107));
    assert.equal(cru.tier, "STRONG");
    assert.equal(merged.tier, "STRONG"); // NÃO caiu p/ WEAK só porque o denominador cresceu
    assert.ok(merged.provenRatio > cru.provenRatio, "provenRatio sobe ao mesclar prova");
  });

  it("caso REAL identify (mesclado): 45% provado + 10.7% runtime → STRONG", () => {
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 198, STATIC_PROVEN: 643, STATIC_UNRESOLVED: 1018 }, 0.107));
    assert.equal(v.tier, "STRONG");
    assert.ok(Math.abs(v.provenRatio - 0.452) < 0.01, "provenRatio ~45%");
  });

  it("INVARIÂNCIA AO TAMANHO: identify pós-Leitura-Máxima (88% provado, observedRatio DESPENCA p/ 2.3%, mas 198 runtime) → segue STRONG", () => {
    // capturar o call-graph provado cresce o denominador → observedRatio cai muito;
    // o sinal de runtime absoluto (198 ≥ 25) preserva o STRONG. Adicionar prova NÃO rebaixa.
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 198, STATIC_PROVEN: 7295, STATIC_UNRESOLVED: 1018 }, 0.023));
    assert.equal(v.tier, "STRONG");
    assert.ok(v.provenRatio > 0.85, "provenRatio ~88%");
    assert.ok(v.observedRatio < 0.05, "observedRatio despencou, mas o tier não caiu");
  });

  it("provar MUITO com runtime quase nulo (7 arestas) NÃO é STRONG — MODERATE (estrutura sem execução)", () => {
    // easynup pós-Leitura-Máxima: 75% provado, mas 7 runtime (<25) e observedRatio ~0
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 7, STATIC_PROVEN: 30427, STATIC_UNRESOLVED: 9709 }, 0.0002));
    assert.equal(v.tier, "MODERATE");
    assert.ok(v.provenRatio > 0.7, "provado alto");
  });

  it("caso REAL easynup (mesclado): 25% provado + 0.1% runtime → MODERATE (estrutura provada, runtime ausente)", () => {
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 7, STATIC_PROVEN: 3207, CONFIG_PROVEN: 22, STATIC_UNRESOLVED: 9709 }, 0.0005));
    assert.equal(v.tier, "MODERATE");
    assert.ok(Math.abs(v.provenRatio - 0.25) < 0.01, "provenRatio ~25%");
  });

  it("reporta provenRatio, observedRatio, unresolvedRatio, byMethod e nós exercitados", () => {
    const v = computeEvidenceVerdict(withCoverage({ RUNTIME_OBSERVED: 1, STATIC_PROVEN: 99 }, 0.01, { observed: 3, total: 40 }));
    assert.equal(v.provenRatio, 1); // tudo provado (runtime+static)
    assert.equal(v.unresolvedRatio, 0);
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
    const v = await explainVerdict(withCoverage({ UNKNOWN: 70, STATIC_PROVEN: 15, STATIC_UNRESOLVED: 15 }, 0), llm);
    assert.equal(v.tier, "WEAK");
    assert.equal(v.mode, "deterministic"); // prosa rejeitada
    assert.match(v.explanation, /FRACA/);
  });
});

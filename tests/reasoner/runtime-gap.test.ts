// ─────────────────────────────────────────────
// reasoner/runtime-gap — o que EXISTE mas nunca foi EXERCITADO (above-SOTA).
// O oposto do dead-code: entrada não-observada = COBRIR (tráfego/teste), não remover.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ShapedGraph, ShapedNode, ShapedEdge } from "../../server/analyzers/system-graph.ts";
import { findRuntimeGap, explainRuntimeGap } from "../../server/reasoner/runtime-gap.ts";

function node(id: string, type: string, extra: Partial<ShapedNode> = {}): ShapedNode {
  return { id, type, className: id.split(":").pop(), inDegree: 0, outDegree: 0, sensitive: false, evidence: { method: "STATIC_PROVEN", confidence: 0.7 }, ...extra } as ShapedNode;
}
function edge(fromNode: string, toNode: string): ShapedEdge {
  return { fromNode, toNode, relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.7 } };
}
function graph(nodes: ShapedNode[], edges: ShapedEdge[]): ShapedGraph {
  return { level: "class", truncated: false, counts: { nodes: nodes.length, edges: edges.length, byType: {} }, coverage: { edges: { byMethod: {} as any, total: edges.length, observedRatio: 0 }, nodes: { observed: 0, total: nodes.length } }, nodes, edges };
}

// 3 rotas: uma observada, duas não; a não-observada "Big" alcança mais nós.
function scenario(): ShapedGraph {
  const nodes = [
    node("ROUTE:/live", "ROUTE", { observed: true, runtimeHot: true, evidence: { method: "RUNTIME_OBSERVED", confidence: 0.99 } }),
    node("ROUTE:/big", "ROUTE"),
    node("CONTROLLER:Small", "CONTROLLER"),
    node("SERVICE:S1", "SERVICE"),
    node("SERVICE:S2", "SERVICE"),
    node("REPOSITORY:R1", "REPOSITORY"),
  ];
  const edges = [edge("ROUTE:/big", "SERVICE:S1"), edge("SERVICE:S1", "SERVICE:S2"), edge("SERVICE:S2", "REPOSITORY:R1")];
  return graph(nodes, edges);
}

describe("reasoner/runtime-gap — findRuntimeGap (determinístico)", () => {
  it("separa entradas observadas × não-exercitadas e prioriza por alcance", () => {
    const { totalEntries, observedEntries, uncovered } = findRuntimeGap(scenario());
    assert.equal(totalEntries, 3); // 2 ROUTE + 1 CONTROLLER
    assert.equal(observedEntries, 1); // /live
    assert.equal(uncovered.length, 2);
    // /big alcança S1→S2→R1 = 3 nós, deve vir antes de Small (0)
    assert.equal(uncovered[0].node.id, "ROUTE:/big");
    assert.equal(uncovered[0].reach, 3);
  });

  it("todas observadas → nenhuma lacuna", () => {
    const g = graph([node("ROUTE:/a", "ROUTE", { observed: true })], []);
    const r = findRuntimeGap(g);
    assert.equal(r.observedEntries, 1);
    assert.equal(r.uncovered.length, 0);
  });

  it("nunca lança com grafo vazio/malformado", () => {
    assert.doesNotThrow(() => findRuntimeGap(graph([], [])));
    assert.doesNotThrow(() => findRuntimeGap({ nodes: null, edges: null } as any));
  });
});

describe("reasoner/runtime-gap — explainRuntimeGap (IA sob gate)", () => {
  it("sem LLM → template determinístico + cobertura correta", async () => {
    const rep = await explainRuntimeGap(scenario(), null);
    assert.equal(rep.mode, "deterministic");
    assert.equal(rep.coverage, 1 / 3);
    assert.match(rep.summary, /Cobertura de runtime.*33%/);
    assert.match(rep.summary, /NÃO é código morto/);
    assert.equal(rep.grounding.proposed, 0);
  });

  it("LLM grounded: dica ancorada FICA, nodeId inexistente é REJEITADO", async () => {
    const fakeLLM = async () =>
      JSON.stringify([
        { nodeId: "ROUTE:/big", text: "Disparar GET /big para exercitar a cadeia S1→S2→R1." },
        { nodeId: "ROUTE:/INVENTADA", text: "alucinação" },
      ]);
    const rep = await explainRuntimeGap(scenario(), fakeLLM);
    assert.equal(rep.mode, "llm-grounded");
    assert.match(rep.uncovered.find((u) => u.nodeId === "ROUTE:/big")!.hint, /exercitar a cadeia/);
    assert.equal(rep.grounding.rejected, 1);
    assert.equal(rep.grounding.rejectedClaims[0].anchorId, "ROUTE:/INVENTADA");
  });
});

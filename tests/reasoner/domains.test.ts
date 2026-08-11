// ─────────────────────────────────────────────
// reasoner/domains — DOMÍNIOS por comunidade do grafo provado (above-SOTA).
//
// Os domínios EMERGEM do que DE FATO se chama (não da pasta). O caso crítico: um
// util/hub compartilhado NÃO pode colar dois domínios num blob (damping de hubs).
// A IA só NOMEIA a comunidade, sob o gate (nome com communityId inexistente cai).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ShapedGraph, ShapedNode, ShapedEdge } from "../../server/analyzers/system-graph.ts";
import { detectDomains, nameDomains } from "../../server/reasoner/domains.ts";

function node(id: string, extra: Partial<ShapedNode> = {}): ShapedNode {
  return { id, type: "SERVICE", className: id.split(":").pop(), inDegree: 0, outDegree: 0, sensitive: false, evidence: { method: "STATIC_PROVEN", confidence: 0.7 }, ...extra } as ShapedNode;
}
function edge(fromNode: string, toNode: string): ShapedEdge {
  return { fromNode, toNode, relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.7 } };
}
function graph(nodes: ShapedNode[], edges: ShapedEdge[]): ShapedGraph {
  return {
    level: "class",
    truncated: false,
    counts: { nodes: nodes.length, edges: edges.length, byType: {} },
    coverage: { edges: { byMethod: {} as any, total: edges.length, observedRatio: 0 }, nodes: { observed: 0, total: nodes.length } },
    nodes,
    edges,
  };
}

// Dois clusters densos (A: a1..a5, B: b1..b5) + um HUB (Logger) que TODOS chamam.
// Sem damping, o hub colaria A e B num blob. Com damping, ficam 2 domínios.
function twoCommunitiesPlusHub(): ShapedGraph {
  const A = ["financial.A1", "financial.A2", "financial.A3", "financial.A4", "financial.A5"].map((s) => `SERVICE:easynup.${s}`);
  const B = ["contract.B1", "contract.B2", "contract.B3", "contract.B4", "contract.B5"].map((s) => `SERVICE:easynup.${s}`);
  const HUB = "SERVICE:easynup.shared.Logger";
  const nodes = [...A, ...B, HUB].map((id) => node(id));
  const edges: ShapedEdge[] = [];
  // clique interno de cada comunidade (denso)
  for (const grp of [A, B]) {
    for (let i = 0; i < grp.length; i++) for (let j = 0; j < grp.length; j++) if (i !== j) edges.push(edge(grp[i], grp[j]));
  }
  // TODO mundo chama o hub (grau altíssimo → deve ser damped)
  for (const n of [...A, ...B]) edges.push(edge(n, HUB));
  return graph(nodes, edges);
}

describe("reasoner/domains — detectDomains (comunidade determinística + damping de hub)", () => {
  it("separa DOIS domínios apesar do hub compartilhado (não vira blob)", () => {
    const { domains, hubs } = detectDomains(twoCommunitiesPlusHub(), { minSize: 3, hubPercentile: 0.9 });
    assert.equal(domains.length, 2, "deve haver exatamente 2 domínios, não 1 blob");
    // cada domínio tem 5 membros; o hub ficou de fora (é ponte)
    assert.ok(domains.every((d) => d.size === 5));
    assert.ok(hubs.includes("SERVICE:easynup.shared.Logger"), "o Logger deve ser reconhecido como hub");
    assert.ok(domains.every((d) => !d.nodeIds.includes("SERVICE:easynup.shared.Logger")));
  });

  it("é DETERMINÍSTICO — mesma entrada, mesma saída (ids e ordem)", () => {
    const g = twoCommunitiesPlusHub();
    const r1 = detectDomains(g, { hubPercentile: 0.9 });
    const r2 = detectDomains(g, { hubPercentile: 0.9 });
    assert.deepEqual(r1.domains.map((d) => d.id), r2.domains.map((d) => d.id));
    assert.deepEqual(r1.domains.map((d) => d.size), r2.domains.map((d) => d.size));
  });

  it("reporta as SEAMS: fatias verticais reais (controller→serviços→repo) + 1 ponte", () => {
    // Forma REALISTA (não clique densa): duas fatias verticais acopladas por 1 aresta.
    const slice = (pfx: string) => {
      const c = `CONTROLLER:${pfx}.Ctrl`, r = `REPOSITORY:${pfx}.Repo`, e = `ENTITY:${pfx}.Ent`;
      const svc = [1, 2, 3, 4].map((i) => `SERVICE:${pfx}.S${i}`);
      const nodes = [node(c, { type: "CONTROLLER" }), ...svc.map((s) => node(s)), node(r, { type: "REPOSITORY" }), node(e, { type: "ENTITY" })];
      const edges = svc.map((s) => edge(c, s)).concat(svc.map((s) => edge(s, r)), [edge(r, e)]);
      return { nodes, edges, svc };
    };
    const A = slice("easynup.financial"), B = slice("easynup.contract");
    const g = graph([...A.nodes, ...B.nodes], [...A.edges, ...B.edges, edge(A.svc[0], B.svc[0])]);
    const { domains, seams } = detectDomains(g, { minSize: 3, hubPercentile: 0.999 });
    assert.equal(domains.length, 2, "duas fatias verticais → dois domínios");
    assert.equal(seams.length, 1, "uma fronteira de acoplamento");
    assert.equal(seams[0].edges, 1, "a ponte tem 1 aresta");
  });

  it("descarta comunidades menores que minSize (ruído)", () => {
    const nodes = [node("SERVICE:x.Solo1"), node("SERVICE:x.Solo2")];
    const { domains } = detectDomains(graph(nodes, [edge("SERVICE:x.Solo1", "SERVICE:x.Solo2")]), { minSize: 3 });
    assert.equal(domains.length, 0);
  });

  it("nunca lança com grafo vazio/malformado", () => {
    assert.doesNotThrow(() => detectDomains(graph([], [])));
    assert.doesNotThrow(() => detectDomains({ nodes: null, edges: null } as any));
  });
});

describe("reasoner/domains — nameDomains (IA sob gate)", () => {
  it("sem LLM → nome determinístico do pacote (financial/contract)", async () => {
    const rep = await nameDomains(twoCommunitiesPlusHub(), null, { hubPercentile: 0.9 });
    assert.equal(rep.mode, "deterministic");
    const names = rep.domains.map((d) => d.name).sort();
    assert.deepEqual(names, ["contract", "financial"]);
    assert.equal(rep.grounding.proposed, 0);
  });

  it("LLM grounded: nome ancorado FICA, nome de comunidade inexistente é REJEITADO", async () => {
    const g = twoCommunitiesPlusHub();
    const { domains } = detectDomains(g, { hubPercentile: 0.9 });
    const realId = domains[0].id;
    const fakeLLM = async () =>
      JSON.stringify([
        { communityId: realId, text: "Execução Financeira" },
        { communityId: "SERVICE:INVENTADO", text: "Domínio Alucinado" },
      ]);
    const rep = await nameDomains(g, fakeLLM, { hubPercentile: 0.9 });
    assert.equal(rep.mode, "llm-grounded");
    assert.ok(rep.domains.find((d) => d.id === realId)!.name === "Execução Financeira");
    assert.equal(rep.grounding.rejected, 1);
    assert.equal(rep.grounding.rejectedClaims[0].anchorId, "SERVICE:INVENTADO");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shapeSystemGraph } from "../../server/analyzers/system-graph";

describe("shapeSystemGraph (System Map)", () => {
  const raw = {
    nodes: [
      { id: "c1", type: "CONTROLLER", className: "ContractController" },
      { id: "s1", type: "SERVICE", className: "ContractService" },
      { id: "r1", type: "REPOSITORY", className: "ContractRepository" },
      { id: "e1", type: "ENTITY", className: "Contract", metadata: { sensitiveFields: ["cpf"], sourceFile: "Contract.java" } },
    ],
    edges: [
      { fromNode: "c1", toNode: "s1", relationType: "CALLS" },
      { fromNode: "s1", toNode: "r1", relationType: "CALLS" },
      { fromNode: "r1", toNode: "e1", relationType: "WRITES_ENTITY" },
      { fromNode: "s1", toNode: "e1", relationType: "READS_ENTITY" },
    ],
  };

  it("computa grau de entrada/saída por nó", () => {
    const g = shapeSystemGraph(raw);
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    assert.equal(byId.e1.inDegree, 2); // r1 escreve + s1 lê
    assert.equal(byId.e1.outDegree, 0);
    assert.equal(byId.s1.inDegree, 1);
    assert.equal(byId.s1.outDegree, 2); // chama r1 + lê e1
  });

  it("marca sensível pela metadata (anel de risco na tela)", () => {
    const g = shapeSystemGraph(raw);
    const e1 = g.nodes.find((n) => n.id === "e1")!;
    assert.equal(e1.sensitive, true);
    assert.equal(e1.sourceFile, "Contract.java");
    const c1 = g.nodes.find((n) => n.id === "c1")!;
    assert.equal(c1.sensitive, false);
  });

  it("conta por tipo e total", () => {
    const g = shapeSystemGraph(raw);
    assert.deepEqual(g.counts.byType, { CONTROLLER: 1, SERVICE: 1, REPOSITORY: 1, ENTITY: 1 });
    assert.equal(g.counts.nodes, 4);
    assert.equal(g.counts.edges, 4);
  });

  it("descarta aresta órfã (extremo inexistente) — nunca conta grau contra nó fantasma", () => {
    const g = shapeSystemGraph({
      nodes: [{ id: "a", type: "SERVICE" }],
      edges: [
        { fromNode: "a", toNode: "ghost", relationType: "CALLS" },
        { fromNode: "ghost", toNode: "a", relationType: "CALLS" },
      ],
    });
    assert.equal(g.counts.edges, 0);
    assert.equal(g.nodes[0].inDegree, 0);
    assert.equal(g.nodes[0].outDegree, 0);
  });

  it("propaga a flag truncated", () => {
    assert.equal(shapeSystemGraph({ nodes: [], edges: [], truncated: true }).truncated, true);
    assert.equal(shapeSystemGraph({ nodes: [], edges: [] }).truncated, false);
  });
});

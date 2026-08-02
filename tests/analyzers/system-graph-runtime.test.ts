import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shapeSystemGraph } from "../../server/analyzers/system-graph";

// A costura (ADR-0026) marca no grafo cru: nós com metadata.runtimeHot/runtimeCount
// e arestas RUNTIME_OBSERVED com metadata.observed/count. Este teste garante que a
// shaping (que a tela consome via /graph) NÃO descarta esses campos — o bug que o
// dono pegaria: aresta observada aparece, mas hot/cold e contagem somem.
const raw = {
  nodes: [
    { id: "route:runtime:GET:/api/x", type: "ROUTE", className: "/api/x", metadata: { runtimeHot: true, runtimeCount: 7, observed: true } },
    { id: "ENTITY:d.WorkflowCallbackToken", type: "ENTITY", className: "WorkflowCallbackToken", metadata: { runtimeHot: true, runtimeCount: 7 } },
    { id: "ENTITY:d.Frio", type: "ENTITY", className: "Frio", metadata: {} }, // sem tráfego = frio
  ],
  edges: [
    { fromNode: "route:runtime:GET:/api/x", toNode: "ENTITY:d.WorkflowCallbackToken", relationType: "RUNTIME_OBSERVED", metadata: { observed: true, source: "jaeger", count: 7 } },
  ],
};

describe("ADR-0026 costura — shapeSystemGraph preserva runtime (nó hot + aresta observada)", () => {
  it("class-level: nó tocado por tráfego fica runtimeHot com count; nó sem tráfego fica frio", () => {
    const g = shapeSystemGraph(raw, "class");
    const ent = g.nodes.find((n) => n.className === "WorkflowCallbackToken")!;
    assert.equal(ent.runtimeHot, true);
    assert.equal(ent.runtimeCount, 7);
    const frio = g.nodes.find((n) => n.className === "Frio")!;
    assert.equal(frio.runtimeHot, undefined); // FRIO: existe no código, sem tráfego
  });

  it("class-level: aresta RUNTIME_OBSERVED preserva observed + count (tooltip da tela)", () => {
    const g = shapeSystemGraph(raw, "class");
    const e = g.edges.find((x) => x.relationType === "RUNTIME_OBSERVED")!;
    assert.ok(e, "aresta observada preservada");
    assert.equal(e.observed, true);
    assert.equal(e.count, 7);
  });

  it("method-level: mesmos campos preservados", () => {
    const g = shapeSystemGraph(raw, "method");
    const route = g.nodes.find((n) => n.id === "route:runtime:GET:/api/x")!;
    assert.equal(route.runtimeHot, true);
    assert.equal(route.runtimeCount, 7);
    const e = g.edges.find((x) => x.relationType === "RUNTIME_OBSERVED")!;
    assert.equal(e.observed, true);
    assert.equal(e.count, 7);
  });

  it("aresta ESTÁTICA (sem observed) não ganha observed/count fantasma", () => {
    const g = shapeSystemGraph(
      { nodes: raw.nodes, edges: [{ fromNode: "route:runtime:GET:/api/x", toNode: "ENTITY:d.Frio", relationType: "READS_ENTITY", metadata: { resolution: "compiler" } }] },
      "class",
    );
    const e = g.edges.find((x) => x.relationType === "READS_ENTITY")!;
    assert.equal(e.observed, undefined);
    assert.equal(e.count, undefined);
    assert.equal(e.resolution, "compiler"); // proveniência estática intacta
  });
});

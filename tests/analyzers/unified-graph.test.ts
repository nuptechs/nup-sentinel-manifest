import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnifiedGraph,
  mergeUnifiedGraphs,
  UnifiedGraph,
} from "../../server/analyzers/unified-graph";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";
import { qualifyNodeId, type AggregatedCrossServiceEdge } from "../../server/analyzers/cross-service-symbol-junction";

// OBS-D11 (lado manifest) — uma verdade consultável sobre code+manifest(+runtime).
// Projeção PURA do grafo shaped; inerte (nenhum endpoint a serve ainda).

const raw: RawSystemGraph = {
  nodes: [
    { id: "CONTROLLER:a.Foo.list()", type: "CONTROLLER", className: "Foo", metadata: { sourceFile: "Foo.java" } },
    { id: "SERVICE:a.Bar.run()", type: "SERVICE", className: "Bar", metadata: { sourceFile: "Bar.java", runtimeHot: true } },
    { id: "ENTITY:a.Baz", type: "ENTITY", className: "Baz", metadata: { sourceFile: "Baz.java" } },
  ],
  edges: [
    { fromNode: "CONTROLLER:a.Foo.list()", toNode: "SERVICE:a.Bar.run()", relationType: "CALLS", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:a.Bar.run()", toNode: "ENTITY:a.Baz", relationType: "READS_ENTITY", metadata: {} },
  ],
};

describe("unified-graph — projeção tri-eixo consultável", () => {
  it("todo nó é atestado por code; manifest vem do id-set; runtime vem do shape", () => {
    const shaped = shapeSystemGraph(raw, "method");
    const ug = buildUnifiedGraph(shaped, { manifestNodeIds: ["CONTROLLER:a.Foo.list()"] });

    assert.ok(ug instanceof UnifiedGraph);
    const foo = ug.node("CONTROLLER:a.Foo.list()")!;
    assert.equal(foo.provenance.code, true);
    assert.equal(foo.provenance.manifest, true);

    const bar = ug.node("SERVICE:a.Bar.run()")!;
    assert.equal(bar.provenance.manifest, false);
    assert.equal(bar.provenance.runtime, true, "runtimeHot no shape → eixo runtime");

    // consultas
    assert.deepEqual(ug.neighbors("CONTROLLER:a.Foo.list()"), ["SERVICE:a.Bar.run()"]);
    assert.equal(ug.in("SERVICE:a.Bar.run()").length, 1);
    assert.equal(ug.byType("ENTITY").length, 1);
    assert.equal(ug.byProvenance("manifest").length, 1);

    const cov = ug.coverage();
    assert.equal(cov.nodes.total, 3);
    assert.equal(cov.nodes.code, 3);
    assert.equal(cov.nodes.manifest, 1);
    assert.equal(cov.nodes.runtime, 1);
    assert.equal(cov.edges.total, 2);
  });

  it("qualifica ids por serviço quando pedido", () => {
    const shaped = shapeSystemGraph(raw, "method");
    const ug = buildUnifiedGraph(shaped, { service: "svcA" });
    assert.ok(ug.hasNode("svcA::CONTROLLER:a.Foo.list()"));
    assert.equal(ug.node("svcA::CONTROLLER:a.Foo.list()")!.service, "svcA");
  });
});

describe("unified-graph — une N serviços e dobra cross-service (OBS-D04)", () => {
  it("merge + aresta cross-service com as duas pontas presentes", () => {
    const shaped = shapeSystemGraph(raw, "method");
    const a = buildUnifiedGraph(shaped, { service: "easynup" });
    const b = buildUnifiedGraph(shaped, { service: "identify" });

    const x: AggregatedCrossServiceEdge = {
      fromNode: qualifyNodeId("easynup", "CONTROLLER:a.Foo.list()"),
      toNode: qualifyNodeId("identify", "SERVICE:a.Bar.run()"),
      relationType: "CALLS",
      resolution: "compiler",
      crossService: true,
      fromService: "easynup",
      toService: "identify",
    };

    const merged = mergeUnifiedGraphs([a, b], [x]);
    assert.equal(merged.nodes().length, 6, "3 nós por serviço, ids distintos");
    const cross = merged.crossServiceEdges();
    assert.equal(cross.length, 1);
    assert.equal(cross[0].evidence.method, "STATIC_PROVEN");
    // o elo cross-service conta no grau dos dois lados
    assert.equal(merged.node(x.fromNode)!.outDegree >= 1, true);
    assert.equal(merged.node(x.toNode)!.inDegree >= 1, true);
  });

  it("cross-service sem as duas pontas presentes NÃO entra (honesto)", () => {
    const shaped = shapeSystemGraph(raw, "method");
    const a = buildUnifiedGraph(shaped, { service: "easynup" });
    const dangling: AggregatedCrossServiceEdge = {
      fromNode: qualifyNodeId("easynup", "CONTROLLER:a.Foo.list()"),
      toNode: qualifyNodeId("ghost", "SERVICE:x.Y.z()"),
      relationType: "CALLS", resolution: "compiler", crossService: true, fromService: "easynup", toService: "ghost",
    };
    const merged = mergeUnifiedGraphs([a], [dangling]);
    assert.equal(merged.crossServiceEdges().length, 0);
  });
});

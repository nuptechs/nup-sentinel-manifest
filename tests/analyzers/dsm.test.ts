import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDsm } from "../../server/analyzers/dsm";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

const dsmOf = (raw: RawSystemGraph) => computeDsm(shapeSystemGraph(raw, "class"));

describe("ADR-0026 AT1 — DSM/LSM: partição automática de camadas (acíclico)", () => {
  // cadeia limpa: Controller → Service → Repository → Entity
  const raw: RawSystemGraph = {
    nodes: [
      { id: "CONTROLLER:c.A", type: "CONTROLLER", className: "A" },
      { id: "SERVICE:s.B", type: "SERVICE", className: "B" },
      { id: "REPOSITORY:r.C", type: "REPOSITORY", className: "C" },
      { id: "ENTITY:e.D", type: "ENTITY", className: "D" },
    ],
    edges: [
      { fromNode: "CONTROLLER:c.A", toNode: "SERVICE:s.B", relationType: "CALLS" },
      { fromNode: "SERVICE:s.B", toNode: "REPOSITORY:r.C", relationType: "CALLS" },
      { fromNode: "REPOSITORY:r.C", toNode: "ENTITY:e.D", relationType: "READS_ENTITY" },
    ],
  };

  it("descobre 4 camadas niveladas sem ninguém desenhar; acíclico ⇒ levelizable", () => {
    const d = dsmOf(raw);
    assert.equal(d.levelizable, true);
    assert.equal(d.stats.levels, 4);
    assert.equal(d.stats.cycleCount, 0);
    assert.equal(d.stats.feedbackEdges, 0);
    assert.equal(d.stats.feedbackPct, 0);
  });

  it("ordem block-triangular: A(0) → B(1) → C(2) → D(3)", () => {
    const d = dsmOf(raw);
    assert.deepEqual(d.order, ["CONTROLLER:c.A", "SERVICE:s.B", "REPOSITORY:r.C", "ENTITY:e.D"]);
    assert.deepEqual(d.partitions.map((p) => p.level), [0, 1, 2, 3]);
    assert.deepEqual(d.partitions[0].nodes, ["CONTROLLER:c.A"]);
    assert.deepEqual(d.partitions[3].nodes, ["ENTITY:e.D"]);
  });
});

describe("ADR-0026 AT1 — tangles (ciclos) impedem a nivelação", () => {
  const raw: RawSystemGraph = {
    nodes: [
      { id: "SERVICE:s.X", type: "SERVICE", className: "X" },
      { id: "SERVICE:s.Y", type: "SERVICE", className: "Y" },
    ],
    edges: [
      { fromNode: "SERVICE:s.X", toNode: "SERVICE:s.Y", relationType: "CALLS" },
      { fromNode: "SERVICE:s.Y", toNode: "SERVICE:s.X", relationType: "CALLS" },
    ],
  };

  it("SCC ≥2 detectado como tangle; levelizable=false; arestas intra-ciclo são feedback", () => {
    const d = dsmOf(raw);
    assert.equal(d.stats.cycleCount, 1);
    assert.equal(d.stats.nodesInCycles, 2);
    assert.equal(d.levelizable, false);
    assert.deepEqual(d.cycles[0], ["SERVICE:s.X", "SERVICE:s.Y"]);
    assert.equal(d.stats.feedbackEdges, 2); // ambas as arestas fecham o ciclo
  });
});

describe("ADR-0026 AT1 — diamante (DAG) é 100% nivelável, feedback só vem de tangle", () => {
  // A→B, A→C, B→D, C→D. Sob caminho-mais-longo: A=0, B=1, C=1, D=2.
  // TODA aresta de um DAG desce ≥1 nível ⇒ 0 feedback (a marca de arquitetura
  // limpa; feedback>0 ⟺ existe tangle).
  const raw: RawSystemGraph = {
    nodes: [
      { id: "CONTROLLER:a.A", type: "CONTROLLER", className: "A" },
      { id: "SERVICE:b.B", type: "SERVICE", className: "B" },
      { id: "SERVICE:c.C", type: "SERVICE", className: "C" },
      { id: "REPOSITORY:d.D", type: "REPOSITORY", className: "D" },
    ],
    edges: [
      { fromNode: "CONTROLLER:a.A", toNode: "SERVICE:b.B", relationType: "CALLS" },
      { fromNode: "CONTROLLER:a.A", toNode: "SERVICE:c.C", relationType: "CALLS" },
      { fromNode: "SERVICE:b.B", toNode: "REPOSITORY:d.D", relationType: "CALLS" },
      { fromNode: "SERVICE:c.C", toNode: "REPOSITORY:d.D", relationType: "CALLS" },
    ],
  };

  it("D cai no nível mais fundo (2); DAG ⇒ levelizable, 0 feedback", () => {
    const d = dsmOf(raw);
    assert.equal(d.levelizable, true);
    assert.equal(d.stats.cycleCount, 0);
    assert.equal(d.stats.levels, 3);       // 0:A · 1:B,C · 2:D
    assert.equal(d.stats.feedbackEdges, 0);
    assert.equal(d.stats.feedbackPct, 0);
    assert.deepEqual(d.partitions[1].nodes.sort(), ["SERVICE:b.B", "SERVICE:c.C"]);
    assert.deepEqual(d.partitions[2].nodes, ["REPOSITORY:d.D"]);
  });
});

describe("ADR-0026 AT1 — bordas (nunca quebra)", () => {
  it("grafo sem arestas → cada nó no nível 0, sem feedback", () => {
    const d = dsmOf({ nodes: [{ id: "ENTITY:e.A", type: "ENTITY" }, { id: "ENTITY:e.B", type: "ENTITY" }], edges: [] });
    assert.equal(d.stats.levels, 1);
    assert.equal(d.stats.feedbackEdges, 0);
    assert.equal(d.levelizable, true);
  });
  it("grafo vazio → estrutura vazia coerente", () => {
    const d = dsmOf({ nodes: [], edges: [] });
    assert.equal(d.stats.nodes, 0);
    assert.equal(d.order.length, 0);
    assert.equal(d.stats.feedbackPct, 0);
  });
});

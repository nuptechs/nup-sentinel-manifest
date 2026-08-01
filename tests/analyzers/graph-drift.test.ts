import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeGraphDrift, driftToFindings } from "../../server/analyzers/graph-drift.ts";

// helpers: monta RawSystemGraph class-level (ids já em nível de classe, sem "(")
const N = (id: string, type: string) => ({ id, type });
const E = (a: string, b: string, t = "CALLS") => ({ fromNode: a, toNode: b, relationType: t });

describe("computeGraphDrift — máquina do tempo (Obra 3)", () => {
  it("detecta nós/arestas novos e removidos, e delta por camada", () => {
    const prev = { nodes: [N("SERVICE:a.A", "SERVICE"), N("ENTITY:a.E", "ENTITY")], edges: [E("SERVICE:a.A", "ENTITY:a.E", "READS_ENTITY")] };
    const curr = { nodes: [N("SERVICE:a.A", "SERVICE"), N("SERVICE:a.B", "SERVICE"), N("ENTITY:a.E", "ENTITY")],
      edges: [E("SERVICE:a.A", "ENTITY:a.E", "READS_ENTITY"), E("SERVICE:a.B", "SERVICE:a.A")] };
    const d = computeGraphDrift(prev, curr);
    assert.deepEqual(d.nodes.added, ["SERVICE:a.B"]);
    assert.equal(d.nodes.removed.length, 0);
    assert.equal(d.nodes.byLayerDelta.SERVICE, 1);
    assert.equal(d.edges.added, 1);
    assert.ok(d.edges.addedSample[0].includes("SERVICE:a.B->SERVICE:a.A"));
  });

  it("acusa CICLO NOVO entre serviços que não existia antes → finding new-cycle", () => {
    const prev = { nodes: [N("SERVICE:a.A", "SERVICE"), N("SERVICE:a.B", "SERVICE")], edges: [E("SERVICE:a.A", "SERVICE:a.B")] };
    const curr = { nodes: [N("SERVICE:a.A", "SERVICE"), N("SERVICE:a.B", "SERVICE")],
      edges: [E("SERVICE:a.A", "SERVICE:a.B"), E("SERVICE:a.B", "SERVICE:a.A")] }; // fecha o ciclo
    const d = computeGraphDrift(prev, curr);
    assert.equal(d.newServiceCycles.length, 1);
    const f = driftToFindings(d, { projectId: "p" });
    const cyc = f.find((x) => x.subtype === "graph-drift-new-cycle");
    assert.ok(cyc, "ciclo novo vira finding");
    assert.ok(cyc.evidences[0].observation.includes("SERVICE:a.A"));
  });

  it("ciclo PREEXISTENTE não vira finding (só o NOVO conta)", () => {
    const cyc = { nodes: [N("SERVICE:a.A", "SERVICE"), N("SERVICE:a.B", "SERVICE")],
      edges: [E("SERVICE:a.A", "SERVICE:a.B"), E("SERVICE:a.B", "SERVICE:a.A")] };
    const d = computeGraphDrift(cyc, cyc);
    assert.equal(d.newServiceCycles.length, 0);
    assert.equal(driftToFindings(d, { projectId: "p" }).length, 0);
  });

  it("salto de acoplamento ≥50% e ≥+5 dependentes vira finding; ruído pequeno não", () => {
    const mkHub = (deps: number) => {
      const nodes = [N("ENTITY:a.Hub", "ENTITY")]; const edges = [];
      for (let i = 0; i < deps; i++) { nodes.push(N(`SERVICE:a.S${i}`, "SERVICE")); edges.push(E(`SERVICE:a.S${i}`, "ENTITY:a.Hub", "READS_ENTITY")); }
      return { nodes, edges };
    };
    const d = computeGraphDrift(mkHub(4), mkHub(12)); // 4→12 = +200%, +8
    const spike = driftToFindings(d, { projectId: "p" }).find((x) => x.subtype === "graph-drift-coupling-spike");
    assert.ok(spike, "salto grande vira finding");
    assert.ok(spike.title.includes("4→12") || spike.title.includes("4") );
    const d2 = computeGraphDrift(mkHub(10), mkHub(12)); // +2 apenas
    assert.equal(driftToFindings(d2, { projectId: "p" }).find((x) => x.subtype === "graph-drift-coupling-spike"), undefined);
  });

  it("delta de isolamento é reportado", () => {
    const prev = { nodes: [N("SERVICE:a.A", "SERVICE"), N("SERVICE:a.Orphan", "SERVICE")], edges: [] };
    const curr = { nodes: [N("SERVICE:a.A", "SERVICE"), N("SERVICE:a.Orphan", "SERVICE")], edges: [E("SERVICE:a.A", "SERVICE:a.Orphan")] };
    const d = computeGraphDrift(prev, curr);
    assert.equal(d.isolationDelta.before, 2);
    assert.equal(d.isolationDelta.after, 0, "os dois deixaram de ser isolados");
  });
});

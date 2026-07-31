import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shapeSystemGraph, classKeyOf } from "../../server/analyzers/system-graph";

describe("classKeyOf", () => {
  it("classe permanece; método vira a classe dona", () => {
    assert.equal(classKeyOf("REPOSITORY:a.b.ContractRepository"), "REPOSITORY:a.b.ContractRepository");
    assert.equal(classKeyOf("REPOSITORY:a.b.ContractRepository.findAll()"), "REPOSITORY:a.b.ContractRepository");
    assert.equal(classKeyOf("REPOSITORY:a.b.ContractRepository.save(S)"), "REPOSITORY:a.b.ContractRepository");
    assert.equal(classKeyOf("SERVICE:a.b.X.m(java.lang.Long, java.lang.String)"), "SERVICE:a.b.X");
  });
});

describe("shapeSystemGraph — level=class (agregação por classe)", () => {
  // grafo method-level: ContractRepository (classe + 2 métodos) → Contract (entidade);
  // ContractService.m → ContractRepository.findAll
  const raw = {
    nodes: [
      { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract", metadata: { sensitiveFields: ["cpf"], sourceFile: "Contract.java" } },
      { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
      { id: "REPOSITORY:d.ContractRepository.findAll()", type: "REPOSITORY" },
      { id: "REPOSITORY:d.ContractRepository.save(S)", type: "REPOSITORY" },
      { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
      { id: "SERVICE:d.ContractService.list()", type: "SERVICE" },
    ],
    edges: [
      { fromNode: "REPOSITORY:d.ContractRepository.findAll()", toNode: "ENTITY:d.Contract", relationType: "READS_ENTITY" },
      { fromNode: "REPOSITORY:d.ContractRepository.save(S)", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY" },
      { fromNode: "SERVICE:d.ContractService.list()", toNode: "REPOSITORY:d.ContractRepository.findAll()", relationType: "CALLS" },
      // self-loop de método interno (mesma classe) — deve sumir no class-level
      { fromNode: "SERVICE:d.ContractService.list()", toNode: "SERVICE:d.ContractService", relationType: "CALLS" },
    ],
  };

  it("dedup: 6 nós de método viram 3 classes", () => {
    const g = shapeSystemGraph(raw, "class");
    assert.equal(g.level, "class");
    assert.equal(g.counts.nodes, 3);
    assert.deepEqual(g.counts.byType, { ENTITY: 1, REPOSITORY: 1, SERVICE: 1 });
    const repo = g.nodes.find((n) => n.type === "REPOSITORY")!;
    assert.equal(repo.className, "ContractRepository");
    assert.equal(repo.memberCount, 3); // classe + 2 métodos
  });

  it("arestas rolam pra classe→classe, dedup, sem self-loop", () => {
    const g = shapeSystemGraph(raw, "class");
    // ContractRepository→Contract (READS+WRITES = 2 arestas de tipos distintos) + ContractService→ContractRepository (CALLS)
    assert.equal(g.counts.edges, 3);
    const keyed = g.edges.map((e) => `${e.toNode.split(".").pop()} ${e.relationType}`);
    assert.ok(keyed.includes("Contract READS_ENTITY"));
    assert.ok(keyed.includes("Contract WRITES_ENTITY"));
    // self-loop ContractService→ContractService NÃO entra
    assert.ok(!g.edges.some((e) => e.fromNode === e.toNode));
  });

  it("grau agregado conecta a CLASSE (antes o nó de classe ficava isolado)", () => {
    const g = shapeSystemGraph(raw, "class");
    const repo = g.nodes.find((n) => n.type === "REPOSITORY")!;
    assert.equal(repo.outDegree, 2); // lê + escreve Contract
    assert.equal(repo.inDegree, 1);  // ContractService chama
    const contract = g.nodes.find((n) => n.type === "ENTITY")!;
    assert.equal(contract.inDegree, 2);
    assert.equal(contract.sensitive, true);
    assert.equal(contract.sourceFile, "Contract.java");
  });
});

describe("shapeSystemGraph — level=method (grafo cru preservado p/ drill-down)", () => {
  it("mantém todos os nós de método e não rola arestas", () => {
    const raw = {
      nodes: [
        { id: "REPOSITORY:d.R", type: "REPOSITORY" },
        { id: "REPOSITORY:d.R.findAll()", type: "REPOSITORY" },
        { id: "ENTITY:d.E", type: "ENTITY" },
      ],
      edges: [{ fromNode: "REPOSITORY:d.R.findAll()", toNode: "ENTITY:d.E", relationType: "READS_ENTITY" }],
    };
    const g = shapeSystemGraph(raw, "method");
    assert.equal(g.level, "method");
    assert.equal(g.counts.nodes, 3);
    assert.equal(g.counts.edges, 1);
  });
});

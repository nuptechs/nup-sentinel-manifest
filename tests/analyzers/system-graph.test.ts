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

describe("shapeSystemGraph — ADR-0025 Ondas 3+4 (ASSOCIATES + entryPoint)", () => {
  it("aresta ASSOCIATES entidade→entidade rola pro class-level (filha conectada)", () => {
    const raw = {
      nodes: [
        { id: "ENTITY:d.ReferenceTable", type: "ENTITY" },
        { id: "ENTITY:d.ReferenceTableRow", type: "ENTITY" },
      ],
      edges: [
        { fromNode: "ENTITY:d.ReferenceTable", toNode: "ENTITY:d.ReferenceTableRow", relationType: "ASSOCIATES" },
      ],
    };
    const g = shapeSystemGraph(raw, "class");
    assert.equal(g.counts.edges, 1);
    assert.equal(g.edges[0].relationType, "ASSOCIATES");
    const filha = g.nodes.find((n) => n.id.endsWith("Row"))!;
    assert.equal(filha.inDegree, 1, "filha deixou de ser isolada");
  });

  it("entryPoint do MÉTODO agrega na CLASSE (class-level) e passa cru no method-level", () => {
    const raw = {
      nodes: [
        { id: "SERVICE:d.AutoScheduler", type: "SERVICE" },
        { id: "SERVICE:d.AutoScheduler.tick()", type: "SERVICE", metadata: { entryPoint: "Scheduled" } },
        { id: "SERVICE:d.Normal.faz()", type: "SERVICE" },
      ],
      edges: [],
    };
    const cls = shapeSystemGraph(raw, "class");
    const sched = cls.nodes.find((n) => n.id.endsWith("AutoScheduler"))!;
    assert.deepEqual(sched.entryPoint, ["Scheduled"], "classe herda o gatilho do método");
    const normal = cls.nodes.find((n) => n.id.endsWith("Normal"))!;
    assert.equal(normal.entryPoint, undefined, "classe comum sem marca");

    const met = shapeSystemGraph(raw, "method");
    const tick = met.nodes.find((n) => n.id.includes("tick"))!;
    assert.deepEqual(tick.entryPoint, ["Scheduled"]);
  });
});

describe("shapeSystemGraph — T1 proveniência exposta nas arestas (ADR-0025)", () => {
  it("resolution/synthetic da metadata crua fluem pro shape (class e method)", () => {
    const raw = {
      nodes: [
        { id: "CONTROLLER:d.Ws.handle()", type: "CONTROLLER" },
        { id: "SERVICE:d.Svc.faz()", type: "SERVICE" },
      ],
      edges: [
        { fromNode: "CONTROLLER:d.Ws.handle()", toNode: "SERVICE:d.Svc.faz()", relationType: "CALLS",
          metadata: { resolution: "interface-impl", synthetic: true } },
      ],
    };
    for (const level of ["class", "method"] as const) {
      const g = shapeSystemGraph(raw, level);
      assert.equal(g.edges[0].resolution, "interface-impl", `${level}: resolution flui`);
      assert.equal(g.edges[0].synthetic, true, `${level}: synthetic flui`);
    }
  });

  it("aresta sem metadata segue sem os campos (payload enxuto, sem regressão)", () => {
    const raw = {
      nodes: [{ id: "SERVICE:d.A.m()", type: "SERVICE" }, { id: "SERVICE:d.B.n()", type: "SERVICE" }],
      edges: [{ fromNode: "SERVICE:d.A.m()", toNode: "SERVICE:d.B.n()", relationType: "CALLS" }],
    };
    const g = shapeSystemGraph(raw, "method");
    assert.equal(g.edges[0].resolution, undefined);
    assert.equal(g.edges[0].synthetic, undefined);
  });
});

// ─── ADR-0028 P0.1 — taxonomia epistêmica (método+confiança) + censo ───
// Prova o CONTRATO: toda aresta/nó declara COMO sabemos que existe, e o grafo
// carrega um censo. Os valores REAIS de `resolution` (grep server/analyzers|
// pipeline): PRECISOS `compiler`/`interface-impl` (Engine A) → STATIC_PROVEN;
// HEURÍSTICOS `syntactic-declared` (sempre synthetic:true) + `convention-name`
// (full-stack-augment) → STATIC_UNRESOLVED.
describe("shapeSystemGraph — ADR-0028 P0.1 evidence por ARESTA (5 métodos)", () => {
  function oneEdge(metadata: Record<string, unknown> | undefined) {
    const raw = {
      nodes: [{ id: "SERVICE:d.A.m()", type: "SERVICE" }, { id: "SERVICE:d.B.n()", type: "SERVICE" }],
      edges: [{ fromNode: "SERVICE:d.A.m()", toNode: "SERVICE:d.B.n()", relationType: "CALLS", metadata }],
    };
    return shapeSystemGraph(raw, "method").edges[0];
  }

  it("observed → RUNTIME_OBSERVED (0.95) e preserva count", () => {
    const e = oneEdge({ observed: true, count: 7, source: "jaeger" });
    assert.deepEqual(e.evidence, { method: "RUNTIME_OBSERVED", confidence: 0.95 });
    assert.equal(e.observed, true);
    assert.equal(e.count, 7);
  });

  it("resolution `compiler` → STATIC_PROVEN (0.80)", () => {
    const e = oneEdge({ resolution: "compiler" });
    assert.deepEqual(e.evidence, { method: "STATIC_PROVEN", confidence: 0.80 });
  });

  it("resolution `interface-impl` (sem synthetic) → STATIC_PROVEN (0.80)", () => {
    const e = oneEdge({ resolution: "interface-impl" });
    assert.deepEqual(e.evidence, { method: "STATIC_PROVEN", confidence: 0.80 });
  });

  it("synthetic:true + `syntactic-declared` → STATIC_UNRESOLVED (0.40)", () => {
    const e = oneEdge({ synthetic: true, resolution: "syntactic-declared" });
    assert.deepEqual(e.evidence, { method: "STATIC_UNRESOLVED", confidence: 0.40 });
  });

  it("resolution `convention-name` (heurística, sem synthetic) → STATIC_UNRESOLVED (0.40)", () => {
    const e = oneEdge({ resolution: "convention-name" });
    assert.deepEqual(e.evidence, { method: "STATIC_UNRESOLVED", confidence: 0.40 });
  });

  it("aresta sem proveniência → UNKNOWN (0.20) — o mapa ADMITE que não sabe", () => {
    const e = oneEdge(undefined);
    assert.deepEqual(e.evidence, { method: "UNKNOWN", confidence: 0.20 });
  });

  it("precedência: observed vence resolution/synthetic (RUNTIME domina)", () => {
    const e = oneEdge({ observed: true, resolution: "convention-name", synthetic: true });
    assert.equal(e.evidence.method, "RUNTIME_OBSERVED");
  });

  it("precedência: synthetic vence resolution precisa (declarada > provada nominal)", () => {
    // `syntactic-declared` chega SEMPRE com synthetic:true no full-stack-augment;
    // aqui simulamos synthetic com uma resolution que seria precisa se sozinha.
    const e = oneEdge({ synthetic: true, resolution: "compiler" });
    assert.equal(e.evidence.method, "STATIC_UNRESOLVED");
  });

  it("LLM_CONJECTURED é RESERVADO — nenhum produtor o emite hoje", () => {
    // Não há entrada que produza este método; a coluna existe só no censo (=0).
    // Garante que resolution desconhecida NÃO vira LLM_CONJECTURED por engano.
    const e = oneEdge({ resolution: "algo-inventado" });
    assert.equal(e.evidence.method, "UNKNOWN");
  });
});

describe("shapeSystemGraph — ADR-0028 P0.1 evidence por NÓ + censo de cobertura", () => {
  // Grafo method-level cobrindo os 5 métodos de aresta + nós hot/frio.
  const raw = {
    nodes: [
      { id: "ROUTE:runtime:GET:/x", type: "ROUTE", metadata: { runtimeHot: true, runtimeCount: 4, observed: true } },
      { id: "SERVICE:d.A.m()", type: "SERVICE", metadata: { runtimeHot: true, runtimeCount: 2 } },
      { id: "SERVICE:d.B.n()", type: "SERVICE" }, // frio
      { id: "SERVICE:d.C.p()", type: "SERVICE" }, // frio
      { id: "SERVICE:d.D.q()", type: "SERVICE" }, // frio
    ],
    edges: [
      { fromNode: "ROUTE:runtime:GET:/x", toNode: "SERVICE:d.A.m()", relationType: "RUNTIME_OBSERVED", metadata: { observed: true, count: 4 } },
      { fromNode: "SERVICE:d.A.m()", toNode: "SERVICE:d.B.n()", relationType: "CALLS", metadata: { resolution: "compiler" } },
      { fromNode: "SERVICE:d.A.m()", toNode: "SERVICE:d.C.p()", relationType: "CALLS", metadata: { resolution: "interface-impl" } },
      { fromNode: "SERVICE:d.B.n()", toNode: "SERVICE:d.C.p()", relationType: "CALLS", metadata: { synthetic: true, resolution: "syntactic-declared" } },
      { fromNode: "SERVICE:d.C.p()", toNode: "SERVICE:d.D.q()", relationType: "CALLS", metadata: { resolution: "convention-name" } },
      { fromNode: "SERVICE:d.B.n()", toNode: "SERVICE:d.D.q()", relationType: "CALLS" }, // sem metadata → UNKNOWN
    ],
  };

  it("nó hot → evidence RUNTIME_OBSERVED + observed:true; nó frio → STATIC_PROVEN sem observed", () => {
    const g = shapeSystemGraph(raw, "method");
    const hot = g.nodes.find((n) => n.id === "SERVICE:d.A.m()")!;
    assert.deepEqual(hot.evidence, { method: "RUNTIME_OBSERVED", confidence: 0.95 });
    assert.equal(hot.observed, true);
    const frio = g.nodes.find((n) => n.id === "SERVICE:d.B.n()")!;
    assert.deepEqual(frio.evidence, { method: "STATIC_PROVEN", confidence: 0.80 });
    assert.equal(frio.observed, undefined);
  });

  it("censo de arestas: byMethod (LLM=0, CONFIG=0) + total + observedRatio", () => {
    const g = shapeSystemGraph(raw, "method");
    assert.deepEqual(g.coverage.edges.byMethod, {
      RUNTIME_OBSERVED: 1,
      STATIC_PROVEN: 2,
      CONFIG_PROVEN: 0, // ADR-0035 §4 — coluna do censo (=0 sem config-edges)
      STATIC_UNRESOLVED: 2,
      LLM_CONJECTURED: 0,
      UNKNOWN: 1,
    });
    assert.equal(g.coverage.edges.total, 6);
    assert.equal(g.coverage.edges.observedRatio, 1 / 6);
    // soma das colunas == total (censo fechado, nada some por omissão)
    const sum = Object.values(g.coverage.edges.byMethod).reduce((a, b) => a + b, 0);
    assert.equal(sum, g.coverage.edges.total);
  });

  it("censo de nós: observed vs total (o que roda × o que só existe)", () => {
    const g = shapeSystemGraph(raw, "method");
    assert.deepEqual(g.coverage.nodes, { observed: 2, total: 5 });
  });

  it("grafo vazio: observedRatio=0 sem divisão-por-zero; colunas zeradas", () => {
    const g = shapeSystemGraph({ nodes: [], edges: [] }, "method");
    assert.equal(g.coverage.edges.total, 0);
    assert.equal(g.coverage.edges.observedRatio, 0);
    assert.deepEqual(g.coverage.edges.byMethod, {
      RUNTIME_OBSERVED: 0, STATIC_PROVEN: 0, CONFIG_PROVEN: 0, STATIC_UNRESOLVED: 0, LLM_CONJECTURED: 0, UNKNOWN: 0,
    });
    assert.deepEqual(g.coverage.nodes, { observed: 0, total: 0 });
  });

  it("class-level também carrega censo + evidence (após dedup de arestas)", () => {
    const g = shapeSystemGraph(raw, "class");
    // toda aresta shaped tem evidence
    assert.ok(g.edges.every((e) => !!e.evidence && typeof e.evidence.confidence === "number"));
    // todo nó shaped tem evidence
    assert.ok(g.nodes.every((n) => !!n.evidence));
    assert.equal(g.coverage.edges.total, g.edges.length);
    const sum = Object.values(g.coverage.edges.byMethod).reduce((a, b) => a + b, 0);
    assert.equal(sum, g.coverage.edges.total);
  });
});

// ─────────────────────────────────────────────
// impact-confidence — unit tests (ADR-0028 P4)
//
// A análise de impacto passa a colher o contrato epistêmico (P0.1): por afetado,
// o ELO MAIS FRACO no caminho + confiança; partição PROVEN × POSSIBLE; a lista de
// BLIND SPOTS (arestas não-resolvidas que tocam o raio e podem esconder impacto);
// confiança geral + disclosure honesto. Degrada pra tudo UNKNOWN sem crashar.
// Puro, determinístico, sem I/O.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shapeSystemGraph } from "../../server/analyzers/system-graph.ts";
import { computeImpactConfidence } from "../../server/analyzers/impact-confidence.ts";
import { computeImpact } from "../../server/analyzers/impact-analyzer.ts";

// Grafo cru (class-level). Direção from→to = chamador→chamado / acessor→entidade.
//   ContractController → ContractService   (CALLS, compiler)         STATIC_PROVEN
//   ContractService    → ContractRepository (CALLS, observed)        RUNTIME_OBSERVED
//   ContractRepository → Contract           (WRITES_ENTITY, compiler) STATIC_PROVEN
//   ReportService      → ContractService    (CALLS, synthetic)       STATIC_UNRESOLVED
//   FacadeService      → ReportService       (CALLS, compiler)        STATIC_PROVEN
//   UnrelatedA         → UnrelatedB          (CALLS, synthetic)       STATIC_UNRESOLVED (fora do raio)
const RAW = {
  nodes: [
    { id: "CONTROLLER:d.ContractController", type: "CONTROLLER", className: "ContractController" },
    { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
    { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
    { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract" },
    { id: "SERVICE:d.ReportService", type: "SERVICE", className: "ReportService" },
    { id: "SERVICE:d.FacadeService", type: "SERVICE", className: "FacadeService" },
    { id: "SERVICE:d.UnrelatedA", type: "SERVICE", className: "UnrelatedA" },
    { id: "SERVICE:d.UnrelatedB", type: "SERVICE", className: "UnrelatedB" },
  ],
  edges: [
    { fromNode: "CONTROLLER:d.ContractController", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.ContractService", toNode: "REPOSITORY:d.ContractRepository", relationType: "CALLS", metadata: { observed: true, count: 12 } },
    { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.ReportService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { synthetic: true, resolution: "convention-name" } },
    { fromNode: "SERVICE:d.FacadeService", toNode: "SERVICE:d.ReportService", relationType: "CALLS", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.UnrelatedA", toNode: "SERVICE:d.UnrelatedB", relationType: "CALLS", metadata: { synthetic: true } },
  ],
};

function shaped() {
  return shapeSystemGraph(RAW, "class");
}

describe("computeImpactConfidence — proven × possible (elo mais fraco)", () => {
  const conf = computeImpactConfidence(shaped(), "Contract");

  it("símbolo resolve no grafo e evidência está disponível", () => {
    assert.equal(conf.symbolLocatedInGraph, true);
    assert.equal(conf.evidenceAvailable, true);
  });

  it("PROVEN: alvos por rota inteiramente provada (repo/service/controller)", () => {
    const labels = conf.proven.map((a) => a.label).sort();
    assert.deepEqual(labels, ["ContractController", "ContractRepository", "ContractService"]);
    // todos com weakestMethod na faixa provada
    for (const a of conf.proven) {
      assert.ok(a.weakestMethod === "STATIC_PROVEN" || a.weakestMethod === "RUNTIME_OBSERVED", a.weakestMethod);
    }
  });

  it("POSSIBLE: ReportService entra por rota que passa por aresta não-resolvida", () => {
    const rs = conf.possible.find((a) => a.label === "ReportService");
    assert.ok(rs, "ReportService deve ser 'possible'");
    assert.equal(rs!.weakestMethod, "STATIC_UNRESOLVED");
    assert.equal(rs!.confidence, 0.4);
  });

  it("ELO MAIS FRACO propaga: FacadeService (aresta própria PROVADA) é POSSIBLE por atravessar a não-resolvida", () => {
    // FacadeService → ReportService é compiler (0.8), mas o caminho até Contract
    // passa por ReportService→ContractService (unresolved 0.4). A cadeia vale seu
    // elo mais fraco ⇒ possible, weakestMethod STATIC_UNRESOLVED.
    const fs = conf.possible.find((a) => a.label === "FacadeService");
    assert.ok(fs, "FacadeService deve cair em 'possible' pelo elo mais fraco");
    assert.equal(fs!.weakestMethod, "STATIC_UNRESOLVED");
    assert.equal(fs!.confidence, 0.4);
    assert.ok(!conf.proven.some((a) => a.label === "FacadeService"), "não pode estar em proven");
  });

  it("o próprio símbolo (Contract) NÃO é listado como afetado", () => {
    assert.ok(!conf.proven.some((a) => a.label === "Contract"));
    assert.ok(!conf.possible.some((a) => a.label === "Contract"));
  });

  it("confiança geral = piso do raio (elo mais fraco) e método geral = STATIC_UNRESOLVED", () => {
    assert.equal(conf.overallConfidence, 0.4);
    assert.equal(conf.overallMethod, "STATIC_UNRESOLVED");
  });
});

describe("computeImpactConfidence — blind spots (o que pode esconder impacto)", () => {
  const conf = computeImpactConfidence(shaped(), "Contract");

  it("lista a aresta não-resolvida que TOCA o raio (ReportService→ContractService)", () => {
    assert.equal(conf.blindSpotCount, 1);
    assert.equal(conf.blindSpots.length, 1);
    const bs = conf.blindSpots[0];
    assert.equal(bs.relationType, "CALLS");
    assert.equal(bs.method, "STATIC_UNRESOLVED");
    assert.ok(bs.fromNode.endsWith("ReportService"));
    assert.ok(bs.toNode.endsWith("ContractService"));
    assert.match(bs.reason, /dispatch dinâmico|DI/);
  });

  it("aresta não-resolvida FORA do raio (UnrelatedA→UnrelatedB) NÃO vira blind spot", () => {
    assert.ok(!conf.blindSpots.some((b) => b.fromNode.includes("Unrelated") || b.toNode.includes("Unrelated")));
  });

  it("disclosure é honesto: garante os provados E admite cegueira", () => {
    assert.match(conf.disclosure, /Posso garantir o impacto sobre 3 alvo/);
    assert.match(conf.disclosure, /CEGO em 1 aresta/);
    assert.match(conf.disclosure, /POSSÍVEL/);
  });
});

describe("computeImpactConfidence — widest-path escolhe a rota PROVADA quando existe", () => {
  it("nó com 2 rotas (uma provada, uma não-resolvida) fica PROVEN (maximin)", () => {
    const raw = {
      nodes: [
        { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract" },
        { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
        { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
        { id: "SERVICE:d.DualService", type: "SERVICE", className: "DualService" },
      ],
      edges: [
        { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } },
        { fromNode: "SERVICE:d.ContractService", toNode: "ENTITY:d.Contract", relationType: "READS_ENTITY", metadata: { synthetic: true } }, // rota fraca
        { fromNode: "SERVICE:d.DualService", toNode: "REPOSITORY:d.ContractRepository", relationType: "CALLS", metadata: { observed: true } }, // rota forte
        { fromNode: "SERVICE:d.DualService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { synthetic: true } }, // rota fraca
      ],
    };
    const conf = computeImpactConfidence(shapeSystemGraph(raw, "class"), "Contract");
    const dual = [...conf.proven, ...conf.possible].find((a) => a.label === "DualService");
    assert.ok(dual, "DualService alcançável");
    // existe uma rota inteiramente provada (Dual→Repo(obs)→Contract(compiler)) ⇒ proven
    assert.ok(conf.proven.some((a) => a.label === "DualService"), "maximin deve escolher a rota provada");
    assert.equal(dual!.weakestMethod, "STATIC_PROVEN");
  });
});

describe("computeImpactConfidence — degradação sem crashar", () => {
  it("grafo AUSENTE (null) + raio do manifest → tudo UNKNOWN/possible, disclosure honesto", () => {
    const fallback = [
      { id: "EP:PUT /api/contracts/{id}", label: "PUT /api/contracts/{id}", type: "ENDPOINT", weakestMethod: "STATIC_PROVEN" as const, confidence: 0.9, depth: 1 },
      { id: "ENTITY:Contract", label: "Contract", type: "ENTITY", weakestMethod: "STATIC_PROVEN" as const, confidence: 0.9, depth: 1 },
    ];
    const conf = computeImpactConfidence(null, "Contract", fallback);
    assert.equal(conf.evidenceAvailable, false);
    assert.equal(conf.symbolLocatedInGraph, false);
    assert.equal(conf.proven.length, 0);
    assert.equal(conf.possible.length, 2);
    // o fallback é NORMALIZADO pra UNKNOWN (não herda a confiança otimista do manifest)
    assert.ok(conf.possible.every((a) => a.weakestMethod === "UNKNOWN" && a.confidence === 0.2));
    assert.equal(conf.blindSpots.length, 0);
    assert.match(conf.disclosure, /Sem grafo de evidência/);
    assert.match(conf.disclosure, /Re-rode a análise/);
  });

  it("grafo PRESENTE mas SEM proveniência (snapshot antigo) → arestas UNKNOWN, evidenceAvailable=false, blind spots = arestas do raio", () => {
    const rawNoProv = {
      nodes: [
        { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract" },
        { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
      ],
      edges: [
        // sem metadata → classifyEdgeEvidence = UNKNOWN
        { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY" },
      ],
    };
    const conf = computeImpactConfidence(shapeSystemGraph(rawNoProv, "class"), "Contract");
    assert.equal(conf.evidenceAvailable, false);
    // o repo é alcançável mas por aresta UNKNOWN ⇒ possible, não proven
    assert.equal(conf.proven.length, 0);
    assert.ok(conf.possible.some((a) => a.label === "ContractRepository" && a.weakestMethod === "UNKNOWN"));
    // a aresta UNKNOWN que toca o raio é um blind spot
    assert.equal(conf.blindSpotCount, 1);
    assert.equal(conf.blindSpots[0].method, "UNKNOWN");
    assert.match(conf.disclosure, /não carrega proveniência|Sem grafo de evidência/);
  });

  it("símbolo INEXISTENTE no grafo → raio do manifest, symbolLocatedInGraph=false, sem crash", () => {
    const conf = computeImpactConfidence(shaped(), "NadaAVer", [
      { id: "EP:GET /x", label: "GET /x", type: "ENDPOINT", weakestMethod: "UNKNOWN" as const, confidence: 0.2, depth: 1 },
    ]);
    assert.equal(conf.symbolLocatedInGraph, false);
    assert.equal(conf.possible.length, 1);
    assert.equal(conf.proven.length, 0);
    // o censo do grafo ainda é ecoado (evidência existe no grafo, só não p/ este símbolo)
    assert.ok(conf.coverage, "coverage ecoado do grafo");
  });

  it("grafo vazio / edges ausentes → não estoura", () => {
    assert.doesNotThrow(() => computeImpactConfidence({ nodes: [], edges: [] } as any, "Contract"));
    assert.doesNotThrow(() => computeImpactConfidence(undefined, "Contract"));
  });
});

describe("computeImpact — enriquecimento ADITIVO (retrocompat)", () => {
  it("manifest COM systemGraph → report.confidence colhe proven/possible/blindSpots do grafo", () => {
    const manifest = {
      systemGraph: RAW,
      endpoints: [],
      screens: [],
      entities: [],
    };
    const r = computeImpact(manifest, "Contract");
    assert.ok(r.confidence, "confidence sempre presente");
    assert.equal(r.confidence.symbolLocatedInGraph, true);
    assert.ok(r.confidence.proven.some((a) => a.label === "ContractRepository"));
    assert.ok(r.confidence.possible.some((a) => a.label === "ReportService"));
    assert.equal(r.confidence.blindSpotCount, 1);
  });

  it("manifest SEM systemGraph → campos antigos byte-a-byte + confidence degradado (não quebra)", () => {
    const manifest = {
      endpoints: [
        { path: "/api/contracts/{id}", method: "PUT", controller: "ContractController", controllerMethod: "update", serviceMethods: ["ContractService.update"], entitiesTouched: ["Contract"], fullCallChain: [] },
      ],
      screens: [{ name: "ContractEdit", route: "/c", interactions: [{ endpoint: "/api/contracts/{id}", httpMethod: "PUT" }] }],
      entities: [],
    };
    const r = computeImpact(manifest, "ContractService");
    // campos da Onda anterior intactos
    assert.equal(r.found, true);
    assert.equal(r.summary.endpoints, 1);
    assert.equal(r.impactedEndpoints[0].path, "/api/contracts/{id}");
    // confidence presente, degradado (sem grafo de evidência), raio do manifest vira possible
    assert.ok(r.confidence);
    assert.equal(r.confidence.evidenceAvailable, false);
    assert.equal(r.confidence.proven.length, 0);
    assert.ok(r.confidence.possible.length >= 1);
    assert.ok(r.confidence.possible.every((a) => a.weakestMethod === "UNKNOWN"));
  });

  it("símbolo curto → report vazio ainda carrega confidence (degradado), sem crash", () => {
    const r = computeImpact({ systemGraph: RAW }, "ab");
    assert.equal(r.found, false);
    assert.ok(r.confidence);
    assert.equal(r.confidence.proven.length, 0);
  });
});

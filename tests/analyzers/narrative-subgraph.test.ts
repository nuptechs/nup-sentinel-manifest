// ─────────────────────────────────────────────
// narrative-subgraph — unit tests (ADR-0033 P4.1)
//
// A espinha ANDÁVEL: só arestas VERIFICADAS (RUNTIME_OBSERVED/STATIC_PROVEN) que
// tocam o raio; blindSpots nomeados; proveniência (traços / ADR arquivo:linha).
// Degrada honesto: grafo ausente / símbolo fora → subgrafo vazio, sem crashar.
// Puro, determinístico.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shapeSystemGraph } from "../../server/analyzers/system-graph.ts";
import { buildNarrativeSubgraph } from "../../server/analyzers/narrative-subgraph.ts";
import type { AdrLink } from "../../server/analyzers/adr-tacit-links.ts";

// Grafo cru (class-level). from→to = chamador→chamado / acessor→entidade.
//   ContractController → ContractService   CALLS compiler         STATIC_PROVEN
//   ContractService    → ContractRepository CALLS observed×12      RUNTIME_OBSERVED
//   ContractRepository → Contract           WRITES_ENTITY compiler STATIC_PROVEN (Contract sensível)
//   AuthService(sens.) → ContractService    CALLS observed×5       RUNTIME_OBSERVED
//   ReportService      → ContractService    CALLS synthetic        STATIC_UNRESOLVED (blind)
//   UnrelatedA         → UnrelatedB          CALLS synthetic        STATIC_UNRESOLVED (fora do raio)
const RAW = {
  nodes: [
    { id: "CONTROLLER:d.ContractController", type: "CONTROLLER", className: "ContractController" },
    { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
    { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
    { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract", metadata: { sensitiveFields: ["cpf"] } },
    { id: "SERVICE:d.AuthService", type: "SERVICE", className: "AuthService", metadata: { sensitiveFields: ["token"] } },
    { id: "SERVICE:d.ReportService", type: "SERVICE", className: "ReportService" },
    { id: "SERVICE:d.UnrelatedA", type: "SERVICE", className: "UnrelatedA" },
    { id: "SERVICE:d.UnrelatedB", type: "SERVICE", className: "UnrelatedB" },
  ],
  edges: [
    { fromNode: "CONTROLLER:d.ContractController", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.ContractService", toNode: "REPOSITORY:d.ContractRepository", relationType: "CALLS", metadata: { observed: true, count: 12 } },
    { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.AuthService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { observed: true, count: 5 } },
    { fromNode: "SERVICE:d.ReportService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { synthetic: true, resolution: "convention-name" } },
    { fromNode: "SERVICE:d.UnrelatedA", toNode: "SERVICE:d.UnrelatedB", relationType: "CALLS", metadata: { synthetic: true } },
  ],
};

function shaped() {
  return shapeSystemGraph(RAW, "class");
}

describe("buildNarrativeSubgraph — só arestas VERIFICADAS entram na espinha", () => {
  const sub = buildNarrativeSubgraph(shaped(), "Contract");

  it("símbolo localizado + evidência disponível", () => {
    assert.equal(sub.symbolLocatedInGraph, true);
    assert.equal(sub.evidenceAvailable, true);
  });

  it("a espinha andável tem SÓ arestas proven-tier (a unresolved fica FORA)", () => {
    assert.equal(sub.edges.length, 4);
    for (const e of sub.edges) {
      assert.ok(e.method === "RUNTIME_OBSERVED" || e.method === "STATIC_PROVEN", `aresta verificada esperada, veio ${e.method}`);
    }
    // a aresta STATIC_UNRESOLVED ReportService→ContractService NÃO está na espinha…
    const walkableIds = new Set(sub.edges.map((e) => e.edgeId));
    assert.ok(!walkableIds.has("SERVICE:d.ReportService|SERVICE:d.ContractService|CALLS"), "unresolved não pode ser andável");
    // …mas ESTÁ nos blindSpots (nomeada, não apagada).
    const blind = sub.blindSpots.find((b) => b.fromNode === "SERVICE:d.ReportService" && b.toNode === "SERVICE:d.ContractService");
    assert.ok(blind, "a aresta unresolved deve aparecer como blind spot");
    assert.equal(blind!.method, "STATIC_UNRESOLVED");
  });

  it("edgeIds espelha exatamente a espinha (a lei do gate)", () => {
    assert.equal(sub.edgeIds.size, sub.edges.length);
    for (const e of sub.edges) assert.ok(sub.edgeIds.has(e.edgeId));
  });

  it("proveniência: aresta observada carrega count de traços", () => {
    const svcRepo = sub.edges.find((e) => e.fromNode === "SERVICE:d.ContractService" && e.toNode === "REPOSITORY:d.ContractRepository");
    assert.ok(svcRepo);
    assert.equal(svcRepo!.method, "RUNTIME_OBSERVED");
    assert.equal(svcRepo!.count, 12);
    assert.match(svcRepo!.provenance, /12 traço/);
  });

  it("facetas de projeção: sensível e camada nos extremos", () => {
    const repoContract = sub.edges.find((e) => e.toNode === "ENTITY:d.Contract");
    assert.ok(repoContract);
    assert.equal(repoContract!.toSensitive, true, "Contract é sensível");
    assert.equal(repoContract!.toType, "ENTITY");
    const authSvc = sub.edges.find((e) => e.fromNode === "SERVICE:d.AuthService");
    assert.ok(authSvc);
    assert.equal(authSvc!.fromSensitive, true, "AuthService é sensível");
    // camada canônica derivada (Controller=api, Service=domain)
    const ctrlSvc = sub.edges.find((e) => e.fromNode === "CONTROLLER:d.ContractController");
    assert.equal(ctrlSvc!.fromLayer, "api");
    assert.equal(ctrlSvc!.toLayer, "domain");
  });

  it("UnrelatedA→UnrelatedB (fora do raio) não entra na espinha nem nos blind spots", () => {
    assert.ok(!sub.edges.some((e) => e.fromNode.includes("UnrelatedA")));
    assert.ok(!sub.blindSpots.some((b) => b.fromNode.includes("UnrelatedA")));
  });
});

describe("buildNarrativeSubgraph — proveniência tácita (ADR links filtradas ao raio)", () => {
  const adrLinks: AdrLink[] = [
    { adrId: "ADR-063", adrTitle: "Garantia", targetSymbol: "Contract", sourceRef: "docs/adr/ADR-063.md:12", sourceLine: 12, sourceText: "…Contract…", citation: "backtick", confidence: "STATIC_PROVEN" },
    { adrId: "ADR-070", adrTitle: "Impacto", targetSymbol: "ContractService", sourceRef: "docs/adr/ADR-070.md:5", sourceLine: 5, sourceText: "…ContractService…", citation: "backtick", confidence: "STATIC_PROVEN" },
    { adrId: "ADR-999", adrTitle: "Irrelevante", targetSymbol: "SomethingElse", sourceRef: "docs/adr/ADR-999.md:1", sourceLine: 1, sourceText: "…", citation: "prose", confidence: "STATIC_UNRESOLVED" },
  ];
  const sub = buildNarrativeSubgraph(shaped(), "Contract", { adrLinks });

  it("mantém só as ADR cujos símbolos aparecem no raio", () => {
    const ids = sub.adrLinks.map((l) => l.adrId).sort();
    assert.deepEqual(ids, ["ADR-063", "ADR-070"]);
    assert.ok(!ids.includes("ADR-999"), "ADR de símbolo fora do raio é filtrada");
  });

  it("carrega a proveniência arquivo:linha (não inventada)", () => {
    const l = sub.adrLinks.find((x) => x.adrId === "ADR-063");
    assert.equal(l!.sourceRef, "docs/adr/ADR-063.md:12");
  });
});

describe("buildNarrativeSubgraph — degradação honesta", () => {
  it("grafo ausente → subgrafo vazio, sem crashar", () => {
    const sub = buildNarrativeSubgraph(null, "Contract");
    assert.equal(sub.edges.length, 0);
    assert.equal(sub.edgeIds.size, 0);
    assert.equal(sub.symbolLocatedInGraph, false);
    assert.equal(sub.adrLinks.length, 0);
  });

  it("símbolo fora do grafo → espinha vazia, símbolo não-localizado", () => {
    const sub = buildNarrativeSubgraph(shaped(), "InexistenteXYZ");
    assert.equal(sub.symbolLocatedInGraph, false);
    assert.equal(sub.edges.length, 0);
  });

  it("grafo sem proveniência (tudo UNKNOWN) → nenhuma aresta andável", () => {
    const rawNoProv = {
      nodes: [
        { id: "SERVICE:d.A", type: "SERVICE", className: "A" },
        { id: "SERVICE:d.B", type: "SERVICE", className: "B" },
      ],
      edges: [{ fromNode: "SERVICE:d.A", toNode: "SERVICE:d.B", relationType: "CALLS", metadata: {} }],
    };
    const sub = buildNarrativeSubgraph(shapeSystemGraph(rawNoProv, "class"), "B");
    assert.equal(sub.edges.length, 0, "aresta UNKNOWN não é andável");
  });
});

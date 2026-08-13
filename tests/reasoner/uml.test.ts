// Suíte UML — builders (grafo→modelo) + renderer (modelo→Mermaid). Prova: cada
// tipo usa dados reais do grafo, confiança por elemento, dialeto Mermaid correto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildClass, buildComponent, buildPackage, buildDeployment, buildUseCase, buildActivity, buildState,
} from "../../server/reasoner/uml/uml-builders.ts";
import { umlToMermaid } from "../../server/reasoner/uml/uml-render.ts";

const G = {
  nodes: [
    { id: "ENTITY:app.Contract", type: "ENTITY", className: "Contract", sourceFile: "src/main/java/app/entities/Contract.java", stack: "spring" },
    { id: "ENTITY:app.ServiceOrder", type: "ENTITY", className: "ServiceOrder", sourceFile: "src/main/java/app/entities/ServiceOrder.java", stack: "spring" },
    { id: "SUPERTYPE:app.BaseEntity", type: "SUPERTYPE", className: "BaseEntity", sourceFile: "src/main/java/app/entities/BaseEntity.java", stack: "spring" },
    { id: "SERVICE:app.ContractService", type: "SERVICE", className: "ContractService", sourceFile: "services/gateway/src/contracts/service.ts", stack: "node" },
    { id: "ROUTE:GET:/api/contracts", type: "ROUTE", httpMethod: "GET", endpoint: "/api/contracts", sourceFile: "services/gateway/src/routes/contracts.ts", observed: true },
    { id: "VIEW:ContractsPage", type: "VIEW", className: "ContractsPage", sourceFile: "frontend/src/pages/Contracts.vue", stack: "vue" },
    { id: "ENTITY:app.ContractStatus", type: "ENTITY", className: "ContractStatus", sourceFile: "src/main/java/app/enums/ContractStatus.java", stack: "spring" },
  ],
  edges: [
    { fromNode: "ENTITY:app.Contract", toNode: "SUPERTYPE:app.BaseEntity", relationType: "EXTENDS", resolution: "syntactic-declared" },
    { fromNode: "ENTITY:app.Contract", toNode: "ENTITY:app.ServiceOrder", relationType: "ASSOCIATES", resolution: "compiler" },
    { fromNode: "SERVICE:app.ContractService", toNode: "ENTITY:app.Contract", relationType: "READS_ENTITY", evidence: { method: "STATIC_PROVEN" } },
    { fromNode: "ROUTE:GET:/api/contracts", toNode: "SERVICE:app.ContractService", relationType: "RUNTIME_OBSERVED", evidence: { method: "RUNTIME_OBSERVED" } },
    { fromNode: "SERVICE:app.ContractService", toNode: "ENTITY:app.Contract", relationType: "RUNTIME_OBSERVED", evidence: { method: "RUNTIME_OBSERVED" } },
    { fromNode: "SERVICE:app.ContractService", toNode: "ENTITY:app.Contract", relationType: "CALLS", evidence: { method: "STATIC_PROVEN" } },
  ],
};

describe("uml/builders — cada tipo usa dados reais", () => {
  it("class: entidades + herança + associação", () => {
    const m = buildClass(G as never);
    assert.ok(m.nodes.some((n) => n.label === "Contract"));
    assert.ok(m.rels.some((r) => r.kind === "inheritance"));
    assert.ok(m.rels.some((r) => r.kind === "association" && r.confidence === "proven"));
    assert.match(umlToMermaid(m), /^classDiagram/);
  });
  it("component/package: agrupa por diretório + dependências", () => {
    const c = buildComponent(G as never);
    assert.ok(c.nodes.length >= 2, "vários blocos");
    assert.ok(c.rels.length >= 1, "dependência entre blocos");
    assert.match(umlToMermaid(c), /^flowchart/);
    const p = buildPackage(G as never);
    assert.ok(p.nodes.length >= 2);
  });
  it("deployment: unidades por stack + runtime observado", () => {
    const m = buildDeployment(G as never);
    const ids = m.nodes.map((n) => n.id);
    assert.ok(ids.includes("backend") || ids.includes("gateway"));
    assert.ok(ids.includes("db"), "banco é uma unidade");
    assert.ok(ids.includes("frontend"), "frontend é uma unidade");
    assert.ok(m.rels.some((r) => r.confidence === "observed"), "há ligação observada (runtime)");
  });
  it("usecase: ator + casos agrupados por domínio; observado marcado", () => {
    const m = buildUseCase(G as never);
    assert.ok(m.nodes.some((n) => n.kind === "actor"));
    const uc = m.nodes.find((n) => n.kind === "usecase");
    assert.ok(uc && uc.confidence === "observed", "rota com tráfego = observado");
    assert.ok(m.groups.length >= 1);
  });
  it("activity: reusa mechanism → início/atividades/fim", () => {
    const report = { steps: [{ order: 1, fromLabel: "Route", toLabel: "Service", method: "RUNTIME_OBSERVED", runtimeConfirmed: true }, { order: 2, fromLabel: "Service", toLabel: "Repo", method: "STATIC_PROVEN" }], branches: [{ atLabel: "Service", fanOut: 2 }] };
    const m = buildActivity(report as never, { entryLabel: "GET /x" });
    assert.ok(m.nodes.some((n) => n.kind === "start") && m.nodes.some((n) => n.kind === "end"));
    assert.ok(m.nodes.some((n) => n.kind === "decision"), "fan-out vira decisão");
    assert.match(umlToMermaid(m), /^flowchart TD/);
  });
  it("state: estados identificados; honesto quando não há transição no grafo", () => {
    const m = buildState(G as never);
    assert.ok(m.nodes.some((n) => /ContractStatus/.test(n.label)));
    assert.match(umlToMermaid(m), /^stateDiagram-v2/);
  });
  it("vazio → modelo honesto (não lança, não finge)", () => {
    const m = buildClass({ nodes: [], edges: [] } as never);
    assert.equal(m.nodes.length, 0);
    assert.match(umlToMermaid(m), /flowchart/);
  });
});

// SMOKE contra o grafo REAL do easynup (proj 31), se presente no /tmp.
describe("uml — smoke no grafo real do easynup", () => {
  it("gera os 6 tipos estruturais sem lançar, com conteúdo", (t) => {
    let g;
    try { g = JSON.parse(fs.readFileSync("/tmp/g_easy.json", "utf8")); } catch { return t.skip("g_easy.json ausente"); }
    for (const [name, fn] of [["class", buildClass], ["component", buildComponent], ["package", buildPackage], ["deployment", buildDeployment], ["usecase", buildUseCase], ["state", buildState]] as const) {
      const m = (fn as (x: unknown) => { nodes: unknown[] })(g);
      const mm = umlToMermaid(m as never);
      assert.ok(typeof mm === "string" && mm.length > 10, `${name} gerou Mermaid`);
    }
  });
});

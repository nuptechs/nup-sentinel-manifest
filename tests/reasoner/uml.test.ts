// Suíte UML — builders (grafo→modelo) + renderer (modelo→Mermaid). Prova: cada
// tipo usa dados reais do grafo, confiança por elemento, dialeto Mermaid correto.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildClass, buildComponent, buildPackage, buildDeployment, buildUseCase, buildActivity, buildState, extractEnumStates,
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
  it("class: entidades + herança + associação + quem usa (colaborador)", () => {
    const m = buildClass(G as never);
    assert.ok(m.nodes.some((n) => n.label === "Contract"));
    assert.ok(m.rels.some((r) => r.kind === "inheritance"));
    assert.ok(m.rels.some((r) => r.kind === "association" && r.confidence === "proven"));
    // enriquecimento: o serviço que LÊ a entidade entra como colaborador (útil p/ TS)
    assert.ok(m.nodes.some((n) => n.stereotype === "service" && n.label === "ContractService"));
    assert.ok(m.rels.some((r) => r.kind === "dependency" && (r.label === "lê" || r.label === "grava")));
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
  it("class: colaboradores aparecem MESMO com muitas entidades (fix do cap único)", () => {
    // 40 entidades (> ENT_CAP) + um serviço que lê a top-1 → o serviço DEVE entrar.
    const nodes: never[] = [];
    const edges: never[] = [];
    for (let i = 0; i < 40; i++) nodes.push({ id: `ENTITY:E${i}`, type: "ENTITY", className: `E${i}` } as never);
    // dá grau à E0 (várias arestas de leitura) p/ ela ficar no topo
    for (let i = 0; i < 5; i++) edges.push({ fromNode: `SVC${i}`, toNode: "ENTITY:E0", relationType: "READS_ENTITY", evidence: { method: "STATIC_PROVEN" } } as never);
    for (let i = 0; i < 5; i++) nodes.push({ id: `SVC${i}`, type: "SERVICE", className: `Svc${i}`, sourceFile: `s${i}.ts` } as never);
    const m = buildClass({ nodes, edges } as never);
    assert.ok(m.nodes.some((n) => n.stereotype === "service"), "serviço colaborador entra apesar das 40 entidades");
    assert.ok(m.rels.some((r) => r.kind === "dependency"), "relação de uso presente");
  });
  it("component: exclui diretórios de teste", () => {
    const g = { nodes: [
      { id: "A", type: "SERVICE", sourceFile: "services/gateway/src/a.ts" },
      { id: "B", type: "SERVICE", sourceFile: "services/gateway/src/b.ts" },
      { id: "T", type: "SERVICE", sourceFile: "src/test/foo/t.ts" },
    ], edges: [] };
    const m = buildComponent(g as never);
    assert.ok(!m.nodes.some((n) => /test/i.test(n.label)), "nenhum bloco de teste");
  });
  it("activity: filtra getters/setters triviais", () => {
    const report = { steps: [
      { order: 1, fromLabel: "Svc", toLabel: "createContract", method: "STATIC_PROVEN" },
      { order: 2, fromLabel: "Svc", toLabel: "Contract#getStatus", method: "STATIC_PROVEN" },
      { order: 3, fromLabel: "Svc", toLabel: "audit", method: "STATIC_PROVEN" },
    ] };
    const m = buildActivity(report as never, { entryLabel: "x" });
    assert.ok(!m.nodes.some((n) => /getStatus/.test(n.label)), "getter filtrado");
    assert.ok(m.nodes.some((n) => n.label === "createContract"), "operação mantida");
    assert.equal(m.stats.acessoresFiltrados, 1);
  });
  it("extractEnumStates: Java enum, TS union e const array", () => {
    assert.deepEqual(extractEnumStates("public enum ContractStatus { DRAFT, ACTIVE, CLOSED }", "ContractStatus"), ["DRAFT", "ACTIVE", "CLOSED"]);
    assert.deepEqual(extractEnumStates("export type OrderStatus = 'pending' | 'paid' | 'cancelled';", "OrderStatus"), ["pending", "paid", "cancelled"]);
    assert.deepEqual(extractEnumStates("const Phase = ['a', 'b'] as const", "Phase"), ["a", "b"]);
    assert.deepEqual(extractEnumStates("nada aqui", "X"), []);
  });
  it("state com enumValues: estados REAIS do enum", () => {
    const g = { nodes: [{ id: "ENTITY:ContractStatus", type: "ENTITY", className: "ContractStatus" }], edges: [] };
    const m = buildState(g as never, { focus: "ContractStatus", enumValues: new Map([["ENTITY:ContractStatus", ["DRAFT", "ACTIVE", "CLOSED"]]]) });
    assert.equal(m.nodes.length, 3);
    assert.ok(m.nodes.some((n) => n.label === "DRAFT"));
    assert.ok(m.notes.some((n) => /vivem na lógica de validação|workflow/i.test(n)));
    assert.match(umlToMermaid(m), /stateDiagram-v2/);
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

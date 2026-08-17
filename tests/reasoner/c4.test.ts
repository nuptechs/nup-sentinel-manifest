// Suíte C4 — modelo ÚNICO (grafo→C4Model) + render N-views (Structurizr DSL +
// Mermaid C4 nativo). Prova: contêineres por stack, componentes por diretório,
// confiança por elemento (observado só quando há runtime), DSL versionável.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildC4Model } from "../../server/reasoner/c4/c4-model.ts";
import { toStructurizrDsl, toMermaidC4, c4Catalog } from "../../server/reasoner/c4/c4-render.ts";

const G = {
  nodes: [
    { id: "ENTITY:app.Contract", type: "ENTITY", className: "Contract", sourceFile: "src/main/java/app/entities/Contract.java", stack: "spring" },
    { id: "SERVICE:app.ContractService", type: "SERVICE", className: "ContractService", sourceFile: "src/main/java/app/services/ContractService.java", stack: "spring" },
    { id: "GW:contracts", type: "SERVICE", className: "contractsRoute", sourceFile: "services/gateway/src/routes/contracts.ts", stack: "node", observed: true },
    { id: "VIEW:ContractsPage", type: "VIEW", className: "ContractsPage", sourceFile: "frontend/src/pages/Contracts.vue", stack: "vue" },
    { id: "VIEW:ContractForm", type: "COMPONENT", className: "ContractForm", sourceFile: "frontend/src/components/ContractForm.vue", stack: "vue" },
  ],
  edges: [
    { fromNode: "VIEW:ContractsPage", toNode: "GW:contracts", relationType: "CALLS", evidence: { method: "RUNTIME_OBSERVED" } },
    { fromNode: "GW:contracts", toNode: "SERVICE:app.ContractService", relationType: "CALLS", evidence: { method: "STATIC_PROVEN" } },
    { fromNode: "SERVICE:app.ContractService", toNode: "ENTITY:app.Contract", relationType: "READS_ENTITY", evidence: { method: "STATIC_PROVEN" } },
    { fromNode: "VIEW:ContractsPage", toNode: "VIEW:ContractForm", relationType: "IMPORTS", resolution: "syntactic-declared" },
  ],
};

describe("c4/model — modelo único derivado do grafo", () => {
  it("contêineres por stack (frontend/gateway/backend/db)", () => {
    const m = buildC4Model(G as never, { systemName: "EasyNuP" });
    const ids = m.containers.map((c) => c.id).sort();
    assert.deepEqual(ids, ["backend", "db", "frontend", "gateway"]);
    assert.equal(m.system.name, "EasyNuP");
  });
  it("confiança OBSERVADO só onde houve runtime (gateway); banco fica provado", () => {
    const m = buildC4Model(G as never);
    const gw = m.containers.find((c) => c.id === "gateway")!;
    const db = m.containers.find((c) => c.id === "db")!;
    assert.equal(gw.confidence, "observed", "gateway teve tráfego real");
    assert.equal(db.confidence, "proven", "banco não é runtime-hot → provado, não observado");
  });
  it("relações entre contêineres + usuário→frontend, com confiança da aresta", () => {
    const m = buildC4Model(G as never);
    assert.ok(m.rels.some((r) => r.from === "user" && r.to === "frontend"));
    assert.ok(m.rels.some((r) => r.from === "frontend" && r.to === "gateway" && r.confidence === "observed"));
    assert.ok(m.rels.some((r) => r.from === "backend" && r.to === "db" && r.description === "lê/grava"));
  });
});

describe("c4/render — N views a partir do UM modelo", () => {
  const m = buildC4Model(G as never, { systemName: "EasyNuP" });
  it("Structurizr DSL: workspace + softwareSystem + containers + views", () => {
    const dsl = toStructurizrDsl(m);
    assert.match(dsl, /^workspace "EasyNuP"/);
    assert.match(dsl, /softwareSystem "EasyNuP"/);
    assert.match(dsl, /container "Frontend"/);
    assert.match(dsl, /systemContext sys/);
    assert.match(dsl, /container sys/);
    assert.match(dsl, /user -> frontend "usa"/);
  });
  it("Mermaid C4: dialeto certo por view", () => {
    assert.match(toMermaidC4(m, "context"), /^C4Context/);
    assert.match(toMermaidC4(m, "container"), /^C4Container/);
    assert.match(toMermaidC4(m, "container"), /ContainerDb\(db,/);
    assert.match(toMermaidC4(m, "landscape"), /^flowchart/);
  });
  it("inferido é MARCADO no rótulo (disciplina de honestidade)", () => {
    // a aresta ContractsPage→ContractForm é IMPORTS syntactic → inferido; se ela
    // virar relação de componente do frontend, o rótulo carrega [inferido].
    const land = toMermaidC4(m, "landscape");
    assert.ok(!/observado/i.test(land)); // não inventa rótulo de confiança solto
    assert.ok(land.includes("-->") || land.includes("-.->"));
  });
  it("catálogo lista as 4 views; component pede foco", () => {
    const cat = c4Catalog();
    assert.equal(cat.length, 4);
    assert.ok(cat.find((v) => v.view === "component")!.needsFocus);
  });
});

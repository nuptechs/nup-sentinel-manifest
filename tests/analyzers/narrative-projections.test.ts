// ─────────────────────────────────────────────
// narrative-projections — unit tests (ADR-0033 P4.4)
//
// Perspectiva = FILTRO sobre a MESMA espinha (4+1/C4), nunca grafo novo. A mesma
// `evidence`/`confidence` viaja em toda persona. Persona vazia ≠ falhou.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shapeSystemGraph } from "../../server/analyzers/system-graph.ts";
import { buildNarrativeSubgraph } from "../../server/analyzers/narrative-subgraph.ts";
import { projectPerspective, projectAllPerspectives, parsePersona } from "../../server/analyzers/narrative-projections.ts";

const RAW = {
  nodes: [
    { id: "CONTROLLER:d.ContractController", type: "CONTROLLER", className: "ContractController" },
    { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
    { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
    { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract", metadata: { sensitiveFields: ["cpf"] } },
    { id: "SERVICE:d.AuthService", type: "SERVICE", className: "AuthService", metadata: { sensitiveFields: ["token"] } },
    { id: "SERVICE:d.ReportService", type: "SERVICE", className: "ReportService" },
  ],
  edges: [
    { fromNode: "CONTROLLER:d.ContractController", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.ContractService", toNode: "REPOSITORY:d.ContractRepository", relationType: "CALLS", metadata: { observed: true, count: 12 } },
    { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.AuthService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { observed: true, count: 5 } },
    { fromNode: "SERVICE:d.ReportService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { synthetic: true, resolution: "convention-name" } },
  ],
};
function sub() {
  return buildNarrativeSubgraph(shapeSystemGraph(RAW, "class"), "Contract");
}

// ─────────────────────────────────────────────
// 1º TESTE — a projeção FILTRA a MESMA espinha (mesmos objetos, mesma evidência).
// ─────────────────────────────────────────────
describe("projectPerspective — é FILTRO da MESMA espinha (uma verdade, N lentes)", () => {
  it("security ⊆ espinha: cada aresta da view é o MESMO objeto do subgrafo", () => {
    const s = sub();
    const sec = projectPerspective(s, "security");
    assert.ok(sec.edges.length > 0);
    for (const e of sec.edges) {
      assert.ok(s.edges.includes(e), "a aresta projetada é a MESMA referência da espinha (não cópia/recompute)");
    }
  });

  it("a MESMA aresta carrega evidência IDÊNTICA em toda persona (prova 'uma espinha')", () => {
    const s = sub();
    const all = projectAllPerspectives(s);
    // a aresta Repository→Contract aparece em dev, data, impact — mesma evidência.
    const pick = (persona: keyof typeof all) => all[persona].edges.find((e) => e.toNode === "ENTITY:d.Contract");
    const inDev = pick("dev")!, inData = pick("data")!, inImpact = pick("impact")!;
    assert.ok(inDev && inData && inImpact);
    assert.equal(inDev.method, inData.method);
    assert.equal(inData.method, inImpact.method);
    assert.equal(inDev.confidence, inImpact.confidence);
    assert.equal(inDev.edgeId, inImpact.edgeId);
  });
});

describe("projectPerspective — recortes por preocupação de stakeholder", () => {
  const s = sub();

  it("dev = a cadeia de chamadas inteira (toda a espinha)", () => {
    const dev = projectPerspective(s, "dev");
    assert.equal(dev.edges.length, s.edges.length);
    assert.equal(dev.empty, false);
  });

  it("security = só arestas tocando nó sensível (AuthService, Contract)", () => {
    const sec = projectPerspective(s, "security");
    for (const e of sec.edges) assert.ok(e.fromSensitive || e.toSensitive, "toda aresta de segurança toca um nó sensível");
    // AuthService→Service (from sensível) + Repository→Contract (to sensível)
    assert.equal(sec.edges.length, 2);
  });

  it("data = arestas de/para repositório/entidade", () => {
    const data = projectPerspective(s, "data");
    assert.ok(data.edges.every((e) => /ENTITY|REPOSITORY/.test(e.fromType) || /ENTITY|REPOSITORY/.test(e.toType) || /ENTITY/.test(e.relationType)));
    assert.equal(data.edges.length, 2); // Service→Repository, Repository→Contract
  });

  it("architect = só arestas que CRUZAM camada (fronteiras)", () => {
    const arch = projectPerspective(s, "architect");
    for (const e of arch.edges) assert.notEqual(e.fromLayer, e.toLayer);
    // Controller(api)→Service(domain) e Service(domain)→Repository(data) cruzam;
    // Repository(data)→Contract(data) e AuthService(domain)→Service(domain) não.
    assert.equal(arch.edges.length, 2);
  });

  it("business = arestas tocando controller/tela + surfaça ADR links", () => {
    const withAdr = buildNarrativeSubgraph(shapeSystemGraph(RAW, "class"), "Contract", {
      adrLinks: [{ adrId: "ADR-063", adrTitle: "Garantia", targetSymbol: "Contract", sourceRef: "docs/adr/ADR-063.md:12", sourceLine: 12, sourceText: "x", citation: "backtick", confidence: "STATIC_PROVEN" }],
    });
    const biz = projectPerspective(withAdr, "business");
    assert.ok(biz.edges.some((e) => /CONTROLLER/.test(e.fromType)));
    assert.equal(biz.adrLinks.length, 1, "só a lente de negócio surfaça a decisão (ADR)");
    // outras lentes não carregam ADR links
    assert.equal(projectPerspective(withAdr, "dev").adrLinks.length, 0);
  });

  it("impact = o raio inteiro (todas as arestas verificadas)", () => {
    assert.equal(projectPerspective(s, "impact").edges.length, s.edges.length);
  });
});

describe("projectPerspective — persona vazia ≠ falhou", () => {
  it("sem nó sensível, a lente security vem vazia com nota honesta (não erro)", () => {
    const rawNoSensitive = {
      nodes: [
        { id: "SERVICE:d.A", type: "SERVICE", className: "A" },
        { id: "ENTITY:d.B", type: "ENTITY", className: "B" },
      ],
      edges: [{ fromNode: "SERVICE:d.A", toNode: "ENTITY:d.B", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } }],
    };
    const s2 = buildNarrativeSubgraph(shapeSystemGraph(rawNoSensitive, "class"), "B");
    const sec = projectPerspective(s2, "security");
    assert.equal(sec.empty, true);
    assert.equal(sec.edges.length, 0);
    assert.match(sec.note || "", /Nada verificado sob a lente/);
    // a MESMA espinha ainda tem dado sob outra lente (data) — prova que não "falhou".
    assert.ok(projectPerspective(s2, "data").edges.length > 0);
  });
});

describe("parsePersona", () => {
  it("aceita as personas válidas e rejeita o resto", () => {
    assert.equal(parsePersona("security"), "security");
    assert.equal(parsePersona("  DEV "), "dev");
    assert.equal(parsePersona("hacker"), null);
    assert.equal(parsePersona(42), null);
    assert.equal(parsePersona(undefined), null);
  });
});

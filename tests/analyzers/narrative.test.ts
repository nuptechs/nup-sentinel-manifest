// ─────────────────────────────────────────────
// narrative — unit tests (ADR-0033 P4.2/P4.3)
//
// O GATE de grounding ESTRUTURAL: afirmação de aresta sem `edgeId` verificado é
// DESCARTADA na geração (bloqueia, NÃO sinaliza). Abertura garante×possível×cego
// da partição. Subgrafo vazio → abstenção. Sem LLM → template determinístico.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shapeSystemGraph } from "../../server/analyzers/system-graph.ts";
import { buildNarrativeSubgraph } from "../../server/analyzers/narrative-subgraph.ts";
import { applyGroundingGate, narrate, type EdgeClaim } from "../../server/analyzers/narrative.ts";

const RAW = {
  nodes: [
    { id: "CONTROLLER:d.ContractController", type: "CONTROLLER", className: "ContractController" },
    { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
    { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
    { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract", metadata: { sensitiveFields: ["cpf"] } },
    { id: "SERVICE:d.ReportService", type: "SERVICE", className: "ReportService" },
  ],
  edges: [
    { fromNode: "CONTROLLER:d.ContractController", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.ContractService", toNode: "REPOSITORY:d.ContractRepository", relationType: "CALLS", metadata: { observed: true, count: 12 } },
    { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } },
    { fromNode: "SERVICE:d.ReportService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { synthetic: true, resolution: "convention-name" } },
  ],
};
function sub() {
  return buildNarrativeSubgraph(shapeSystemGraph(RAW, "class"), "Contract");
}
const REAL_EDGE = "REPOSITORY:d.ContractRepository|ENTITY:d.Contract|WRITES_ENTITY";
const OFF_MAP_EDGE = "SERVICE:d.Ghost|ENTITY:d.Contract|CALLS"; // aresta que o grafo NÃO tem

// ─────────────────────────────────────────────
// 1º TESTE — a afirmação OFF-MAP é BLOQUEADA (removida), não sinalizada.
// ─────────────────────────────────────────────
describe("applyGroundingGate — bloqueia, não sinaliza (o coração do P4.2)", () => {
  it("uma afirmação OFF-MAP é DESCARTADA (não entra em kept; entra em discarded)", () => {
    const s = sub();
    const claims: EdgeClaim[] = [
      { edgeId: REAL_EDGE, text: "ContractRepository escreve o Contract." },
      { edgeId: OFF_MAP_EDGE, text: "Ghost chama Contract diretamente." }, // alucinação de aresta
    ];
    const { kept, discarded } = applyGroundingGate(claims, s.edgeIds);
    // a afirmação verdadeira PASSA
    assert.equal(kept.length, 1);
    assert.equal(kept[0].edgeId, REAL_EDGE);
    // a alucinação NÃO está na saída — foi removida, não rebaixada
    assert.ok(!kept.some((c) => c.edgeId === OFF_MAP_EDGE), "aresta off-map NÃO pode estar em kept");
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0].edgeId, OFF_MAP_EDGE);
    assert.equal(discarded[0].reason, "off-map");
  });

  it("afirmação de texto vazio também cai (empty-text)", () => {
    const s = sub();
    const { kept, discarded } = applyGroundingGate([{ edgeId: REAL_EDGE, text: "   " }], s.edgeIds);
    assert.equal(kept.length, 0);
    assert.equal(discarded[0].reason, "empty-text");
  });

  it("entradas nulas/malformadas nunca lançam", () => {
    assert.doesNotThrow(() => applyGroundingGate(null, new Set()));
    assert.doesNotThrow(() => applyGroundingGate([{ edgeId: 123 as any, text: 5 as any }], new Set()));
  });

  it("uma frase por aresta (dedup)", () => {
    const s = sub();
    const { kept } = applyGroundingGate(
      [{ edgeId: REAL_EDGE, text: "primeira" }, { edgeId: REAL_EDGE, text: "segunda" }],
      s.edgeIds,
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0].text, "primeira");
  });
});

describe("narrate — modo determinístico (sem LLM = byte-a-byte)", () => {
  it("sem edgeClaims → template; toda frase de aresta tem origin deterministic", () => {
    const r = narrate(sub());
    assert.equal(r.mode, "deterministic");
    assert.equal(r.abstained, false);
    const edgeStmts = r.statements.filter((s) => s.kind === "edge");
    assert.equal(edgeStmts.length, 3, "3 arestas verificadas na espinha");
    for (const s of edgeStmts) {
      assert.equal(s.origin, "deterministic");
      assert.ok(s.edgeId && sub().edgeIds.has(s.edgeId), "toda frase de aresta referencia edgeId verificado");
    }
  });

  it("abre com a partição garante×possível×cego e fecha com o ponto-cego", () => {
    const r = narrate(sub());
    assert.equal(r.statements[0].kind, "partition");
    assert.match(r.statements[0].text, /PROVADO afetado:/);
    assert.match(r.statements[0].text, /POSSÍVEL:/); // ReportService é possible
    assert.match(r.statements[0].text, /PONTO-CEGO:/); // 1 aresta unresolved toca o raio
    assert.ok(r.statements.some((s) => s.kind === "blindspot"), "fecho de ponto-cego presente");
  });

  it("prosa é estável (byte-a-byte em duas chamadas)", () => {
    assert.equal(narrate(sub()).prose, narrate(sub()).prose);
  });
});

describe("narrate — modo LLM sob gate (nomeia o verificado, bloqueia o off-map)", () => {
  const s = sub();
  const claims: EdgeClaim[] = [
    { edgeId: REAL_EDGE, text: "Esta escrita persiste o contrato no banco." },
    { edgeId: OFF_MAP_EDGE, text: "Ghost injeta dados no Contract." }, // alucinação
  ];
  const r = narrate(s, claims);

  it("modo llm-grounded e a alucinação NÃO aparece na prosa", () => {
    assert.equal(r.mode, "llm-grounded");
    assert.ok(!r.prose.includes("Ghost"), "texto off-map não pode vazar pra prosa");
    assert.ok(r.prose.includes("persiste o contrato"), "a frase válida do LLM aparece");
  });

  it("auditoria do gate: 2 propostas, 1 descartada off-map", () => {
    assert.equal(r.grounding.proposed, 2);
    assert.equal(r.grounding.discarded, 1);
    assert.equal(r.grounding.discardedClaims[0].reason, "off-map");
    assert.equal(r.grounding.kept, 1);
  });

  it("arestas verificadas NÃO nomeadas pelo LLM são preenchidas pelo template (espinha nunca some)", () => {
    const edgeStmts = r.statements.filter((st) => st.kind === "edge");
    assert.equal(edgeStmts.length, 3, "3 arestas verificadas continuam representadas");
    const llmNamed = edgeStmts.filter((st) => st.origin === "llm");
    assert.equal(llmNamed.length, 1);
    const templated = edgeStmts.filter((st) => st.origin === "deterministic");
    assert.equal(templated.length, 2);
  });
});

describe("narrate — abstenção honesta (subgrafo verificado vazio)", () => {
  it("grafo ausente → abstém, não fabrica", () => {
    const r = narrate(buildNarrativeSubgraph(null, "Contract"));
    assert.equal(r.abstained, true);
    assert.ok(r.statements.some((s) => s.kind === "abstain"));
    assert.match(r.prose, /Abstenho-me/);
  });

  it("na abstenção, TODA frase de aresta do LLM é off-map por definição", () => {
    const r = narrate(buildNarrativeSubgraph(null, "Contract"), [{ edgeId: OFF_MAP_EDGE, text: "qualquer coisa" }]);
    assert.equal(r.abstained, true);
    assert.equal(r.grounding.discarded, 1);
    assert.equal(r.grounding.kept, 0);
    assert.ok(!r.prose.includes("qualquer coisa"));
  });
});

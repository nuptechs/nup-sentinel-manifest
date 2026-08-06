// ─────────────────────────────────────────────
// narrative convergence — unit tests (ADR-0033 P4.5)
//
// A CONVERGÊNCIA com o laço ativo (ADR-0032 P3): uma aresta REFUTADA some da
// espinha andável (a narrativa nunca a cita como fato); uma aresta que era
// POSSÍVEL e virou RUNTIME_OBSERVED sobe para a partição PROVADA. Como o P3
// vive no `nup-sentinel` (gated OFF), o campo `refuted` é lido DEFENSIVAMENTE do
// metadata cru — aqui exercitamos com dado sintético, provando o lado do
// manifest. Puro, determinístico.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shapeSystemGraph } from "../../server/analyzers/system-graph.ts";
import { buildNarrativeSubgraph } from "../../server/analyzers/narrative-subgraph.ts";
import { narrate, applyGroundingGate, type EdgeClaim } from "../../server/analyzers/narrative.ts";
import { projectPerspective } from "../../server/analyzers/narrative-projections.ts";

// Grafo com uma aresta REFUTADA e uma aresta candidata a promoção.
//   ContractController → ContractService   CALLS compiler                STATIC_PROVEN  (andável)
//   ContractService    → ContractRepository CALLS observed×9             RUNTIME_OBSERVED (andável)
//   ContractRepository → Contract           WRITES_ENTITY compiler        STATIC_PROVEN  (andável, Contract sensível)
//   LegacyService      → ContractService    CALLS compiler + REFUTADA     REFUTED_LIKELY_DEAD (fora da espinha)
const REFUTED_EDGE_ID = "SERVICE:d.LegacyService|SERVICE:d.ContractService|CALLS";
function rawWithRefutation(refuted: unknown) {
  return {
    nodes: [
      { id: "CONTROLLER:d.ContractController", type: "CONTROLLER", className: "ContractController" },
      { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
      { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
      { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract", metadata: { sensitiveFields: ["cpf"] } },
      { id: "SERVICE:d.LegacyService", type: "SERVICE", className: "LegacyService" },
    ],
    edges: [
      { fromNode: "CONTROLLER:d.ContractController", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { resolution: "compiler" } },
      { fromNode: "SERVICE:d.ContractService", toNode: "REPOSITORY:d.ContractRepository", relationType: "CALLS", metadata: { observed: true, count: 9 } },
      { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } },
      // o estático desenhou LegacyService→ContractService, mas o laço a REFUTOU.
      { fromNode: "SERVICE:d.LegacyService", toNode: "SERVICE:d.ContractService", relationType: "CALLS", metadata: { resolution: "compiler", refutation: refuted } },
    ],
  };
}
function subRefuted(refuted: unknown) {
  return buildNarrativeSubgraph(shapeSystemGraph(rawWithRefutation(refuted), "class"), "Contract");
}

// ─────────────────────────────────────────────
// 1º TESTE — a aresta REFUTADA some da narrativa (ausente da espinha andável).
// ─────────────────────────────────────────────
describe("buildNarrativeSubgraph — aresta REFUTADA fora da espinha andável (P4.5)", () => {
  const s = subRefuted({ subtype: "REFUTED_LIKELY_DEAD", attempts: 3, windows: 3, reason: "pai OK, aresta ausente no traço" });

  it("a aresta refutada NÃO está na espinha andável nem em edgeIds (a lei do gate)", () => {
    assert.ok(!s.edges.some((e) => e.edgeId === REFUTED_EDGE_ID), "refutada não pode ser andável");
    assert.ok(!s.edgeIds.has(REFUTED_EDGE_ID), "refutada não pode estar entre os edgeIds verificados");
  });

  it("mas está NOMEADA em refutedEdges, com grau e proveniência honestos", () => {
    assert.equal(s.refutedCount, 1);
    const r = s.refutedEdges.find((e) => e.edgeId === REFUTED_EDGE_ID);
    assert.ok(r, "a aresta refutada deve aparecer nomeada");
    assert.equal(r!.subtype, "REFUTED_LIKELY_DEAD");
    assert.equal(r!.attempts, 3);
    assert.match(r!.provenance, /falso-positivo|código morto/);
  });

  it("as arestas VERIFICADAS seguem intactas na espinha (a refutação é aditiva)", () => {
    assert.equal(s.edges.length, 3);
    for (const e of s.edges) assert.ok(e.method === "RUNTIME_OBSERVED" || e.method === "STATIC_PROVEN");
  });

  it("subtype ausente/booleano cru → default HONESTO UNKNOWN honesto (nunca 'morta' sem evidência)", () => {
    const bare = subRefuted(true as unknown); // metadata.refutation === true
    assert.equal(bare.refutedCount, 1);
    assert.equal(bare.refutedEdges[0].subtype, "REFUTED_UNREACHABLE_BY_ROBOT");
    assert.match(bare.refutedEdges[0].provenance, /não-confirmada pelo robô|NÃO é morta/);
  });
});

// ─────────────────────────────────────────────
// A narrativa NUNCA cita a refutada — e o gate barra o LLM que tentar.
// ─────────────────────────────────────────────
describe("narrate — a refutação NÃO vira fato; vira fecho NOMEADO (P4.5)", () => {
  const s = subRefuted({ subtype: "REFUTED_LIKELY_DEAD", attempts: 3, windows: 3 });

  it("NENHUMA frase de aresta (fato) cita a aresta refutada", () => {
    const r = narrate(s);
    // a refutada nunca vira uma afirmação de fato…
    assert.ok(!r.statements.some((st) => st.kind === "edge" && st.edgeId === REFUTED_EDGE_ID), "a refutada não pode virar frase de aresta");
    // …e onde o nome aparece é SÓ no fecho de refutação (nomeada, não afirmada).
    const mentions = r.statements.filter((st) => st.text.includes("LegacyService"));
    assert.ok(mentions.length > 0 && mentions.every((st) => st.kind === "refuted"), "LegacyService só pode aparecer no fecho de refutação");
  });

  it("há um fecho de kind 'refuted' que a NOMEIA honestamente", () => {
    const r = narrate(s);
    const rf = r.statements.find((st) => st.kind === "refuted");
    assert.ok(rf, "fecho de refutação presente");
    assert.match(rf!.text, /REFUTOU 1 aresta/);
    assert.match(rf!.text, /NÃO as afirmo/);
    assert.match(rf!.text, /LegacyService→ContractService/);
  });

  it("o gate BLOQUEIA um claim de LLM que cite a aresta refutada (off-map)", () => {
    const claims: EdgeClaim[] = [{ edgeId: REFUTED_EDGE_ID, text: "LegacyService ainda chama o ContractService." }];
    const { kept, discarded } = applyGroundingGate(claims, s.edgeIds);
    assert.equal(kept.length, 0, "citar a refutada é off-map");
    assert.equal(discarded[0].reason, "off-map");
    // e pela via completa: a alucinação não vaza para a prosa.
    const r = narrate(s, claims);
    assert.ok(!r.prose.includes("ainda chama"), "o claim sobre a refutada não pode aparecer na prosa");
    assert.equal(r.grounding.discarded, 1);
  });
});

// ─────────────────────────────────────────────
// PROMOÇÃO: POSSÍVEL (não-observado) → PROVADO ao virar RUNTIME_OBSERVED.
// ─────────────────────────────────────────────
describe("buildNarrativeSubgraph — promoção POSSÍVEL→PROVADO (P4.5)", () => {
  // Mesma topologia; a aresta Service→Repository muda de estado entre os dois grafos.
  const EDGE_ID = "SERVICE:d.ContractService|REPOSITORY:d.ContractRepository|CALLS";
  function raw(serviceRepoMeta: Record<string, unknown>) {
    return {
      nodes: [
        { id: "SERVICE:d.ContractService", type: "SERVICE", className: "ContractService" },
        { id: "REPOSITORY:d.ContractRepository", type: "REPOSITORY", className: "ContractRepository" },
        { id: "ENTITY:d.Contract", type: "ENTITY", className: "Contract", metadata: { sensitiveFields: ["cpf"] } },
      ],
      edges: [
        { fromNode: "SERVICE:d.ContractService", toNode: "REPOSITORY:d.ContractRepository", relationType: "CALLS", metadata: serviceRepoMeta },
        { fromNode: "REPOSITORY:d.ContractRepository", toNode: "ENTITY:d.Contract", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler" } },
      ],
    };
  }

  it("ANTES (não-resolvida): a aresta é POSSÍVEL/cega — FORA da espinha andável", () => {
    const before = buildNarrativeSubgraph(shapeSystemGraph(raw({ synthetic: true, resolution: "convention-name" }), "class"), "Contract");
    assert.ok(!before.edgeIds.has(EDGE_ID), "não-resolvida não é andável");
    assert.ok(before.blindSpots.some((b) => b.fromNode.includes("ContractService")), "aparece como ponto-cego");
  });

  it("DEPOIS (promovida a RUNTIME_OBSERVED): a MESMA aresta SOBE para a espinha PROVADA", () => {
    const after = buildNarrativeSubgraph(shapeSystemGraph(raw({ observed: true, count: 7 }), "class"), "Contract");
    const e = after.edges.find((x) => x.edgeId === EDGE_ID);
    assert.ok(e, "promovida entra na espinha andável");
    assert.equal(e!.method, "RUNTIME_OBSERVED");
    assert.equal(e!.count, 7);
    // e a narrativa agora a AFIRMA como fato (PROVADO runtime).
    const r = narrate(after);
    assert.ok(r.statements.some((st) => st.kind === "edge" && st.edgeId === EDGE_ID), "vira frase de aresta afirmada");
    assert.match(r.prose, /PROVADO \(runtime\)/);
  });

  it("PROMOÇÃO VENCE REFUTAÇÃO: aresta observada E marcada refutada segue ANDÁVEL", () => {
    // Uma flag de refutação ANTIGA que ficou no metadata, mas a aresta foi observada.
    const promoted = buildNarrativeSubgraph(
      shapeSystemGraph(raw({ observed: true, count: 4, refutation: { subtype: "REFUTED_LIKELY_DEAD" } }), "class"),
      "Contract",
    );
    assert.ok(promoted.edgeIds.has(EDGE_ID), "observada vence refutação: continua andável");
    assert.equal(promoted.refutedCount, 0, "não pode aparecer como refutada");
    assert.equal(promoted.edges.find((x) => x.edgeId === EDGE_ID)!.method, "RUNTIME_OBSERVED");
  });
});

// ─────────────────────────────────────────────
// Projeções: a aresta refutada viaja sob a lente certa, sem contar como prova.
// ─────────────────────────────────────────────
describe("projectPerspective — refutada surfaça por lente, não como fato (P4.5)", () => {
  it("a lente 'dev' recorta a refutada em refutedEdges (não em edges)", () => {
    const s = subRefuted({ subtype: "REFUTED_LIKELY_DEAD", attempts: 3 });
    const dev = projectPerspective(s, "dev");
    assert.ok(!dev.edges.some((e) => e.edgeId === REFUTED_EDGE_ID), "refutada não é aresta verificada da lente");
    assert.ok(dev.refutedEdges.some((e) => e.edgeId === REFUTED_EDGE_ID), "refutada viaja em refutedEdges da lente");
  });

  it("uma lente com SÓ arestas refutadas não é 'empty' (tem o que mostrar, ≠ falhou)", () => {
    // grafo onde a única aresta que casa a lente 'data' é uma REFUTADA para entidade.
    const raw = {
      nodes: [
        { id: "SERVICE:d.A", type: "SERVICE", className: "A" },
        { id: "ENTITY:d.B", type: "ENTITY", className: "B" },
        { id: "SERVICE:d.C", type: "SERVICE", className: "C" },
      ],
      edges: [
        { fromNode: "SERVICE:d.C", toNode: "SERVICE:d.A", relationType: "CALLS", metadata: { resolution: "compiler" } },
        { fromNode: "SERVICE:d.A", toNode: "ENTITY:d.B", relationType: "WRITES_ENTITY", metadata: { resolution: "compiler", refutation: { subtype: "REFUTED_LIKELY_DEAD" } } },
      ],
    };
    const s = buildNarrativeSubgraph(shapeSystemGraph(raw, "class"), "B");
    const data = projectPerspective(s, "data");
    assert.equal(data.edges.length, 0, "nenhuma aresta de dado VERIFICADA");
    assert.ok(data.refutedEdges.length >= 1, "mas há uma refutada de dado a mostrar");
    assert.equal(data.empty, false, "lente com refutada não é vazia");
  });
});

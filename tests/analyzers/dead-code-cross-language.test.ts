import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findCrossLanguageDead, suspectsFromCrossLanguageDead } from "../../server/analyzers/dead-code-cross-language";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// OBS-E03 (lado manifest) — morto que ATRAVESSA front↔back. O produtor de
// dead-code de front (codelens/E04) injeta os ids de tela/componente mortos; o
// manifest decide quais superfícies de back ficam órfãs por propagação. Sem o
// produtor (codelens não está em disco), o detector é CEGO por honestidade.

function shaped(raw: RawSystemGraph) {
  return shapeSystemGraph(raw, "method");
}

// Grafo: duas telas de front, duas superfícies de back.
//   HomeView (VIVA)  → /api/home   (viva)
//   LegacyView (MORTA) → /api/legacy (só a LegacyView a chama → morta cross-lang)
//   /api/shared é chamada pela viva E pela morta → NÃO morta (tem front vivo)
const raw: RawSystemGraph = {
  nodes: [
    { id: "VIEW:HomeView", type: "VIEW", className: "HomeView", metadata: {} },
    { id: "VIEW:LegacyView", type: "VIEW", className: "LegacyView", metadata: {} },
    { id: "ROUTE:/api/home", type: "ROUTE", className: "homeRoute", metadata: {} },
    { id: "ROUTE:/api/legacy", type: "ROUTE", className: "legacyRoute", metadata: {} },
    { id: "ROUTE:/api/shared", type: "ROUTE", className: "sharedRoute", metadata: {} },
    { id: "CONTROLLER:Orphan", type: "CONTROLLER", className: "OrphanController", metadata: {} }, // sem chamador cross-stack
  ],
  edges: [
    { fromNode: "VIEW:HomeView", toNode: "ROUTE:/api/home", relationType: "CALLS", metadata: {} },
    { fromNode: "VIEW:LegacyView", toNode: "ROUTE:/api/legacy", relationType: "CALLS", metadata: {} },
    { fromNode: "VIEW:HomeView", toNode: "ROUTE:/api/shared", relationType: "CALLS", metadata: {} },
    { fromNode: "VIEW:LegacyView", toNode: "ROUTE:/api/shared", relationType: "CALLS", metadata: {} },
  ],
};

describe("findCrossLanguageDead — cego sem o produtor de front (codelens ausente)", () => {
  it("sem deadFrontendNodeIds → frontendDeadnessProvided=false, zero candidatos", () => {
    const r = findCrossLanguageDead(shaped(raw), undefined);
    assert.equal(r.frontendDeadnessProvided, false);
    assert.equal(r.candidates.length, 0, "honesto: codelens não injetou nada");
    assert.equal(r.backendSurfacesTotal, 4, "3 ROUTE + 1 CONTROLLER");
  });

  it("conjunto vazio também é cego", () => {
    const r = findCrossLanguageDead(shaped(raw), new Set());
    assert.equal(r.frontendDeadnessProvided, false);
    assert.equal(r.candidates.length, 0);
  });
});

describe("findCrossLanguageDead — com front morto injetado, propaga pela costura", () => {
  const r = findCrossLanguageDead(shaped(raw), new Set(["VIEW:LegacyView"]));

  it("acusa /api/legacy (único chamador é front morto)", () => {
    assert.equal(r.frontendDeadnessProvided, true);
    const legacy = r.candidates.find((c) => c.nodeId === "ROUTE:/api/legacy");
    assert.ok(legacy, "/api/legacy é morto cross-language");
    assert.equal(legacy!.tier, "cross-language-dead");
    assert.deepEqual(legacy!.deadFrontendCallers, ["VIEW:LegacyView"]);
    assert.ok(legacy!.confidence < 1);
  });

  it("NÃO acusa /api/shared (tem front VIVO entre os chamadores)", () => {
    assert.ok(!r.candidates.some((c) => c.nodeId === "ROUTE:/api/shared"));
    assert.ok(r.excluded.liveFrontendCaller >= 1);
  });

  it("NÃO acusa /api/home (chamador vivo) nem o CONTROLLER órfão puro (sem chamador cross-stack)", () => {
    assert.ok(!r.candidates.some((c) => c.nodeId === "ROUTE:/api/home"));
    assert.ok(!r.candidates.some((c) => c.nodeId === "CONTROLLER:Orphan"));
    assert.equal(r.excluded.noCrossStackCaller, 1, "CONTROLLER:Orphan não tem chamador cross-stack → E01, não E03");
  });

  it("runtime/entry-point refutam a morte", () => {
    const withRuntime: RawSystemGraph = {
      nodes: [
        { id: "VIEW:Dead", type: "VIEW", className: "Dead", metadata: {} },
        { id: "ROUTE:/api/hot", type: "ROUTE", className: "hot", metadata: { runtimeHot: true } },
      ],
      edges: [{ fromNode: "VIEW:Dead", toNode: "ROUTE:/api/hot", relationType: "CALLS", metadata: {} }],
    };
    const rr = findCrossLanguageDead(shaped(withRuntime), new Set(["VIEW:Dead"]));
    assert.equal(rr.candidates.length, 0, "endpoint observado em runtime não é morto");
    assert.equal(rr.excluded.runtimeObserved, 1);
  });
});

describe("suspectsFromCrossLanguageDead — compõe com o tri-eixo (OBS-E06)", () => {
  it("converte candidatos; cego → vazio", () => {
    const r = findCrossLanguageDead(shaped(raw), new Set(["VIEW:LegacyView"]));
    const suspects = suspectsFromCrossLanguageDead(r);
    assert.ok(suspects.length >= 1);
    assert.equal(suspects[0].staticSource, "cross-language-dead");
    const blind = findCrossLanguageDead(shaped(raw), undefined);
    assert.equal(suspectsFromCrossLanguageDead(blind).length, 0);
  });
});

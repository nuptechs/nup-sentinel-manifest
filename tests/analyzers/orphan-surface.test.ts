import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findOrphanSurfaces, DEFAULT_WIRING_RELATIONS } from "../../server/analyzers/orphan-surface";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// OBS-E01 — detector de superfície órfã. O ponto crítico: ele NUNCA acusa sem o
// wiring de roteamento (OBS-D03) presente — senão todo controller sem chamador
// (o normal) viraria falso-positivo. Com wiring presente, só a superfície SEM
// aresta de wiring que a monte é candidata.

function shaped(raw: RawSystemGraph) {
  return shapeSystemGraph(raw, "method"); // method-level preserva nós/arestas crus
}

describe("findOrphanSurfaces — cego sem produtor de wiring (honesto)", () => {
  it("grafo sem NENHUMA aresta de wiring → wiringPresent=false, zero candidatos", () => {
    const g = shaped({
      nodes: [
        { id: "ROUTE:/users", type: "ROUTE", className: "usersRoute", metadata: {} },
        { id: "CONTROLLER:UserController", type: "CONTROLLER", className: "UserController", metadata: {} },
      ],
      edges: [],
    });
    const r = findOrphanSurfaces(g);
    assert.equal(r.wiringPresent, false);
    assert.equal(r.candidates.length, 0, "nada acusado sem o produtor D03");
    assert.equal(r.surfacesTotal, 2);
  });
});

describe("findOrphanSurfaces — com wiring presente, acusa só a sem montagem", () => {
  const raw: RawSystemGraph = {
    nodes: [
      { id: "ROUTER:app", type: "SERVICE", className: "appRouter", metadata: {} },
      { id: "ROUTE:/users", type: "ROUTE", className: "usersRoute", metadata: {} }, // montada
      { id: "ROUTE:/legacy", type: "ROUTE", className: "legacyRoute", metadata: {} }, // ÓRFÃ
      { id: "VIEW:Home", type: "VIEW", className: "Home", metadata: { runtimeHot: true } }, // viva por runtime
    ],
    edges: [
      { fromNode: "ROUTER:app", toNode: "ROUTE:/users", relationType: "HANDLES_ROUTE", metadata: { resolution: "compiler" } },
    ],
  };

  it("ROUTE sem wiring, sem runtime, sem gatilho → candidata; montada/observada → excluídas", () => {
    const r = findOrphanSurfaces(shaped(raw));
    assert.equal(r.wiringPresent, true);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].nodeId, "ROUTE:/legacy");
    assert.equal(r.candidates[0].tier, "orphan-surface");
    assert.ok(r.candidates[0].confidence < 1);
    assert.equal(r.excluded.wired, 1, "ROUTE:/users excluída por ter wiring");
    assert.equal(r.excluded.runtimeObserved, 1, "VIEW:Home excluída por runtime");
  });

  it("gatilho (@Scheduled/listener) numa superfície não é órfão", () => {
    const withTrigger: RawSystemGraph = {
      nodes: [
        { id: "ROUTER:app", type: "SERVICE", className: "appRouter", metadata: {} },
        { id: "ROUTE:/users", type: "ROUTE", className: "usersRoute", metadata: {} },
        { id: "CONTROLLER:Cron", type: "CONTROLLER", className: "Cron", metadata: { entryPoint: "@Scheduled" } },
      ],
      edges: [{ fromNode: "ROUTER:app", toNode: "ROUTE:/users", relationType: "HANDLES_ROUTE", metadata: {} }],
    };
    const r = findOrphanSurfaces(shaped(withTrigger));
    assert.equal(r.candidates.length, 0);
    assert.equal(r.excluded.entryPoint, 1);
  });

  it("conjunto de wiring custom é respeitado", () => {
    const custom: RawSystemGraph = {
      nodes: [
        { id: "X", type: "SERVICE", className: "x", metadata: {} },
        { id: "ROUTE:/a", type: "ROUTE", className: "a", metadata: {} },
        { id: "ROUTE:/b", type: "ROUTE", className: "b", metadata: {} },
      ],
      edges: [{ fromNode: "X", toNode: "ROUTE:/a", relationType: "WIRES", metadata: {} }],
    };
    const r = findOrphanSurfaces(shaped(custom), { wiringRelations: new Set(["WIRES"]) });
    assert.equal(r.wiringPresent, true);
    assert.deepEqual(r.candidates.map((c) => c.nodeId), ["ROUTE:/b"]);
  });

  it("DEFAULT_WIRING_RELATIONS exporta as relações esperadas", () => {
    assert.ok(DEFAULT_WIRING_RELATIONS.has("HANDLES_ROUTE"));
    assert.ok(DEFAULT_WIRING_RELATIONS.has("ROUTES_TO"));
    assert.ok(DEFAULT_WIRING_RELATIONS.has("MOUNTS"));
    assert.ok(DEFAULT_WIRING_RELATIONS.has("RENDERS_VIEW"));
  });
});

// ── OBS-E01 — pronto para acender quando D03 existir (contrato travado) ──
describe("findOrphanSurfaces — pronto p/ D03: cobre VIEW, runtime-por-evidência e ordenação", () => {
  it("VIEW órfã (RENDERS_VIEW monta uma, outra não) → só a sem montagem é candidata", () => {
    const raw: RawSystemGraph = {
      nodes: [
        { id: "ROUTER:fe", type: "SERVICE", className: "feRouter", metadata: {} },
        { id: "VIEW:Dashboard", type: "VIEW", className: "Dashboard", metadata: {} }, // montada
        { id: "VIEW:Legacy", type: "VIEW", className: "Legacy", metadata: {} }, // ÓRFÃ
      ],
      edges: [{ fromNode: "ROUTER:fe", toNode: "VIEW:Dashboard", relationType: "RENDERS_VIEW", metadata: {} }],
    };
    const r = findOrphanSurfaces(shaped(raw));
    assert.deepEqual(r.candidates.map((c) => c.nodeId), ["VIEW:Legacy"]);
    assert.equal(r.excluded.wired, 1);
  });

  it("ROUTE exercitada em runtime (runtimeHot) é excluída mesmo sem wiring", () => {
    const raw: RawSystemGraph = {
      nodes: [
        { id: "ROUTER:app", type: "SERVICE", className: "appRouter", metadata: {} },
        { id: "ROUTE:/a", type: "ROUTE", className: "a", metadata: {} }, // montada p/ marcar wiringPresent
        { id: "ROUTE:/hot", type: "ROUTE", className: "hot", metadata: { runtimeHot: true } },
      ],
      edges: [{ fromNode: "ROUTER:app", toNode: "ROUTE:/a", relationType: "HANDLES_ROUTE", metadata: {} }],
    };
    const r = findOrphanSurfaces(shaped(raw));
    assert.equal(r.candidates.length, 0, "a quente não é órfã; a montada tem wiring");
    assert.equal(r.excluded.runtimeObserved, 1);
  });

  it("múltiplas órfãs vêm ordenadas de forma estável (tipo, depois label)", () => {
    const raw: RawSystemGraph = {
      nodes: [
        { id: "ROUTER:app", type: "SERVICE", className: "appRouter", metadata: {} },
        { id: "ROUTE:/mounted", type: "ROUTE", className: "mounted", metadata: {} },
        { id: "ROUTE:/zeta", type: "ROUTE", className: "zeta", metadata: {} },
        { id: "CONTROLLER:Beta", type: "CONTROLLER", className: "Beta", metadata: {} },
      ],
      edges: [{ fromNode: "ROUTER:app", toNode: "ROUTE:/mounted", relationType: "HANDLES_ROUTE", metadata: {} }],
    };
    const r = findOrphanSurfaces(shaped(raw));
    // CONTROLLER antes de ROUTE (localeCompare de tipo); confiança igual (0.6)
    assert.deepEqual(r.candidates.map((c) => c.nodeId), ["CONTROLLER:Beta", "ROUTE:/zeta"]);
    assert.ok(r.candidates.every((c) => c.confidence < 1));
  });

  it("wiringRelations VAZIO cai de volta ao default (não zera a detecção)", () => {
    const raw: RawSystemGraph = {
      nodes: [
        { id: "ROUTER:app", type: "SERVICE", className: "appRouter", metadata: {} },
        { id: "ROUTE:/a", type: "ROUTE", className: "a", metadata: {} },
        { id: "ROUTE:/b", type: "ROUTE", className: "b", metadata: {} },
      ],
      edges: [{ fromNode: "ROUTER:app", toNode: "ROUTE:/a", relationType: "HANDLES_ROUTE", metadata: {} }],
    };
    const r = findOrphanSurfaces(shaped(raw), { wiringRelations: new Set<string>() });
    assert.equal(r.wiringPresent, true, "default aplicado pois o custom veio vazio");
    assert.deepEqual(r.candidates.map((c) => c.nodeId), ["ROUTE:/b"]);
  });
});

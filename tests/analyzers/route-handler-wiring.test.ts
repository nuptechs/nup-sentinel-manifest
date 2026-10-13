import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WIRING_REL,
  ENTRY_HTTP,
  ENTRY_SPA,
  buildRouteHandlerWiring,
  augmentGraphWithRouteWiring,
} from "../../server/analyzers/route-handler-wiring";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";
import { findOrphanSurfaces } from "../../server/analyzers/orphan-surface";

// OBS-D03 — wiring rota→handler. O produtor emite arestas cujo `toNode` É a
// superfície REGISTRADA (controller mapeado / rota montada / view roteada). A
// superfície SEM fato de registro fica de fora — é o resíduo que o OBS-E01
// (orphan-surface) poderá acusar. Inerte: nada no pipeline chama isto.

const graph = (): RawSystemGraph => ({
  nodes: [
    // CONTROLLER MAPEADO (verbo+path) → ganha HANDLES_ROUTE.
    { id: "CONTROLLER:a.FooController.list()", type: "CONTROLLER", className: "FooController", metadata: { httpMethod: "GET", fullPath: "/foo", sourceFile: "Foo.java" } },
    // CONTROLLER SEM mapeamento → candidato a órfão (não ganha wiring).
    { id: "CONTROLLER:a.OrphanController.helper()", type: "CONTROLLER", className: "OrphanController", metadata: { sourceFile: "Orphan.java" } },
    // ROUTE Express → ganha MOUNTS.
    { id: "route:POST:/api/bar", type: "ROUTE", className: "/api/bar", metadata: { httpMethod: "POST", fullPath: "/api/bar", sourceFile: "routes.ts" } },
    // VIEW roteada → ganha RENDERS_VIEW.
    { id: "view:Dashboard", type: "VIEW", className: "Dashboard", metadata: { sourceFile: "Dashboard.vue" } },
    // SERVICE comum (não é superfície — ignorado pelo wiring).
    { id: "SERVICE:a.FooService.run()", type: "SERVICE", className: "FooService", metadata: { sourceFile: "FooService.java" } },
  ],
  edges: [],
});

describe("route-handler-wiring — produtor de wiring", () => {
  it("emite HANDLES_ROUTE/MOUNTS/RENDERS_VIEW só para superfícies registradas", () => {
    const { nodes, edges, stats } = buildRouteHandlerWiring(graph());
    assert.equal(stats.controllersWired, 1);
    assert.equal(stats.routesMounted, 1);
    assert.equal(stats.viewsRendered, 1);
    assert.equal(stats.surfacesSkipped, 1, "o controller sem mapeamento não é fiado");

    const byRel = (rel: string) => edges.filter((e) => e.relationType === rel);
    assert.equal(byRel(WIRING_REL.HANDLES_ROUTE)[0].toNode, "CONTROLLER:a.FooController.list()");
    assert.equal(byRel(WIRING_REL.MOUNTS)[0].toNode, "route:POST:/api/bar");
    assert.equal(byRel(WIRING_REL.RENDERS_VIEW)[0].toNode, "view:Dashboard");

    // nós-origem sintéticos mintados (http + spa) e aresta honesta (synthetic).
    assert.ok(nodes.some((n) => n.id === ENTRY_HTTP));
    assert.ok(nodes.some((n) => n.id === ENTRY_SPA));
    assert.equal(edges[0].metadata?.synthetic, true);
  });

  it("não minta nó-origem de um mecanismo sem arestas", () => {
    const onlyView: RawSystemGraph = { nodes: [{ id: "view:X", type: "VIEW", className: "X", metadata: { sourceFile: "X.vue" } }], edges: [] };
    const { nodes } = buildRouteHandlerWiring(onlyView);
    assert.ok(nodes.some((n) => n.id === ENTRY_SPA));
    assert.ok(!nodes.some((n) => n.id === ENTRY_HTTP), "sem rota/controller HTTP → sem entry:http");
  });

  it("path malformado / verbo ALL não conta como registro", () => {
    const g: RawSystemGraph = {
      nodes: [
        { id: "CONTROLLER:a.Bad.x()", type: "CONTROLLER", className: "Bad", metadata: { httpMethod: "GET", fullPath: "/a{param}{param}" } },
        { id: "route:ALL:/x", type: "ROUTE", className: "/x", metadata: { httpMethod: "ALL", fullPath: "/x" } },
      ],
      edges: [],
    };
    const { stats } = buildRouteHandlerWiring(g);
    assert.equal(stats.controllersWired, 0);
    assert.equal(stats.routesMounted, 0);
    assert.equal(stats.surfacesSkipped, 2);
  });
});

describe("route-handler-wiring — fecha o loop com OBS-E01 (orphan-surface)", () => {
  it("sem wiring o detector é CEGO; com wiring ele avalia e acha o órfão", () => {
    const raw = graph();

    // ANTES: sem wiring → orphan-surface cego.
    const blind = findOrphanSurfaces(shapeSystemGraph(raw, "method"));
    assert.equal(blind.wiringPresent, false);
    assert.equal(blind.candidates.length, 0);

    // DEPOIS: augment injeta o wiring → detector avalia.
    const { graph: wired } = augmentGraphWithRouteWiring(raw);
    const report = findOrphanSurfaces(shapeSystemGraph(wired, "method"));
    assert.equal(report.wiringPresent, true);

    // O controller mapeado, a rota e a view estão fiados (excluídos); o
    // OrphanController (sem mapeamento, sem runtime, sem gatilho) é acusado.
    const ids = report.candidates.map((c) => c.nodeId);
    assert.ok(ids.includes("CONTROLLER:a.OrphanController.helper()"));
    assert.ok(!ids.includes("CONTROLLER:a.FooController.list()"));
    assert.ok(!ids.includes("route:POST:/api/bar"));
    assert.ok(!ids.includes("view:Dashboard"));
    assert.ok(report.excluded.wired >= 3);
  });

  it("augment é puro (não muta o grafo de entrada) e idempotente", () => {
    const raw = graph();
    const beforeNodes = raw.nodes.length;
    const beforeEdges = raw.edges.length;
    const once = augmentGraphWithRouteWiring(raw);
    assert.equal(raw.nodes.length, beforeNodes, "entrada intacta");
    assert.equal(raw.edges.length, beforeEdges);
    const twice = augmentGraphWithRouteWiring(once.graph);
    assert.equal(twice.graph.edges.length, once.graph.edges.length, "re-aplicar não duplica");
  });
});

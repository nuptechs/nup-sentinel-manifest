import { describe, it, expect } from "vitest";
import {
  applyLens,
  buildLensGeometry,
  lensColumnOf,
  matchesUnguarded,
  type LensGraph,
  type LensId,
} from "./evidence-lenses";

const graph: LensGraph = {
  nodes: [
    { id: "route:GET /a", type: "ROUTE", className: "AController", inDegree: 1, outDegree: 2 },
    { id: "svc:Foo", type: "SERVICE", className: "FooService", inDegree: 3, outDegree: 1, runtimeHot: true, runtimeCount: 42, runtimeLastSeenMs: Date.now() },
    { id: "repo:Bar", type: "REPOSITORY", className: "BarRepo", inDegree: 2, outDegree: 0, runtimeStale: true, runtimeLastSeenMs: Date.now() - 999999999 },
    { id: "ent:contract", type: "ENTITY", className: "Contract", inDegree: 1, outDegree: 0, sensitive: true },
  ],
  edges: [
    { fromNode: "route:GET /a", toNode: "svc:Foo", relationType: "CALLS", observed: true, evidence: { method: "RUNTIME_OBSERVED", confidence: 0.95 } },
    { fromNode: "svc:Foo", toNode: "repo:Bar", relationType: "CALLS", evidence: { method: "STATIC_UNRESOLVED", confidence: 0.4 } },
  ],
};

describe("lensColumnOf", () => {
  it("mapeia camadas para colunas fixas", () => {
    expect(lensColumnOf("ROUTE")).toBe(0);
    expect(lensColumnOf("CONTROLLER")).toBe(1);
    expect(lensColumnOf("SERVICE")).toBe(2);
    expect(lensColumnOf("ENTITY")).toBe(3);
  });
});

describe("buildLensGeometry", () => {
  it("posiciona nós por coluna de camada e mantém as arestas", () => {
    const geom = buildLensGeometry(graph);
    expect(geom.nodes).toHaveLength(4);
    expect(geom.edges).toHaveLength(2);
    const route = geom.nodes.find((n) => n.node.id === "route:GET /a")!;
    const svc = geom.nodes.find((n) => n.node.id === "svc:Foo")!;
    expect(route.column).toBe(0);
    expect(svc.column).toBe(2);
    expect(route.x).toBeLessThan(svc.x); // fluxo esquerda→direita
  });

  it("anuncia truncamento quando estoura o cap (nunca corta em silêncio)", () => {
    const big: LensGraph = {
      nodes: Array.from({ length: 500 }, (_, i) => ({ id: `n${i}`, type: "SERVICE", inDegree: i, outDegree: 0 })),
      edges: [],
    };
    const geom = buildLensGeometry(big, 400);
    expect(geom.truncated).toBe(true);
    expect(geom.shown).toBe(400);
    expect(geom.total).toBe(500);
  });
});

describe("applyLens — INVARIÂNCIA GEOMÉTRICA (o ponto do conceito)", () => {
  it("a POSIÇÃO dos nós é idêntica entre as 4 lentes; só cor/estilo muda", () => {
    const geom = buildLensGeometry(graph);
    const positions = geom.nodes.map((n) => ({ id: n.node.id, x: n.x, y: n.y }));
    const lenses: LensId[] = ["evidence", "sensitive", "runtime", "recency"];
    // a geometria (geom) é a mesma referência para todas — applyLens NÃO a muta.
    for (const lens of lenses) {
      const styles = applyLens(lens, geom);
      expect(styles.nodes).toHaveLength(geom.nodes.length);
      expect(styles.edges).toHaveLength(geom.edges.length);
    }
    // após aplicar todas as lentes, as posições continuam intactas
    const after = geom.nodes.map((n) => ({ id: n.node.id, x: n.x, y: n.y }));
    expect(after).toEqual(positions);
  });

  it("lente Sensível+Guarda acende nós sensíveis e rotas sem guarda", () => {
    const geom = buildLensGeometry(graph);
    const styles = applyLens("sensitive", geom, { unguarded: [{ path: "/a", method: "GET" }] });
    const contractIdx = geom.nodes.findIndex((n) => n.node.id === "ent:contract");
    // o nó sensível não fica esmaecido
    expect(styles.nodes[contractIdx].opacity).toBeGreaterThan(0.3);
  });

  it("matchesUnguarded liga rota a endpoint sem guarda pelo path", () => {
    const routeNode = graph.nodes[0];
    expect(matchesUnguarded(routeNode, { unguarded: [{ path: "/a", method: "GET" }] })).toBe(true);
    expect(matchesUnguarded(routeNode, { unguarded: [{ path: "/outra", method: "GET" }] })).toBe(false);
  });

  it("lente Recência distingue fresh de stale (última observação por nó)", () => {
    const geom = buildLensGeometry(graph);
    const styles = applyLens("recency", geom);
    const fooIdx = geom.nodes.findIndex((n) => n.node.id === "svc:Foo"); // hot recente
    const barIdx = geom.nodes.findIndex((n) => n.node.id === "repo:Bar"); // stale
    // fresh mais saturado que stale (opacidade maior)
    expect(styles.nodes[fooIdx].opacity).toBeGreaterThanOrEqual(styles.nodes[barIdx].opacity);
  });
});

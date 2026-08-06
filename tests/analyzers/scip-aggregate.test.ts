import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fileOfScipSymbol,
  buildFileNodeIndex,
  aggregateScipEdges,
  mergeScipEdges,
  type ScipDerivedEdge,
} from "../../server/analyzers/scip-aggregate";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// Símbolos reais (formato scip-typescript, verificado no index.scip do NuPIdentify).
const SYM = {
  tenantMiddleware: "scip-typescript npm nupidentity 1.0.0 server/middleware/`tenant.ts`/tenantMiddleware().",
  jwtVerify: "scip-typescript npm nupidentity 1.0.0 server/auth/`jwt.ts`/verifyToken().",
  tenantService: "scip-typescript npm nupidentity 1.0.0 server/services/`tenant.service.ts`/TenantService#resolve().",
  utilCn: "scip-typescript npm nupidentity 1.0.0 client/src/lib/`utils.ts`/cn().",
  external: "scip-typescript npm typescript 5.6.3 lib/`lib.dom.d.ts`/Console#error().",
  externalDts: "scip-typescript npm @types/node 20.16.11 `console.d.ts`/`\"node:console\"`/global/Console#error().",
  localScip: "local 0",
};

describe("fileOfScipSymbol", () => {
  it("extrai o arquivo local (dir aninhado + filename com múltiplos pontos)", () => {
    assert.equal(fileOfScipSymbol(SYM.tenantMiddleware), "server/middleware/tenant.ts");
    assert.equal(fileOfScipSymbol(SYM.tenantService), "server/services/tenant.service.ts");
    assert.equal(fileOfScipSymbol(SYM.utilCn), "client/src/lib/utils.ts");
  });
  it("extrai arquivos de pacotes externos (serão filtrados por não casar nó)", () => {
    assert.equal(fileOfScipSymbol(SYM.external), "lib/lib.dom.d.ts");
    assert.equal(fileOfScipSymbol(SYM.externalDts), "console.d.ts");
  });
  it("retorna null para símbolos sem arquivo (local, não-scip, vazio)", () => {
    assert.equal(fileOfScipSymbol(SYM.localScip), null);
    assert.equal(fileOfScipSymbol(""), null);
    assert.equal(fileOfScipSymbol("garbage without scheme"), null);
  });
});

// Grafo cru mínimo espelhando a forma do NuPIdentify (nós node:<file> + route + entity).
function fixtureGraph(): RawSystemGraph {
  return {
    nodes: [
      { id: "node:server/middleware/tenant.ts", type: "SERVICE", className: "tenant", metadata: { sourceFile: "server/middleware/tenant.ts", synthetic: true, runtime: "node" } },
      { id: "node:server/auth/jwt.ts", type: "SERVICE", className: "jwt", metadata: { sourceFile: "server/auth/jwt.ts", synthetic: true, runtime: "node" } },
      { id: "node:server/services/tenant.service.ts", type: "SERVICE", className: "tenant.service", metadata: { sourceFile: "server/services/tenant.service.ts", synthetic: true, runtime: "node" } },
      // arquivo com >1 nó: rota + módulo → o índice prefere o módulo
      { id: "route:GET:/orgs/:id", type: "ROUTE", metadata: { sourceFile: "server/routes/orgs.routes.ts", httpMethod: "GET", synthetic: true } },
      { id: "route:POST:/orgs", type: "ROUTE", metadata: { sourceFile: "server/routes/orgs.routes.ts", httpMethod: "POST", synthetic: true } },
      { id: "node:server/routes/orgs.routes.ts", type: "SERVICE", className: "orgs.routes", metadata: { sourceFile: "server/routes/orgs.routes.ts", synthetic: true, runtime: "node" } },
      // arquivo com só ENTITY
      { id: "table:organizations", type: "ENTITY", className: "organizations", metadata: { sourceFile: "server/db/schema.ts", drizzleOnly: true } },
    ],
    // aresta heurística pré-existente (node-chain do full-stack-augment): será PROMOVIDA
    edges: [
      { fromNode: "node:server/middleware/tenant.ts", toNode: "node:server/services/tenant.service.ts", relationType: "CALLS", metadata: { synthetic: true, resolution: "syntactic-declared", convention: "node-chain" } },
    ],
  };
}

describe("buildFileNodeIndex — prioridade honesta (ADR-0031 §4.1)", () => {
  const idx = buildFileNodeIndex(fixtureGraph().nodes);
  it("mapeia arquivo→módulo node:<file> quando existe", () => {
    assert.equal(idx.get("server/services/tenant.service.ts"), "node:server/services/tenant.service.ts");
  });
  it("arquivo com rota+módulo → prefere o módulo (por-arquivo, não ambíguo)", () => {
    assert.equal(idx.get("server/routes/orgs.routes.ts"), "node:server/routes/orgs.routes.ts");
  });
  it("arquivo só com ENTITY → mapeia a entidade", () => {
    assert.equal(idx.get("server/db/schema.ts"), "table:organizations");
  });
});

describe("buildFileNodeIndex — arquivo ambíguo (N rotas, sem módulo) não é indexado", () => {
  const nodes = [
    { id: "route:GET:/a", type: "ROUTE", metadata: { sourceFile: "server/routes/multi.ts", synthetic: true } },
    { id: "route:GET:/b", type: "ROUTE", metadata: { sourceFile: "server/routes/multi.ts", synthetic: true } },
  ];
  it("não indexa (evita mis-atribuição por-endpoint)", () => {
    assert.equal(buildFileNodeIndex(nodes as any).get("server/routes/multi.ts"), undefined);
  });
});

describe("aggregateScipEdges — símbolo→nó→aresta-de-sistema", () => {
  const nodes = fixtureGraph().nodes;
  it("chamada direta handler→service vira aresta de sistema compiler", () => {
    const derived: ScipDerivedEdge[] = [{ from: SYM.tenantMiddleware, to: SYM.tenantService, kind: "CALLS", resolution: "compiler" }];
    const { edges } = aggregateScipEdges(nodes, derived);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], { fromNode: "node:server/middleware/tenant.ts", toNode: "node:server/services/tenant.service.ts", relationType: "CALLS", resolution: "compiler" });
  });
  it("símbolo órfão (arquivo sem nó) → aresta descartada", () => {
    const derived: ScipDerivedEdge[] = [{ from: SYM.utilCn, to: SYM.tenantService, resolution: "compiler" }];
    const { edges, stats } = aggregateScipEdges(nodes, derived);
    assert.equal(edges.length, 0);
    assert.equal(stats.orphanDropped, 1);
  });
  it("intra-nó (mesmo arquivo/nó nas duas pontas) → descartada", () => {
    const derived: ScipDerivedEdge[] = [{ from: SYM.tenantMiddleware, to: SYM.tenantMiddleware, resolution: "compiler" }];
    const { edges, stats } = aggregateScipEdges(nodes, derived);
    assert.equal(edges.length, 0);
    assert.equal(stats.intraDropped, 1);
  });
  it("compiler prevalece sobre interface-impl para o MESMO par de nós", () => {
    const derived: ScipDerivedEdge[] = [
      { from: SYM.tenantMiddleware, to: SYM.jwtVerify, resolution: "interface-impl" },
      { from: SYM.tenantMiddleware, to: SYM.jwtVerify, resolution: "compiler" },
    ];
    const { edges } = aggregateScipEdges(nodes, derived);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].resolution, "compiler");
  });
  it("interface-impl preservado quando é a única evidência do par", () => {
    const derived: ScipDerivedEdge[] = [{ from: SYM.tenantMiddleware, to: SYM.jwtVerify, resolution: "interface-impl" }];
    const { edges } = aggregateScipEdges(nodes, derived);
    assert.equal(edges[0].resolution, "interface-impl");
  });
});

describe("mergeScipEdges — promove/adiciona sem mutar a entrada", () => {
  it("PROMOVE aresta heurística existente a compiler (remove synthetic)", () => {
    const raw = fixtureGraph();
    const before = JSON.stringify(raw);
    const payload = { edges: [{ from: SYM.tenantMiddleware, to: SYM.tenantService, resolution: "compiler" as const }] };
    const { graph, stats } = mergeScipEdges(raw, payload);
    assert.equal(stats.upgraded, 1);
    assert.equal(stats.added, 0);
    const e = graph.edges.find((x) => x.fromNode === "node:server/middleware/tenant.ts" && x.toNode === "node:server/services/tenant.service.ts");
    assert.equal((e!.metadata as any).resolution, "compiler");
    assert.equal((e!.metadata as any).synthetic, undefined);
    // entrada intocada (clone defensivo)
    assert.equal(JSON.stringify(raw), before);
  });
  it("ADICIONA aresta nova quando não há aresta crua correspondente", () => {
    const raw = fixtureGraph();
    const payload = { edges: [{ from: SYM.tenantMiddleware, to: SYM.jwtVerify, resolution: "compiler" as const }] };
    const { graph, stats } = mergeScipEdges(raw, payload);
    assert.equal(stats.added, 1);
    const e = graph.edges.find((x) => x.fromNode === "node:server/middleware/tenant.ts" && x.toNode === "node:server/auth/jwt.ts");
    assert.ok(e);
    assert.equal((e!.metadata as any).resolution, "compiler");
  });
  it("payload nulo/vazio → grafo byte-a-byte (mesma referência)", () => {
    const raw = fixtureGraph();
    assert.equal(mergeScipEdges(raw, null).graph, raw);
    assert.equal(mergeScipEdges(raw, { edges: [] }).graph, raw);
  });
});

// ── O 1º teste do DoD (ADR-0031 §6 A3): uma aresta que vira STATIC_PROVEN ──
describe("fim-a-fim: a aresta provada sobe o STATIC_PROVEN do censo de 0 para >0", () => {
  it("merge + shapeSystemGraph classifica a aresta como STATIC_PROVEN (resolution compiler)", () => {
    const raw = fixtureGraph();

    // ANTES: nenhuma aresta provada.
    const before = shapeSystemGraph(raw, "class");
    assert.equal(before.coverage.edges.byMethod.STATIC_PROVEN, 0);

    // Ingere a aresta compiler + uma nova service→service.
    const payload = {
      edges: [
        { from: SYM.tenantMiddleware, to: SYM.tenantService, resolution: "compiler" as const },
        { from: SYM.tenantMiddleware, to: SYM.jwtVerify, resolution: "compiler" as const },
      ],
    };
    const { graph } = mergeScipEdges(raw, payload);
    const after = shapeSystemGraph(graph, "class");

    assert.ok(after.coverage.edges.byMethod.STATIC_PROVEN >= 2, `esperado >=2 STATIC_PROVEN, veio ${after.coverage.edges.byMethod.STATIC_PROVEN}`);
    // a aresta promovida saiu de STATIC_UNRESOLVED
    const proven = after.edges.filter((e) => e.evidence.method === "STATIC_PROVEN");
    assert.ok(proven.every((e) => e.resolution === "compiler"));
    // e a promovida não é mais synthetic (deixou de ser DECLARADA)
    const promoted = after.edges.find((e) => e.fromNode.includes("tenant.ts") && e.toNode.includes("tenant.service.ts"));
    assert.equal(promoted!.evidence.method, "STATIC_PROVEN");
    assert.equal(promoted!.synthetic, undefined);
  });
});

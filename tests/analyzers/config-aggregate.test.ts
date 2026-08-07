import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  typeFqnOfConfigEndpoint,
  buildFqnNodeIndex,
  aggregateConfigEdges,
  mergeConfigEdges,
  type ConfigDerivedEdge,
  type ConfigEdgesPayload,
} from "../../server/analyzers/config-aggregate";
import { mergeScipEdges, type ScipEdgesPayload } from "../../server/analyzers/scip-aggregate";
import { shapeSystemGraph, type RawSystemGraph, type ShapedEdge } from "../../server/analyzers/system-graph";

// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 §4 — o CONSUMIDOR da camada CONFIG_PROVEN. Prova, com o mesmo rigor
// das scip-edges, que uma aresta config-proven (DI resolvida pelo wiring do
// Spring) vira CONFIG_PROVEN no mapa — não UNKNOWN, não STATIC_PROVEN.
// ─────────────────────────────────────────────────────────────────────────

// FQNs reais no espírito dos ports & adapters do easynup (ADR-001).
const FQN = {
  deductionPort: "easynup.services.common.rules.adapters.DeductionAdapter",
  deductionImpl: "easynup.services.common.rules.adapters.impl.EasyNupDeductionAdapter",
  notifPort: "easynup.services.common.rules.adapters.NotificationAdapter",
  notifImpl: "easynup.services.common.rules.adapters.impl.EasyNupNotificationAdapter",
  libPort: "org.springframework.SomeLibPort", // fora do escopo parseado → sem nó
};

// Símbolo scip-java de TIPO (termina em `#`), a forma que o resolvedor POSTa
// quando roda com `--scip-json`.
const SCIPJAVA = {
  deductionPort: "scip-java maven easynup 0.0.1 easynup/services/common/rules/adapters/DeductionAdapter#",
  deductionImpl: "scip-java maven easynup 0.0.1 easynup/services/common/rules/adapters/impl/EasyNupDeductionAdapter#",
};

// Grafo Java cru mínimo espelhando o Engine A: nó de CLASSE `<STEREOTYPE>:<FQN>`
// + um nó de MÉTODO por classe (para exercitar o rollup class-level). Como no Java
// real, SÓ o nó de CLASSE carrega `metadata.sourceFile` (o nó de método reduz à
// classe via `classKeyOf` — sem `(` é atômico; com `(` tira o `.metodo(...)`). Isso
// também deixa o `buildFileNodeIndex` do scip resolver arquivo→1-nó (senão N nós no
// mesmo arquivo = ambíguo, não indexado).
function fixtureGraph(): RawSystemGraph {
  return {
    nodes: [
      { id: `SERVICE:${FQN.deductionPort}`, type: "SERVICE", className: "DeductionAdapter", metadata: { sourceFile: "DeductionAdapter.java" } },
      { id: `SERVICE:${FQN.deductionPort}.calculate(x)`, type: "SERVICE", metadata: {} },
      { id: `SERVICE:${FQN.deductionImpl}`, type: "SERVICE", className: "EasyNupDeductionAdapter", metadata: { sourceFile: "EasyNupDeductionAdapter.java" } },
      { id: `SERVICE:${FQN.deductionImpl}.calculate(x)`, type: "SERVICE", metadata: {} },
      { id: `SERVICE:${FQN.notifPort}`, type: "SERVICE", className: "NotificationAdapter", metadata: { sourceFile: "NotificationAdapter.java" } },
      { id: `SERVICE:${FQN.notifImpl}`, type: "SERVICE", className: "EasyNupNotificationAdapter", metadata: { sourceFile: "EasyNupNotificationAdapter.java" } },
    ],
    edges: [],
  };
}

function configPayload(edges: ConfigDerivedEdge[]): ConfigEdgesPayload {
  return { tool: "config-proven", schema: "adr-0035.config-proven.v1", edges };
}

/** Acha a aresta shaped entre dois nós de classe (por relationType opcional). */
function findEdge(edges: ShapedEdge[], from: string, to: string, rel?: string): ShapedEdge | undefined {
  return edges.find((e) => e.fromNode === from && e.toNode === to && (rel ? e.relationType === rel : true));
}

describe("typeFqnOfConfigEndpoint — identidade agnóstica à forma", () => {
  it("FQN pontuado cru (o que o CI POSTa hoje) → usa direto", () => {
    assert.equal(typeFqnOfConfigEndpoint(FQN.deductionPort), FQN.deductionPort);
  });
  it("símbolo scip-java de TIPO → extrai o FQN (`/`→`.`, sem o `#`)", () => {
    assert.equal(typeFqnOfConfigEndpoint(SCIPJAVA.deductionPort), FQN.deductionPort);
  });
  it("`fromFqn`/`toFqn` preservado pelo resolvedor vence o parse do símbolo", () => {
    assert.equal(typeFqnOfConfigEndpoint(SCIPJAVA.deductionImpl, FQN.deductionImpl), FQN.deductionImpl);
  });
  it("entrada vazia / sem descritor de tipo → null (nunca lança)", () => {
    assert.equal(typeFqnOfConfigEndpoint(""), null);
    assert.equal(typeFqnOfConfigEndpoint("scip-java maven x 1 local 0"), null);
    assert.equal(typeFqnOfConfigEndpoint(undefined as unknown as string), null);
  });
});

describe("buildFqnNodeIndex — FQN → nó de CLASSE real", () => {
  const idx = buildFqnNodeIndex(fixtureGraph().nodes);
  it("mapeia o FQN para o nó de CLASSE (id sem sufixo de método)", () => {
    assert.equal(idx.get(FQN.deductionPort), `SERVICE:${FQN.deductionPort}`);
    assert.equal(idx.get(FQN.deductionImpl), `SERVICE:${FQN.deductionImpl}`);
  });
  it("FQN de tipo sem nó no grafo → ausente (aresta será descartada, §5)", () => {
    assert.equal(idx.get(FQN.libPort), undefined);
  });
  it("nó de CLASSE (bare) é preferido mesmo quando há só métodos antes dele", () => {
    const nodes = [
      { id: `SERVICE:${FQN.notifPort}.send(m)`, type: "SERVICE", metadata: { sourceFile: "N.java" } },
      { id: `SERVICE:${FQN.notifPort}`, type: "SERVICE", metadata: { sourceFile: "N.java" } },
    ];
    // classKeyOf de um id sem `(` é o próprio id → método `.send(m)` reduz à classe.
    assert.equal(buildFqnNodeIndex(nodes as never).get(FQN.notifPort), `SERVICE:${FQN.notifPort}`);
  });
});

describe("aggregateConfigEdges — FQN→nó→aresta DI_RESOLVES", () => {
  const nodes = fixtureGraph().nodes;
  it("interface→impl (FQN pontuado) vira 1 aresta DI_RESOLVES config", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: FQN.deductionPort, to: FQN.deductionImpl, kind: "DI_RESOLVES", resolution: "config", reason: "spring-single-bean" },
    ];
    const { edges, stats } = aggregateConfigEdges(nodes, derived);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], {
      fromNode: `SERVICE:${FQN.deductionPort}`,
      toNode: `SERVICE:${FQN.deductionImpl}`,
      relationType: "DI_RESOLVES",
      resolution: "config",
      reason: "spring-single-bean",
    });
    assert.equal(stats.orphanDropped, 0);
    assert.equal(stats.intraDropped, 0);
  });

  it("forma scip-java (com fromFqn/toFqn) resolve IDÊNTICO à forma FQN", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: SCIPJAVA.deductionPort, to: SCIPJAVA.deductionImpl, fromFqn: FQN.deductionPort, toFqn: FQN.deductionImpl, resolution: "config", reason: "spring-primary" },
    ];
    const { edges } = aggregateConfigEdges(nodes, derived);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].fromNode, `SERVICE:${FQN.deductionPort}`);
    assert.equal(edges[0].toNode, `SERVICE:${FQN.deductionImpl}`);
  });

  it("órfão (FQN de tipo sem nó — lib externa) → descartado, nunca inventa nó", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: FQN.libPort, to: FQN.deductionImpl, resolution: "config" },
    ];
    const { edges, stats } = aggregateConfigEdges(nodes, derived);
    assert.equal(edges.length, 0);
    assert.equal(stats.orphanDropped, 1);
  });

  it("auto-referência (mesmo nó nas duas pontas) → descartada", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: FQN.deductionPort, to: FQN.deductionPort, resolution: "config" },
    ];
    const { edges, stats } = aggregateConfigEdges(nodes, derived);
    assert.equal(edges.length, 0);
    assert.equal(stats.intraDropped, 1);
  });

  it("dedup por par de nós (mesma DI POSTada 2×) → 1 aresta", () => {
    const e: ConfigDerivedEdge = { from: FQN.deductionPort, to: FQN.deductionImpl, resolution: "config" };
    const { edges } = aggregateConfigEdges(nodes, [e, { ...e }]);
    assert.equal(edges.length, 1);
  });
});

describe("mergeConfigEdges + shapeSystemGraph — a aresta config vira CONFIG_PROVEN", () => {
  it("classifica como CONFIG_PROVEN (não UNKNOWN, não STATIC_PROVEN) e conta no censo", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: FQN.deductionPort, to: FQN.deductionImpl, resolution: "config", reason: "spring-single-bean" },
      { from: FQN.notifPort, to: FQN.notifImpl, resolution: "config", reason: "spring-single-bean" },
    ];
    const { graph, stats } = mergeConfigEdges(fixtureGraph(), configPayload(derived));
    assert.equal(stats.added, 2);
    assert.equal(stats.supersededByScip, 0);

    const shaped = shapeSystemGraph(graph, "class");
    const edge = findEdge(shaped.edges, `SERVICE:${FQN.deductionPort}`, `SERVICE:${FQN.deductionImpl}`, "DI_RESOLVES");
    assert.ok(edge, "aresta DI_RESOLVES presente no grafo shaped");
    assert.equal(edge!.evidence.method, "CONFIG_PROVEN");
    assert.equal(edge!.evidence.confidence, 0.78);
    assert.notEqual(edge!.evidence.method, "UNKNOWN");
    assert.notEqual(edge!.evidence.method, "STATIC_PROVEN");
    assert.equal(edge!.resolution, "config");

    // (b) coverage.byMethod.CONFIG_PROVEN > 0
    assert.ok(shaped.coverage.edges.byMethod.CONFIG_PROVEN > 0, "censo conta CONFIG_PROVEN");
    assert.equal(shaped.coverage.edges.byMethod.CONFIG_PROVEN, 2);
    assert.equal(shaped.coverage.edges.byMethod.UNKNOWN, 0);
  });

  it("SEM a costura CONFIG_PROVEN, a MESMA aresta cairia em UNKNOWN (regressão-guard)", () => {
    // Prova que a coluna nova é o que classifica: um edge cru com resolution:'config'
    // mas SEM configProven, sem o ramo novo, seria UNKNOWN. Aqui garantimos que o
    // ramo `resolution==='config'` do classifyEdgeEvidence o resgata.
    const raw: RawSystemGraph = {
      nodes: fixtureGraph().nodes,
      edges: [{ fromNode: `SERVICE:${FQN.deductionPort}`, toNode: `SERVICE:${FQN.deductionImpl}`, relationType: "DI_RESOLVES", metadata: { resolution: "config" } }],
    };
    const shaped = shapeSystemGraph(raw, "class");
    const edge = findEdge(shaped.edges, `SERVICE:${FQN.deductionPort}`, `SERVICE:${FQN.deductionImpl}`);
    assert.equal(edge!.evidence.method, "CONFIG_PROVEN");
  });

  it("promove aresta DI_RESOLVES crua pré-existente (declarada) a CONFIG_PROVEN", () => {
    const raw: RawSystemGraph = {
      nodes: fixtureGraph().nodes,
      edges: [{ fromNode: `SERVICE:${FQN.deductionPort}`, toNode: `SERVICE:${FQN.deductionImpl}`, relationType: "DI_RESOLVES", metadata: { synthetic: true } }],
    };
    const derived: ConfigDerivedEdge[] = [{ from: FQN.deductionPort, to: FQN.deductionImpl, resolution: "config", reason: "spring-single-bean" }];
    const { graph, stats } = mergeConfigEdges(raw, configPayload(derived));
    assert.equal(stats.upgraded, 1);
    assert.equal(stats.added, 0);
    const merged = graph.edges.find((e) => e.relationType === "DI_RESOLVES")!;
    assert.equal((merged.metadata as Record<string, unknown>).resolution, "config");
    assert.equal((merged.metadata as Record<string, unknown>).configProven, true);
    assert.equal((merged.metadata as Record<string, unknown>).synthetic, undefined); // deixou de ser DECLARADA
  });
});

describe("SEM config-edges → byte-a-byte (fail-soft, GATED)", () => {
  it("payload null / vazio → mesma referência de grafo e mesmo shape", () => {
    const g = fixtureGraph();
    const shapedBefore = shapeSystemGraph(g, "class");

    const rNull = mergeConfigEdges(g, null);
    assert.strictEqual(rNull.graph, g);
    assert.equal(rNull.stats.added, 0);

    const rEmpty = mergeConfigEdges(g, configPayload([]));
    assert.strictEqual(rEmpty.graph, g);

    // shape idêntico (censo sem CONFIG_PROVEN)
    const shapedAfter = shapeSystemGraph(rEmpty.graph, "class");
    assert.deepEqual(shapedAfter.coverage, shapedBefore.coverage);
    assert.equal(shapedAfter.counts.edges, shapedBefore.counts.edges);
  });

  it("todas as arestas órfãs → grafo intocado (aggregated 0)", () => {
    const g = fixtureGraph();
    const derived: ConfigDerivedEdge[] = [{ from: FQN.libPort, to: "com.other.AlsoAbsent", resolution: "config" }];
    const { graph, stats } = mergeConfigEdges(g, configPayload(derived));
    assert.strictEqual(graph, g);
    assert.equal(stats.orphanDropped, 1);
    assert.equal(stats.added, 0);
  });
});

describe("PRECEDÊNCIA scip > config — scip + config coexistem sem colisão", () => {
  it("par já provado por scip (STATIC_PROVEN) NÃO é rebaixado nem duplicado por config", () => {
    // Semeia o par port→impl já provado por scip (scipProven, como o mergeScipEdges
    // marca as arestas que promove/adiciona) — a forma determinística do "mesmo par".
    const raw: RawSystemGraph = {
      nodes: fixtureGraph().nodes,
      edges: [
        { fromNode: `SERVICE:${FQN.deductionPort}`, toNode: `SERVICE:${FQN.deductionImpl}`, relationType: "CALLS", metadata: { resolution: "interface-impl", scipProven: true } },
      ],
    };
    const derived: ConfigDerivedEdge[] = [{ from: FQN.deductionPort, to: FQN.deductionImpl, resolution: "config", reason: "spring-single-bean" }];
    const { graph, stats } = mergeConfigEdges(raw, configPayload(derived));
    assert.equal(stats.supersededByScip, 1, "config cedeu ao scip");
    assert.equal(stats.added, 0, "nenhuma aresta config concorrente adicionada");

    // Shape final: o par continua STATIC_PROVEN; ZERO CONFIG_PROVEN para ele.
    const shaped = shapeSystemGraph(graph, "class");
    const proven = shaped.edges.filter(
      (e) => e.fromNode === `SERVICE:${FQN.deductionPort}` && e.toNode === `SERVICE:${FQN.deductionImpl}`,
    );
    assert.equal(proven.length, 1);
    assert.equal(proven[0].evidence.method, "STATIC_PROVEN");
    assert.equal(shaped.coverage.edges.byMethod.CONFIG_PROVEN, 0);
    assert.ok(shaped.coverage.edges.byMethod.STATIC_PROVEN >= 1);
  });

  it("pipeline /graph (scip PRIMEIRO, config DEPOIS): STATIC_PROVEN + CONFIG_PROVEN coexistem", () => {
    // Símbolo scip-JAVA de MÉTODO (call-graph, com fromFile/toFile) — a forma que o
    // deriver POSTa. Deduction (call-graph, STATIC_PROVEN) × Notif (DI, CONFIG_PROVEN).
    const scip: ScipEdgesPayload = {
      tool: "scip-java",
      schema: "adr-0031.p2",
      edges: [
        {
          from: "scip-java maven easynup 0.0.1 easynup/services/common/rules/adapters/DeductionAdapter#calculate().",
          to: "scip-java maven easynup 0.0.1 easynup/services/common/rules/adapters/impl/EasyNupDeductionAdapter#calculate().",
          kind: "CALLS",
          resolution: "interface-impl",
          fromFile: "DeductionAdapter.java",
          toFile: "EasyNupDeductionAdapter.java",
        },
      ],
    } as ScipEdgesPayload;
    const scipMerged = mergeScipEdges(fixtureGraph(), scip);
    assert.ok((scipMerged.stats.added + scipMerged.stats.upgraded) >= 1, "scip produziu ao menos 1 aresta provada");

    const derived: ConfigDerivedEdge[] = [{ from: FQN.notifPort, to: FQN.notifImpl, resolution: "config" }];
    const configMerged = mergeConfigEdges(scipMerged.graph, configPayload(derived));
    assert.equal(configMerged.stats.added, 1);
    assert.equal(configMerged.stats.supersededByScip, 0);

    const shaped = shapeSystemGraph(configMerged.graph, "class");
    assert.ok(shaped.coverage.edges.byMethod.STATIC_PROVEN >= 1, "scip STATIC_PROVEN presente");
    assert.equal(shaped.coverage.edges.byMethod.CONFIG_PROVEN, 1, "config CONFIG_PROVEN presente");
    const notif = findEdge(shaped.edges, `SERVICE:${FQN.notifPort}`, `SERVICE:${FQN.notifImpl}`, "DI_RESOLVES");
    assert.equal(notif!.evidence.method, "CONFIG_PROVEN");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  typeFqnOfConfigEndpoint,
  buildFqnNodeIndex,
  fqnSuffixesFromSourceFile,
  inferRootSegments,
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

// ─────────────────────────────────────────────────────────────────────────
// REGRESSÃO do #140 (o `configEdgesProven:0` medido no projeto 27). O grafo REAL
// do `java-analyzer` NÃO usa `<STEREOTYPE>:<FQN>` no id — usa o NOME SIMPLES da
// classe (`SERVICE:Foo.metodo`, `ENTITY:Contract`) e guarda o pacote só em
// `metadata.sourceFile` (o caminho do arquivo). As config-edges vêm em FQN
// PONTUADO. Estes testes provam que o índice reconstrói o FQN do `sourceFile` e
// casa — a causa-raiz do bug.
// ─────────────────────────────────────────────────────────────────────────

// Grafo Java como o `java-analyzer` REALMENTE produz: id = nome SIMPLES + método;
// o pacote vive só no `metadata.sourceFile`. Ports/adapters dos exemplos do easynup.
function realJavaGraph(): RawSystemGraph {
  return {
    nodes: [
      // interface (port) classificada como SERVICE — nós de MÉTODO (sem nó bare de classe)
      { id: "SERVICE:DeductionAdapter.calculate", type: "SERVICE", className: "DeductionAdapter", methodName: "calculate", metadata: { sourceFile: "src/main/java/easynup/services/common/rules/adapters/DeductionAdapter.java" } },
      // impl (adapter) — 2 métodos, provando o agrupamento por arquivo (1 rep/classe)
      { id: "SERVICE:EasyNupDeductionAdapter.calculate", type: "SERVICE", className: "EasyNupDeductionAdapter", methodName: "calculate", metadata: { sourceFile: "src/main/java/easynup/services/common/rules/adapters/impl/EasyNupDeductionAdapter.java" } },
      { id: "SERVICE:EasyNupDeductionAdapter.init", type: "SERVICE", className: "EasyNupDeductionAdapter", methodName: "init", metadata: { sourceFile: "src/main/java/easynup/services/common/rules/adapters/impl/EasyNupDeductionAdapter.java" } },
      // uma ENTITY (nó bare de classe, id sem método) p/ provar a preferência de rep
      { id: "ENTITY:Contract", type: "ENTITY", className: "Contract", metadata: { sourceFile: "src/main/java/easynup/persistence/entities/Contract.java" } },
    ],
    edges: [],
  };
}

const REAL_FQN = {
  deductionPort: "easynup.services.common.rules.adapters.DeductionAdapter",
  deductionImpl: "easynup.services.common.rules.adapters.impl.EasyNupDeductionAdapter",
  contract: "easynup.persistence.entities.Contract",
};

describe("fqnSuffixesFromSourceFile — reconstrução de FQN a partir do caminho", () => {
  it("gera todos os sufixos pontuados (do caminho inteiro à classe), sem extensão", () => {
    const suffixes = fqnSuffixesFromSourceFile("src/main/java/easynup/services/x/Foo.java");
    assert.ok(suffixes.includes("easynup.services.x.Foo"), "o FQN da config-edge está entre os sufixos");
    assert.equal(suffixes[0], "src.main.java.easynup.services.x.Foo"); // mais longo primeiro
    assert.equal(suffixes[suffixes.length - 1], "Foo");                 // classe sozinha por último
  });
  it("caminho já sem raiz (o cron pode POSTar relativo) casa exato", () => {
    const suffixes = fqnSuffixesFromSourceFile("easynup/services/x/Foo.java");
    assert.equal(suffixes[0], "easynup.services.x.Foo");
  });
  it("Windows (`\\`), sem extensão, vazio → nunca lança", () => {
    assert.ok(fqnSuffixesFromSourceFile("a\\b\\C.kt").includes("a.b.C"));
    assert.deepEqual(fqnSuffixesFromSourceFile(""), []);
    assert.deepEqual(fqnSuffixesFromSourceFile(undefined), []);
  });
});

describe("buildFqnNodeIndex — esquema REAL (id nome-simples + sourceFile pontuado)", () => {
  const idx = buildFqnNodeIndex(realJavaGraph().nodes);
  it("casa o FQN da config-edge com o nó, via sourceFile (a correção do bug)", () => {
    assert.equal(idx.get(REAL_FQN.deductionPort), "SERVICE:DeductionAdapter.calculate");
    // impl: 2 métodos no mesmo arquivo → 1 representante (não ambíguo)
    assert.ok(idx.get(REAL_FQN.deductionImpl)?.startsWith("SERVICE:EasyNupDeductionAdapter."));
  });
  it("nó de CLASSE (ENTITY, id sem método) é o representante preferido", () => {
    assert.equal(idx.get(REAL_FQN.contract), "ENTITY:Contract");
  });
});

describe("aggregateConfigEdges — esquema REAL vira CONFIG_PROVEN > 0", () => {
  it("interface→impl (FQN pontuado) casa e conta no censo — prova do fim do bug", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: REAL_FQN.deductionPort, to: REAL_FQN.deductionImpl, kind: "DI_RESOLVES", resolution: "config", reason: "spring-single-bean" },
    ];
    const { edges, stats } = aggregateConfigEdges(realJavaGraph().nodes, derived);
    assert.equal(edges.length, 1, "1 aresta agregada (era 0 antes da correção)");
    assert.equal(stats.orphanDropped, 0);

    const { graph } = mergeConfigEdges(realJavaGraph(), configPayload(derived));
    const shaped = shapeSystemGraph(graph, "class");
    assert.ok(shaped.coverage.edges.byMethod.CONFIG_PROVEN >= 1, "CONFIG_PROVEN > 0 no /graph");
  });

  it("port que NÃO é nó (lib/interface fora do escopo) → órfão honesto (§5)", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: "org.springframework.SomeLibPort", to: REAL_FQN.deductionImpl, resolution: "config" },
    ];
    const { edges, stats } = aggregateConfigEdges(realJavaGraph().nodes, derived);
    assert.equal(edges.length, 0);
    assert.equal(stats.orphanDropped, 1);
  });
});

describe("buildFqnNodeIndex — desambiguação por pacote (nome simples colidente)", () => {
  it("mesmo nome simples em pacotes distintos: cada FQN longo resolve ao seu nó; o nome curto é ambíguo→ausente", () => {
    // Nós com ids DISTINTOS (métodos diferentes) mas mesmo nome simples em pacotes
    // diferentes — o cenário real que só o FQN pontuado longo desambigua.
    const nodes: RawSystemNode[] = [
      { id: "SERVICE:Helper.run", type: "SERVICE", className: "Helper", methodName: "run", metadata: { sourceFile: "src/main/java/easynup/a/Helper.java" } },
      { id: "SERVICE:Helper.exec", type: "SERVICE", className: "Helper", methodName: "exec", metadata: { sourceFile: "src/main/java/easynup/b/Helper.java" } },
    ];
    const idx = buildFqnNodeIndex(nodes);
    // FQN longo (o que a config-edge usa) é único → resolve corretamente ao seu nó
    assert.equal(idx.get("easynup.a.Helper"), "SERVICE:Helper.run");
    assert.equal(idx.get("easynup.b.Helper"), "SERVICE:Helper.exec");
    // o nome curto colidiu entre 2 classes → removido (não mis-atribui)
    assert.equal(idx.get("Helper"), undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// REGRESSÃO do config-proven no PROJETO REAL (dados vivos do coordenador). As
// config-edges são PORT→ADAPTER (interface hexagonal → impl). O analisador NÃO
// emite nó para o PORT (interface referenciada só via DI) — só para o ADAPTER.
// Node id real = `<TYPE>:<FQN COMPLETO>` (o FQN JÁ está no id). Sem o nó do port,
// a aresta orfaniza e CONFIG_PROVEN=0. O fix MATERIALIZA um INTERFACE:<fqn> p/ o
// port in-scope, ancorando a aresta.
// ─────────────────────────────────────────────────────────────────────────

// Grafo como o REAL: id = <TYPE>:<FQN>; só o ADAPTER é nó (o PORT não existe).
function portAdapterGraph(): RawSystemGraph {
  return {
    nodes: [
      { id: "SERVICE:easynup.services.adapters.authz.RoutingDecisionAdapter", type: "SERVICE", className: "RoutingDecisionAdapter" },
      { id: "SERVICE:easynup.services.adapters.identity.NuPIdentityPermissionAdapter", type: "SERVICE", className: "NuPIdentityPermissionAdapter" },
      // um nó qualquer p/ firmar o pacote-raiz do projeto (easynup)
      { id: "ENTITY:easynup.persistence.entities.Contract", type: "ENTITY", className: "Contract" },
    ],
    edges: [],
  };
}
const PORT = {
  authz: "easynup.services.common.ports.AuthorizationDecisionPort",
  perm: "easynup.services.common.ports.PermissionPort",
};
const ADAPTER = {
  routing: "easynup.services.adapters.authz.RoutingDecisionAdapter",
  identity: "easynup.services.adapters.identity.NuPIdentityPermissionAdapter",
};

describe("config PORT→ADAPTER com PORT SEM NÓ → materializa INTERFACE + CONFIG_PROVEN", () => {
  it("materializa o nó do port in-scope e a aresta vira CONFIG_PROVEN (era 0)", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: PORT.authz, to: ADAPTER.routing, kind: "DI_RESOLVES", resolution: "config", reason: "spring-single-bean" },
      { from: PORT.perm, to: ADAPTER.identity, kind: "DI_RESOLVES", resolution: "config", reason: "spring-single-bean" },
    ];
    const { edges, interfaceNodes, stats } = aggregateConfigEdges(portAdapterGraph().nodes, derived);
    assert.equal(edges.length, 2, "2 arestas port→adapter (era 0 antes: port órfão)");
    assert.equal(stats.orphanDropped, 0);
    assert.equal(stats.interfacesMinted, 2, "2 ports materializados");
    assert.ok(interfaceNodes.some((n) => n.id === `INTERFACE:${PORT.authz}`));
    // a aresta liga o INTERFACE sintético ao SERVICE do adapter
    assert.ok(edges.some((e) => e.fromNode === `INTERFACE:${PORT.authz}` && e.toNode === `SERVICE:${ADAPTER.routing}`));

    const { graph, stats: mstats } = mergeConfigEdges(portAdapterGraph(), configPayload(derived));
    assert.equal(mstats.interfacesMinted, 2);
    assert.equal(mstats.added, 2);
    // o nó do port foi materializado no grafo
    assert.ok(graph.nodes.some((n) => n.id === `INTERFACE:${PORT.authz}` && (n.metadata as any)?.materializedByConfig === true));

    const shaped = shapeSystemGraph(graph, "class");
    assert.ok(shaped.coverage.edges.byMethod.CONFIG_PROVEN >= 2, "CONFIG_PROVEN > 0 no /graph");
    const edge = findEdge(shaped.edges, `INTERFACE:${PORT.authz}`, `SERVICE:${ADAPTER.routing}`, "DI_RESOLVES");
    assert.ok(edge, "aresta port→adapter presente no shaped");
    assert.equal(edge!.evidence.method, "CONFIG_PROVEN");
  });

  it("port de LIB EXTERNA (fora do pacote-raiz) → NÃO materializa, órfão honesto (§5)", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: "org.springframework.SomeLibPort", to: ADAPTER.routing, resolution: "config" },
    ];
    const { edges, interfaceNodes, stats } = aggregateConfigEdges(portAdapterGraph().nodes, derived);
    assert.equal(edges.length, 0);
    assert.equal(interfaceNodes.length, 0, "NUNCA inventa nó de tipo de fora do projeto");
    assert.equal(stats.orphanDropped, 1);
    assert.equal(stats.interfacesMinted, 0);
  });

  it("dedup: o MESMO port em 2 arestas materializa 1 nó só", () => {
    const derived: ConfigDerivedEdge[] = [
      { from: PORT.authz, to: ADAPTER.routing, resolution: "config" },
      { from: PORT.authz, to: ADAPTER.identity, resolution: "config" },
    ];
    const { edges, interfaceNodes } = aggregateConfigEdges(portAdapterGraph().nodes, derived);
    assert.equal(edges.length, 2);
    assert.equal(interfaceNodes.filter((n) => n.id === `INTERFACE:${PORT.authz}`).length, 1, "1 nó de port, reusado nas 2 arestas");
  });
});

describe("inferRootSegments — raízes de pacote do projeto (dos FQN dos nós)", () => {
  it("extrai o 1º segmento dos FQN Java, ignora ids route:/table:/node:", () => {
    const roots = inferRootSegments([
      { id: "SERVICE:easynup.services.X", type: "SERVICE" },
      { id: "ENTITY:easynup.persistence.Y", type: "ENTITY" },
      { id: "route:GET:/api/x", type: "ROUTE" },
      { id: "table:audit_log", type: "ENTITY" },
      { id: "node:src/foo.ts", type: "SERVICE" },
    ] as never);
    assert.ok(roots.has("easynup"));
    assert.ok(!roots.has("route"));
    assert.ok(!roots.has("table"));
    assert.ok(!roots.has("node"));
  });
});

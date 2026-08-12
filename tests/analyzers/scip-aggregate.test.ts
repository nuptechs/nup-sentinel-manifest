import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fileOfScipSymbol,
  functionOfScipSymbol,
  buildFileNodeIndex,
  aggregateScipEdges,
  mergeScipEdges,
  type ScipDerivedEdge,
} from "../../server/analyzers/scip-aggregate";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// Símbolos reais (formato scip-typescript, verificado no index.scip do NuPIdentify).
const SYM = {
  // duas funções do MESMO arquivo (o caso "intra-nó" que a granularidade de
  // FUNÇÃO recupera — antes ambas caíam em `node:<file>` e a aresta era descartada).
  tenantMiddleware: "scip-typescript npm nupidentity 1.0.0 server/middleware/`tenant.ts`/tenantMiddleware().",
  tenantLoadClaims: "scip-typescript npm nupidentity 1.0.0 server/middleware/`tenant.ts`/loadClaims().",
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

describe("functionOfScipSymbol (A5) — arquivo + função PAREN-FREE", () => {
  it("extrai {file, fn} de função e método (sufixo de chamada `().` removido)", () => {
    assert.deepEqual(functionOfScipSymbol(SYM.tenantMiddleware), { file: "server/middleware/tenant.ts", fn: "tenantMiddleware" });
    assert.deepEqual(functionOfScipSymbol(SYM.tenantService), { file: "server/services/tenant.service.ts", fn: "TenantService#resolve" });
    assert.deepEqual(functionOfScipSymbol(SYM.utilCn), { file: "client/src/lib/utils.ts", fn: "cn" });
  });
  it("o `fn` NUNCA contém `(` — invariante do id de sub-nó (classKeyOf atômico)", () => {
    for (const s of [SYM.tenantMiddleware, SYM.tenantService, SYM.utilCn, SYM.jwtVerify]) {
      const r = functionOfScipSymbol(s)!;
      assert.ok(!r.fn.includes("("), `fn "${r.fn}" contém (`);
    }
  });
  it("retorna null para símbolos sem arquivo", () => {
    assert.equal(functionOfScipSymbol(SYM.localScip), null);
    assert.equal(functionOfScipSymbol(""), null);
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
    // aresta heurística pré-existente (node-chain do full-stack-augment) entre módulos.
    edges: [
      { fromNode: "node:server/middleware/tenant.ts", toNode: "node:server/services/tenant.service.ts", relationType: "CALLS", metadata: { synthetic: true, resolution: "syntactic-declared", convention: "node-chain" } },
    ],
  };
}

// ids de sub-nó de função esperados (paren-free)
const FN = {
  tenantMiddleware: "node:server/middleware/tenant.ts::tenantMiddleware",
  tenantLoadClaims: "node:server/middleware/tenant.ts::loadClaims",
  tenantResolve: "node:server/services/tenant.service.ts::TenantService#resolve",
  jwtVerify: "node:server/auth/jwt.ts::verifyToken",
};

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

describe("aggregateScipEdges (A5) — símbolo→FUNÇÃO→aresta-de-sistema", () => {
  const nodes = fixtureGraph().nodes;
  it("chamada cross-módulo handler→service vira aresta função→função compiler", () => {
    const derived: ScipDerivedEdge[] = [{ from: SYM.tenantMiddleware, to: SYM.tenantService, kind: "CALLS", resolution: "compiler" }];
    const { edges, functionNodes } = aggregateScipEdges(nodes, derived);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], { fromNode: FN.tenantMiddleware, toNode: FN.tenantResolve, relationType: "CALLS", resolution: "compiler" });
    // sub-nós de função materializados, sob o módulo correto, com o arquivo
    const ids = functionNodes.map((n) => n.id).sort();
    assert.deepEqual(ids, [FN.tenantResolve, FN.tenantMiddleware].sort());
    const mw = functionNodes.find((n) => n.id === FN.tenantMiddleware)!;
    assert.equal(mw.parentModule, "node:server/middleware/tenant.ts");
    assert.equal(mw.sourceFile, "server/middleware/tenant.ts");
    assert.equal(mw.type, "SERVICE");
  });

  it("A5 — DUAS funções do MESMO arquivo viram aresta provada (recupera o 'intra-nó')", () => {
    // No motor por-arquivo isto era descartado como intra-nó (ambas em `node:tenant.ts`).
    const derived: ScipDerivedEdge[] = [{ from: SYM.tenantMiddleware, to: SYM.tenantLoadClaims, resolution: "compiler" }];
    const { edges, stats } = aggregateScipEdges(nodes, derived);
    assert.equal(stats.intraDropped, 0);
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], { fromNode: FN.tenantMiddleware, toNode: FN.tenantLoadClaims, relationType: "CALLS", resolution: "compiler" });
  });

  it("Leitura-Máxima: arquivo órfão LOCAL vira nó de MÓDULO e a prova é CAPTURADA (default ON)", () => {
    // client/src/lib/utils.ts não é nó arquitetural — antes a prova era descartada.
    const derived: ScipDerivedEdge[] = [{ from: SYM.utilCn, to: SYM.tenantService, resolution: "compiler" }];
    const { edges, moduleNodes, stats } = aggregateScipEdges(nodes, derived);
    assert.equal(stats.orphanDropped, 0, "não descarta mais");
    assert.equal(stats.moduleNodesAdded, 1);
    assert.deepEqual(moduleNodes[0], { id: "node:client/src/lib/utils.ts", sourceFile: "client/src/lib/utils.ts", label: "utils.ts", runtime: "node" });
    // granularidade de ARQUIVO no órfão: o endpoint é o MÓDULO, não `::fn`
    assert.equal(edges.length, 1);
    assert.equal(edges[0].fromNode, "node:client/src/lib/utils.ts");
    assert.equal(edges[0].toNode, FN.tenantResolve);
  });

  it("com materializeOrphanModules:false → comportamento antigo (órfão descartado, byte-a-byte)", () => {
    const derived: ScipDerivedEdge[] = [{ from: SYM.utilCn, to: SYM.tenantService, resolution: "compiler" }];
    const { edges, stats } = aggregateScipEdges(nodes, derived, { materializeOrphanModules: false });
    assert.equal(edges.length, 0);
    assert.equal(stats.orphanDropped, 1);
    assert.equal(stats.moduleNodesAdded, 0);
  });

  it("NUNCA materializa dependência externa (.d.ts / node_modules) — anti-ruído", () => {
    // ambos externos: lib.dom.d.ts (.d.ts) — filtrado, aresta descartada
    const dts: ScipDerivedEdge[] = [{ from: SYM.utilCn, to: SYM.external, resolution: "compiler" }];
    const { moduleNodes, stats } = aggregateScipEdges(nodes, dts);
    assert.ok(!moduleNodes.some((m) => /\.d\.ts$/.test(m.sourceFile)), "nenhum .d.ts materializado");
    assert.equal(stats.orphanDropped, 1); // o endpoint externo dropou a aresta
  });

  it("auto-chamada (MESMA função nas duas pontas) → descartada", () => {
    const derived: ScipDerivedEdge[] = [{ from: SYM.tenantMiddleware, to: SYM.tenantMiddleware, resolution: "compiler" }];
    const { edges, stats } = aggregateScipEdges(nodes, derived);
    assert.equal(edges.length, 0);
    assert.equal(stats.intraDropped, 1);
  });

  it("compiler prevalece sobre interface-impl para o MESMO par de funções", () => {
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

describe("Leitura-Máxima — granularidade de ARQUIVO consistente no módulo materializado", () => {
  const nodes = fixtureGraph().nodes;
  // segunda função do MESMO arquivo órfão + um segundo arquivo órfão como ALVO
  const utilTwMerge = "scip-typescript npm nupidentity 1.0.0 client/src/lib/`utils.ts`/twMerge().";
  const fmtOrphan = "scip-typescript npm nupidentity 1.0.0 client/src/lib/`format.ts`/fmt().";
  const multiTouch: ScipDerivedEdge[] = [
    { from: SYM.utilCn, to: SYM.tenantService, resolution: "compiler" }, // 1ª aresta materializa utils.ts
    { from: utilTwMerge, to: SYM.tenantService, resolution: "compiler" }, // 2ª aresta do MESMO arquivo órfão
    { from: SYM.tenantMiddleware, to: fmtOrphan, resolution: "compiler" }, // órfão como alvo (1ª)
    { from: SYM.jwtVerify, to: fmtOrphan, resolution: "compiler" }, // órfão como alvo (2ª)
  ];

  it("aresta SEGUINTE a tocar o arquivo órfão também resolve no nó de ARQUIVO — nunca `::fn` sob MODULE", () => {
    // Regressão: a 1ª aresta registrava o módulo no fileIndex e as seguintes caíam
    // no caminho arquitetural, fragmentando o MESMO endpoint em `node:<f>` E
    // `node:<f>::<fn>` (ordem-dependente, parentModule pendurado em nó não-emitido).
    const { edges, functionNodes, moduleNodes } = aggregateScipEdges(nodes, multiTouch);
    for (const e of edges) {
      assert.ok(!e.fromNode.includes("client/src/lib/utils.ts::"), `endpoint fn sob módulo materializado: ${e.fromNode}`);
      assert.ok(!e.toNode.includes("client/src/lib/format.ts::"), `endpoint fn sob módulo materializado: ${e.toNode}`);
    }
    // as DUAS funções de utils.ts colapsam no mesmo endpoint de arquivo → dedup em 1 aresta
    assert.equal(edges.filter((e) => e.fromNode === "node:client/src/lib/utils.ts").length, 1);
    // format.ts como alvo de 2 chamadores distintos → 2 arestas, ambas no nó de arquivo
    assert.equal(edges.filter((e) => e.toNode === "node:client/src/lib/format.ts").length, 2);
    // nenhum sub-nó de função pendura em módulo materializado (o pai sempre existe no grafo)
    const matIds = new Set(moduleNodes.map((m) => m.id));
    for (const f of functionNodes) assert.ok(!matIds.has(f.parentModule), `parentModule materializado: ${f.id}`);
  });

  it("resultado IDÊNTICO com as arestas em ordem inversa (ordem-independência)", () => {
    const a = aggregateScipEdges(nodes, multiTouch);
    const b = aggregateScipEdges(nodes, multiTouch.slice().reverse());
    const key = (e: { fromNode: string; toNode: string; resolution: string }) => `${e.fromNode}→${e.toNode}:${e.resolution}`;
    assert.deepEqual(a.edges.map(key).sort(), b.edges.map(key).sort());
  });

  it("fn→fn DENTRO do mesmo arquivo órfão → intra (granularidade de arquivo), sem aresta torta", () => {
    const derived: ScipDerivedEdge[] = [
      { from: SYM.utilCn, to: SYM.tenantService, resolution: "compiler" }, // materializa utils.ts
      { from: SYM.utilCn, to: utilTwMerge, resolution: "compiler" }, // chamada intra-arquivo órfão
    ];
    const { edges, stats } = aggregateScipEdges(nodes, derived);
    assert.equal(stats.intraDropped, 1);
    assert.equal(edges.length, 1); // só utils.ts → TenantService#resolve
    assert.ok(!edges.some((e) => e.toNode.startsWith("node:client/src/lib/utils.ts")));
  });
});

describe("fim-a-fim (fixture express-drizzle): a prova do compilador não é jogada fora", () => {
  // Deriva as arestas do índice SCIP REAL do fixture (o mesmo caminho do CI) e
  // agrega SEM nós arquiteturais — o pior caso: o extrator não modelou nada.
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const DERIVER = path.resolve(HERE, "../../tools/scip-typescript/derive-edges.mjs");
  const FIXTURE = path.resolve(HERE, "../fixtures/scip/express-drizzle-index.json");
  const out = JSON.parse(execFileSync("node", [DERIVER, "--json", FIXTURE], { encoding: "utf8" })) as {
    edges: ScipDerivedEdge[];
    dataAccess?: unknown[];
  };

  it("ANTES (materialização OFF — regra antiga): 9 arestas provadas, 0 retidas", () => {
    const r = aggregateScipEdges([], out.edges, { materializeOrphanModules: false });
    assert.equal(out.edges.length, 9);
    assert.equal(r.edges.length, 0);
    assert.equal(r.stats.orphanDropped, 9);
  });

  it("DEPOIS (Leitura-Máxima ON): routes→handlers capturada em nível de arquivo; só o externo fica fora", () => {
    const r = aggregateScipEdges([], out.edges);
    assert.deepEqual(r.edges, [
      { fromNode: "node:src/routes.ts", toNode: "node:src/handlers.ts", relationType: "CALLS", resolution: "compiler" },
    ]);
    assert.equal(r.stats.moduleNodesAdded, 2);
    // as 6 chamadas para os `.d.ts` do drizzle-orm são dependência EXTERNA (anti-ruído):
    // ficam fora do call-graph, mas o eixo DB dessa prova sobrevive no `dataAccess`.
    assert.equal(r.stats.orphanDropped, 6);
    assert.equal((out.dataAccess ?? []).length, 3);
  });
});

describe("mergeScipEdges (A5) — materializa sub-nós de função + arestas, sem mutar a entrada", () => {
  it("ADICIONA a aresta função→função e MATERIALIZA os sub-nós de função", () => {
    const raw = fixtureGraph();
    const before = JSON.stringify(raw);
    const payload = { edges: [{ from: SYM.tenantMiddleware, to: SYM.tenantService, resolution: "compiler" as const }] };
    const { graph, stats } = mergeScipEdges(raw, payload);
    assert.equal(stats.added, 1);
    assert.equal(stats.functionNodesAdded, 2);
    // a aresta função→função existe com resolution compiler
    const e = graph.edges.find((x) => x.fromNode === FN.tenantMiddleware && x.toNode === FN.tenantResolve);
    assert.ok(e);
    assert.equal((e!.metadata as any).resolution, "compiler");
    assert.equal((e!.metadata as any).scipProven, true);
    // os sub-nós de função existem, com proveniência de arquivo
    const mw = graph.nodes.find((n) => n.id === FN.tenantMiddleware)!;
    assert.ok(mw);
    assert.equal((mw.metadata as any).sourceFile, "server/middleware/tenant.ts");
    assert.equal((mw.metadata as any).parentModule, "node:server/middleware/tenant.ts");
    assert.equal((mw.metadata as any).scipProven, true);
    // a aresta HEURÍSTICA módulo→módulo permanece intocada (não é o par provado)
    const chain = graph.edges.find((x) => x.fromNode === "node:server/middleware/tenant.ts" && x.toNode === "node:server/services/tenant.service.ts");
    assert.equal((chain!.metadata as any).synthetic, true);
    assert.equal((chain!.metadata as any).resolution, "syntactic-declared");
    // entrada intocada (clone defensivo)
    assert.equal(JSON.stringify(raw), before);
  });

  it("payload nulo/vazio → grafo byte-a-byte (mesma referência)", () => {
    const raw = fixtureGraph();
    assert.equal(mergeScipEdges(raw, null).graph, raw);
    assert.equal(mergeScipEdges(raw, { edges: [] }).graph, raw);
  });

  it("aresta só de órfãos → nenhuma agregação → grafo byte-a-byte (mesma referência)", () => {
    const raw = fixtureGraph();
    const payload = { edges: [{ from: SYM.utilCn, to: SYM.external, resolution: "compiler" as const }] };
    const { graph, stats } = mergeScipEdges(raw, payload);
    assert.equal(stats.aggregated, 0);
    assert.equal(graph, raw);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 F1 — scip-JAVA: identidade canônica AGNÓSTICA à linguagem.
// O símbolo scip-java carrega pacote/CLASSE (não o arquivo em crases do TS); o
// deriver fornece o arquivo-fonte por ponta (`fromFile`/`toFile`) e a agregação
// o usa direto. Sem esses campos, o símbolo Java é órfão (sem crase → sem file).
// ─────────────────────────────────────────────────────────────────────────
const JSYM = {
  createContract: "scip-java maven easynup 0.0.0 easynup/services/web/contract/CreateContractServiceV1#execute(+1).",
  createContractValidate: "scip-java maven easynup 0.0.0 easynup/services/web/contract/CreateContractServiceV1#validate().",
  contractRepoSave: "scip-java maven easynup 0.0.0 easynup/persistence/ContractRepository#save(+1).",
  externalJava: "scip-java maven org.springframework 6.0.0 org/springframework/data/Repository#save().",
};
const JFILE = {
  createSvc: "src/main/java/easynup/services/web/contract/CreateContractServiceV1.java",
  repo: "src/main/java/easynup/persistence/ContractRepository.java",
};

describe("scip-JAVA (F1) — símbolo→função com arquivo fornecido pelo deriver", () => {
  it("descriptorsOf agnóstico: scip-java aceito, `local`/lixo rejeitado", () => {
    // parse-de-crases (sem file) → Java NÃO tem arquivo no símbolo → null (órfão honesto)
    assert.equal(fileOfScipSymbol(JSYM.createContract), null);
    assert.equal(functionOfScipSymbol(JSYM.createContract), null);
  });
  it("com `file` fornecido, extrai {file, fn} — fn = Classe#metodo PAREN-FREE", () => {
    const r = functionOfScipSymbol(JSYM.createContract, JFILE.createSvc)!;
    assert.deepEqual(r, { file: JFILE.createSvc, fn: "CreateContractServiceV1#execute" });
    assert.ok(!r.fn.includes("("), "fn Java não pode conter (");
    // método com disambiguator VAZIO (herança de assinatura) também vira paren-free
    assert.equal(functionOfScipSymbol(JSYM.createContractValidate, JFILE.createSvc)!.fn, "CreateContractServiceV1#validate");
    assert.equal(functionOfScipSymbol(JSYM.contractRepoSave, JFILE.repo)!.fn, "ContractRepository#save");
  });
});

// Grafo Java: DOIS sabores de nó file-backed — um nó-MÓDULO `node:<file>.java` E
// um nó `route:` com `metadata.sourceFile` apontando pro `.java` — para provar que
// a generalização pendura sub-nó de função em AMBOS (route:/node:), não só `node:`.
function javaFixtureGraph(): RawSystemGraph {
  return {
    nodes: [
      // controller mapeado como ROTA (sem nó-módulo `node:` para este arquivo)
      { id: "route:POST:/easynup/createContract.v1", type: "ROUTE", className: "CreateContractServiceV1", metadata: { sourceFile: JFILE.createSvc, httpMethod: "POST", runtime: "java", synthetic: true } },
      // repositório mapeado como nó-MÓDULO
      { id: `node:${JFILE.repo}`, type: "REPOSITORY", className: "ContractRepository", metadata: { sourceFile: JFILE.repo, runtime: "java", synthetic: true } },
    ],
    edges: [],
  };
}
const JFN = {
  createExecute: "route:POST:/easynup/createContract.v1::CreateContractServiceV1#execute",
  createValidate: "route:POST:/easynup/createContract.v1::CreateContractServiceV1#validate",
  repoSave: `node:${JFILE.repo}::ContractRepository#save`,
};

describe("aggregateScipEdges (F1) — arestas scip-JAVA agregam a STATIC_PROVEN", () => {
  it("chamada controller(route:)→repo(node:) vira aresta função→função compiler", () => {
    const nodes = javaFixtureGraph().nodes;
    const derived: ScipDerivedEdge[] = [
      { from: JSYM.createContract, to: JSYM.contractRepoSave, resolution: "compiler", fromFile: JFILE.createSvc, toFile: JFILE.repo },
    ];
    const { edges, functionNodes, stats } = aggregateScipEdges(nodes, derived);
    assert.equal(stats.aggregated, 1);
    assert.deepEqual(edges[0], { fromNode: JFN.createExecute, toNode: JFN.repoSave, relationType: "CALLS", resolution: "compiler" });
    // sub-nó pendura no nó ROTA (não-`node:`) — a generalização em ação
    const ctrl = functionNodes.find((n) => n.id === JFN.createExecute)!;
    assert.equal(ctrl.parentModule, "route:POST:/easynup/createContract.v1");
    assert.equal(ctrl.sourceFile, JFILE.createSvc);
    assert.equal(ctrl.type, "ROUTE"); // tipo herdado do pai
    assert.equal(ctrl.runtime, "java"); // runtime herdado do pai
    const repo = functionNodes.find((n) => n.id === JFN.repoSave)!;
    assert.equal(repo.type, "REPOSITORY");
    // o `fn` no id é paren-free (classKeyOf atômico)
    assert.ok(!ctrl.id.includes("(") && !repo.id.includes("("));
  });

  it("sub-nó de função pendura em nó `route:` (não só `node:`)", () => {
    const nodes = javaFixtureGraph().nodes;
    const derived: ScipDerivedEdge[] = [
      { from: JSYM.createContract, to: JSYM.contractRepoSave, resolution: "compiler", fromFile: JFILE.createSvc, toFile: JFILE.repo },
    ];
    const { functionNodes } = aggregateScipEdges(nodes, derived);
    assert.ok(functionNodes.some((n) => n.id.startsWith("route:") && n.id.includes("::")));
  });

  it("órfão: símbolo Java cujo `toFile` não casa nenhum nó → descartado com materialização OFF", () => {
    // Com ON (default) um arquivo .java LOCAL seria materializado; o filtro de projeto
    // não distingue dep Java externa (o deriver já resolve só locais). Aqui provamos o
    // caminho OFF: sem materialização, o órfão é descartado (byte-a-byte antigo).
    const nodes = javaFixtureGraph().nodes;
    const derived: ScipDerivedEdge[] = [
      { from: JSYM.createContract, to: JSYM.externalJava, resolution: "compiler", fromFile: JFILE.createSvc, toFile: "org/springframework/data/Repository.java" },
    ];
    const { edges, stats } = aggregateScipEdges(nodes, derived, { materializeOrphanModules: false });
    assert.equal(edges.length, 0);
    assert.equal(stats.orphanDropped, 1);
  });

  it("intra: auto-chamada Java (mesmo arquivo+método) descartada; duas funções do mesmo arquivo contam", () => {
    const nodes = javaFixtureGraph().nodes;
    // auto-chamada: mesmo símbolo/arquivo → mesmo endpoint → intra
    const selfCall: ScipDerivedEdge[] = [
      { from: JSYM.createContract, to: JSYM.createContract, resolution: "compiler", fromFile: JFILE.createSvc, toFile: JFILE.createSvc },
    ];
    assert.equal(aggregateScipEdges(nodes, selfCall).stats.intraDropped, 1);
    // duas funções DISTINTAS do mesmo arquivo → aresta função→função legítima
    const twoFns: ScipDerivedEdge[] = [
      { from: JSYM.createContract, to: JSYM.createContractValidate, resolution: "compiler", fromFile: JFILE.createSvc, toFile: JFILE.createSvc },
    ];
    const { edges, stats } = aggregateScipEdges(nodes, twoFns);
    assert.equal(stats.intraDropped, 0);
    assert.deepEqual(edges[0], { fromNode: JFN.createExecute, toNode: JFN.createValidate, relationType: "CALLS", resolution: "compiler" });
  });

  it("interface-impl Java NÃO é colapsado; dedup compiler>interface-impl no mesmo par", () => {
    const nodes = javaFixtureGraph().nodes;
    const impls: ScipDerivedEdge[] = [
      { from: JSYM.createContract, to: JSYM.contractRepoSave, resolution: "interface-impl", fromFile: JFILE.createSvc, toFile: JFILE.repo },
    ];
    assert.equal(aggregateScipEdges(nodes, impls).edges[0].resolution, "interface-impl");
    const both: ScipDerivedEdge[] = [
      { from: JSYM.createContract, to: JSYM.contractRepoSave, resolution: "interface-impl", fromFile: JFILE.createSvc, toFile: JFILE.repo },
      { from: JSYM.createContract, to: JSYM.contractRepoSave, resolution: "compiler", fromFile: JFILE.createSvc, toFile: JFILE.repo },
    ];
    const { edges } = aggregateScipEdges(nodes, both);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].resolution, "compiler");
  });
});

describe("mergeScipEdges + shapeSystemGraph (F1) — arestas Java viram STATIC_PROVEN", () => {
  it("Java function→function agrega e é classificada STATIC_PROVEN (systemEdgesProven>0)", () => {
    const raw = javaFixtureGraph();
    const before = shapeSystemGraph(raw, "class");
    assert.equal(before.coverage.edges.byMethod.STATIC_PROVEN, 0);

    const payload = {
      edges: [
        { from: JSYM.createContract, to: JSYM.contractRepoSave, resolution: "compiler" as const, fromFile: JFILE.createSvc, toFile: JFILE.repo },
        { from: JSYM.createContract, to: JSYM.createContractValidate, resolution: "compiler" as const, fromFile: JFILE.createSvc, toFile: JFILE.createSvc },
      ],
    };
    const { graph, stats } = mergeScipEdges(raw, payload);
    assert.equal(stats.aggregated, 2);
    assert.ok(stats.functionNodesAdded >= 3); // execute, validate, save
    // o sub-nó Java carrega runtime herdado `java` (facet de stack preservado)
    const execNode = graph.nodes.find((n) => n.id === JFN.createExecute)!;
    assert.equal((execNode.metadata as any).runtime, "java");
    assert.equal((execNode.metadata as any).scipProven, true);

    const after = shapeSystemGraph(graph, "class");
    assert.equal(after.coverage.edges.byMethod.STATIC_PROVEN, 2);
    assert.ok(after.edges.filter((e) => e.evidence.method === "STATIC_PROVEN").length === 2);
  });
});

describe("orçamento de arestas (bounded anti-monólito) — prioriza arquitetural, reporta o excedente", () => {
  const nodes = fixtureGraph().nodes;
  // gera N arestas órfão→órfão (arquivos locais distintos, todos materializáveis)
  function orphanEdges(n: number): ScipDerivedEdge[] {
    const out: ScipDerivedEdge[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        from: `scip-typescript npm p 1 \`src/u${i}.ts\`/f().`,
        to: `scip-typescript npm p 1 \`src/v${i}.ts\`/g().`,
        resolution: "compiler",
      });
    }
    return out;
  }
  it("acima do orçamento: mantém até o teto e CONTA o excedente (nunca silêncio)", () => {
    const { edges, stats } = aggregateScipEdges(nodes, orphanEdges(50), { edgeBudget: 20 });
    assert.equal(edges.length, 20, "grafo bounded ao orçamento");
    assert.equal(stats.cappedEdges, 30, "excedente reportado");
  });
  it("PRIORIDADE: aresta que toca nó ARQUITETURAL sobrevive ao orçamento antes de órfão↔órfão", () => {
    const archEdge: ScipDerivedEdge = { from: SYM.tenantMiddleware, to: SYM.tenantService, resolution: "compiler" };
    // 1 arquitetural + 10 órfão↔órfão, orçamento 1 → mantém a arquitetural, corta as 10
    const { edges, stats } = aggregateScipEdges(nodes, [archEdge, ...orphanEdges(10)], { edgeBudget: 1 });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].fromNode, FN.tenantMiddleware, "a arquitetural foi a mantida");
    assert.equal(stats.cappedEdges, 10);
  });
});

// ── O 1º teste do DoD (ADR-0031 §6 A3/A5): o STATIC_PROVEN sobe, e a
// granularidade de FUNÇÃO faz o par intra-arquivo contar (antes descartado). ──
describe("fim-a-fim: função→função sobe o STATIC_PROVEN do censo — inclusive intra-arquivo", () => {
  it("merge + shapeSystemGraph classifica as arestas de função como STATIC_PROVEN", () => {
    const raw = fixtureGraph();

    // ANTES: nenhuma aresta provada.
    const before = shapeSystemGraph(raw, "class");
    assert.equal(before.coverage.edges.byMethod.STATIC_PROVEN, 0);

    const payload = {
      edges: [
        // cross-módulo
        { from: SYM.tenantMiddleware, to: SYM.tenantService, resolution: "compiler" as const },
        { from: SYM.tenantMiddleware, to: SYM.jwtVerify, resolution: "compiler" as const },
        // MESMO arquivo (o ganho central de A5 — antes intra-nó descartado)
        { from: SYM.tenantMiddleware, to: SYM.tenantLoadClaims, resolution: "compiler" as const },
      ],
    };
    const { graph } = mergeScipEdges(raw, payload);
    const after = shapeSystemGraph(graph, "class");

    // 3 arestas função→função distintas, TODAS contadas (incl. a intra-arquivo)
    assert.equal(after.coverage.edges.byMethod.STATIC_PROVEN, 3);
    const proven = after.edges.filter((e) => e.evidence.method === "STATIC_PROVEN");
    assert.equal(proven.length, 3);
    assert.ok(proven.every((e) => e.resolution === "compiler"));
    // a aresta intra-arquivo (duas funções de tenant.ts) está entre as provadas
    const intraFile = after.edges.find((e) => e.fromNode === FN.tenantMiddleware && e.toNode === FN.tenantLoadClaims);
    assert.ok(intraFile, "esperado a aresta função→função intra-arquivo");
    assert.equal(intraFile!.evidence.method, "STATIC_PROVEN");
    // os sub-nós de função aparecem no grafo shaped (nós atômicos no class-level)
    assert.ok(after.nodes.some((n) => n.id === FN.tenantMiddleware));
    assert.ok(after.nodes.some((n) => n.id === FN.tenantResolve));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeDataAccessEdges } from "../../server/analyzers/data-access-aggregate";
import { shapeSystemGraph } from "../../server/analyzers/system-graph";

// ── Opção A: liga o dataAccess (compiler-proven) ao grafo ──
// O deriver prova função→tabela READ/WRITE. Este teste verifica que a agregação
// vira aresta READS/WRITES_ENTITY com resolution:compiler → STATIC_PROVEN no
// grafo servido (o caminho que estava DESLIGADO: o ingest descartava o campo).

// símbolos SCIP realistas (scip-typescript): componente de arquivo em crases.
const fnSym = "scip-typescript npm . . `server/services/contract.service.ts`/ContractService#create().";
const tableSym = "scip-typescript npm . . `shared/schema/contract.ts`/contract.";

function graphWithModule() {
  return {
    nodes: [
      // nó de MÓDULO do arquivo-fonte (o buildFileNodeIndex casa por sourceFile)
      { id: "node:server/services/contract.service.ts", type: "MODULE", className: "contract.service", metadata: { sourceFile: "server/services/contract.service.ts" } },
    ],
    edges: [] as Array<{ fromNode: string; toNode: string; relationType: string; metadata?: Record<string, unknown> }>,
  };
}

describe("Opção A — mergeDataAccessEdges", () => {
  it("emite WRITES_ENTITY compiler-proven do módulo p/ a tabela (mintando a entidade)", () => {
    const g = graphWithModule();
    const { graph, stats } = mergeDataAccessEdges(g, [
      { from: fnSym, to: tableSym, access: "write", fromFile: "server/services/contract.service.ts", toFile: "shared/schema/contract.ts" },
    ]);
    assert.equal(stats.received, 1);
    assert.equal(stats.edgesAdded, 1);
    assert.equal(stats.tableNodesMinted, 1);
    // nó de tabela sintético criado
    assert.ok(graph.nodes.some((n) => n.id === "table:contract"));
    // aresta WRITES do módulo → tabela, resolution compiler
    const e = graph.edges.find((x) => x.relationType === "WRITES_ENTITY");
    assert.ok(e, "aresta WRITES_ENTITY existe");
    assert.equal(e!.fromNode, "node:server/services/contract.service.ts");
    assert.equal(e!.toNode, "table:contract");
    assert.equal((e!.metadata as any).resolution, "compiler");
  });

  it("READ vira READS_ENTITY; casa ENTITY EXISTENTE em vez de mintar", () => {
    const g = graphWithModule();
    g.nodes.push({ id: "entity:Contract", type: "ENTITY", className: "Contract", metadata: {} } as never);
    const { graph, stats } = mergeDataAccessEdges(g, [
      { from: fnSym, to: tableSym, access: "read", fromFile: "server/services/contract.service.ts", toFile: "shared/schema/contract.ts" },
    ]);
    assert.equal(stats.tableNodesMinted, 0); // casou a entidade existente (Contract→contract)
    const e = graph.edges.find((x) => x.relationType === "READS_ENTITY");
    assert.equal(e!.toNode, "entity:Contract");
  });

  it("STATIC_PROVEN no grafo SERVIDO: a aresta data-access vira evidence.method STATIC_PROVEN", () => {
    const g = graphWithModule();
    const { graph } = mergeDataAccessEdges(g, [
      { from: fnSym, to: tableSym, access: "write", fromFile: "server/services/contract.service.ts", toFile: "shared/schema/contract.ts" },
    ]);
    const shaped = shapeSystemGraph(graph as never);
    const daEdge = shaped.edges.find((e: any) => e.relationType === "WRITES_ENTITY" && e.toLabel?.includes("contract") || e.to === "table:contract" || e.toNode === "table:contract");
    // o censo deve contar a aresta como provada
    const bm = shaped.coverage?.edges?.byMethod || {};
    assert.ok((bm.STATIC_PROVEN || 0) >= 1, `STATIC_PROVEN>=1, veio ${JSON.stringify(bm)}`);
  });

  it("fromFile sem nó no grafo → NÃO atribui (honesto, contado)", () => {
    const g = graphWithModule();
    const { stats } = mergeDataAccessEdges(g, [
      { from: fnSym, to: tableSym, access: "read", fromFile: "server/OUTRO/arquivo.ts", toFile: "shared/schema/contract.ts" },
    ]);
    assert.equal(stats.edgesAdded, 0);
    assert.equal(stats.fromUnresolved, 1);
  });

  it("payload vazio/ausente → no-op byte-a-byte", () => {
    const g = graphWithModule();
    const r1 = mergeDataAccessEdges(g, []);
    assert.equal(r1.stats.edgesAdded, 0);
    assert.equal(r1.graph.edges.length, 0);
    const r2 = mergeDataAccessEdges(g, null);
    assert.equal(r2.graph.nodes.length, g.nodes.length);
  });

  it("dedup: mesma tripla função-arquivo→tabela não duplica aresta", () => {
    const g = graphWithModule();
    const { stats } = mergeDataAccessEdges(g, [
      { from: fnSym, to: tableSym, access: "write", fromFile: "server/services/contract.service.ts", toFile: "shared/schema/contract.ts" },
      { from: fnSym, to: tableSym, access: "write", fromFile: "server/services/contract.service.ts", toFile: "shared/schema/contract.ts" },
    ]);
    assert.equal(stats.edgesAdded, 1);
  });
});

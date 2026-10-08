import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_NODE_TYPE,
  FIELD_REL,
  fieldNodeId,
  parseFieldNodeId,
  isFieldNodeId,
  makeFieldNode,
  hasFieldEdge,
  mapsToColumnEdge,
  mergeFieldGraph,
} from "../../server/analyzers/field-graph";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// OBS-D05 — modelo de granularidade de CAMPO. Scaffold INERTE: nenhum produtor
// emite FIELD ainda; estes testes travam o CONTRATO (id reversível, nó/arestas
// puros, e convivência byte-a-byte com o shape existente).

describe("field-graph — id determinístico e reversível", () => {
  it("round-trip owner#name#kind sobrevive ao parse", () => {
    const id = fieldNodeId("VIEW:ClientForm", "razaoSocial", "view");
    assert.equal(id, "field:view:VIEW%3AClientForm#razaoSocial");
    const p = parseFieldNodeId(id);
    assert.deepEqual(p, { kind: "view", owner: "VIEW:ClientForm", name: "razaoSocial" });
  });

  it("escapa # e : no owner e no name (reversível sem ambiguidade)", () => {
    const id = fieldNodeId("table:a#b:c", "co#lu:mn", "column");
    const p = parseFieldNodeId(id);
    assert.deepEqual(p, { kind: "column", owner: "table:a#b:c", name: "co#lu:mn" });
  });

  it("determinístico: mesma entrada, mesmo id", () => {
    assert.equal(fieldNodeId("entity:Contract", "cnpj", "column"), fieldNodeId("entity:Contract", "cnpj", "column"));
  });

  it("parse recusa id que não é de campo", () => {
    assert.equal(parseFieldNodeId("VIEW:ClientForm"), null);
    assert.equal(parseFieldNodeId("field:bogus:X#y"), null); // kind inválido
    assert.equal(parseFieldNodeId("field:view:#y"), null); // owner vazio
    assert.equal(parseFieldNodeId("field:view:X#"), null); // name vazio
    assert.equal(isFieldNodeId("table:contract"), false);
    assert.equal(isFieldNodeId(makeFieldNode({ owner: "o", name: "n", kind: "dto" }).id), true);
  });
});

describe("field-graph — construtores puros de nó e arestas", () => {
  it("makeFieldNode carrega kind/owner no metadata e nome no className", () => {
    const n = makeFieldNode({ owner: "VIEW:Form", name: "cnpj", kind: "view", sourceFile: "client/src/Form.tsx" });
    assert.equal(n.type, FIELD_NODE_TYPE);
    assert.equal(n.className, "cnpj");
    assert.equal((n.metadata as any).fieldKind, "view");
    assert.equal((n.metadata as any).fieldOwner, "VIEW:Form");
    assert.equal((n.metadata as any).sourceFile, "client/src/Form.tsx");
  });

  it("hasFieldEdge liga owner→campo; mapsToColumnEdge liga campo→coluna", () => {
    const spec = { owner: "VIEW:Form", name: "cnpj", kind: "view" as const };
    const has = hasFieldEdge("VIEW:Form", spec);
    assert.equal(has.relationType, FIELD_REL.HAS_FIELD);
    assert.equal(has.fromNode, "VIEW:Form");
    assert.equal(has.toNode, fieldNodeId("VIEW:Form", "cnpj", "view"));

    const map = mapsToColumnEdge(has.toNode, "table:contract");
    assert.equal(map.relationType, FIELD_REL.MAPS_TO_COLUMN);
    assert.equal(map.toNode, "table:contract");
  });
});

describe("field-graph — convive com o shape existente (não quebra o censo)", () => {
  it("um grafo COM nós FIELD ainda é shapeável e conta FIELD em byType", () => {
    const field = makeFieldNode({ owner: "entity:Contract", name: "cnpj", kind: "column" });
    const graph: RawSystemGraph = {
      nodes: [
        { id: "entity:Contract", type: "ENTITY", className: "Contract", metadata: {} },
        field,
      ],
      edges: [hasFieldEdge("entity:Contract", { owner: "entity:Contract", name: "cnpj", kind: "column" })],
    };
    const shaped = shapeSystemGraph(graph);
    assert.ok(shaped.counts.byType[FIELD_NODE_TYPE] >= 1, `esperava FIELD em byType, veio ${JSON.stringify(shaped.counts.byType)}`);
    // cada nó declara evidência (contrato ADR-0028): o FIELD não escapa disso.
    const fieldShaped = shaped.nodes.find((n) => n.id === field.id);
    assert.ok(fieldShaped, "nó FIELD presente no shape");
    assert.ok(fieldShaped!.evidence?.method, "nó FIELD tem evidence.method");
  });
});

// ── OBS-D05 — produtor de campo (compõe o modelo num subgrafo mesclável) ──
describe("mergeFieldGraph — produtor puro, honesto e inerte", () => {
  const baseGraph = (): RawSystemGraph => ({
    nodes: [
      { id: "VIEW:Form", type: "VIEW", className: "Form", metadata: {} },
      { id: "table:contract", type: "ENTITY", className: "contract", metadata: {} },
    ],
    edges: [],
  });

  it("emite FIELD + HAS_FIELD; MAPS_TO_COLUMN quando a coluna é dada", () => {
    const { graph, stats } = mergeFieldGraph(baseGraph(), [
      { owner: "VIEW:Form", name: "cnpj", kind: "view", mapsToColumn: "table:contract" },
    ]);
    assert.equal(stats.fieldNodesAdded, 1);
    assert.equal(stats.hasFieldEdges, 1);
    assert.equal(stats.mapsToColumnEdges, 1);
    const fid = fieldNodeId("VIEW:Form", "cnpj", "view");
    assert.ok(graph.nodes.some((n) => n.id === fid));
    assert.ok(graph.edges.some((e) => e.relationType === FIELD_REL.HAS_FIELD && e.fromNode === "VIEW:Form" && e.toNode === fid));
    assert.ok(graph.edges.some((e) => e.relationType === FIELD_REL.MAPS_TO_COLUMN && e.fromNode === fid && e.toNode === "table:contract"));
  });

  it("owner inexistente no grafo → NÃO cria campo flutuante (honesto, contado)", () => {
    const { graph, stats } = mergeFieldGraph(baseGraph(), [
      { owner: "VIEW:Fantasma", name: "x", kind: "view" },
    ]);
    assert.equal(stats.fieldOwnerUnresolved, 1);
    assert.equal(stats.fieldNodesAdded, 0);
    assert.equal(graph.nodes.filter((n) => n.type === FIELD_NODE_TYPE).length, 0);
  });

  it("allowMintTableOwner minta `table:<x>` ausente p/ coluna física", () => {
    const g: RawSystemGraph = { nodes: [], edges: [] };
    const { graph, stats } = mergeFieldGraph(g, [{ owner: "table:person", name: "cpf", kind: "column" }], { allowMintTableOwner: true });
    assert.equal(stats.fieldNodesAdded, 1);
    assert.ok(graph.nodes.some((n) => n.id === "table:person" && n.type === "ENTITY"));
  });

  it("dedup: campo repetido não duplica nó nem aresta", () => {
    const decls = [
      { owner: "VIEW:Form", name: "cnpj", kind: "view" as const },
      { owner: "VIEW:Form", name: "cnpj", kind: "view" as const },
    ];
    const { stats } = mergeFieldGraph(baseGraph(), decls);
    assert.equal(stats.fieldNodesAdded, 1);
    assert.equal(stats.hasFieldEdges, 1);
  });

  it("payload vazio/ausente → no-op byte-a-byte", () => {
    const g = baseGraph();
    const r1 = mergeFieldGraph(g, []);
    assert.equal(r1.graph.nodes.length, g.nodes.length);
    assert.equal(r1.graph.edges.length, 0);
    const r2 = mergeFieldGraph(g, null);
    assert.equal(r2.graph.nodes.length, g.nodes.length);
  });

  it("não muta o snapshot de entrada (puro)", () => {
    const g = baseGraph();
    const nodesBefore = g.nodes.length;
    mergeFieldGraph(g, [{ owner: "VIEW:Form", name: "cnpj", kind: "view" }]);
    assert.equal(g.nodes.length, nodesBefore, "grafo de entrada intacto");
  });
});

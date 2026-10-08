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

// ─────────────────────────────────────────────
// wsv1NodesToCatalogEntries — materializa a superfície WsV1 (@Ws) no catálogo.
//
// Bug consertado: o easynup é WsV1 (`@Ws` → /easynup/<op>.v<N>, rota derivada do
// nome da classe, não @*Mapping). `augmentGraphWithWsV1` já criava os nós
// CONTROLLER sintéticos + a edge pra entidade, MAS o pipeline não os
// materializava em catalog entries → catálogo vinha com endpoint:"/" e
// entitiesTouched vazio. Aqui provamos que os nós viram entries com o path REAL
// + a entidade que operam.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ApplicationGraph, GraphNode, GraphEdge } from "../../server/analyzers/application-graph.ts";
import { wsv1NodesToCatalogEntries } from "../../server/analyzers/graph-connector.ts";

function graphWithWsV1(): ApplicationGraph {
  const g = new ApplicationGraph();
  // entidade Contract com campos (fonte do entityFieldsMetadata)
  g.addNode(new GraphNode("entity:Contract", "ENTITY", "Contract", null, null, {
    enrichedFields: [
      { name: "id", type: "Long", isId: true, isSensitive: false },
      { name: "value", type: "BigDecimal", isId: false, isSensitive: false },
    ],
  }));
  // nó WsV1 sintético (como augmentGraphWithWsV1 cria) — leitura
  g.addNode(new GraphNode("wsv1:GET:/easynup/findContracts.v1", "CONTROLLER", "FindContractsWsV1", "execute", null, {
    httpMethod: "GET",
    fullPath: "/easynup/findContracts.v1",
    sourceFile: "src/main/java/easynup/services/web/contracts/findContracts/v1/FindContractsWsV1.java",
    lineNumber: 23,
    synthetic: true,
    convention: "wsv1-package",
  }));
  // edge sintética pra entidade (convenção verbo+entidade: findContracts → Contract)
  g.addEdge(new GraphEdge("wsv1:GET:/easynup/findContracts.v1", "entity:Contract", "READS_ENTITY", {
    synthetic: true, operation: "read",
  }));
  // nó NÃO-sintético (controller REST normal) — NÃO deve virar entry WsV1
  g.addNode(new GraphNode("ctrl:WebhookController.retry", "CONTROLLER", "WebhookController", "retry", null, {
    httpMethod: "POST", fullPath: "/api/webhooks/{id}/retry",
  }));
  return g;
}

describe("wsv1NodesToCatalogEntries", () => {
  it("emite um entry com o path REAL /easynup/* (não \"/\")", () => {
    const entries = wsv1NodesToCatalogEntries(graphWithWsV1(), 1, 3);
    const e = entries.find((x) => x.endpoint === "/easynup/findContracts.v1");
    assert.ok(e, "entry WsV1 emitido");
    assert.equal(e!.httpMethod, "GET");
    assert.equal(e!.controllerClass, "FindContractsWsV1");
    assert.equal(e!.architectureType, "WS_OPERATION_BASED");
    assert.notEqual(e!.endpoint, "/");
  });

  it("popula entitiesTouched + entityFieldsMetadata via a edge sintética", () => {
    const entries = wsv1NodesToCatalogEntries(graphWithWsV1(), 1, 3);
    const e = entries.find((x) => x.endpoint === "/easynup/findContracts.v1")!;
    assert.deepEqual(e.entitiesTouched, ["Contract"]);
    assert.ok((e.persistenceOperations || []).includes("read"));
    assert.equal((e.entityFieldsMetadata as any[])[0]?.entity, "Contract");
    // honestidade da proveniência: entidade vem da convenção (inferida)
    assert.equal((e.dataSource as any).entitiesTouched, "inferred");
    assert.equal((e.dataSource as any).endpoint, "extracted");
  });

  it("só materializa nós sintéticos (não duplica controllers REST normais)", () => {
    const entries = wsv1NodesToCatalogEntries(graphWithWsV1(), 1, 3);
    assert.equal(entries.length, 1);
    assert.ok(!entries.some((x) => x.controllerClass === "WebhookController"));
  });

  it("grafo sem WsV1 → nenhum entry (não quebra)", () => {
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("ctrl:X.y", "CONTROLLER", "X", "y", null, { httpMethod: "GET" }));
    assert.equal(wsv1NodesToCatalogEntries(g, 1, 3).length, 0);
  });
});

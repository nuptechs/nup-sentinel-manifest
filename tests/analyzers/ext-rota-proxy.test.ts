import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractJavaProxies, type ExpressRoute } from "../../server/analyzers/node-backend/express-routes";
import { augmentGraphWithFullStack } from "../../server/analyzers/full-stack-augment";
import { ApplicationGraph, GraphNode } from "../../server/analyzers/application-graph";

const route = (method: string, path: string, extra: Partial<ExpressRoute> = {}): ExpressRoute =>
  ({ method, path, routerVar: "r", requiredRoles: [], permissionExpression: null, entitiesTouched: [], persistenceOperations: [], callChain: [], proxiesTo: [], sourceFile: "services/gateway/src/routes/x.routes.js", lineNumber: 1, ...extra }) as ExpressRoute;

describe("ADR-0026 EXT-ROTA — extractJavaProxies (rota → endpoint Java)", () => {
  it("pega fetch /easynup/<op>.vN + op-key do callJavaWs, normaliza p/ fullPath", () => {
    const h = `async (req,res)=>{ await fetch(\`\${springBootUrl}/easynup/validateAndTransition.v1\`,{}); await callJavaWs({op:'findContracts.v1'}); const x='createServiceOrder.v2'; }`;
    assert.deepEqual(extractJavaProxies(h), [
      "/easynup/createServiceOrder.v2",
      "/easynup/findContracts.v1",
      "/easynup/validateAndTransition.v1",
    ]);
  });
  it("handler sem proxy → vazio (precisão, não chuta)", () => {
    assert.deepEqual(extractJavaProxies("async (req,res)=>{ res.json(await db.select()); }"), []);
    assert.deepEqual(extractJavaProxies(""), []);
  });
  it("não confunde versão em texto solto (precisa de aspas ou /easynup/)", () => {
    assert.deepEqual(extractJavaProxies("const v1 = foo.v1; bar.v2()"), []);
  });
});

describe("ADR-0026 EXT-ROTA — liga rota gateway → wsv1 (fecha o beco)", () => {
  it("rota que proxia um endpoint Java existente ganha aresta CALLS gateway-proxy", () => {
    const g = new ApplicationGraph();
    // endpoint Java já mintado (como no pipeline, antes do full-stack)
    g.addNode(new GraphNode("wsv1:POST:/easynup/findContracts.v1", "CONTROLLER", "FindContractsWsV1", "execute", null, { fullPath: "/easynup/findContracts.v1", synthetic: true }));
    augmentGraphWithFullStack(g, [], [route("GET", "/api/contracts", { proxiesTo: ["/easynup/findContracts.v1"] })], []);
    const edge = g.getAllEdges().find((e) => e.fromNode === "route:GET:/api/contracts" && e.toNode === "wsv1:POST:/easynup/findContracts.v1");
    assert.ok(edge, "aresta rota→wsv1 criada; arestas=" + g.getAllEdges().map((e) => e.fromNode + "->" + e.toNode).join(", "));
    assert.equal(edge!.relationType, "CALLS");
    assert.equal(edge!.metadata.convention, "gateway-proxy");
  });
  it("proxia endpoint INEXISTENTE → sem aresta (precisão: só liga a nó real)", () => {
    const g = new ApplicationGraph();
    augmentGraphWithFullStack(g, [], [route("GET", "/api/x", { proxiesTo: ["/easynup/naoExiste.v1"] })], []);
    assert.equal(g.getAllEdges().filter((e) => e.toNode.startsWith("wsv1:")).length, 0, "não liga a endpoint inexistente");
  });
});

// ADR-0025 Onda 6 — VIEW+ROUTE no grafo (cadeia clique→dado)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApplicationGraph, GraphNode } from "../../server/analyzers/application-graph.ts";
import { augmentGraphWithFullStack, urlMatchesRoute } from "../../server/analyzers/full-stack-augment.ts";
import type { ExpressRoute } from "../../server/analyzers/node-backend/express-routes.ts";

const route = (method: string, path: string, extra: Partial<ExpressRoute> = {}): ExpressRoute =>
  ({ method, path, routerVar: "r", requiredRoles: [], permissionExpression: null, entitiesTouched: [], ...extra }) as ExpressRoute;

const interaction = (over: Record<string, unknown>) =>
  ({
    component: "ContractsPage", elementType: "button", actionName: "load",
    httpMethod: "POST", url: "/easynup/findContracts.v1", mappedBackendNode: null,
    sourceFile: "src/pages/ContractsPage.vue", lineNumber: 10,
    resolutionTier: null, resolutionStrategy: null, resolutionPath: null,
    interactionCategory: "HTTP", confidence: 0.9, ...over,
  }) as never;

describe("augmentGraphWithFullStack (Onda 6)", () => {
  it("tela com backend mapeado vira VIEW→wsv1 (proveniência convention-name)", () => {
    const g = new ApplicationGraph();
    const ws = new GraphNode("wsv1:POST:/easynup/findContracts.v1", "CONTROLLER", "FindContractsWsV1", "execute", null, { synthetic: true });
    g.addNode(ws);
    const r = augmentGraphWithFullStack(g, [interaction({ mappedBackendNode: ws })], []);
    assert.equal(r.views, 1);
    const edge = g.getOutgoingEdges("view:ContractsPage")[0];
    assert.equal(edge.toNode, ws.id);
    assert.equal(edge.metadata.resolution, "convention-name");
    assert.equal(edge.metadata.synthetic, true);
  });

  it("tela sem backend Java casa com ROTA do gateway (método+path com :param)", () => {
    const g = new ApplicationGraph();
    const r = augmentGraphWithFullStack(
      g,
      [interaction({ url: "/api/user-flows/abc/execute", mappedBackendNode: null })],
      [route("POST", "/api/user-flows/:code/execute", { requiredRoles: ["user_flows.execute"] })],
    );
    assert.equal(r.routes, 1);
    assert.equal(r.edges, 1);
    const edge = g.getOutgoingEdges("view:ContractsPage")[0];
    assert.equal(edge.toNode, "route:POST:/api/user-flows/:code/execute");
    const routeNode = g.getNode(edge.toNode)!;
    assert.deepEqual(routeNode.metadata.requiredRoles, ["user_flows.execute"], "permissão da rota flui");
  });

  it("método diferente NÃO casa; interação não-HTTP não vira VIEW", () => {
    const g = new ApplicationGraph();
    const r = augmentGraphWithFullStack(
      g,
      [
        interaction({ httpMethod: "GET", url: "/api/x" }),
        interaction({ interactionCategory: "UI_ONLY", component: "OnlyUi" }),
      ],
      [route("POST", "/api/x")],
    );
    assert.equal(g.getNode("view:OnlyUi"), undefined, "UI_ONLY fora");
    assert.equal(r.edges, 0, "GET não casa rota POST");
  });

  it("idempotente: re-augmentar não duplica nós nem arestas", () => {
    const g = new ApplicationGraph();
    const its = [interaction({ url: "/api/x", mappedBackendNode: null })];
    const rts = [route("POST", "/api/x")];
    augmentGraphWithFullStack(g, its, rts);
    const again = augmentGraphWithFullStack(g, its, rts);
    assert.equal(again.views, 0);
    assert.equal(again.routes, 0);
    assert.equal(g.getAllEdges().length, 1);
  });

  it("urlMatchesRoute: segmentos exatos, :param curinga, query ignorada", () => {
    const r = route("GET", "/api/projects/:id/graph");
    assert.ok(urlMatchesRoute("/api/projects/31/graph?level=method", r));
    assert.ok(!urlMatchesRoute("/api/projects/31", r), "tamanho diferente não casa");
    assert.ok(!urlMatchesRoute("/api/other/31/graph", r), "segmento literal deve bater");
  });
});

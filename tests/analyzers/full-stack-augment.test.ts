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

describe("linkViewsViaApiLayer (Onda 6b — cadeia componente→api/*.ts→URL)", () => {
  const apiFile = {
    filePath: "frontend/src/api/vendors.ts",
    content: "export async function findVendors(q = {}) {\n  const r = await authFetch(`${API_BASE_URL}/easynup/findVendors.v1?${p}`);\n  return r.json();\n}\nexport async function orfa() { return 1; }\n",
  };
  const page = {
    filePath: "frontend/src/pages/VendorWorkspacePage.vue",
    content: "<script setup>\nimport { findVendors, orfa } from '@/api/vendors';\nconst load = async () => { const d = await findVendors({ q: 'x' }); };\n</script>",
  };
  it("indexa export→URL e liga VIEW→wsv1 com proveniência api-layer", async () => {
    const { indexApiLayer, linkViewsViaApiLayer } = await import("../../server/analyzers/full-stack-augment.ts");
    const idx = indexApiLayer([apiFile]);
    assert.equal(idx.vendors.findVendors, "/easynup/findVendors.v1");
    assert.equal(idx.vendors.orfa, undefined, "função sem URL não entra");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:POST:/easynup/findVendors.v1", "CONTROLLER", "FindVendorsWsV1", "execute", null, { synthetic: true }));
    const r = linkViewsViaApiLayer(g, [apiFile, page]);
    assert.equal(r.views, 1);
    assert.equal(r.edges, 1);
    const e = g.getOutgoingEdges("view:VendorWorkspacePage")[0];
    assert.equal(e.toNode, "wsv1:POST:/easynup/findVendors.v1");
    assert.equal(e.metadata.resolution, "syntactic-declared");
    assert.equal(e.metadata.via, "api/vendors.findVendors");
  });
  it("importada mas NÃO invocada não liga; URL sem alvo no grafo não liga", async () => {
    const { linkViewsViaApiLayer } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:POST:/easynup/findVendors.v1", "CONTROLLER", "X", "execute", null, {}));
    const soImporta = { filePath: "frontend/src/pages/Outra.vue", content: "import { findVendors } from '@/api/vendors';\nconst nada = 1;" };
    const r = linkViewsViaApiLayer(g, [apiFile, soImporta]);
    assert.equal(r.edges, 0, "sem invocação não liga (precisão)");
  });
  it("URL /api/ com ${param} casa rota Express :param", async () => {
    const { linkViewsViaApiLayer } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("route:GET:/api/projects/:id/graph", "ROUTE", "/api/projects/:id/graph", null, null, { fullPath: "/api/projects/:id/graph", synthetic: true }));
    const api = { filePath: "frontend/src/api/graph.ts", content: "export async function getGraph(id) { return authFetch(`${B}/api/projects/${id}/graph`); }\n" };
    const pg = { filePath: "frontend/src/pages/Mapa.vue", content: "import { getGraph } from '@/api/graph';\nconst x = () => getGraph(1);" };
    const r = linkViewsViaApiLayer(g, [api, pg]);
    assert.equal(r.edges, 1);
    assert.equal(g.getOutgoingEdges("view:Mapa")[0].toNode, "route:GET:/api/projects/:id/graph");
  });
});

describe("linkViewsViaComposablesAndInline (Onda 6b-2)", () => {
  const api = { filePath: "frontend/src/api/vendors.ts",
    content: "export async function findVendors() { return authFetch(`${B}/easynup/findVendors.v1`); }\nexport async function delVendor() { return authFetch(`${B}/easynup/deleteVendor.v1`); }\n" };
  const comp = { filePath: "frontend/src/composables/useVendors.ts",
    content: "import { findVendors, delVendor } from '@/api/vendors';\nexport function useVendors() { const load = () => findVendors(); return { load }; }\nexport function useVendorDelete() { return () => delVendor(); }\n" };
  const page = { filePath: "frontend/src/pages/VendorList.vue",
    content: "<script setup>\nimport { useVendors } from '@/composables/useVendors';\nconst { load } = useVendors();\n</script>" };
  it("componente→composable→api→URL liga com via rastreável; export não usado NÃO vaza", async () => {
    const { linkViewsViaComposablesAndInline } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:POST:/easynup/findVendors.v1", "CONTROLLER", "F", "execute", null, {}));
    g.addNode(new GraphNode("wsv1:POST:/easynup/deleteVendor.v1", "CONTROLLER", "D", "execute", null, {}));
    const r = linkViewsViaComposablesAndInline(g, [api, comp, page]);
    assert.equal(r.edges, 1, "só a URL do export INVOCADO (useVendors), não do useVendorDelete");
    const e = g.getOutgoingEdges("view:VendorList")[0];
    assert.equal(e.toNode, "wsv1:POST:/easynup/findVendors.v1");
    assert.ok(String(e.metadata.via).includes("useVendors.ts".replace(".ts","")) || String(e.metadata.via).includes("useVendors"), String(e.metadata.via));
  });
  it("URL literal inline no componente liga direto (authFetch no corpo)", async () => {
    const { linkViewsViaComposablesAndInline } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:POST:/easynup/processHeatmap.v1", "CONTROLLER", "H", "execute", null, {}));
    const pg = { filePath: "frontend/src/pages/Heat.vue", content: "const r = await authFetch(`${B}/easynup/processHeatmap.v1`);" };
    const r = linkViewsViaComposablesAndInline(g, [pg]);
    assert.equal(r.edges, 1);
    assert.equal(g.getOutgoingEdges("view:Heat")[0].metadata.via, "inline-url");
  });
});

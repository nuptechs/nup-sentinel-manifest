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

  it("serviços DECLARADOS viram nó mesmo sem rota que os alcance (fecha o ponto cego do barrel)", () => {
    // Um serviço só alcançado por barrel/re-export (que o resolvedor não segue) ou
    // por rotas que o parser pulava ficava SEM nó. Agora todo `server/services/**`
    // declarado vira nó — idempotente e sem depender de aresta resolvida.
    const g = new ApplicationGraph();
    const fileData = [
      { filePath: "server/services/permission/index.ts", content: "export function checkPermission(){}" },
      { filePath: "server/services/rebac/rebac-engine.ts", content: "export function check(){}" },
      { filePath: "server/services/permission/index.test.ts", content: "// teste, deve ser ignorado" },
      { filePath: "server/routes/access.routes.ts", content: "// rota, não é services/, ignorada por este bloco" },
    ];
    augmentGraphWithFullStack(g, [], [], fileData);
    assert.ok(g.getNode("node:server/services/permission/index.ts"), "barrel index.ts declarado vira nó");
    assert.ok(g.getNode("node:server/services/rebac/rebac-engine.ts"), "engine atrás de barrel vira nó");
    assert.ok(!g.getNode("node:server/services/permission/index.test.ts"), "arquivo de teste NÃO vira nó");
    const decl = g.getNode("node:server/services/permission/index.ts")!;
    assert.equal((decl.metadata as Record<string, unknown>).serviceDeclared, true);
    // idempotente: re-augmentar não duplica
    const before = g.getAllNodes().length;
    augmentGraphWithFullStack(g, [], [], fileData);
    assert.equal(g.getAllNodes().length, before, "re-augmentar não duplica os nós declarados");
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
  it("CADEIA materializada: tela→composable(fn)→endpoint; export não usado NÃO vira nó", async () => {
    const { linkViewsViaComposablesAndInline } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:POST:/easynup/findVendors.v1", "CONTROLLER", "F", "execute", null, {}));
    g.addNode(new GraphNode("wsv1:POST:/easynup/deleteVendor.v1", "CONTROLLER", "D", "execute", null, {}));
    linkViewsViaComposablesAndInline(g, [api, comp, page]);
    const pe = g.getOutgoingEdges("view:VendorList")[0];
    assert.equal(pe.toNode, "composable:useVendors.useVendors", "tela aponta pro COMPOSABLE (camada real)");
    const ce = g.getOutgoingEdges("composable:useVendors.useVendors")[0];
    assert.equal(ce.toNode, "wsv1:POST:/easynup/findVendors.v1", "composable aponta pro endpoint");
    assert.ok(String(ce.metadata.via).includes("useVendors"));
    assert.equal(g.getNode("composable:useVendors.useVendorDelete"), undefined, "export não invocado não vira nó");
    const node = g.getNode("composable:useVendors.useVendors")!;
    assert.equal(node.type, "COMPOSABLE");
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

describe("TELA = roteada no router (correção de definição) + propagação componente→tela", () => {
  const router = { filePath: "frontend/src/router.ts",
    content: "const r=[{path:'/vendors',component:()=>import('./pages/VendorList.vue')}];" };
  const api = { filePath: "frontend/src/api/vendors.ts",
    content: "export async function findVendors(){ return authFetch(`${B}/easynup/findVendors.v1`); }\n" };
  const comp = { filePath: "frontend/src/components/vendor/VendorPicker.vue",
    content: "<script setup>\nimport { findVendors } from '@/api/vendors';\nconst load=()=>findVendors();\n</script>" };
  const page = { filePath: "frontend/src/pages/VendorList.vue",
    content: "<script setup>\nimport VendorPicker from '@/components/vendor/VendorPicker.vue'\n</script>" };

  it("componente NÃO vira nó TELA; a chamada dele é atribuída à página roteada que o importa", async () => {
    const { linkViewsViaComposablesAndInline } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:POST:/easynup/findVendors.v1", "CONTROLLER", "F", "execute", null, {}));
    const r = linkViewsViaComposablesAndInline(g, [router, api, comp, page]);
    assert.equal(g.getNode("view:VendorPicker"), undefined, "componente não é tela");
    const compNode = g.getNode("component:VendorPicker")!;
    assert.equal(compNode.type, "COMPONENT", "componente é CAMADA própria");
    const pe = g.getOutgoingEdges("view:VendorList")[0];
    assert.equal(pe.toNode, "component:VendorPicker", "tela → componente");
    const ce = g.getOutgoingEdges("component:VendorPicker")[0];
    assert.equal(ce.toNode, "wsv1:POST:/easynup/findVendors.v1", "componente → endpoint (api direta dele)");
    assert.ok(r.components >= 1 && r.edges >= 2);
  });

  it("com router no payload, arquivo em pages/ NÃO-roteado também não vira tela", async () => {
    const { linkViewsViaComposablesAndInline } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:POST:/easynup/findVendors.v1", "CONTROLLER", "F", "execute", null, {}));
    const naoRoteada = { filePath: "frontend/src/pages/contract-wizard/components/SubPainel.vue",
      content: "const x = () => authFetch(`${B}/easynup/findVendors.v1`);" };
    linkViewsViaComposablesAndInline(g, [router, naoRoteada]);
    assert.equal(g.getNode("view:SubPainel"), undefined, "sub-componente de pages/ fora do router não é tela");
  });

  it("routedPageBases lê imports lazy do router; fallback /pages/ sem router", async () => {
    const { routedPageBases, isRoutedPage } = await import("../../server/analyzers/full-stack-augment.ts");
    const bases = routedPageBases([router]);
    assert.ok(bases.has("VendorList"));
    assert.equal(isRoutedPage("frontend/src/components/X.vue", bases), false);
    assert.equal(isRoutedPage("frontend/src/pages/Y.vue", new Set()), true, "fallback sem router");
  });
});

describe("BACKEND NODE materializado + composables indiretos (além-fronteira)", () => {
  it("callChain vira módulos Node encadeados e o toque Drizzle casa com a ENTIDADE Java pela tabela", async () => {
    const { augmentGraphWithFullStack } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("ENTITY:easynup.Notification", "ENTITY", "Notification", null, null, {}));
    augmentGraphWithFullStack(g, [], [
      route("POST", "/api/notifications/send", {
        callChain: ["services/gateway/src/routes/notifications.js::handler", "packages/core/src/repositories/notification.repository.js::create"],
        entitiesTouched: ["notification"], persistenceOperations: ["write"],
      } as never),
    ]);
    const r1 = g.getOutgoingEdges("route:POST:/api/notifications/send");
    assert.equal(r1[0].toNode, "node:services/gateway/src/routes/notifications.js", "rota → 1º módulo da cadeia");
    const hop = g.getOutgoingEdges(r1[0].toNode);
    assert.equal(hop[0].toNode, "node:packages/core/src/repositories/notification.repository.js", "cadeia encadeada");
    const data = g.getOutgoingEdges(hop[0].toNode)[0];
    assert.equal(data.toNode, "ENTITY:easynup.Notification", "tabela drizzle CASA com a entidade Java (mesmo Postgres)");
    assert.equal(data.relationType, "WRITES_ENTITY", "persistenceOperations=write → WRITES");
    const mod = g.getNode(r1[0].toNode)!;
    assert.equal(mod.type, "SERVICE");
    assert.equal(mod.metadata.runtime, "node", "camada SERVICE, runtime node");
  });

  it("@Table(name=) divergente: toque na tabela física casa a ENTIDADE Java pelo metadata.tableName", async () => {
    const { augmentGraphWithFullStack } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    // convenção diria "legacy_user"; o banco real é TB_USUARIO_LEGADO (@Table name=)
    g.addNode(new GraphNode("ENTITY:legado.LegacyUser", "ENTITY", "LegacyUser", null, null, {
      tableName: "TB_USUARIO_LEGADO",
    }));
    augmentGraphWithFullStack(g, [], [
      route("GET", "/api/users/list", {
        callChain: ["services/gateway/src/routes/users.js::handler"],
        entitiesTouched: ["tb_usuario_legado"], persistenceOperations: ["read"],
      } as never),
    ]);
    const hop = g.getOutgoingEdges("route:GET:/api/users/list")[0];
    const data = g.getOutgoingEdges(hop.toNode)[0];
    assert.equal(data.toNode, "ENTITY:legado.LegacyUser", "casou pelo tableName explícito, não pela convenção");
    assert.equal(g.getNode("table:tb_usuario_legado"), undefined, "não mintou nó drizzleOnly duplicado");
  });

  it("tabela sem entidade Java vira nó ENTITY drizzleOnly (gateway-only não é invisível)", async () => {
    const { augmentGraphWithFullStack } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    augmentGraphWithFullStack(g, [], [
      route("GET", "/api/sessions/list", { entitiesTouched: ["gateway_session"], persistenceOperations: ["read"], callChain: [] } as never),
    ]);
    const t = g.getNode("table:gateway_session")!;
    assert.equal(t.type, "ENTITY");
    assert.equal(t.metadata.drizzleOnly, true);
    assert.equal(g.getOutgoingEdges("route:GET:/api/sessions/list")[0].relationType, "READS_ENTITY");
  });

  it("composable INDIRETO (chama outro composable) e URL inline em composable alcançam o endpoint", async () => {
    const { indexComposableLayer, indexApiLayer } = await import("../../server/analyzers/full-stack-augment.ts");
    const api = { filePath: "frontend/src/api/vendors.ts", content: "export async function findVendors(){ return authFetch(`${B}/easynup/findVendors.v1`); }\n" };
    const base = { filePath: "frontend/src/composables/useVendorsBase.ts",
      content: "import { findVendors } from '@/api/vendors';\nexport function useVendorsBase(){ return () => findVendors(); }\n" };
    const wrapper = { filePath: "frontend/src/composables/useVendorScreen.ts",
      content: "import { useVendorsBase } from '@/composables/useVendorsBase';\nexport function useVendorScreen(){ const b = useVendorsBase(); return b; }\n" };
    const inline = { filePath: "frontend/src/composables/useHeat.ts",
      content: "export function useHeat(){ return () => authFetch(`${B}/easynup/processHeatmap.v1`); }\n" };
    const idx = indexComposableLayer([base, wrapper, inline], indexApiLayer([api, base, wrapper, inline]));
    assert.ok(idx.useVendorsBase.useVendorsBase, "direto ok");
    assert.ok(idx.useVendorScreen.useVendorScreen, "INDIRETO herdou o alvo via fixpoint");
    assert.equal(idx.useVendorScreen.useVendorScreen[0].url, "/easynup/findVendors.v1");
    assert.ok(String(idx.useVendorScreen.useVendorScreen[0].via).includes("useVendorScreen"));
    assert.equal(idx.useHeat.useHeat[0].url, "/easynup/processHeatmap.v1", "inline em composable ok");
  });
});

describe("frontendInventory — reconciliação inventário × participação", () => {
  it("conta telas roteadas, .vue não-roteados e funções de composable do CÓDIGO", async () => {
    const { frontendInventory } = await import("../../server/analyzers/full-stack-augment.ts");
    const inv = frontendInventory([
      { filePath: "frontend/src/router.ts", content: "import('./pages/A.vue');import('./pages/B.vue')" },
      { filePath: "frontend/src/pages/A.vue", content: "" },
      { filePath: "frontend/src/pages/B.vue", content: "" },
      { filePath: "frontend/src/components/X.vue", content: "" },
      { filePath: "frontend/src/pages/sub/components/Y.vue", content: "" },
      { filePath: "frontend/src/composables/useA.ts", content: "export function useA(){}\nexport function useB(){}\n" },
    ]);
    assert.equal(inv.routedPages, 2);
    assert.equal(inv.vueComponents, 2, "X + Y (co-locado) — roteadas fora");
    assert.equal(inv.composableFiles, 1);
    assert.equal(inv.composableFns, 2);
  });
});

// ── Furo 2 (auditoria 2026-08-10): entidades Drizzle DECLARADAS ──
// Antes, um nó `table:*` só nascia quando um HANDLER DE ROTA tocava a tabela.
// Uma tabela do schema tocada só em job/worker ficava SEM nó estático → o
// overlay de runtime a mintava como "invisível" (9/9 falsos-cegos no identify).
describe("augmentGraphWithFullStack — entidades Drizzle declaradas (Furo 2)", () => {
  const schemaFile = {
    filePath: "shared/schema/enterprise.ts",
    content:
      'export const accessRequests = pgTable("access_requests", { id: text("id") });\n' +
      'export const loginAttempts = pgTable("login_attempts", { id: text("id") });\n',
  };

  it("materializa um nó ENTITY table:<nome> por pgTable — SEM rota que a toque", () => {
    const g = new ApplicationGraph();
    // NENHUMA rota, NENHUM handler — só o schema. No código velho: 0 nós ENTITY.
    const r = augmentGraphWithFullStack(g, [], [], [schemaFile]);
    assert.equal(r.drizzleDeclared, 2);
    const ar = g.getNode("table:access_requests");
    const la = g.getNode("table:login_attempts");
    assert.ok(ar, "access_requests (tocada só em job) tem nó declarado");
    assert.ok(la);
    // DECLARADO, não synthetic/runtimeOnly → o BIMR conta como resolvido (não minta).
    const md = (ar!.metadata || {}) as Record<string, unknown>;
    assert.equal(md.drizzleDeclared, true);
    assert.notEqual(md.synthetic, true);
    assert.notEqual(md.runtimeOnly, true);
  });

  it("idempotente: entidade existente de mesmo NOME FÍSICO vence (não duplica)", () => {
    const g = new ApplicationGraph();
    // casamento é pelo nome FÍSICO da tabela (toSnakeCase(className) == tabela).
    g.addNode(new GraphNode("ENTITY:app.AccessRequests", "ENTITY", "AccessRequests", null, null, {}));
    const r = augmentGraphWithFullStack(g, [], [], [schemaFile]);
    // access_requests já casa a entidade existente → não recria; só login_attempts nasce.
    assert.equal(r.drizzleDeclared, 1);
    assert.equal(g.getNode("table:access_requests"), undefined);
    assert.ok(g.getNode("table:login_attempts"));
  });

  it("arquivo sem pgTable → 0 declaradas (não inventa entidade)", () => {
    const g = new ApplicationGraph();
    const r = augmentGraphWithFullStack(g, [], [], [{ filePath: "server/x.ts", content: "export const f = () => 1;" }]);
    assert.equal(r.drizzleDeclared, 0);
  });
});

// ── ADR-0026 CM2: REPOSITORY materializado com as PRÓPRIAS entidades Drizzle ──
describe("nó REPOSITORY minta com entidades Drizzle do próprio arquivo", () => {
  it("cadeia que alcança repositório vira nó REPOSITORY→ENTITY (resolveHandlerEntities reusada)", async () => {
    const { augmentGraphWithFullStack } = await import("../../server/analyzers/full-stack-augment.ts");
    const g = new ApplicationGraph();
    const fileData = [
      {
        filePath: "packages/core/src/db/schema.ts",
        content: `import { pgTable, integer } from "drizzle-orm/pg-core";
export const notifications = pgTable("notification", { id: integer("id").primaryKey() });
export const auditLogs = pgTable("audit_log", { id: integer("id").primaryKey() });
`,
      },
      {
        filePath: "packages/core/src/repositories/notification.repository.ts",
        content: `import { db } from "../db/client";
import { notifications, auditLogs } from "../db/schema";
export class NotificationRepository {
  async create(p) { await db.insert(notifications).values(p); await db.insert(auditLogs).values({}); }
}
`,
      },
    ];
    augmentGraphWithFullStack(g, [], [
      route("POST", "/api/notifications/send", {
        callChain: [
          "services/gateway/src/routes/notifications.js::handler",
          "packages/core/src/repositories/notification.repository.ts::NotificationRepository.create",
        ],
        entitiesTouched: ["notification"], persistenceOperations: ["write"],
      } as never),
    ], fileData);
    const repoNode = g.getNode("node:packages/core/src/repositories/notification.repository.ts")!;
    assert.ok(repoNode, "módulo de repositório materializado");
    assert.equal(repoNode.type, "REPOSITORY", "tier de dados, não SERVICE genérico");
    const out = g.getOutgoingEdges(repoNode.id).map((e) => e.toNode).sort();
    assert.ok(out.includes("table:notification"), "entidade tocada pela rota ligada ao repo");
    assert.ok(
      out.includes("table:audit_log"),
      "entidade PRÓPRIA do arquivo (fora do agregado da rota) também ligada — resolveHandlerEntities reusada",
    );
  });
});

// ── Meta mensurável (fixture do próprio repo): >0 repositórios materializados ──
describe("mini-easynup: ROUTE→SERVICE→REPOSITORY→ENTITY navegável de ponta a ponta", () => {
  it(">0 nós REPOSITORY e a cadeia completa do POST /webhooks/inbound chega em table:webhook_event", async () => {
    const { augmentGraphWithFullStack } = await import("../../server/analyzers/full-stack-augment.ts");
    const { extractExpressRoutes } = await import("../../server/analyzers/node-backend/express-routes.ts");
    const { MINI_EASYNUP } = await import("../regression/mini-easynup.fixture.ts");
    const nodeFiles = MINI_EASYNUP.filter((f) => !f.filePath.endsWith(".java"));

    const g = new ApplicationGraph();
    const routes = extractExpressRoutes(nodeFiles);
    augmentGraphWithFullStack(g, [], routes, nodeFiles);

    const repoNodes = g.getAllNodes().filter((n) => n.type === "REPOSITORY");
    assert.ok(repoNodes.length > 0, "a nota de honestidade (0 repositórios) precisa estar obsoleta");
    assert.ok(
      repoNodes.some((n) => n.id === "node:services/gateway/src/repos/webhook-repo.ts"),
      "o repo do fixture (src/repos/) é um deles",
    );

    // POST /webhooks/inbound: rota → app.ts → webhook-service → webhook-repo → tabela.
    const start = "route:POST:/webhooks/inbound";
    assert.ok(g.getNode(start), "rota do canário C4 existe");
    let cursor = start;
    const visited: string[] = [start];
    let foundRepo = false;
    for (let hop = 0; hop < 6; hop++) {
      const edges = g.getOutgoingEdges(cursor);
      if (edges.length === 0) break;
      const next = edges[0].toNode;
      visited.push(next);
      const node = g.getNode(next);
      if (node?.type === "REPOSITORY") foundRepo = true;
      if (next.startsWith("table:")) break;
      cursor = next;
    }
    assert.ok(foundRepo, `cadeia deveria passar por um REPOSITORY: ${visited.join(" → ")}`);
    assert.equal(
      visited[visited.length - 1],
      "table:webhook_event",
      `cadeia deveria terminar na entidade: ${visited.join(" → ")}`,
    );
  });
});

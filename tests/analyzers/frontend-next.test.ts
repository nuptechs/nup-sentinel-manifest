import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NEXT_REL,
  classifyNextFile,
  segmentsToRoute,
  parseNextSource,
  nextRouteId,
  nextComponentId,
  mergeNextGraph,
} from "../../server/analyzers/frontend-next";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// OBS-D07 — analyzer de Next/SSR. Fixture = projeto Next mínimo (App + Pages
// Router) provando mapeamento de rotas, server/client e handlers de API.

describe("frontend-next — derivação de URL por convenção de arquivo", () => {
  it("route groups somem, [param]→:param, [...]→*, [[...]]→*?, @slot some", () => {
    assert.equal(segmentsToRoute(["(marketing)", "about"]), "/about");
    assert.equal(segmentsToRoute(["users", "[id]"]), "/users/:id");
    assert.equal(segmentsToRoute(["blog", "[...slug]"]), "/blog/*slug");
    assert.equal(segmentsToRoute(["shop", "[[...all]]"]), "/shop/*all?");
    assert.equal(segmentsToRoute(["@modal", "login"]), "/login");
    assert.equal(segmentsToRoute([]), "/");
  });

  it("classifica App Router: page / route(api) / layout", () => {
    assert.deepEqual(classifyNextFile("app/users/[id]/page.tsx"), {
      router: "app", kind: "page", route: "/users/:id", filePath: "app/users/[id]/page.tsx",
    });
    const api = classifyNextFile("src/app/api/health/route.ts")!;
    assert.equal(api.kind, "api");
    assert.equal(api.route, "/api/health"); // App Router: `api` É segmento da URL
    const layout = classifyNextFile("app/layout.tsx")!;
    assert.equal(layout.kind, "layout");
    assert.equal(layout.special, "layout");
  });

  it("classifica Pages Router: index→/, [id], api, infra (_app)", () => {
    assert.equal(classifyNextFile("pages/index.tsx")!.route, "/");
    assert.equal(classifyNextFile("pages/users/[id].tsx")!.route, "/users/:id");
    const api = classifyNextFile("pages/api/users/[id].ts")!;
    assert.equal(api.kind, "api");
    assert.equal(api.route, "/users/:id");
    assert.equal(classifyNextFile("pages/_app.tsx")!.kind, "infra");
  });

  it("ignora arquivos fora do roteamento", () => {
    assert.equal(classifyNextFile("src/lib/utils.ts"), null);
    assert.equal(classifyNextFile("app/users/helper.ts"), null);
    assert.equal(classifyNextFile("README.md"), null);
  });
});

describe("frontend-next — server vs client e exports via parser TS", () => {
  it("App Router default = server; `\"use client\"` → client", () => {
    assert.equal(parseNextSource("app/page.tsx", "export default function P(){return null}", "app").rendering, "server");
    assert.equal(parseNextSource("app/page.tsx", `'use client';\nexport default function P(){return null}`, "app").rendering, "client");
  });

  it("detecta métodos HTTP exportados em route.ts", () => {
    const facts = parseNextSource("app/api/x/route.ts", "export async function GET(){}\nexport function POST(){}", "app");
    assert.deepEqual(facts.httpMethods.sort(), ["GET", "POST"]);
  });

  it("detecta data-fetching do Pages Router", () => {
    const facts = parseNextSource("pages/p.tsx", "export async function getServerSideProps(){return {props:{}}}\nexport default function P(){}", "pages");
    assert.ok(facts.dataFetching.includes("getServerSideProps"));
  });
});

const PROJECT: { filePath: string; content: string }[] = [
  { filePath: "app/layout.tsx", content: "export default function Root({children}){return children}" },
  { filePath: "app/page.tsx", content: "export default function Home(){return null}" },
  { filePath: "app/dashboard/page.tsx", content: `'use client';\nexport default function Dash(){return null}` },
  { filePath: "app/users/[id]/page.tsx", content: "export default function User(){return null}" },
  { filePath: "app/api/health/route.ts", content: "export async function GET(){return Response.json({ok:true})}" },
  { filePath: "pages/_app.tsx", content: "export default function App({Component}){return null}" },
  { filePath: "pages/about.tsx", content: "export default function About(){return null}" },
  { filePath: "src/lib/noise.ts", content: "export const noise = 1;" },
];

describe("mergeNextGraph — produtor puro, inerte, dedup", () => {
  const base = (): RawSystemGraph => ({ nodes: [], edges: [] });

  it("emite ROUTE/VIEW + RENDERS + WRAPS + HANDLES de um projeto misto", () => {
    const { graph, stats } = mergeNextGraph(base(), PROJECT);

    // 3 páginas app (home, dashboard, user) + 1 página pages (about) = 4 rotas page
    // + 1 rota api (health) = 5 nós ROUTE.
    assert.equal(stats.routesAdded, 5);
    assert.ok(stats.rendersEdges >= 4);
    assert.ok(stats.handlesEdges >= 1, "GET /health vira HANDLES");
    assert.ok(stats.wrapsEdges >= 1, "layout envolve a home da raiz");
    assert.ok(stats.clientComponents >= 1 && stats.serverComponents >= 1, "mistura server/client");

    const home = classifyNextFile("app/page.tsx")!;
    assert.ok(graph.nodes.some((n) => n.id === nextRouteId(home) && n.type === "ROUTE"));
    assert.ok(graph.edges.some((e) => e.relationType === NEXT_REL.RENDERS && e.fromNode === nextRouteId(home)));

    const api = classifyNextFile("app/api/health/route.ts")!;
    assert.ok(graph.edges.some((e) => e.relationType === NEXT_REL.HANDLES && e.fromNode === nextRouteId(api)));

    // componente dashboard é client
    const dash = graph.nodes.find((n) => n.id === nextComponentId("app/dashboard/page.tsx"));
    assert.equal((dash!.metadata as any).rendering, "client");
  });

  it("não cria nós para ruído fora do roteamento", () => {
    const { graph } = mergeNextGraph(base(), PROJECT);
    assert.ok(!graph.nodes.some((n) => (n.metadata as any)?.sourceFile === "src/lib/noise.ts"));
  });

  it("convive com o shape do censo (ROUTE tem evidence.method)", () => {
    const { graph } = mergeNextGraph(base(), PROJECT);
    const shaped = shapeSystemGraph(graph as RawSystemGraph);
    assert.ok(shaped.counts.byType["ROUTE"] >= 4);
    const home = shaped.nodes.find((n) => n.id === nextRouteId(classifyNextFile("app/page.tsx")!));
    assert.ok(home?.evidence?.method, "ROUTE declara evidência");
  });

  it("dedup e pureza: duas chamadas / entrada vazia não duplicam nem mutam", () => {
    const { stats } = mergeNextGraph(base(), [...PROJECT, ...PROJECT]);
    assert.equal(stats.routesAdded, 5);

    const g = base();
    g.nodes.push({ id: "svc", type: "SERVICE", metadata: {} });
    const before = g.nodes.length;
    mergeNextGraph(g, PROJECT);
    assert.equal(g.nodes.length, before, "grafo de entrada intacto (puro)");
    const empty = mergeNextGraph(base(), []);
    assert.equal(empty.stats.routesAdded, 0);
  });
});

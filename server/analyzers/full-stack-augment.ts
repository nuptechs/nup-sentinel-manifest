// ─────────────────────────────────────────────
// Full-stack augment (ADR-0025 Onda 6) — as camadas VIEW e ROUTE entram no
// grafo persistido. As peças JÁ eram extraídas na mesma análise
// (frontendInteractions com mappedBackendNode; rotas Express do gateway) —
// só não viravam nós. Agora o grafo conta a cadeia inteira:
//   VIEW (tela) → endpoint/handler → service → repositório → entidade
//   VIEW (tela) → ROUTE (gateway Node) quando a URL casa com rota Express.
// Puro e idempotente (addNode/addEdge dedupam). Aresta com proveniência T1
// (`resolution: convention-name`) e `synthetic: true` — o conformance da
// Onda 8 e o filtro de confiança da tela as tratam como convenção, nunca
// como chamada de código observada.
// ─────────────────────────────────────────────
import { ApplicationGraph, GraphNode, GraphEdge } from "./application-graph";
import type { FrontendInteraction } from "./frontend-analyzer";
import type { ExpressRoute } from "./node-backend/express-routes";

export interface FullStackAugmentResult {
  views: number;
  routes: number;
  edges: number;
}

/** Normaliza um path Express (`/api/x/:id`) em segmentos comparáveis. */
function routeSegments(path: string): string[] {
  return (path || "").split("/").filter(Boolean);
}

/** URL concreta casa com path Express? (`:param` casa qualquer segmento.) */
export function urlMatchesRoute(url: string, route: ExpressRoute): boolean {
  const clean = (url || "").split("?")[0];
  const us = routeSegments(clean);
  const rs = routeSegments(route.path);
  if (us.length !== rs.length || us.length === 0) return false;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i].startsWith(":")) continue; // parâmetro casa qualquer coisa
    if (rs[i] !== us[i]) return false;
  }
  return true;
}

export function augmentGraphWithFullStack(
  graph: ApplicationGraph,
  interactions: FrontendInteraction[],
  routes: ExpressRoute[],
): FullStackAugmentResult {
  let views = 0;
  let routesAdded = 0;
  let edges = 0;
  const edgeSeen = new Set<string>();
  const addEdgeOnce = (from: string, to: string, meta: Record<string, unknown>) => {
    const k = `${from}->${to}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    graph.addEdge(new GraphEdge(from, to, "CALLS", meta));
    edges++;
  };

  // ROUTE — rotas Express do gateway (nó por método+path; carrega permissão).
  const routeNodeByKey = new Map<string, { id: string; route: ExpressRoute }>();
  for (const r of routes || []) {
    if (!r?.path || !r.method || r.method === "ALL") continue;
    const id = `route:${r.method}:${r.path}`;
    if (!graph.getNode(id)) {
      graph.addNode(
        new GraphNode(id, "ROUTE", r.path, null, null, {
          httpMethod: r.method,
          fullPath: r.path,
          sourceFile: (r as unknown as { sourceFile?: string }).sourceFile,
          requiredRoles: r.requiredRoles || [],
          synthetic: true,
        }),
      );
      routesAdded++;
    }
    routeNodeByKey.set(id, { id, route: r });
  }

  // VIEW — telas/componentes com interação HTTP; aresta pro backend mapeado
  // (wsv1/CONTROLLER — o matcher já resolveu) ou pra ROUTE do gateway.
  const viewIds = new Set<string>();
  for (const it of interactions || []) {
    if (it.interactionCategory !== "HTTP") continue;
    const component = it.component || "UnknownView";
    const viewId = `view:${component}`;
    if (!viewIds.has(viewId) && !graph.getNode(viewId)) {
      graph.addNode(
        new GraphNode(viewId, "VIEW", component, null, null, {
          sourceFile: it.sourceFile,
          synthetic: true,
        }),
      );
      views++;
    }
    viewIds.add(viewId);

    if (it.mappedBackendNode?.id) {
      addEdgeOnce(viewId, it.mappedBackendNode.id, {
        synthetic: true,
        resolution: "convention-name",
        httpMethod: it.httpMethod,
        url: it.url,
        convention: "frontend-http",
      });
      continue;
    }
    // sem backend Java mapeado: tenta rota do gateway (a camada Node)
    if (!it.url || !it.httpMethod) continue;
    for (const { id, route } of Array.from(routeNodeByKey.values())) {
      if (route.method !== it.httpMethod) continue;
      if (!urlMatchesRoute(it.url, route)) continue;
      addEdgeOnce(viewId, id, {
        synthetic: true,
        resolution: "convention-name",
        httpMethod: it.httpMethod,
        url: it.url,
        convention: "frontend-gateway",
      });
      break; // primeira rota que casa (método+path) basta
    }
  }

  return { views, routes: routesAdded, edges };
}

// ─── Onda 6b (ADR-0025): resolvedor da CAMADA DE API do frontend ───
// O padrão easynup: componente importa função de `frontend/src/api/*.ts`
// (`import { findVendors } from '@/api/vendors'`) e a função contém a URL
// (`${API_BASE_URL}/easynup/findVendors.v1`). O analisador de interações não
// atravessa essa cadeia (2.871 interações → só 12 telas ligadas). Aqui a
// travessia é DETERMINÍSTICA: indexa export→URL nos módulos de api, casa
// import+invocação no componente e emite VIEW→endpoint/rota com proveniência
// `syntactic-declared` (é sintaxe real: import + chamada + URL literal).

export interface ApiLayerIndex { [module: string]: { [fn: string]: string } }

const EXPORT_RE = /export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/g;
const URL_RE = /(\/(?:easynup|api)\/[A-Za-z0-9_\-./${}:]*[A-Za-z0-9_\-.}])/;

export function indexApiLayer(fileData: { filePath: string; content: string }[]): ApiLayerIndex {
  const idx: ApiLayerIndex = {};
  for (const f of fileData) {
    if (!/frontend\/src\/api\/[\w-]+\.ts$/.test(f.filePath)) continue;
    const mod = f.filePath.replace(/.*\/api\//, "").replace(/\.ts$/, "");
    const marks: { name: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    EXPORT_RE.lastIndex = 0;
    while ((m = EXPORT_RE.exec(f.content)) !== null) marks.push({ name: m[1] || m[2], at: m.index });
    for (let i = 0; i < marks.length; i++) {
      const body = f.content.slice(marks[i].at, marks[i + 1]?.at ?? f.content.length);
      const u = body.match(URL_RE);
      if (u) (idx[mod] = idx[mod] || {})[marks[i].name] = u[1].split("?")[0];
    }
  }
  return idx;
}

const IMPORT_RE = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*['"](?:@\/|\.{1,2}\/(?:\.\.\/)*)api\/([\w-]+)['"]/g;

/** URL da api (com `${…}`) casa com path de rota Express (`:param` curinga). */
function apiUrlMatchesRoutePath(url: string, routePath: string): boolean {
  const us = url.split("/").filter(Boolean);
  const rs = routePath.split("/").filter(Boolean);
  if (us.length !== rs.length || !us.length) return false;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i].startsWith(":") || us[i].includes("${")) continue;
    if (rs[i] !== us[i]) return false;
  }
  return true;
}

export function linkViewsViaApiLayer(
  graph: ApplicationGraph,
  fileData: { filePath: string; content: string }[],
): { views: number; edges: number } {
  const idx = indexApiLayer(fileData);
  let views = 0, edges = 0;
  if (!Object.keys(idx).length) return { views, edges };
  // alvo por URL: wsv1 por PATH exato (qualquer método) · ROUTE por segmentos
  const epByPath = new Map<string, string>();
  const routeNodes: { id: string; path: string }[] = [];
  for (const n of graph.getAllNodes()) {
    if (n.id.startsWith("wsv1:")) epByPath.set(n.id.slice(n.id.indexOf(":", 5) + 1), n.id);
    else if (n.type === "ROUTE") routeNodes.push({ id: n.id, path: String(n.metadata.fullPath || "") });
  }
  const resolveTarget = (url: string): string | null => {
    const hit = epByPath.get(url);
    if (hit) return hit;
    for (const r of routeNodes) if (apiUrlMatchesRoutePath(url, r.path)) return r.id;
    return null;
  };
  const seen = new Set<string>();
  for (const f of fileData) {
    if (!/frontend\/src\/.*\.(vue|ts)$/.test(f.filePath) || /frontend\/src\/api\//.test(f.filePath)) continue;
    const component = (f.filePath.split("/").pop() || "").replace(/\.(vue|ts)$/, "");
    let im: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((im = IMPORT_RE.exec(f.content)) !== null) {
      const mod = idx[im[2]];
      if (!mod) continue;
      for (const raw of im[1].split(",")) {
        const fn = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!mod[fn]) continue;
        if (!new RegExp("[^\\w.]" + fn + "\\s*\\(").test(f.content)) continue; // importada mas não invocada
        const target = resolveTarget(mod[fn]);
        if (!target) continue;
        const viewId = `view:${component}`;
        if (!graph.getNode(viewId)) {
          graph.addNode(new GraphNode(viewId, "VIEW", component, null, null, { sourceFile: f.filePath, synthetic: true }));
          views++;
        }
        const k = `${viewId}->${target}`;
        if (seen.has(k)) continue;
        seen.add(k);
        graph.addEdge(new GraphEdge(viewId, target, "CALLS", {
          synthetic: true, resolution: "syntactic-declared", convention: "api-layer", via: `api/${im[2]}.${fn}`,
        }));
        edges++;
      }
    }
  }
  return { views, edges };
}

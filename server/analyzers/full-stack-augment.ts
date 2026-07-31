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

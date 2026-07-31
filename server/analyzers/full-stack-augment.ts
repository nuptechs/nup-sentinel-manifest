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
  fileData: { filePath: string; content: string }[] = [],
): FullStackAugmentResult {
  const routedSet = routedPageBases(fileData);
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
    // TELA = roteada (correção de definição): interação de COMPONENTE não
    // minta nó "view:" — a atribuição vem pela árvore de imports (6b).
    if (it.sourceFile && !isRoutedPage(it.sourceFile, routedSet)) continue;
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
  const routed = routedPageBases(fileData);
  for (const f of fileData) {
    if (!/frontend\/src\/.*\.(vue|ts)$/.test(f.filePath) || /frontend\/src\/api\//.test(f.filePath)) continue;
    if (!isRoutedPage(f.filePath, routed)) continue; // TELA = roteada; componente vai via propagação
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

// ─── Onda 6b-2 (ADR-0025): salto de COMPOSABLE + URL inline ───
// (a) componente→composables/*.ts→api/*.ts→URL: o composable importa a api e
// cada EXPORT dele é fatiado em bloco (mesma técnica do indexApiLayer) — só as
// funções de api INVOCADAS no bloco contam (precisão por export, não por
// arquivo). (b) componente com URL /easynup|/api LITERAL no próprio corpo
// (authFetch direto) → aresta direta. Ambos determinísticos, via= rastreável.

const COMPOSABLE_IMPORT_RE = /import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*['"](?:@\/|\.{1,2}\/(?:\.\.\/)*)composables\/([\w-]+)['"]/g;
const URL_RE_G = /(\/(?:easynup|api)\/[A-Za-z0-9_\-./${}:]*[A-Za-z0-9_\-.}])/g;

export interface ComposableIndex { [module: string]: { [fn: string]: { url: string; via: string }[] } }

export function indexComposableLayer(
  fileData: { filePath: string; content: string }[],
  apiIdx: ApiLayerIndex,
): ComposableIndex {
  const out: ComposableIndex = {};
  for (const f of fileData) {
    if (!/frontend\/src\/composables\/.*\.ts$/.test(f.filePath)) continue;
    const mod = (f.filePath.split("/").pop() || "").replace(/\.ts$/, "");
    // api fns importadas neste composable
    const apiFns: { fn: string; url: string; via: string }[] = [];
    let im: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((im = IMPORT_RE.exec(f.content)) !== null) {
      const amod = apiIdx[im[2]];
      if (!amod) continue;
      for (const raw of im[1].split(",")) {
        const fn = raw.trim().split(/\s+as\s+/)[0].trim();
        if (amod[fn]) apiFns.push({ fn, url: amod[fn], via: `api/${im[2]}.${fn}` });
      }
    }
    if (!apiFns.length) continue;
    // bloco por export: só api fns invocadas no bloco
    const marks: { name: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    EXPORT_RE.lastIndex = 0;
    while ((m = EXPORT_RE.exec(f.content)) !== null) marks.push({ name: m[1] || m[2], at: m.index });
    for (let i = 0; i < marks.length; i++) {
      const body = f.content.slice(marks[i].at, marks[i + 1]?.at ?? f.content.length);
      const hits = apiFns.filter((a) => new RegExp("[^\\w.]" + a.fn + "\\s*\\(").test(body));
      if (hits.length) (out[mod] = out[mod] || {})[marks[i].name] =
        hits.map((h) => ({ url: h.url, via: `composables/${mod}.${marks[i].name}→${h.via}` }));
    }
  }
  return out;
}

/** 6b-2: liga telas via composable e via URL inline. Chamar APÓS linkViewsViaApiLayer. */
export function linkViewsViaComposablesAndInline(
  graph: ApplicationGraph,
  fileData: { filePath: string; content: string }[],
): { views: number; edges: number } {
  const apiIdx = indexApiLayer(fileData);
  const compIdx = indexComposableLayer(fileData, apiIdx);
  let views = 0, edges = 0;
  const epByPath = new Map<string, string>();
  const routeNodes: { id: string; path: string }[] = [];
  for (const n of graph.getAllNodes()) {
    if (n.id.startsWith("wsv1:")) epByPath.set(n.id.slice(n.id.indexOf(":", 5) + 1), n.id);
    else if (n.type === "ROUTE") routeNodes.push({ id: n.id, path: String(n.metadata.fullPath || "") });
  }
  const resolveTarget = (url: string): string | null => {
    const hit = epByPath.get(url.split("?")[0]);
    if (hit) return hit;
    for (const r of routeNodes) if (apiUrlMatchesRoutePath(url.split("?")[0], r.path)) return r.id;
    return null;
  };
  const seen = new Set<string>();
  const routed = routedPageBases(fileData);
  const targetsByBase = new Map<string, Set<string>>();
  const collect = (base: string, target: string) => {
    if (!targetsByBase.has(base)) targetsByBase.set(base, new Set());
    targetsByBase.get(base)!.add(target);
  };
  const link = (component: string, sourceFile: string, target: string, via: string) => {
    const viewId = `view:${component}`;
    if (!graph.getNode(viewId)) {
      graph.addNode(new GraphNode(viewId, "VIEW", component, null, null, { sourceFile, synthetic: true }));
      views++;
    }
    const k = `${viewId}->${target}`;
    if (seen.has(k) || graph.getOutgoingEdges(viewId).some((e) => e.toNode === target)) return;
    seen.add(k);
    graph.addEdge(new GraphEdge(viewId, target, "CALLS", {
      synthetic: true, resolution: "syntactic-declared", convention: "api-layer", via,
    }));
    edges++;
  };
  for (const f of fileData) {
    if (!/frontend\/src\/.*\.(vue|ts)$/.test(f.filePath)) continue;
    if (/frontend\/src\/(api|composables)\//.test(f.filePath)) continue;
    const component = (f.filePath.split("/").pop() || "").replace(/\.(vue|ts)$/, "");
    const page = isRoutedPage(f.filePath, routed);
    const hit = (t: string, via: string) => page ? link(component, f.filePath, t, via) : collect(component, t);
    // (a0) api DIRETO — pro NÃO-roteado (o linkViewsViaApiLayer agora só cobre telas)
    if (!page) {
      let ia: RegExpExecArray | null;
      IMPORT_RE.lastIndex = 0;
      while ((ia = IMPORT_RE.exec(f.content)) !== null) {
        const amod = apiIdx[ia[2]];
        if (!amod) continue;
        for (const raw of ia[1].split(",")) {
          const fn = raw.trim().split(/\s+as\s+/)[0].trim();
          if (!amod[fn]) continue;
          if (!new RegExp("[^\\w.]" + fn + "\\s*\\(").test(f.content)) continue;
          const t = resolveTarget(amod[fn]);
          if (t) collect(component, t);
        }
      }
    }
    // (a) composable hop
    let im: RegExpExecArray | null;
    COMPOSABLE_IMPORT_RE.lastIndex = 0;
    while ((im = COMPOSABLE_IMPORT_RE.exec(f.content)) !== null) {
      const cmod = compIdx[im[2]];
      if (!cmod) continue;
      for (const raw of im[1].split(",")) {
        const fn = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!cmod[fn]) continue;
        if (!new RegExp("[^\\w.]" + fn + "\\s*\\(").test(f.content)) continue;
        for (const { url, via } of cmod[fn]) {
          const t = resolveTarget(url);
          if (t) hit(t, via);
        }
      }
    }
    // (b) URL literal inline
    let um: RegExpExecArray | null;
    URL_RE_G.lastIndex = 0;
    while ((um = URL_RE_G.exec(f.content)) !== null) {
      const t = resolveTarget(um[1]);
      if (t) hit(t, "inline-url");
    }
  }
  // (c) componentes → telas que os importam (árvore de imports .vue)
  const prop = propagateComponentTargets(graph, fileData, targetsByBase, routed);
  return { views: views + prop.views, edges: edges + prop.edges };
}

// ─── TELA = componente ROTEADO (correção de definição, 2026-07-31) ───
// O usuário provou a inconsistência: a camada "TELA" mintava QUALQUER arquivo
// de frontend que chama backend (301 nós — componentes/painéis/composables
// viravam "tela"), enquanto a contagem correta de telas do easynup é a do
// router (154 rotas / 143 arquivos roteados). Definição dura daqui em diante:
//   TELA  = .vue importado pelo router.ts (fonte da verdade)
//   resto = COMPONENTE — as chamadas dele são ATRIBUÍDAS às telas que o
//           importam (travessia da árvore de imports .vue, fixpoint ≤4 níveis)
// Fallback sem router no payload: /pages/ no path (compat com testes/payloads
// parciais). Nada de nó "view:" pra não-roteado — o mapa fala a MESMA língua
// que o código.

const ROUTER_VUE_RE = /['"]([^'"]+\.vue)['"]/g;
const VUE_IMPORT_RE = /import\s+\w+\s+from\s+['"]([^'"]+\.vue)['"]/g;

/** Set de BASENAMES (sem .vue) roteados pelo router.ts do payload. */
export function routedPageBases(fileData: { filePath: string; content: string }[]): Set<string> {
  const bases = new Set<string>();
  for (const f of fileData) {
    if (!/frontend\/src\/router\.(ts|js)$/.test(f.filePath)) continue;
    let m: RegExpExecArray | null;
    ROUTER_VUE_RE.lastIndex = 0;
    while ((m = ROUTER_VUE_RE.exec(f.content)) !== null) {
      const base = (m[1].split("/").pop() || "").replace(/\.vue$/, "");
      if (base) bases.add(base);
    }
  }
  return bases;
}

/** Arquivo é TELA? (roteado; fallback /pages/ quando o payload não tem router) */
export function isRoutedPage(filePath: string, routed: Set<string>): boolean {
  const base = (filePath.split("/").pop() || "").replace(/\.(vue|ts)$/, "");
  if (routed.size > 0) return routed.has(base);
  return /\/pages\//.test(filePath) && filePath.endsWith(".vue");
}

/**
 * Atribui as chamadas de COMPONENTES às TELAS que os importam (fixpoint sobre
 * a árvore de imports .vue). `targetsByBase` = alvos já resolvidos por arquivo
 * NÃO-roteado. Emite aresta tela→alvo com via=component:<Nome>. Puro.
 */
export function propagateComponentTargets(
  graph: ApplicationGraph,
  fileData: { filePath: string; content: string }[],
  targetsByBase: Map<string, Set<string>>,
  routed: Set<string>,
): { edges: number; views: number } {
  // grafo de imports: base do arquivo → bases .vue importadas
  const importsOf = new Map<string, string[]>();
  const fileByBase = new Map<string, { filePath: string; content: string }>();
  for (const f of fileData) {
    if (!/frontend\/src\/.*\.vue$/.test(f.filePath)) continue;
    const base = (f.filePath.split("/").pop() || "").replace(/\.vue$/, "");
    fileByBase.set(base, f);
    const imps: string[] = [];
    let m: RegExpExecArray | null;
    VUE_IMPORT_RE.lastIndex = 0;
    while ((m = VUE_IMPORT_RE.exec(f.content)) !== null) {
      const b = (m[1].split("/").pop() || "").replace(/\.vue$/, "");
      if (b && b !== base) imps.push(b);
    }
    importsOf.set(base, imps);
  }
  // fixpoint: alvos de componente sobem pelos imports (≤4 níveis, anti-ciclo)
  const resolved = new Map<string, Set<string>>();
  const resolve = (base: string, depth: number, seen: Set<string>): Set<string> => {
    if (resolved.has(base)) return resolved.get(base)!;
    const out = new Set<string>(targetsByBase.get(base) || []);
    if (depth < 4 && !seen.has(base)) {
      seen.add(base);
      for (const child of importsOf.get(base) || []) {
        if (routed.size > 0 ? routed.has(child) : false) continue; // tela não propaga pra cima
        for (const t of Array.from(resolve(child, depth + 1, seen))) out.add(t);
      }
    }
    resolved.set(base, out);
    return out;
  };
  let edges = 0, views = 0;
  for (const [base, f] of Array.from(fileByBase.entries())) {
    if (!isRoutedPage(f.filePath, routed)) continue;
    const targets = new Set<string>();
    for (const child of importsOf.get(base) || []) {
      for (const t of Array.from(resolve(child, 1, new Set([base])))) targets.add(t);
    }
    if (!targets.size) continue;
    const viewId = `view:${base}`;
    if (!graph.getNode(viewId)) {
      graph.addNode(new GraphNode(viewId, "VIEW", base, null, null, { sourceFile: f.filePath, synthetic: true }));
      views++;
    }
    for (const t of Array.from(targets)) {
      if (graph.getOutgoingEdges(viewId).some((e) => e.toNode === t)) continue;
      graph.addEdge(new GraphEdge(viewId, t, "CALLS", {
        synthetic: true, resolution: "syntactic-declared", convention: "api-layer", via: "component-tree",
      }));
      edges++;
    }
  }
  return { edges, views };
}

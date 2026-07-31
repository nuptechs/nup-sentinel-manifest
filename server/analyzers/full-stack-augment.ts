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
import { toSnakeCase } from "./nuptechs-conventions";

export interface FullStackAugmentResult {
  views: number;
  routes: number;
  edges: number;
  nodeModules?: number;
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
  // BACKEND NODE MATERIALIZADO (2026-08-01 — "rota → nada" era o maior buraco
  // do mapa): o extractor JÁ resolve a cadeia interna do handler (callChain
  // ["file::fn",...]) + tabelas Drizzle (entitiesTouched) + operações
  // (persistenceOperations) — e tudo era DESCARTADO. Agora:
  //   ROUTE → node:<módulo> (SERVICE runtime=node, por ARQUIVO — análogo à
  //   classe) → ... → tabela: casa com a ENTIDADE Java pelo nome físico da
  //   tabela (snake_case — MESMO Postgres) ou minta `table:<nome>` ENTITY
  //   drizzleOnly. Relação READS/WRITES pelo persistenceOperations real.
  const entityByTable = new Map<string, string>();
  for (const n of graph.getNodesByType("ENTITY")) {
    entityByTable.set(toSnakeCase(n.className), n.id);
  }
  let nodeModules = 0;
  const mintNodeModule = (fileFn: string): string | null => {
    const file = fileFn.split("::")[0];
    if (!file) return null;
    const id = `node:${file}`;
    if (!graph.getNode(id)) {
      const base = (file.split("/").pop() || file).replace(/\.(js|ts)$/, "");
      graph.addNode(new GraphNode(id, "SERVICE", base, null, null, {
        sourceFile: file, runtime: "node", synthetic: true,
      }));
      nodeModules++;
    }
    return id;
  };
  const dataEdge = (fromId: string, r: ExpressRoute) => {
    const ops = r.persistenceOperations || [];
    const isWrite = ops.some((o) => /write|insert|update|delete|upsert/i.test(o));
    for (const table of r.entitiesTouched || []) {
      let target = entityByTable.get(table);
      if (!target) {
        target = `table:${table}`;
        if (!graph.getNode(target)) {
          graph.addNode(new GraphNode(target, "ENTITY", table, null, null, {
            drizzleOnly: true, synthetic: true,
          }));
        }
      }
      graph.addEdge(new GraphEdge(fromId, target, isWrite ? "WRITES_ENTITY" : "READS_ENTITY", {
        synthetic: true, resolution: "syntactic-declared", operation: "drizzle",
        ops: ops.join(","),
      }));
    }
  };
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
    // cadeia interna do handler → módulos Node encadeados
    const chain = (r.callChain || []).map(mintNodeModule).filter((x): x is string => !!x);
    let prev = id;
    for (const hop of chain) {
      if (hop !== prev) {
        graph.addEdge(new GraphEdge(prev, hop, "CALLS", {
          synthetic: true, resolution: "syntactic-declared", convention: "node-chain",
        }));
        prev = hop;
      }
    }
    // toque de dados sai do FIM da cadeia (ou da própria rota se same-file)
    dataEdge(prev, r);
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

  return { views, routes: routesAdded, edges, nodeModules };
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

export interface ComposableIndex { [module: string]: { [fn: string]: { url: string; via: string; filePath?: string }[] } }

export function indexComposableLayer(
  fileData: { filePath: string; content: string }[],
  apiIdx: ApiLayerIndex,
): ComposableIndex {
  const out: ComposableIndex = {};
  const pendingChildren: { mod: string; fn: string; filePath: string; kids: string[] }[] = [];
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
    // bloco por export: api fns invocadas + URL inline + composables FILHOS
    const marks: { name: string; at: number }[] = [];
    let m: RegExpExecArray | null;
    EXPORT_RE.lastIndex = 0;
    while ((m = EXPORT_RE.exec(f.content)) !== null) marks.push({ name: m[1] || m[2], at: m.index });
    // composables importados por ESTE composable (cadeia indireta — 68 dos 81
    // composables do easynup não importam api direto; chamam OUTRO composable)
    const childImports: { fn: string; key: string }[] = [];
    let ci: RegExpExecArray | null;
    COMPOSABLE_IMPORT_RE.lastIndex = 0;
    while ((ci = COMPOSABLE_IMPORT_RE.exec(f.content)) !== null) {
      for (const raw of ci[1].split(",")) {
        const fn = raw.trim().split(/\s+as\s+/)[0].trim();
        if (fn) childImports.push({ fn, key: `${ci[2]}.${fn}` });
      }
    }
    for (let i = 0; i < marks.length; i++) {
      const body = f.content.slice(marks[i].at, marks[i + 1]?.at ?? f.content.length);
      const entries: { url: string; via: string; filePath?: string }[] = [];
      for (const a of apiFns) {
        if (new RegExp("[^\\w.]" + a.fn + "\\s*\\(").test(body)) {
          entries.push({ url: a.url, via: `composables/${mod}.${marks[i].name}→${a.via}`, filePath: f.filePath });
        }
      }
      let um: RegExpExecArray | null;
      URL_RE_G.lastIndex = 0;
      while ((um = URL_RE_G.exec(body)) !== null) {
        entries.push({ url: um[1], via: `composables/${mod}.${marks[i].name}:inline`, filePath: f.filePath });
      }
      if (entries.length) (out[mod] = out[mod] || {})[marks[i].name] = entries;
      const kids = childImports.filter((c) => new RegExp("[^\\w.]" + c.fn + "\\s*\\(").test(body));
      if (kids.length) pendingChildren.push({ mod, fn: marks[i].name, filePath: f.filePath, kids: kids.map((k) => k.key) });
    }
  }
  // fixpoint (≤3 passadas): composable herda os alvos dos composables FILHOS
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const pc of pendingChildren) {
      const mine = (out[pc.mod] = out[pc.mod] || {});
      const have = new Set((mine[pc.fn] || []).map((e) => e.url));
      for (const key of pc.kids) {
        const dot = key.lastIndexOf(".");
        const kidEntries = out[key.slice(0, dot)]?.[key.slice(dot + 1)] || [];
        for (const e of kidEntries) {
          if (have.has(e.url)) continue;
          have.add(e.url);
          (mine[pc.fn] = mine[pc.fn] || []).push({ url: e.url, via: `composables/${pc.mod}.${pc.fn}→${e.via}`, filePath: pc.filePath });
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * CADEIA FRONTEND MATERIALIZADA (correção de fronteira, 2026-08-01 — pergunta
 * do dono "composable não seria outra camada?"): em vez de ACHATAR a cadeia
 * numa aresta tela→endpoint (perdendo a estrutura — assimétrico com o backend,
 * que modela Controller/Service/Repository), as camadas intermediárias viram
 * NÓS de 1ª classe e a agregação vira papel da LENTE (mesma lição do
 * método×classe do PR #83):
 *   TELA (view:, roteada) → COMPONENTE (component:, .vue não-roteado) →
 *   COMPOSABLE (composable:<mod>.<fn>, por FUNÇÃO exportada — por módulo
 *   reintroduziria o vazamento que o 6b-2 matou) → endpoint/rota.
 * Módulo de api NÃO vira camada (função de api ≈ 1:1 endpoint — coluna
 * redundante); fica como proveniência via=. Só entra intermediário que
 * ALCANÇA backend (poda ramo morto — componente puramente visual não é ruído).
 */
export function linkViewsViaComposablesAndInline(
  graph: ApplicationGraph,
  fileData: { filePath: string; content: string }[],
): { views: number; components: number; composables: number; edges: number } {
  const apiIdx = indexApiLayer(fileData);
  const compIdx = indexComposableLayer(fileData, apiIdx);
  const routed = routedPageBases(fileData);
  let views = 0, components = 0, composables = 0, edges = 0;

  const epByPath = new Map<string, string>();
  const routeNodes: { id: string; path: string }[] = [];
  for (const n of graph.getAllNodes()) {
    if (n.id.startsWith("wsv1:")) epByPath.set(n.id.slice(n.id.indexOf(":", 5) + 1), n.id);
    else if (n.type === "ROUTE") routeNodes.push({ id: n.id, path: String(n.metadata.fullPath || "") });
  }
  const resolveTarget = (url: string): string | null => {
    const clean = url.split("?")[0];
    const hit = epByPath.get(clean);
    if (hit) return hit;
    for (const r of routeNodes) if (apiUrlMatchesRoutePath(clean, r.path)) return r.id;
    return null;
  };
  const addEdgeOnce = (from: string, to: string, meta: Record<string, unknown>) => {
    if (graph.getOutgoingEdges(from).some((e) => e.toNode === to)) return;
    graph.addEdge(new GraphEdge(from, to, "CALLS", { synthetic: true, resolution: "syntactic-declared", ...meta }));
    edges++;
  };

  // ── camada COMPOSABLE: nó por função exportada que alcança backend ──
  const composableTargets = new Map<string, { targets: { t: string; via: string }[]; filePath?: string }>();
  for (const mod of Object.keys(compIdx)) {
    for (const fn of Object.keys(compIdx[mod])) {
      const targets: { t: string; via: string }[] = [];
      let fp: string | undefined;
      for (const { url, via, filePath } of compIdx[mod][fn]) {
        const t = resolveTarget(url);
        if (t) { targets.push({ t, via }); fp = fp || filePath; }
      }
      if (targets.length) composableTargets.set(`${mod}.${fn}`, { targets, filePath: fp });
    }
  }
  const mintComposable = (key: string): string => {
    const id = `composable:${key}`;
    if (!graph.getNode(id)) {
      const info = composableTargets.get(key)!;
      graph.addNode(new GraphNode(id, "COMPOSABLE", key, null, null, {
        sourceFile: info.filePath, synthetic: true,
      }));
      composables++;
      for (const { t, via } of info.targets) addEdgeOnce(id, t, { convention: "api-layer", via });
    }
    return id;
  };

  // ── por arquivo: alvos DIRETOS (api-import + inline) e usos de composable ──
  interface FileFacts { base: string; filePath: string; isVue: boolean; direct: { t: string; via: string }[]; composableKeys: string[]; vueImports: string[]; }
  const facts = new Map<string, FileFacts>();
  for (const f of fileData) {
    if (!/frontend\/src\/.*\.(vue|ts)$/.test(f.filePath)) continue;
    if (/frontend\/src\/(api|composables)\//.test(f.filePath)) continue;
    const base = (f.filePath.split("/").pop() || "").replace(/\.(vue|ts)$/, "");
    const ff: FileFacts = { base, filePath: f.filePath, isVue: f.filePath.endsWith(".vue"), direct: [], composableKeys: [], vueImports: [] };
    // api direto
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
        if (t) ff.direct.push({ t, via: `api/${ia[2]}.${fn}` });
      }
    }
    // inline
    let um: RegExpExecArray | null;
    URL_RE_G.lastIndex = 0;
    while ((um = URL_RE_G.exec(f.content)) !== null) {
      const t = resolveTarget(um[1]);
      if (t) ff.direct.push({ t, via: "inline-url" });
    }
    // composables usados (import + invocação)
    let im: RegExpExecArray | null;
    COMPOSABLE_IMPORT_RE.lastIndex = 0;
    while ((im = COMPOSABLE_IMPORT_RE.exec(f.content)) !== null) {
      for (const raw of im[1].split(",")) {
        const fn = raw.trim().split(/\s+as\s+/)[0].trim();
        const key = `${im[2]}.${fn}`;
        if (!composableTargets.has(key)) continue;
        if (!new RegExp("[^\\w.]" + fn + "\\s*\\(").test(f.content)) continue;
        ff.composableKeys.push(key);
      }
    }
    // imports de .vue (árvore de componentes)
    let vm: RegExpExecArray | null;
    VUE_IMPORT_RE.lastIndex = 0;
    while ((vm = VUE_IMPORT_RE.exec(f.content)) !== null) {
      const b = (vm[1].split("/").pop() || "").replace(/\.vue$/, "");
      if (b && b !== base) ff.vueImports.push(b);
    }
    facts.set(base, ff);
  }

  // ── quais componentes ALCANÇAM backend (fixpoint bottom-up, anti-ciclo) ──
  const reaching = new Map<string, boolean>();
  const reaches = (base: string, seen: Set<string>): boolean => {
    if (reaching.has(base)) return reaching.get(base)!;
    if (seen.has(base)) return false;
    seen.add(base);
    const ff = facts.get(base);
    if (!ff) { reaching.set(base, false); return false; }
    let ok = ff.direct.length > 0 || ff.composableKeys.length > 0;
    if (!ok) for (const child of ff.vueImports) {
      if (isRoutedPage((facts.get(child)?.filePath) || "", routed)) continue;
      if (reaches(child, seen)) { ok = true; break; }
    }
    reaching.set(base, ok);
    return ok;
  };

  const mintComponent = (base: string): string | null => {
    const ff = facts.get(base);
    if (!ff || !ff.isVue) return null;
    const id = `component:${base}`;
    if (!graph.getNode(id)) {
      graph.addNode(new GraphNode(id, "COMPONENT", base, null, null, { sourceFile: ff.filePath, synthetic: true }));
      components++;
      for (const { t, via } of ff.direct) addEdgeOnce(id, t, { convention: "api-layer", via });
      for (const key of ff.composableKeys) addEdgeOnce(id, mintComposable(key), { convention: "frontend-chain" });
      for (const child of ff.vueImports) {
        const cf = facts.get(child);
        if (!cf || isRoutedPage(cf.filePath, routed)) continue;
        if (reaches(child, new Set())) {
          const cid = mintComponent(child);
          if (cid) addEdgeOnce(id, cid, { convention: "frontend-chain" });
        }
      }
    }
    return id;
  };

  // ── TELAS (roteadas): próprias chamadas + componentes + composables ──
  for (const ff of Array.from(facts.values())) {
    if (!isRoutedPage(ff.filePath, routed)) continue;
    const hasChain = ff.direct.length || ff.composableKeys.length ||
      ff.vueImports.some((c) => { const cf = facts.get(c); return cf && !isRoutedPage(cf.filePath, routed) && reaches(c, new Set()); });
    if (!hasChain) continue;
    const viewId = `view:${ff.base}`;
    if (!graph.getNode(viewId)) {
      graph.addNode(new GraphNode(viewId, "VIEW", ff.base, null, null, { sourceFile: ff.filePath, synthetic: true }));
      views++;
    }
    for (const { t, via } of ff.direct) addEdgeOnce(viewId, t, { convention: "api-layer", via });
    for (const key of ff.composableKeys) addEdgeOnce(viewId, mintComposable(key), { convention: "frontend-chain" });
    for (const child of ff.vueImports) {
      const cf = facts.get(child);
      if (!cf || isRoutedPage(cf.filePath, routed)) continue;
      if (reaches(child, new Set())) {
        const cid = mintComponent(child);
        if (cid) addEdgeOnce(viewId, cid, { convention: "frontend-chain" });
      }
    }
  }

  return { views, components, composables, edges };
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

// ─── INVENTÁRIO do frontend (reconciliação, 2026-08-01) ───
// O mapa poda ramo morto (só quem ALCANÇA backend vira nó) — correto para
// arquitetura, mas o chip "43 composables" sem o denominador é meia-verdade
// (o dono provou: outro agente contou 199 funções no CÓDIGO). Um sistema
// superior a um agente ad-hoc entrega OS DOIS números + o resíduo: inventário
// (quantos existem) × participação (quantos tocam backend). Puro.
export interface FrontendInventory {
  routedPages: number;       // telas no router.ts
  vueComponents: number;     // .vue NÃO-roteados (components/ + co-locados)
  composableFiles: number;   // arquivos em composables/
  composableFns: number;     // funções exportadas nesses arquivos
}

export function frontendInventory(fileData: { filePath: string; content: string }[]): FrontendInventory {
  const routed = routedPageBases(fileData);
  let vueComponents = 0, composableFiles = 0, composableFns = 0;
  for (const f of fileData) {
    if (/frontend\/src\/.*\.vue$/.test(f.filePath)) {
      if (!isRoutedPage(f.filePath, routed)) vueComponents++;
    } else if (/frontend\/src\/composables\/.*\.ts$/.test(f.filePath)) {
      composableFiles++;
      let m: RegExpExecArray | null;
      EXPORT_RE.lastIndex = 0;
      while ((m = EXPORT_RE.exec(f.content)) !== null) composableFns++;
    }
  }
  return { routedPages: routed.size, vueComponents, composableFiles, composableFns };
}

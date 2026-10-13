// ─────────────────────────────────────────────────────────────────────────
// OBS-D07 (ADR-0036 WS-D) — ANALYZER DE FRONTEND NEXT/SSR.
//
// Mapeia as ROTAS de um projeto Next.js (App Router e Pages Router) e os
// SERVER/CLIENT components, emitindo nós/arestas rastreáveis no mesmo contrato
// `RawSystemNode`/`RawSystemEdge` do `system-graph.ts`. Segue o padrão INERTE do
// `field-graph.ts`/`frontend-svelte.ts`: construtores puros + produtor
// `mergeNextGraph` mesclável, SEM fiação no pipeline — nada o chama ainda, logo
// o grafo servido continua byte-a-byte e boot/deploy não mudam. Régua D2 = ◐.
//
// O QUE É PARSEADO (real, não stub):
//  • ROTA App Router — `app/**/page.{tsx,ts,jsx,js,mdx}` vira ROTA navegável; o
//    caminho do arquivo é convertido em URL (route groups `(grp)` sumem,
//    `[param]`→`:param`, `[...slug]`→`*slug`, `[[...slug]]`→`*slug?`, slots
//    paralelos `@slot` saem da URL). `route.ts` vira ROTA de API e cada método
//    HTTP exportado (GET/POST/…) vira um HANDLER ligado por `HANDLES` (parse TS
//    real dos exports). `layout`/`template`/`loading`/`error`/… viram COMPONENT.
//  • ROTA Pages Router — `pages/**/*.{tsx,ts,jsx,js}` vira ROTA (index→`/`,
//    `[id]`→`:id`); `pages/api/**` vira ROTA de API. `_app`/`_document`/`_error`
//    são componentes de infraestrutura (não rota navegável).
//  • SERVER vs CLIENT — diretiva `"use client"` no topo do arquivo marca o
//    componente como client; App Router sem a diretiva = server component.
//    `getServerSideProps`/`getStaticProps`/`getInitialProps` (Pages) marcam o
//    modo de dados. Tudo em metadata (não muda o tier de evidência).
//
// HONESTIDADE: o roteamento por convenção de arquivo do Next é forte mas NÃO é
// prova de compilador → arestas nascem `resolution:'convention-path'`
// (STATIC_UNRESOLVED 0.40 no censo — heurística honesta). PURO: nada lança;
// `mergeNextGraph` clona o grafo.
// ─────────────────────────────────────────────────────────────────────────

import _ts from "typescript";
import { parseTypeScript } from "./frontend/parsers";
import type { RawSystemNode, RawSystemEdge } from "./system-graph";

import ts = _ts;

export const NEXT_REL = {
  /** rota → componente que ela renderiza. */
  RENDERS: "RENDERS",
  /** layout/template → rota/segmento que ele envolve. */
  WRAPS: "WRAPS",
  /** rota de API → handler de método HTTP. */
  HANDLES: "HANDLES",
} as const;
export type NextRelation = (typeof NEXT_REL)[keyof typeof NEXT_REL];

export type NextRouter = "app" | "pages";
export type NextRouteKind = "page" | "api" | "layout" | "infra";
export type NextRendering = "server" | "client";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const APP_SPECIAL = new Set(["layout", "template", "loading", "error", "not-found", "global-error", "default"]);
const PAGES_INFRA = new Set(["_app", "_document", "_error"]);
const ROUTE_EXTS = [".tsx", ".ts", ".jsx", ".js", ".mdx"];

function norm(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}
function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i);
}
function baseNoExt(p: string): string {
  const b = p.split("/").pop() || p;
  const i = b.lastIndexOf(".");
  return i < 0 ? b : b.slice(0, i);
}

/** Converte um segmento de diretório Next em segmento de URL (ou null se some). */
function segmentToUrl(seg: string): string | null {
  if (seg === "") return null;
  if (seg.startsWith("(") && seg.endsWith(")")) return null; // route group
  if (seg.startsWith("@")) return null;                      // parallel slot
  const optCatch = seg.match(/^\[\[\.\.\.(.+)\]\]$/);
  if (optCatch) return `*${optCatch[1]}?`;
  const catchAll = seg.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll) return `*${catchAll[1]}`;
  const dyn = seg.match(/^\[(.+)\]$/);
  if (dyn) return `:${dyn[1]}`;
  return seg;
}

/**
 * Deriva a URL de rota a partir dos segmentos de diretório (sem o nome do
 * arquivo). Determinístico. `/` para a raiz.
 */
export function segmentsToRoute(dirSegments: string[]): string {
  const parts: string[] = [];
  for (const seg of dirSegments) {
    const u = segmentToUrl(seg);
    if (u !== null) parts.push(u);
  }
  return "/" + parts.join("/");
}

export interface NextRouteInfo {
  router: NextRouter;
  kind: NextRouteKind;
  /** URL navegável/da API (ex.: `/users/:id`). */
  route: string;
  /** nome do arquivo especial (page/route/layout/_app…) p/ kind=layout/infra. */
  special?: string;
  filePath: string;
}

/**
 * Classifica um arquivo como rota/componente Next, ou null se não for parte do
 * roteamento. PURO — só olha o caminho. Reconhece o segmento-raiz `app`/`pages`
 * (inclusive sob `src/`).
 */
export function classifyNextFile(filePath: string): NextRouteInfo | null {
  const p = norm(filePath);
  if (!ROUTE_EXTS.includes(extOf(p))) return null;
  const parts = p.split("/");
  // acha o segmento-raiz do roteador (último `app`/`pages`, aceita `src/app`).
  let rootIdx = -1;
  let router: NextRouter | null = null;
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i] === "app") { rootIdx = i; router = "app"; break; }
    if (parts[i] === "pages") { rootIdx = i; router = "pages"; break; }
  }
  if (rootIdx < 0 || !router) return null;

  const rel = parts.slice(rootIdx + 1); // segmentos após app/pages, inclui o arquivo
  const fileName = rel[rel.length - 1];
  const dirSegments = rel.slice(0, -1);
  const stem = baseNoExt(fileName);

  if (router === "app") {
    if (stem === "page") return { router, kind: "page", route: segmentsToRoute(dirSegments), filePath: p };
    if (stem === "route") return { router, kind: "api", route: segmentsToRoute(dirSegments), filePath: p };
    if (APP_SPECIAL.has(stem)) return { router, kind: "layout", special: stem, route: segmentsToRoute(dirSegments), filePath: p };
    return null; // outros arquivos do app/ não são rota por si
  }

  // Pages Router
  if (PAGES_INFRA.has(stem)) return { router, kind: "infra", special: stem, route: "", filePath: p };
  const isApi = dirSegments[0] === "api";
  const urlSegments = isApi ? dirSegments.slice(1) : dirSegments;
  const stemSeg = stem === "index" ? null : segmentToUrl(stem);
  const fullSegments = stemSeg === null ? urlSegments : [...urlSegments, stem];
  const route = segmentsToRoute(fullSegments);
  return { router, kind: isApi ? "api" : "page", route: isApi ? route : route, filePath: p };
}

export interface NextSourceFacts {
  rendering: NextRendering;
  /** métodos HTTP exportados (rotas de API App Router). */
  httpMethods: string[];
  /** data-fetching do Pages Router detectado (getServerSideProps…). */
  dataFetching: string[];
}

const DATA_FETCHING = ["getServerSideProps", "getStaticProps", "getInitialProps", "getStaticPaths"];

/** Detecta a diretiva `"use client"` nas primeiras linhas (antes de código). */
function hasUseClientDirective(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteralLike(stmt.expression)) {
      const v = stmt.expression.text;
      if (v === "use client") return true;
      continue; // outra directive prologue → segue
    }
    break; // primeiro statement não-string encerra o prologue
  }
  return false;
}

/**
 * Lê fatos do fonte (server/client + métodos/data-fetching) via parser TS real.
 * App Router default = server. PURO (não lança).
 */
export function parseNextSource(filePath: string, content: string, router: NextRouter): NextSourceFacts {
  const facts: NextSourceFacts = { rendering: router === "app" ? "server" : "client", httpMethods: [], dataFetching: [] };
  if (!content) return facts;
  let sf: ts.SourceFile;
  try {
    sf = parseTypeScript(content, filePath);
  } catch {
    return facts;
  }

  if (hasUseClientDirective(sf)) facts.rendering = "client";

  const noteExport = (name: string) => {
    if (HTTP_METHODS.includes(name) && !facts.httpMethods.includes(name)) facts.httpMethods.push(name);
    if (DATA_FETCHING.includes(name) && !facts.dataFetching.includes(name)) facts.dataFetching.push(name);
  };

  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isExported = mods?.some((mod) => mod.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name) noteExport(stmt.name.text);
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) noteExport(d.name.text);
      }
    }
  }
  return facts;
}

// ── ids e construtores de nó/aresta ──

function slugRoute(route: string): string {
  return route === "/" ? "root" : route.replace(/^\//, "").replace(/\//g, "_");
}

export function nextRouteId(info: NextRouteInfo): string {
  if (info.kind === "api") return `route:next:api:${info.router}:${slugRoute(info.route)}`;
  if (info.kind === "page") return `route:next:${info.router}:${slugRoute(info.route)}`;
  return `component:next:${norm(info.filePath)}`; // layout/infra: só componente
}
export function nextComponentId(filePath: string): string {
  return `component:next:${norm(filePath)}`;
}
export function nextHandlerId(info: NextRouteInfo, method: string): string {
  return `${nextRouteId(info)}#${method}`;
}

export function makeNextRouteNode(info: NextRouteInfo): RawSystemNode {
  return {
    id: nextRouteId(info),
    type: "ROUTE",
    className: info.route || "/",
    metadata: { framework: "next", router: info.router, kind: info.kind, route: info.route, sourceFile: info.filePath },
  };
}
export function makeNextComponentNode(info: NextRouteInfo, facts: NextSourceFacts): RawSystemNode {
  return {
    id: nextComponentId(info.filePath),
    type: info.kind === "page" ? "VIEW" : "COMPONENT",
    className: info.special ?? baseNoExt(info.filePath),
    metadata: {
      framework: "next",
      router: info.router,
      rendering: facts.rendering,
      sourceFile: info.filePath,
      ...(facts.dataFetching.length ? { dataFetching: facts.dataFetching } : {}),
      ...(info.special ? { special: info.special } : {}),
    },
  };
}

export interface NextGraphStats {
  routesAdded: number;
  componentsAdded: number;
  rendersEdges: number;
  handlesEdges: number;
  wrapsEdges: number;
  apiHandlers: number;
  clientComponents: number;
  serverComponents: number;
}

interface MinimalGraph {
  nodes: RawSystemNode[];
  edges: RawSystemEdge[];
}

function zeroStats(): NextGraphStats {
  return { routesAdded: 0, componentsAdded: 0, rendersEdges: 0, handlesEdges: 0, wrapsEdges: 0, apiHandlers: 0, clientComponents: 0, serverComponents: 0 };
}

/**
 * Produtor: mescla as rotas/componentes Next como subgrafo. PURO (clona),
 * dedup por id de nó e tripla de aresta, INERTE. Ignora arquivos fora do
 * roteamento sem erro.
 */
export function mergeNextGraph<G extends MinimalGraph>(
  rawGraph: G | null | undefined,
  files: { filePath: string; content: string }[] | null | undefined,
): { graph: G; stats: NextGraphStats } {
  const stats = zeroStats();
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) {
    return { graph: rawGraph as G, stats };
  }
  const list = (files ?? []).filter((f) => f && typeof f.filePath === "string");
  if (list.length === 0) return { graph: rawGraph, stats };

  const graph = { ...rawGraph, nodes: rawGraph.nodes.slice(), edges: rawGraph.edges.slice() } as G;
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  const seenEdge = new Set<string>();
  for (const e of graph.edges) seenEdge.add(`${e.fromNode}|${e.toNode}|${e.relationType}`);

  const addNode = (n: RawSystemNode): boolean => {
    if (existingIds.has(n.id)) return false;
    existingIds.add(n.id);
    graph.nodes.push(n);
    return true;
  };
  const addEdge = (e: RawSystemEdge): boolean => {
    const key = `${e.fromNode}|${e.toNode}|${e.relationType}`;
    if (seenEdge.has(key)) return false;
    seenEdge.add(key);
    graph.edges.push(e);
    return true;
  };

  // layouts/templates por diretório p/ ligar WRAPS a rotas do mesmo segmento.
  const layoutsByDir = new Map<string, NextRouteInfo>();
  const classified: { info: NextRouteInfo; facts: NextSourceFacts }[] = [];
  for (const file of list) {
    const info = classifyNextFile(file.filePath);
    if (!info) continue;
    const facts = parseNextSource(file.filePath, file.content ?? "", info.router);
    classified.push({ info, facts });
    if (info.kind === "layout" && info.special === "layout") {
      const dir = norm(info.filePath).split("/").slice(0, -1).join("/");
      layoutsByDir.set(dir, info);
    }
  }

  for (const { info, facts } of classified) {
    if (info.kind === "infra") {
      if (addNode(makeNextComponentNode(info, facts))) stats.componentsAdded++;
      continue;
    }

    if (info.kind === "layout") {
      if (addNode(makeNextComponentNode(info, facts))) stats.componentsAdded++;
      if (facts.rendering === "client") stats.clientComponents++; else stats.serverComponents++;
      continue;
    }

    // page / api → nó ROUTE
    if (addNode(makeNextRouteNode(info))) stats.routesAdded++;

    if (info.kind === "page") {
      const comp = makeNextComponentNode(info, facts);
      if (addNode(comp)) stats.componentsAdded++;
      if (facts.rendering === "client") stats.clientComponents++; else stats.serverComponents++;
      if (addEdge({ fromNode: nextRouteId(info), toNode: comp.id, relationType: NEXT_REL.RENDERS, metadata: { resolution: "convention-path", rendering: facts.rendering } })) {
        stats.rendersEdges++;
      }
      // layout do mesmo diretório envolve a rota
      const dir = norm(info.filePath).split("/").slice(0, -1).join("/");
      const layout = layoutsByDir.get(dir);
      if (layout) {
        if (addEdge({ fromNode: nextComponentId(layout.filePath), toNode: nextRouteId(info), relationType: NEXT_REL.WRAPS, metadata: { resolution: "convention-path" } })) {
          stats.wrapsEdges++;
        }
      }
    } else {
      // api: um HANDLER por método HTTP exportado (App) ou default (Pages)
      const methods = info.router === "app" ? facts.httpMethods : (facts.httpMethods.length ? facts.httpMethods : ["DEFAULT"]);
      for (const method of methods) {
        const hId = nextHandlerId(info, method);
        addNode({ id: hId, type: "HANDLER", className: `${method} ${info.route}`, metadata: { framework: "next", router: info.router, method, sourceFile: info.filePath } });
        if (addEdge({ fromNode: nextRouteId(info), toNode: hId, relationType: NEXT_REL.HANDLES, metadata: { resolution: "convention-path", method } })) {
          stats.handlesEdges++;
          stats.apiHandlers++;
        }
      }
    }
  }

  return { graph, stats };
}

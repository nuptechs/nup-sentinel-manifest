// ─────────────────────────────────────────────────────────────────────────
// OBS-D03 (ADR-0036 WS-D) — WIRING ROTA→HANDLER no grafo de sistema.
//
// O grafo tem as superfícies de entrada (CONTROLLER Java com @…Mapping, ROUTE
// Express do gateway, VIEW roteada) mas o fato de ELAS SEREM ROTEADAS é hoje
// IMPLÍCITO (vive só no metadata do nó: `httpMethod`+`fullPath`, ou no fato de
// a VIEW ter sido mintada como página roteada). Nenhuma ARESTA do grafo prova
// "esta superfície está montada/roteada" — por isso o `reasoner/dead-code.ts`
// EXCLUI por honestidade toda CONTROLLER/ROUTE/VIEW com inDegree 0 (não sabe
// distinguir órfã de alcançada-pelo-framework) e o `orphan-surface.ts` (OBS-E01)
// fica CEGO até existir o wiring (`wiringPresent:false`).
//
// ESTE MÓDULO é o PRODUTOR desse wiring: deriva, dos fatos de REGISTRO que já
// vivem no grafo cru, arestas de roteamento cujo `toNode` É a superfície montada
// (o contrato que o `orphan-surface.ts` consome: `HANDLES_ROUTE`/`MOUNTS`/
// `RENDERS_VIEW`). Uma superfície COM fato de registro ganha aresta de wiring
// (fica viva por construção); uma CONTROLLER/ROUTE/VIEW SEM fato de registro
// (ex.: controller parseado sem nenhum mapeamento HTTP) NÃO ganha — e aí sim o
// `orphan-surface.ts` pode acusá-la como candidata a órfã.
//
// INERTE por construção (régua D2 da ADR-0037): nenhum estágio do pipeline chama
// isto, logo o `/graph` servido continua byte-a-byte (gates G2/G3 intactos). O
// consumo (ligar no pipeline atrás de flag, ou servir num endpoint de triagem)
// entra num PR seguinte — a mesma estratégia inerte do `field-graph.ts` (D05) e
// do `orphan-surface.ts` (E01), que ESPERA exatamente estas arestas.
//
// HONESTIDADE (§2.3 ADR-0036): o verbo+path do mapeamento é PARSEADO (real), mas
// o ELO rota→nó é por convenção de metadata, não resolução de compilador — por
// isso a aresta nasce `synthetic:true, resolution:"convention-name"` (o
// `classifyEdgeEvidence` a classifica STATIC_UNRESOLVED/0.40, DECLARADA, não
// provada). PURA: nunca lança, nenhum I/O.
// ─────────────────────────────────────────────────────────────────────────

import type { RawSystemNode, RawSystemEdge, RawSystemGraph } from "./system-graph";
import { isMalformedEndpointPath } from "./application-graph";

/**
 * Relações de wiring de roteamento — ALINHADAS 1:1 com o
 * `DEFAULT_WIRING_RELATIONS` do `orphan-surface.ts` (uma só definição de
 * "wiring"). O `toNode` de cada aresta É a superfície montada.
 */
export const WIRING_REL = {
  /** mapeamento HTTP → a CONTROLLER/handler que o atende (controller é `toNode`). */
  HANDLES_ROUTE: "HANDLES_ROUTE",
  /** registro de rota (`app.METHOD(path,…)`) → o nó ROUTE do gateway (route é `toNode`). */
  MOUNTS: "MOUNTS",
  /** router SPA → a VIEW/tela que ele renderiza (view é `toNode`). */
  RENDERS_VIEW: "RENDERS_VIEW",
} as const;
export type WiringRelation = (typeof WIRING_REL)[keyof typeof WIRING_REL];

/** Nós-origem sintéticos do wiring — representam o MECANISMO de entrada (fora do
 *  grafo de código). Mintados só quando há ao menos 1 aresta daquele mecanismo. */
export const ENTRY_HTTP = "entry:http-router" as const;
export const ENTRY_SPA = "entry:spa-router" as const;

const ENTRY_NODE_TYPE = "ENTRYPOINT" as const;

export interface RouteWiringStats {
  /** CONTROLLER Java com @…Mapping (verbo+path) → aresta HANDLES_ROUTE emitida. */
  controllersWired: number;
  /** ROUTE Express (verbo+path) → aresta MOUNTS emitida. */
  routesMounted: number;
  /** VIEW roteada → aresta RENDERS_VIEW emitida. */
  viewsRendered: number;
  /** superfície (CONTROLLER/ROUTE/VIEW) SEM fato de registro → NÃO fiada (honesto). */
  surfacesSkipped: number;
}

export interface RouteWiringResult {
  /** nós-origem sintéticos a adicionar (0, 1 ou 2 — só os que têm aresta). */
  nodes: RawSystemNode[];
  /** arestas de wiring (toNode = superfície). */
  edges: RawSystemEdge[];
  stats: RouteWiringStats;
}

function metaStr(n: RawSystemNode, key: string): string | undefined {
  const v = (n.metadata || {})[key];
  return typeof v === "string" && v ? v : undefined;
}

/** CONTROLLER/ROUTE é REGISTRADA? (verbo HTTP + path bem-formado no metadata). */
function hasHttpRegistration(n: RawSystemNode): boolean {
  const method = metaStr(n, "httpMethod");
  const path = metaStr(n, "fullPath");
  if (!method || !path) return false;
  if (method.toUpperCase() === "ALL") return false; // mount genérico, não um endpoint
  return !isMalformedEndpointPath(path);
}

/**
 * Deriva o wiring de roteamento do grafo cru. PURA. Emite uma aresta por
 * superfície REGISTRADA (toNode = a superfície); superfícies sem fato de
 * registro ficam de fora (contadas em `surfacesSkipped`) — é esse resíduo que o
 * `orphan-surface.ts` poderá acusar.
 */
export function buildRouteHandlerWiring(
  raw: RawSystemGraph | null | undefined,
): RouteWiringResult {
  const stats: RouteWiringStats = { controllersWired: 0, routesMounted: 0, viewsRendered: 0, surfacesSkipped: 0 };
  const edges: RawSystemEdge[] = [];
  if (!raw || !Array.isArray(raw.nodes)) return { nodes: [], edges, stats };

  let usedHttp = false;
  let usedSpa = false;
  const seen = new Set<string>();
  const emit = (from: string, to: string, rel: WiringRelation) => {
    const k = `${from}|${to}|${rel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    edges.push({ fromNode: from, toNode: to, relationType: rel, metadata: { synthetic: true, resolution: "convention-name", wiring: true } });
    return true;
  };

  for (const n of raw.nodes) {
    if (!n || typeof n.id !== "string") continue;
    const type = String(n.type || "");
    if (type === "CONTROLLER") {
      if (hasHttpRegistration(n)) {
        if (emit(ENTRY_HTTP, n.id, WIRING_REL.HANDLES_ROUTE)) { stats.controllersWired++; usedHttp = true; }
      } else {
        stats.surfacesSkipped++; // controller sem mapeamento HTTP → candidato a órfão
      }
    } else if (type === "ROUTE") {
      if (hasHttpRegistration(n)) {
        if (emit(ENTRY_HTTP, n.id, WIRING_REL.MOUNTS)) { stats.routesMounted++; usedHttp = true; }
      } else {
        stats.surfacesSkipped++;
      }
    } else if (type === "VIEW") {
      // VIEW neste repo nasce já ROTEADA (`full-stack-augment` só minta página do
      // router). O fato de registro é a própria existência do nó VIEW — o router
      // SPA a renderiza. Sem sourceFile (nó sintético incompleto) → não fia.
      if (metaStr(n, "sourceFile")) {
        if (emit(ENTRY_SPA, n.id, WIRING_REL.RENDERS_VIEW)) { stats.viewsRendered++; usedSpa = true; }
      } else {
        stats.surfacesSkipped++;
      }
    }
  }

  const nodes: RawSystemNode[] = [];
  if (usedHttp) nodes.push({ id: ENTRY_HTTP, type: ENTRY_NODE_TYPE, className: "HTTP Router", metadata: { synthetic: true, entryMechanism: "http" } });
  if (usedSpa) nodes.push({ id: ENTRY_SPA, type: ENTRY_NODE_TYPE, className: "SPA Router", metadata: { synthetic: true, entryMechanism: "spa" } });

  return { nodes, edges, stats };
}

/**
 * Devolve um CLONE do grafo cru com o wiring de roteamento adicionado (nós-origem
 * + arestas). PURA: não muta a entrada. Idempotente (dedup por id de nó e por
 * tripla de aresta). É a ponte que faz o `orphan-surface.ts` sair de CEGO
 * (`wiringPresent:false`) para AVALIANDO — sem tocar o pipeline nem o `/graph`
 * default (quem chama isto opta explicitamente).
 */
export function augmentGraphWithRouteWiring(
  raw: RawSystemGraph,
): { graph: RawSystemGraph; stats: RouteWiringStats } {
  const { nodes, edges, stats } = buildRouteHandlerWiring(raw);
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return { graph: raw, stats };
  }
  if (nodes.length === 0 && edges.length === 0) {
    return { graph: raw, stats };
  }
  const existingIds = new Set(raw.nodes.map((n) => n.id));
  const seenEdge = new Set<string>();
  for (const e of raw.edges) seenEdge.add(`${e.fromNode}|${e.toNode}|${e.relationType}`);

  const graph: RawSystemGraph = { ...raw, nodes: raw.nodes.slice(), edges: raw.edges.slice() };
  for (const n of nodes) {
    if (existingIds.has(n.id)) continue;
    existingIds.add(n.id);
    graph.nodes.push(n);
  }
  for (const e of edges) {
    const k = `${e.fromNode}|${e.toNode}|${e.relationType}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    graph.edges.push(e);
  }
  return { graph, stats };
}

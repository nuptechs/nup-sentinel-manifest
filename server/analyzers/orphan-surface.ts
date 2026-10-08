// ─────────────────────────────────────────────────────────────────────────
// OBS-E01 (ADR-0036 WS-E) — DETECTOR DE SUPERFÍCIE ÓRFÃ (controller/rota/tela).
//
// Hoje a triagem tri-eixo (reasoner/dead-code.ts) EXCLUI por honestidade toda
// superfície de entrada (CONTROLLER/ROUTE/VIEW) com inDegree 0: nenhum código a
// chama porque o framework HTTP/o router é que a alcança "de fora". O comentário
// do próprio dead-code.ts diz: "Detectar um controller/rota realmente órfão exige
// o wiring de roteamento (rota→handler), não o grafo de chamada".
//
// Este módulo é esse detector — mas SÓ dispara quando o wiring de roteamento
// EXISTE no grafo (OBS-D03). A regra: uma superfície é ÓRFÃ quando NENHUMA aresta
// de WIRING (rota a monta/roteia/renderiza) aterrissa nela, E ela não tem tráfego
// de runtime, E não é ponto de entrada por gatilho. Sem wiring no grafo, o
// detector se DECLARA cego (`wiringPresent:false`, zero candidatos) — nunca acusa
// tudo como órfão (seria o exato falso-positivo que o dead-code.ts evita). Assim
// ele é MERGEÁVEL e INERTE até D03 começar a emitir as arestas de wiring.
//
// PURO: nunca lança, nenhum I/O. A IA não entra — o veredito é determinístico
// (§2.3 da ADR-0036: IA nunca é juiz).
// ─────────────────────────────────────────────────────────────────────────

import type { ShapedGraph, ShapedNode, ShapedEdge } from "./system-graph";

/** Superfícies de entrada — alcançadas de FORA do grafo de código. Alinhado com
 *  o `ENTRY_SURFACE_TYPES` do reasoner/dead-code.ts (uma só definição de "superfície"). */
export const ENTRY_SURFACE_TYPES = new Set(["CONTROLLER", "ROUTE", "VIEW"]);

/**
 * Relações que PROVAM que uma superfície está montada/roteada (o wiring de D03).
 * Default conservador; o produtor D03 passa o seu conjunto real via `opts.wiringRelations`.
 * Enquanto NENHUMA dessas arestas existir no grafo, o detector fica cego por projeto.
 */
export const DEFAULT_WIRING_RELATIONS = new Set(["HANDLES_ROUTE", "ROUTES_TO", "MOUNTS", "RENDERS_VIEW"]);

export type OrphanTier = "orphan-surface";

export interface OrphanSurfaceCandidate {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  tier: OrphanTier;
  reasons: string[];
  /** 0..1, nunca 1 — wiring estático erra por montagem dinâmica/reflexão. */
  confidence: number;
}

export interface OrphanSurfaceExclusions {
  /** superfície COM wiring de entrada (montada/roteada) — viva por construção. */
  wired: number;
  /** superfície exercitada por tráfego real — viva, fim de papo. */
  runtimeObserved: number;
  /** superfície que é gatilho/root legítimo (@Scheduled/listener). */
  entryPoint: number;
}

export interface OrphanSurfaceReport {
  /** false = o grafo NÃO tem nenhuma aresta de wiring → detector CEGO (honesto). */
  wiringPresent: boolean;
  candidates: OrphanSurfaceCandidate[];
  excluded: OrphanSurfaceExclusions;
  surfacesTotal: number;
  summary: string;
}

function labelOf(n: ShapedNode): string {
  return n.className || n.methodName || (typeof n.id === "string" ? n.id.split(":").pop() || n.id : "?");
}
function isObserved(n: ShapedNode): boolean {
  return n.observed === true || n.runtimeHot === true || n.evidence?.method === "RUNTIME_OBSERVED";
}
function isEntryPoint(n: ShapedNode): boolean {
  return Array.isArray(n.entryPoint) && n.entryPoint.length > 0;
}

/**
 * Detecta superfícies de entrada órfãs. PURO, nunca lança.
 *
 * @param graph  grafo shaped (nós + arestas com relationType).
 * @param opts.wiringRelations  conjunto de relações que contam como wiring de
 *   roteamento (default `DEFAULT_WIRING_RELATIONS`). Vazio → usa o default.
 *
 * Guarda-mestra: se o grafo não contém NENHUMA aresta de wiring, retorna
 * `wiringPresent:false` e ZERO candidatos (todas as superfícies ficam no balde
 * `wired:0`/não-acusadas) — o detector admite que não pode decidir sem o produtor.
 */
export function findOrphanSurfaces(
  graph: ShapedGraph,
  opts: { wiringRelations?: Set<string> } = {},
): OrphanSurfaceReport {
  const wiring = opts.wiringRelations && opts.wiringRelations.size > 0 ? opts.wiringRelations : DEFAULT_WIRING_RELATIONS;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  // Arestas de WIRING que aterrissam em cada nó (toNode = a superfície montada).
  const wiredInto = new Set<string>();
  let wiringPresent = false;
  for (const e of edges as ShapedEdge[]) {
    if (!e || typeof e.toNode !== "string" || typeof e.relationType !== "string") continue;
    if (!wiring.has(e.relationType)) continue;
    wiringPresent = true;
    wiredInto.add(e.toNode);
  }

  const excluded: OrphanSurfaceExclusions = { wired: 0, runtimeObserved: 0, entryPoint: 0 };
  const candidates: OrphanSurfaceCandidate[] = [];
  let surfacesTotal = 0;

  for (const n of nodes) {
    if (!n || typeof n.id !== "string") continue;
    const type = String(n.type || "");
    if (!ENTRY_SURFACE_TYPES.has(type)) continue;
    surfacesTotal++;

    // CEGO sem produtor: não decide nada; conta a superfície e segue.
    if (!wiringPresent) continue;

    if (isObserved(n)) {
      excluded.runtimeObserved++;
      continue;
    }
    if (isEntryPoint(n)) {
      excluded.entryPoint++;
      continue;
    }
    if (wiredInto.has(n.id)) {
      excluded.wired++;
      continue;
    }
    // Superfície de entrada SEM wiring de roteamento, SEM runtime, SEM gatilho:
    // nada a alcança — candidata a órfã. Confiança média: o wiring estático pode
    // perder montagem dinâmica (`app.use(prefix, router)` computado), por isso < 1.
    candidates.push({
      nodeId: n.id,
      type,
      label: labelOf(n),
      ...(n.sourceFile ? { sourceFile: n.sourceFile } : {}),
      tier: "orphan-surface",
      confidence: 0.6,
      reasons: [
        "superfície de entrada (controller/rota/tela) sem wiring de roteamento que a monte",
        "sem tráfego observado em runtime",
        "não é ponto de entrada por gatilho (@Scheduled/listener)",
      ],
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.type.localeCompare(b.type) || a.label.localeCompare(b.label));

  const summary = !wiringPresent
    ? `Detector cego: o grafo não tem arestas de wiring de roteamento (OBS-D03 ainda não emite para este projeto). ${surfacesTotal} superfície(s) de entrada não avaliadas — honesto, nenhuma acusada.`
    : candidates.length === 0
      ? `Nenhuma superfície órfã: as ${surfacesTotal} superfície(s) de entrada ou têm wiring, ou rodam em runtime, ou são gatilho.`
      : `${candidates.length} superfície(s) de entrada órfã(s) de ${surfacesTotal} — sem wiring de roteamento, sem runtime, sem gatilho (excluídas: ${excluded.wired} com wiring, ${excluded.runtimeObserved} observadas, ${excluded.entryPoint} gatilho).`;

  return { wiringPresent, candidates, excluded, surfacesTotal, summary };
}

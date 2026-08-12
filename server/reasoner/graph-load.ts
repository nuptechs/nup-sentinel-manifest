// ─────────────────────────────────────────────
// Loader ÚNICO do grafo do Reasoner — lê o MESMO mapa que o `/graph` serve.
//
// O problema que isto fecha: cada endpoint `/reasoner/*` (e o `/narrative`)
// moldava o `manifest.systemGraph` CRU do snapshot — sem mesclar os overlays
// PROVADOS que ficam no store lateral do projeto (`scipEdges` → STATIC_PROVEN,
// compiler-accurate; `configEdges` → CONFIG_PROVEN, wiring de DI). Só o `/graph`
// e o `/bimr` mesclavam (via `applyPersistedOverlays`). Resultado: o Reasoner
// raciocinava sobre um grafo INCOMPLETO —
//   • o veredito subestimava a cobertura provada (ex.: NuPIdentify lia 0
//     STATIC_PROVEN e um provenRatio de 16%, quando o mapa real tem 643 arestas
//     provadas pelo compilador e ~45% de cobertura provada);
//   • o dead-code inventava "sem chamador provado" para funções cujo ÚNICO
//     chamador é uma aresta CALLS provada pelo scip que nem estava no grafo;
//   • domínios/mecanismo perdiam as arestas função→função do call-graph real.
//
// A correção é reuso puro (§2.5): TODO consumidor do grafo passa por aqui, que
// aplica os overlays (fail-soft, byte-a-byte sem payload) ANTES de moldar — a
// mesma receita canônica do `/graph`. Sem 2ª verdade.
// ─────────────────────────────────────────────

import type { ShapedGraph } from "../analyzers/system-graph";

/** Só o que o loader precisa do storage — injetado (hexagonal, testável sem DB). */
export interface ReasonerGraphDeps {
  getSnapshots: (
    projectId: number,
  ) => Promise<Array<{ manifestJson: unknown; analysisRunId: number | null }>>;
  getProject: (projectId: number) => Promise<unknown>;
  logger?: { error: (...a: unknown[]) => void };
}

export interface LoadedReasonerGraph {
  ok: true;
  /** grafo MOLDADO já com os overlays provados mesclados (scip + config). */
  shaped: ShapedGraph;
  analysisRunId: number | null;
  /** o manifest cru do snapshot (ex.: `adrLinks`, `allEntitiesFromGraph`). */
  manifest: Record<string, unknown>;
  /** o projeto persistido (reusado por quem precisa de config de runtime). */
  project: unknown;
  /** estatística dos merges (ausente quando não houve overlay). */
  overlays: { scipStats?: unknown; configStats?: unknown };
  /** IMPORT-REACHABILITY: conjunto de arquivos (relative_path) IMPORTADOS por outro
   *  arquivo do projeto — eixo dedicado de dead-code (modelo Knip). Vazio se não houver
   *  o campo `imports` no store scip (retrocompat). */
  importReachableFiles: Set<string>;
  /** ENTRY-FILES por CONFIG: arquivos rodados direto (package.json/index.html) — raízes
   *  legítimas do dead-code. Vazio se não houver o campo `entryFiles` (retrocompat). */
  configEntryFiles: Set<string>;
}

export interface LoadFailure {
  ok: false;
  status: number;
  body: { code?: string; message: string };
}

export type LoadResult = LoadedReasonerGraph | LoadFailure;

const NO_SNAPSHOT: LoadFailure = {
  ok: false,
  status: 404,
  body: { message: "No analysis snapshot for this project yet — run an analysis first." },
};
const NO_GRAPH: LoadFailure = {
  ok: false,
  status: 404,
  body: { code: "GRAPH_NOT_IN_SNAPSHOT", message: "Este snapshot precede o system graph — re-rode a análise." },
};

/**
 * Carrega o grafo do snapshot mais recente, mescla os overlays provados e molda.
 * Fail-soft: falha de carregar o projeto ou de mesclar um overlay NÃO derruba —
 * serve-se o melhor grafo disponível (um mapa que morre por causa de um overlay
 * é pior que o mapa sem o overlay).
 */
export async function loadReasonerGraph(
  projectId: number,
  deps: ReasonerGraphDeps,
  level: "class" | "method" = "class",
): Promise<LoadResult> {
  const logger = deps.logger ?? console;
  const snapshots = await deps.getSnapshots(projectId);
  if (!snapshots.length) return NO_SNAPSHOT;

  const manifest = ((snapshots[0].manifestJson as Record<string, unknown>) || {}) as Record<string, unknown>;
  const sg = manifest.systemGraph as { nodes?: unknown; edges?: unknown } | undefined;
  if (!sg || !Array.isArray(sg.nodes) || !Array.isArray(sg.edges)) return NO_GRAPH;

  let project: unknown = null;
  try {
    project = await deps.getProject(projectId);
  } catch (e) {
    logger.error("[reasoner] project load failed (fail-soft, raw graph):", e);
  }

  const { applyPersistedOverlays } = await import("../analyzers/graph-overlays");
  const overlays = await applyPersistedOverlays(sg as never, project as never, logger);

  const { shapeSystemGraph } = await import("../analyzers/system-graph");
  const shaped = shapeSystemGraph(overlays.graph, level);

  // Conjuntos de import-reachability e entry-files por config (o lado `to` dos pares /
  // a lista `entryFiles`) — fail-soft.
  const importReachableFiles = new Set<string>();
  const configEntryFiles = new Set<string>();
  try {
    const scipStore = (project as { scipEdges?: { imports?: unknown; entryFiles?: unknown } } | null)?.scipEdges;
    const imp = scipStore?.imports;
    if (Array.isArray(imp)) {
      for (const e of imp) {
        const to = (e as { to?: unknown })?.to;
        if (typeof to === "string" && to) importReachableFiles.add(to);
      }
    }
    const ef = scipStore?.entryFiles;
    if (Array.isArray(ef)) {
      for (const f of ef) if (typeof f === "string" && f) configEntryFiles.add(f);
    }
  } catch (e) {
    logger.error("[reasoner] import-reachability/entry-files load failed (fail-soft):", e);
  }

  return {
    ok: true,
    shaped,
    analysisRunId: snapshots[0].analysisRunId ?? null,
    manifest,
    project,
    overlays: {
      ...(overlays.scipStats ? { scipStats: overlays.scipStats } : {}),
      ...(overlays.configStats ? { configStats: overlays.configStats } : {}),
    },
    importReachableFiles,
    configEntryFiles,
  };
}

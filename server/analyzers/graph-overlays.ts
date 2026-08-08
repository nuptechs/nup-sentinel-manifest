// ─────────────────────────────────────────────────────────────────────────
// Mescla (na LEITURA) as evidências externas provadas que ficam guardadas no
// projeto: `scipEdges` (STATIC_PROVEN, compiler-accurate — ADR-0025 Onda 9) e
// `configEdges` (CONFIG_PROVEN, wiring de DI — ADR-0035 §4).
//
// Extraído do handler do `/graph` para que TODO consumidor do grafo leia
// exatamente o mesmo mapa (o `/bimr` seria uma 2ª verdade se lesse só o
// snapshot cru). Comportamento preservado byte-a-byte:
//   • ORDEM: scip PRIMEIRO, config DEPOIS — assim a config enxerga os pares já
//     provados pelo scip e cede a eles (precedência scip > config);
//   • GATED: sem payload (ou payload vazio) nada roda — grafo cru intacto;
//   • FAIL-SOFT: erro em um merge não derruba o endpoint nem cancela o outro —
//     serve-se o melhor grafo disponível. Um mapa que morre por causa de um
//     overlay é pior que um mapa sem o overlay.
// ─────────────────────────────────────────────────────────────────────────

import type { RawSystemGraph } from "./system-graph";

export interface OverlayApplyResult {
  graph: RawSystemGraph;
  /** estatística do merge scip (ausente quando não houve merge). */
  scipStats?: unknown;
  /** estatística do merge config (ausente quando não houve merge). */
  configStats?: unknown;
}

/** Só o que interessa do projeto persistido (evita acoplar ao tipo do Drizzle). */
export interface OverlaySource {
  scipEdges?: unknown;
  configEdges?: unknown;
}

function hasEdges(payload: unknown): payload is { edges: unknown[] } {
  const p = payload as { edges?: unknown } | null | undefined;
  return !!p && Array.isArray(p.edges) && p.edges.length > 0;
}

export async function applyPersistedOverlays(
  systemGraph: RawSystemGraph,
  project: OverlaySource | null | undefined,
  logger: { error: (...a: unknown[]) => void } = console,
): Promise<OverlayApplyResult> {
  let graph = systemGraph;
  let scipStats: unknown;
  let configStats: unknown;

  try {
    const scip = project?.scipEdges;
    if (hasEdges(scip)) {
      const { mergeScipEdges } = await import("./scip-aggregate");
      const merged = mergeScipEdges(graph, scip as never);
      graph = merged.graph;
      scipStats = merged.stats;
    }
  } catch (e) {
    logger.error("scip-edges merge failed (fail-soft, serving raw graph):", e);
  }

  try {
    const config = project?.configEdges;
    if (hasEdges(config)) {
      const { mergeConfigEdges } = await import("./config-aggregate");
      const merged = mergeConfigEdges(graph, config as never);
      graph = merged.graph;
      configStats = merged.stats;
    }
  } catch (e) {
    logger.error("config-edges merge failed (fail-soft, serving raw graph):", e);
  }

  return {
    graph,
    ...(scipStats ? { scipStats } : {}),
    ...(configStats ? { configStats } : {}),
  };
}

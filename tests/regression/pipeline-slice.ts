// ─────────────────────────────────────────────
// Pipeline slice — ADR-0015 Onda 0.
//
// Roda, em processo (sem JVM, sem Postgres), a MESMA sequência de estágios
// puros que o AnalysisPipeline compõe (analysis-pipeline.ts) para produzir
// o snapshot determinístico do golden test:
//
//   split por extensão (espelha analysis-pipeline.ts:110-111)
//   → buildApplicationGraph (fallback TS do Java)
//   → augmentGraphWithWsV1 (convenção WsV1)
//   → analyzeGraphEndpoints
//   → analyzeFrontend
//   → extractGatewayPrefixes + mapInteractionsToGatewayPrefixes
//   → detectArchitecture
//   → catalog entries (endpoint + WsV1 + interações) → classificador determinístico
//   → detectFrontendBackendInconsistencies
//
// O resultado é serializado de forma ESTÁVEL (arrays ordenados, sem campos
// não-determinísticos) para comparação byte-a-byte com o golden versionado.
// Helper de teste: vive em tests/ de propósito — este PR não muda NADA de
// runtime (G2 por construção).
// ─────────────────────────────────────────────

import {
  buildApplicationGraph,
  analyzeGraphEndpoints,
} from "../../server/analyzers/java-analyzer.ts";
import {
  augmentGraphWithWsV1,
  extractGatewayPrefixes,
  mapInteractionsToGatewayPrefixes,
} from "../../server/analyzers/nuptechs-conventions.ts";
import { analyzeFrontend } from "../../server/analyzers/frontend-analyzer.ts";
import {
  endpointImpactsToCatalogEntries,
  wsv1NodesToCatalogEntries,
  interactionsToCatalogEntries,
} from "../../server/analyzers/graph-connector.ts";
import { detectArchitecture } from "../../server/analyzers/architecture-detector.ts";
import { classifyEntriesDeterministic } from "../../server/analyzers/deterministic-classifier.ts";
import { detectFrontendBackendInconsistencies } from "../../server/analyzers/frontend-backend-consistency.ts";

export interface SliceFile {
  filePath: string;
  content: string;
}

export interface SliceSnapshot {
  architecture: { type: string; confidence: number };
  gatewayPrefixes: string[];
  graph: { nodes: number; edges: number; entities: string[] };
  endpoints: Array<{
    endpoint: string;
    httpMethod: string | null;
    controllerClass: string | null;
    technicalOperation: string | null;
    requiredRoles: string[];
    entitiesTouched: string[];
    criticalityScore: number | null;
  }>;
  screens: Array<{
    screen: string;
    interaction: string;
    endpoint: string | null;
    httpMethod: string | null;
    resolved: boolean;
  }>;
  inconsistencies: Array<{ url: string | null; component: string }>;
  totals: {
    catalogEntries: number;
    endpointEntries: number;
    screenEntries: number;
    interactions: number;
    coveredByGatewayPrefix: number;
  };
}

function sortByKeys<T>(arr: T[], key: (t: T) => string): T[] {
  return [...arr].sort((a, b) => key(a).localeCompare(key(b)));
}

export function runPipelineSlice(files: SliceFile[]): SliceSnapshot {
  // Espelha o split do pipeline real (analysis-pipeline.ts:110-111).
  const javaFiles = files.filter((f) => f.filePath.endsWith(".java"));
  const frontendFiles = files.filter((f) => !f.filePath.endsWith(".java"));

  const graph = buildApplicationGraph(javaFiles);
  augmentGraphWithWsV1(graph, javaFiles);

  const impacts = analyzeGraphEndpoints(graph);
  const interactions = analyzeFrontend(frontendFiles, graph);

  const gatewayPrefixes = extractGatewayPrefixes(frontendFiles);
  const covered = mapInteractionsToGatewayPrefixes(interactions, gatewayPrefixes);

  const architecture = detectArchitecture(graph, files);

  // Espelha EXATAMENTE o connectGraph do pipeline real (analysis-pipeline.ts:378-410):
  // interações primeiro; impacts só se interações = 0; WsV1 com dedup (método, endpoint).
  let entriesRaw = interactionsToCatalogEntries(interactions, graph, 1, 1, architecture.type);
  if (entriesRaw.length === 0 && impacts.length > 0) {
    entriesRaw = endpointImpactsToCatalogEntries(impacts, graph, 1, 1);
  }
  const wsv1Entries = wsv1NodesToCatalogEntries(graph, 1, 1);
  const seen = new Set(entriesRaw.map((e) => `${e.httpMethod || ""} ${e.endpoint || ""}`));
  for (const e of wsv1Entries) {
    const key = `${e.httpMethod || ""} ${e.endpoint || ""}`;
    if (!seen.has(key)) {
      entriesRaw.push(e);
      seen.add(key);
    }
  }
  const entries = classifyEntriesDeterministic(entriesRaw);

  const inconsistencies = detectFrontendBackendInconsistencies(interactions);

  // Entries do lado backend carregam screen "API: <Classe>" (graph-connector.ts:248,350);
  // entries de tela carregam o nome real do componente.
  const isApiEntry = (e: { screen?: string | null }) =>
    typeof e.screen === "string" && e.screen.startsWith("API: ");
  const endpointEntries = entries.filter(isApiEntry);
  const screenEntries = entries.filter((e) => !isApiEntry(e));

  const endpoints = sortByKeys(
    endpointEntries
      .filter((e) => e.endpoint && e.endpoint !== "/")
      .map((e) => ({
        endpoint: e.endpoint as string,
        httpMethod: e.httpMethod ?? null,
        controllerClass: e.controllerClass ?? null,
        technicalOperation: e.technicalOperation ?? null,
        requiredRoles: [...((e.requiredRoles as string[] | null) ?? [])].sort(),
        entitiesTouched: [...((e.entitiesTouched as string[] | null) ?? [])].sort(),
        criticalityScore: (e.criticalityScore as number | null) ?? null,
      })),
    (e) => `${e.endpoint}|${e.httpMethod ?? ""}`,
  );

  const screens = sortByKeys(
    interactions
      .filter((i) => i.interactionCategory === "HTTP")
      .map((i) => ({
        screen: i.component,
        interaction: i.actionName,
        endpoint: i.url ?? null,
        httpMethod: i.httpMethod ?? null,
        resolved: i.mappedBackendNode != null,
      })),
    (s) => `${s.screen}|${s.interaction}|${s.endpoint ?? ""}`,
  );

  return {
    architecture: {
      type: architecture.type,
      confidence: architecture.confidence,
    },
    gatewayPrefixes: [...gatewayPrefixes].sort(),
    graph: {
      nodes: graph.getAllNodes().length,
      edges: graph.getAllEdges().length,
      entities: graph
        .getNodesByType("ENTITY")
        .map((n) => n.className)
        .sort(),
    },
    endpoints,
    screens,
    inconsistencies: sortByKeys(
      inconsistencies.map((f) => ({ url: f.url ?? null, component: f.component ?? "" })),
      (f) => `${f.url ?? ""}|${f.component}`,
    ),
    totals: {
      catalogEntries: entries.length,
      endpointEntries: endpointEntries.length,
      screenEntries: screenEntries.length,
      interactions: interactions.length,
      coveredByGatewayPrefix: covered,
    },
  };
}

import type { FrontendInteraction } from "./frontend-analyzer";
import type { JavaEndpoint, JavaServiceMethod, JavaEntity } from "./java-analyzer";
import { inferOperationType } from "./java-analyzer";
import type { InsertCatalogEntry } from "@shared/schema";

interface GraphNode {
  interaction: FrontendInteraction;
  matchedEndpoint: JavaEndpoint | null;
  resolvedServiceMethods: string[];
  resolvedRepositoryMethods: string[];
  resolvedEntities: string[];
  fullCallChain: string[];
  persistenceOperations: string[];
  inferredOperation: string;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint
    .replace(/\$\{[^}]+\}/g, "{param}")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/\/+/g, "/")
    .trim();
}

function endpointMatchScore(frontendUrl: string, backendPath: string): number {
  const normFront = normalizeEndpoint(frontendUrl);
  const normBack = backendPath.replace(/\/+/g, "/");

  if (normFront === normBack) return 100;

  const frontParts = normFront.split("/").filter(Boolean);
  const backParts = normBack.split("/").filter(Boolean);

  if (frontParts.length !== backParts.length) {
    if (normFront.includes(normBack) || normBack.includes(normFront)) return 60;
    return 0;
  }

  let matchCount = 0;
  for (let i = 0; i < frontParts.length; i++) {
    const fp = frontParts[i];
    const bp = backParts[i];
    if (fp === bp) {
      matchCount++;
    } else if (bp.startsWith("{") || fp === "{param}" || fp.startsWith(":")) {
      matchCount += 0.8;
    }
  }

  return (matchCount / frontParts.length) * 100;
}

function resolveServiceCallChain(
  serviceCalls: string[],
  allServiceMethods: JavaServiceMethod[]
): { resolvedMethods: string[]; resolvedRepos: string[]; resolvedEntities: string[] } {
  const resolvedMethods = new Set<string>();
  const resolvedRepos = new Set<string>();
  const resolvedEntities = new Set<string>();
  const visited = new Set<string>();

  function trace(calls: string[], depth: number) {
    if (depth > 10) return;

    for (const call of calls) {
      if (visited.has(call)) continue;
      visited.add(call);
      resolvedMethods.add(call);

      const [serviceName, methodName] = call.split(".");
      const matchingMethod = allServiceMethods.find(
        (sm) =>
          (sm.className === serviceName ||
            sm.className.toLowerCase() === serviceName.replace(/^[a-z]/, "").toLowerCase()) &&
          sm.methodName === methodName
      );

      if (matchingMethod) {
        for (const repo of matchingMethod.repositoryCalls) {
          resolvedRepos.add(repo);
        }
        for (const entity of matchingMethod.entitiesTouched) {
          resolvedEntities.add(entity);
        }
        if (matchingMethod.nestedServiceCalls.length > 0) {
          trace(matchingMethod.nestedServiceCalls, depth + 1);
        }
      }
    }
  }

  trace(serviceCalls, 0);
  return {
    resolvedMethods: Array.from(resolvedMethods),
    resolvedRepos: Array.from(resolvedRepos),
    resolvedEntities: Array.from(resolvedEntities),
  };
}

export function buildGraph(
  interactions: FrontendInteraction[],
  endpoints: JavaEndpoint[],
  serviceMethods: JavaServiceMethod[],
  entities: JavaEntity[]
): GraphNode[] {
  const nodes: GraphNode[] = [];

  for (const interaction of interactions) {
    let bestMatch: JavaEndpoint | null = null;
    let bestScore = 0;

    if (interaction.endpoint) {
      for (const endpoint of endpoints) {
        if (interaction.httpMethod && endpoint.httpMethod !== interaction.httpMethod) {
          continue;
        }

        const score = endpointMatchScore(interaction.endpoint, endpoint.fullPath);
        if (score > bestScore && score >= 50) {
          bestScore = score;
          bestMatch = endpoint;
        }
      }

      if (!bestMatch && interaction.httpMethod) {
        for (const endpoint of endpoints) {
          const score = endpointMatchScore(interaction.endpoint, endpoint.fullPath);
          if (score > bestScore && score >= 40) {
            bestScore = score;
            bestMatch = endpoint;
          }
        }
      }
    }

    let resolvedServiceMethods: string[] = [];
    let resolvedRepositoryMethods: string[] = [];
    let resolvedEntities: string[] = [];
    let fullCallChain: string[] = [];
    let persistenceOperations: string[] = [];

    if (bestMatch) {
      fullCallChain = bestMatch.fullCallChain || [];
      persistenceOperations = bestMatch.persistenceOperations || [];

      const allServiceCalls = bestMatch.serviceCalls.slice();
      const resolved = resolveServiceCallChain(allServiceCalls, serviceMethods);

      resolvedServiceMethods = resolved.resolvedMethods;
      resolvedRepositoryMethods = Array.from(
        new Set(bestMatch.repositoryCalls.concat(resolved.resolvedRepos))
      );
      resolvedEntities = Array.from(
        new Set(bestMatch.entitiesTouched.concat(resolved.resolvedEntities))
      );
    }

    const inferredOperation = bestMatch
      ? inferOperationType(resolvedServiceMethods, resolvedRepositoryMethods, bestMatch.httpMethod, persistenceOperations)
      : interaction.interactionType === "navigation"
      ? "NAVIGATION"
      : inferOperationType([], [], interaction.httpMethod);

    nodes.push({
      interaction,
      matchedEndpoint: bestMatch,
      resolvedServiceMethods,
      resolvedRepositoryMethods,
      resolvedEntities,
      fullCallChain,
      persistenceOperations,
      inferredOperation,
    });
  }

  return nodes;
}

export function graphToCatalogEntries(
  nodes: GraphNode[],
  analysisRunId: number,
  projectId: number
): InsertCatalogEntry[] {
  return nodes.map((node) => ({
    analysisRunId,
    projectId,
    screen: node.interaction.screen,
    interaction: node.interaction.interaction,
    interactionType: node.interaction.interactionType,
    endpoint: node.matchedEndpoint?.fullPath || node.interaction.endpoint,
    httpMethod: node.matchedEndpoint?.httpMethod || node.interaction.httpMethod,
    controllerClass: node.matchedEndpoint?.className || null,
    controllerMethod: node.matchedEndpoint?.methodName || null,
    serviceMethods: node.resolvedServiceMethods,
    repositoryMethods: node.resolvedRepositoryMethods,
    entitiesTouched: node.resolvedEntities,
    fullCallChain: node.fullCallChain,
    persistenceOperations: node.persistenceOperations,
    technicalOperation: node.inferredOperation,
    criticalityScore: null,
    suggestedMeaning: null,
    humanClassification: null,
    sourceFile: node.interaction.sourceFile,
    lineNumber: node.interaction.lineNumber,
  }));
}

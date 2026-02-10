import type { FrontendInteraction } from "./frontend-analyzer";
import type { ApplicationGraph, EndpointImpact, GraphNode } from "./application-graph";
import type { InsertCatalogEntry } from "@shared/schema";
import type { ArchitectureType } from "./architecture-detector";

const IGNORED_CONTROLLERS = new Set([
  "healthcheckcontroller",
  "healthcontroller",
  "pingcontroller",
  "actuatorcontroller",
]);

const IGNORED_URL_PREFIXES = [
  "/api/",
  "/easynup/",
  "/v1/",
  "/v2/",
  "/v3/",
  "/rest/",
  "/ws/",
  "/services/",
];

interface MatchStats {
  byOperationName: number;
  byMethodName: number;
  bySuffix: number;
  byStructural: number;
  noMatch: number;
  total: number;
}

function extractOperationName(url: string): string | null {
  const cleaned = url
    .replace(/\?.*$/, "")
    .replace(/\$\{[^}]+\}/g, "{param}")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

  const segments = cleaned.split("/").filter(Boolean);

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg === "{param}" || seg.startsWith("{") || seg.startsWith(":")) continue;
    if (/^\d+$/.test(seg)) continue;

    const withoutVersion = seg.replace(/\.v\d+$/, "");

    if (/[a-z][A-Z]/.test(withoutVersion)) {
      return withoutVersion;
    }

    if (withoutVersion.includes("-")) {
      const camel = withoutVersion.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camel.length > 2) return camel;
    }

    if (withoutVersion.length > 2 && /^[a-zA-Z]+$/.test(withoutVersion)) {
      return withoutVersion;
    }
  }

  return null;
}

function getControllerCandidates(graph: ApplicationGraph): GraphNode[] {
  return graph.getNodesByType("CONTROLLER").filter((node) => {
    const name = node.className.toLowerCase();
    return !IGNORED_CONTROLLERS.has(name);
  });
}

function matchByMethodName(
  operationName: string,
  httpMethod: string | null,
  candidates: GraphNode[]
): GraphNode | null {
  const opLower = operationName.toLowerCase();

  let exactMatch: GraphNode | null = null;
  let methodOnlyMatch: GraphNode | null = null;

  for (const node of candidates) {
    if (!node.methodName) continue;
    const nodeMethods = node.methodName.toLowerCase();

    if (nodeMethods === opLower) {
      const meta = node.metadata as { httpMethod?: string };
      if (httpMethod && meta.httpMethod && meta.httpMethod.toUpperCase() === httpMethod.toUpperCase()) {
        return node;
      }
      exactMatch = node;
    }
  }

  if (exactMatch) return exactMatch;

  for (const node of candidates) {
    if (!node.methodName) continue;
    const nodeMethod = node.methodName.toLowerCase();

    if (nodeMethod.includes(opLower) || opLower.includes(nodeMethod)) {
      if (Math.min(nodeMethod.length, opLower.length) / Math.max(nodeMethod.length, opLower.length) > 0.5) {
        const meta = node.metadata as { httpMethod?: string };
        if (httpMethod && meta.httpMethod && meta.httpMethod.toUpperCase() === httpMethod.toUpperCase()) {
          return node;
        }
        if (!methodOnlyMatch) methodOnlyMatch = node;
      }
    }
  }

  return methodOnlyMatch;
}

function tokenize(name: string): string[] {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function matchByOperationName(
  url: string,
  httpMethod: string | null,
  candidates: GraphNode[]
): GraphNode | null {
  const cleaned = url
    .replace(/\?.*$/, "")
    .replace(/\$\{[^}]+\}/g, "")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

  const segments = cleaned.split("/").filter(Boolean);

  let operationSegment: string | null = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.startsWith("{") || seg.startsWith(":") || /^\d+$/.test(seg)) continue;
    operationSegment = seg;
    break;
  }

  if (!operationSegment) return null;

  const withoutExt = operationSegment
    .replace(/\.(v\d+|json|xml|html|csv|pdf)$/i, "");

  const opTokens = tokenize(withoutExt);
  if (opTokens.length === 0) return null;

  const opTokenSet = new Set(opTokens);

  let bestNode: GraphNode | null = null;
  let bestScore = 0;

  for (const node of candidates) {
    let nodeScore = 0;

    if (node.methodName) {
      const methodTokens = tokenize(node.methodName);
      const methodSet = new Set(methodTokens);
      let methodIntersection = 0;
      Array.from(opTokenSet).forEach((t) => {
        if (methodSet.has(t)) methodIntersection++;
      });
      if (methodIntersection > 0) {
        const union = new Set(Array.from(opTokenSet).concat(methodTokens)).size;
        const jaccardScore = (methodIntersection / union) * 100;
        if (methodIntersection === opTokenSet.size && methodIntersection === methodSet.size) {
          nodeScore = 100;
        } else {
          nodeScore = Math.max(nodeScore, jaccardScore);
        }
      }
    }

    if (nodeScore < 80) {
      const sigTokens = node.qualifiedSignature
        ? tokenize(node.qualifiedSignature.split("(")[0].split(".").pop() || "")
        : [];
      if (sigTokens.length > 0) {
        const sigSet = new Set(sigTokens);
        let sigIntersection = 0;
        Array.from(opTokenSet).forEach((t) => {
          if (sigSet.has(t)) sigIntersection++;
        });
        if (sigIntersection > 0) {
          const union = new Set(Array.from(opTokenSet).concat(sigTokens)).size;
          nodeScore = Math.max(nodeScore, (sigIntersection / union) * 90);
        }
      }
    }

    if (nodeScore < 80) {
      const cleanedClass = node.className
        .replace(/(Controller|WsV\d+|Ws)$/i, "");
      const classTokens = tokenize(cleanedClass);
      if (classTokens.length > 0) {
        const classSet = new Set(classTokens);
        let classIntersection = 0;
        Array.from(opTokenSet).forEach((t) => {
          if (classSet.has(t)) classIntersection++;
        });
        if (classIntersection > 0) {
          if (classIntersection === opTokenSet.size && classIntersection === classSet.size) {
            nodeScore = Math.max(nodeScore, 95);
          } else if (classIntersection === opTokenSet.size || classIntersection === classSet.size) {
            nodeScore = Math.max(nodeScore, 75);
          } else {
            const union = new Set(Array.from(opTokenSet).concat(classTokens)).size;
            nodeScore = Math.max(nodeScore, (classIntersection / union) * 60);
          }
        }
      }
    }

    if (nodeScore === 0) continue;

    if (httpMethod) {
      const meta = node.metadata as { httpMethod?: string };
      if (meta.httpMethod && meta.httpMethod.toUpperCase() === httpMethod.toUpperCase()) {
        nodeScore += 10;
      }
    }

    if (nodeScore > bestScore) {
      bestScore = nodeScore;
      bestNode = node;
    }
  }

  if (bestScore >= 60 && bestNode) {
    console.log(`[MATCH][operation] ${withoutExt} -> ${bestNode.className}.${bestNode.methodName} (score: ${bestScore.toFixed(1)})`);
    return bestNode;
  }

  return null;
}

function stripKnownPrefixes(path: string): string {
  let normalized = path
    .replace(/\?.*$/, "")
    .replace(/\$\{[^}]+\}/g, "")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/https?:\/\/[^/]+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();

  const segments = normalized.split("/").filter(Boolean);
  const cleaned: string[] = [];

  const prefixSegments = new Set(
    IGNORED_URL_PREFIXES.flatMap((p) =>
      p.toLowerCase().split("/").filter(Boolean)
    )
  );

  for (const seg of segments) {
    if (seg.startsWith("{") || seg.startsWith(":") || /^\d+$/.test(seg)) continue;
    if (prefixSegments.has(seg)) continue;
    const withoutVersion = seg.replace(/\.v\d+$/, "");
    if (withoutVersion.length > 0) cleaned.push(withoutVersion);
  }

  return cleaned.join("/");
}

function matchBySuffix(
  url: string,
  httpMethod: string | null,
  candidates: GraphNode[]
): GraphNode | null {
  const frontendStripped = stripKnownPrefixes(url);
  if (!frontendStripped) return null;

  let bestNode: GraphNode | null = null;
  let bestScore = 0;

  for (const node of candidates) {
    const meta = node.metadata as { httpMethod?: string; fullPath?: string };
    if (!meta.fullPath) continue;

    const backendStripped = stripKnownPrefixes(meta.fullPath);
    if (!backendStripped) continue;

    let score = 0;

    if (frontendStripped === backendStripped) {
      score = 100;
    } else if (frontendStripped.endsWith(backendStripped) || backendStripped.endsWith(frontendStripped)) {
      const longer = Math.max(frontendStripped.length, backendStripped.length);
      const shorter = Math.min(frontendStripped.length, backendStripped.length);
      score = (shorter / longer) * 90;
    } else {
      const frontParts = frontendStripped.split("/");
      const backParts = backendStripped.split("/");

      const frontReversed = [...frontParts].reverse();
      const backReversed = [...backParts].reverse();
      const compareLen = Math.min(frontReversed.length, backReversed.length);
      let consecutiveMatches = 0;

      for (let i = 0; i < compareLen; i++) {
        if (frontReversed[i] === backReversed[i]) {
          consecutiveMatches++;
        } else {
          break;
        }
      }

      if (consecutiveMatches > 0) {
        const maxLen = Math.max(frontParts.length, backParts.length);
        score = (consecutiveMatches / maxLen) * 80;
      }
    }

    if (score === 0) continue;

    if (httpMethod && meta.httpMethod && meta.httpMethod.toUpperCase() === httpMethod.toUpperCase()) {
      score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  return bestScore >= 40 ? bestNode : null;
}

function extractKeywords(text: string): Set<string> {
  const cleaned = text
    .replace(/\?.*$/, "")
    .replace(/\$\{[^}]+\}/g, "")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/https?:\/\/[^/]+/, "")
    .replace(/[/{}.:\-_]+/g, " ")
    .replace(/\.v\d+/g, "")
    .toLowerCase()
    .trim();

  const words = cleaned
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const prefixWords = IGNORED_URL_PREFIXES.flatMap((p) =>
    p.toLowerCase().split("/").filter((s) => s.length > 0)
  );

  const stopWords = new Set(["param", "the", "and", "for", "with"].concat(prefixWords));

  return new Set(words.filter((w) => !stopWords.has(w) && !/^\d+$/.test(w)));
}

function matchByKeywordIntersection(
  url: string,
  httpMethod: string | null,
  candidates: GraphNode[]
): GraphNode | null {
  const urlKeywords = extractKeywords(url);
  if (urlKeywords.size === 0) return null;

  let bestNode: GraphNode | null = null;
  let bestScore = 0;

  for (const node of candidates) {
    const meta = node.metadata as { httpMethod?: string; fullPath?: string };
    if (!meta.fullPath) continue;

    const pathKeywords = extractKeywords(meta.fullPath);
    if (pathKeywords.size === 0) continue;

    const methodKeywords = new Set<string>();
    if (node.methodName) {
      const methodWords = node.methodName
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      for (const w of methodWords) methodKeywords.add(w);
    }

    const allBackendKeywords = new Set(Array.from(pathKeywords).concat(Array.from(methodKeywords)));

    let intersection = 0;
    Array.from(urlKeywords).forEach((kw) => {
      if (allBackendKeywords.has(kw)) {
        intersection++;
      }
    });

    if (intersection === 0) continue;

    const union = new Set(Array.from(urlKeywords).concat(Array.from(allBackendKeywords))).size;
    let score = (intersection / union) * 100;

    if (httpMethod && meta.httpMethod && meta.httpMethod.toUpperCase() === httpMethod.toUpperCase()) {
      score += 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  return bestScore >= 25 ? bestNode : null;
}

function extractWsOperationSegment(url: string): string | null {
  const cleaned = url
    .replace(/\?.*$/, "")
    .replace(/\$\{[^}]+\}/g, "")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

  const segments = cleaned.split("/").filter(Boolean);

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.startsWith("{") || seg.startsWith(":") || /^\d+$/.test(seg)) continue;
    if (seg === "{param}") continue;
    const withoutExt = seg.replace(/\.(v\d+|json|xml|html|csv|pdf)$/i, "");
    if (withoutExt.length > 2 && /[a-zA-Z]/.test(withoutExt)) {
      return withoutExt;
    }
  }
  return null;
}

function matchWsOperationBased(
  url: string,
  httpMethod: string | null,
  candidates: GraphNode[]
): GraphNode | null {
  const opSegment = extractWsOperationSegment(url);
  if (!opSegment) return null;

  const opTokens = tokenize(opSegment);
  if (opTokens.length === 0) return null;

  const opTokenSet = new Set(opTokens);

  let bestNode: GraphNode | null = null;
  let bestScore = 0;

  for (const node of candidates) {
    const cleanedClass = node.className.replace(/(Controller|WsV\d+|ServiceV\d+|Ws)$/i, "");
    const classTokens = tokenize(cleanedClass);
    if (classTokens.length === 0) continue;

    const classSet = new Set(classTokens);
    let intersection = 0;
    Array.from(opTokenSet).forEach((t) => {
      if (classSet.has(t)) intersection++;
    });

    if (intersection === 0) continue;

    let score: number;

    if (intersection === opTokenSet.size && intersection === classSet.size) {
      score = 100;
    } else if (intersection === opTokenSet.size) {
      score = 85;
    } else if (intersection === classSet.size) {
      score = 80;
    } else {
      const union = new Set(Array.from(opTokenSet).concat(classTokens)).size;
      score = (intersection / union) * 70;
    }

    if (httpMethod) {
      const meta = node.metadata as { httpMethod?: string };
      if (meta.httpMethod && meta.httpMethod.toUpperCase() === httpMethod.toUpperCase()) {
        score += 10;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  if (bestScore >= 50 && bestNode) {
    console.log(`[MATCH][ws-operation] ${opSegment} -> ${bestNode.className}.${bestNode.methodName} (score: ${bestScore.toFixed(1)})`);
    return bestNode;
  }

  return null;
}

function matchUrlToController(
  url: string,
  httpMethod: string | null,
  graph: ApplicationGraph,
  stats: MatchStats,
  architectureType: ArchitectureType = "REST_CONTROLLER"
): GraphNode | null {
  const candidates = getControllerCandidates(graph);
  if (candidates.length === 0) return null;

  if (architectureType === "WS_OPERATION_BASED") {
    const wsMatch = matchWsOperationBased(url, httpMethod, candidates);
    if (wsMatch) {
      stats.byOperationName++;
      return wsMatch;
    }
    stats.noMatch++;
    return null;
  }

  const byOpName = matchByOperationName(url, httpMethod, candidates);
  if (byOpName) {
    stats.byOperationName++;
    return byOpName;
  }

  const operationName = extractOperationName(url);

  if (operationName) {
    const byName = matchByMethodName(operationName, httpMethod, candidates);
    if (byName) {
      stats.byMethodName++;
      return byName;
    }
  }

  const bySuffix = matchBySuffix(url, httpMethod, candidates);
  if (bySuffix) {
    stats.bySuffix++;
    return bySuffix;
  }

  const byKeyword = matchByKeywordIntersection(url, httpMethod, candidates);
  if (byKeyword) {
    stats.byStructural++;
    return byKeyword;
  }

  stats.noMatch++;
  return null;
}

function walkCallChain(
  graph: ApplicationGraph,
  startNodeId: string
): {
  serviceMethods: string[];
  repositoryMethods: string[];
  entitiesTouched: string[];
  fullCallChain: string[];
  persistenceOperations: string[];
} {
  const visited = new Set<string>();
  const entityNames = new Set<string>();
  const persistenceOps = new Set<string>();
  const serviceMethodNames: string[] = [];
  const repoMethodNames: string[] = [];
  const callChain: string[] = [];

  const walk = (nodeId: string, depth: number) => {
    if (depth > 15 || visited.has(nodeId)) return;
    visited.add(nodeId);

    const n = graph.getNode(nodeId);
    if (!n) return;

    if (n.methodName) {
      callChain.push(`${n.className}.${n.methodName}`);
    }

    if (n.type === "SERVICE" && n.methodName) {
      serviceMethodNames.push(`${n.className}.${n.methodName}`);
    }
    if (n.type === "REPOSITORY" && n.methodName) {
      repoMethodNames.push(`${n.className}.${n.methodName}`);
    }
    if (n.type === "ENTITY") {
      entityNames.add(n.className);
      return;
    }

    for (const edge of graph.getOutgoingEdges(nodeId)) {
      if (edge.relationType === "WRITES_ENTITY" || edge.relationType === "READS_ENTITY") {
        const targetNode = graph.getNode(edge.toNode);
        if (targetNode) {
          entityNames.add(targetNode.className);
          const opType = edge.relationType === "WRITES_ENTITY" ? "write" : "read";
          const specificOp = (edge.metadata.operation as string) || opType;
          persistenceOps.add(specificOp);
        }
      } else if (edge.relationType === "CALLS") {
        walk(edge.toNode, depth + 1);
      }
    }
  };

  walk(startNodeId, 0);

  return {
    serviceMethods: serviceMethodNames,
    repositoryMethods: repoMethodNames,
    entitiesTouched: Array.from(entityNames),
    fullCallChain: callChain,
    persistenceOperations: Array.from(persistenceOps),
  };
}

function computeStructuralConfidence(
  resolutionPath: { tier: string; file: string; function: string | null; detail: string | null }[] | undefined | null,
  controllerClass: string | null,
  repositoryMethods: string[]
): number | null {
  if (!resolutionPath || resolutionPath.length === 0) return null;

  let score = 0.3;

  const hasController = controllerClass !== null;
  const hasRepository = repositoryMethods.length > 0;

  if (hasController) score += 0.35;
  if (hasRepository) score += 0.2;

  const realHops = resolutionPath.filter(
    (step) => step.file && step.file !== "unknown"
  ).length;

  if (realHops === 1) score += 0.15;
  else if (realHops === 2) score += 0.1;
  else if (realHops >= 3) score += 0.05;

  return Math.min(1.0, Math.round(score * 100) / 100);
}

export function endpointImpactsToCatalogEntries(
  impacts: EndpointImpact[],
  analysisRunId: number,
  projectId: number
): InsertCatalogEntry[] {
  return impacts.map((impact) => {
    const serviceMethods = impact.involvedNodes
      .filter((n) => n.type === "SERVICE" && n.methodName)
      .map((n) => `${n.className}.${n.methodName}`);
    const repositoryMethods = impact.involvedNodes
      .filter((n) => n.type === "REPOSITORY" && n.methodName)
      .map((n) => `${n.className}.${n.methodName}`);

    const technicalOperation = inferOperationType(
      serviceMethods,
      repositoryMethods,
      impact.httpMethod,
      impact.persistenceOperations
    );

    return {
      analysisRunId,
      projectId,
      screen: `API: ${impact.controllerClass}`,
      interaction: `${impact.httpMethod} ${impact.endpoint}`,
      interactionType: "endpoint",
      endpoint: impact.endpoint,
      httpMethod: impact.httpMethod,
      controllerClass: impact.controllerClass,
      controllerMethod: impact.controllerMethod,
      serviceMethods,
      repositoryMethods,
      entitiesTouched: impact.entitiesTouched,
      fullCallChain: impact.fullCallChain,
      persistenceOperations: impact.persistenceOperations,
      technicalOperation,
      criticalityScore: null,
      suggestedMeaning: null,
      humanClassification: null,
      sourceFile: impact.sourceFile,
      lineNumber: impact.lineNumber,
      resolutionPath: [{ tier: "backend_only", file: impact.sourceFile || impact.controllerClass, function: impact.controllerMethod, detail: "backend endpoint analysis" }],
      architectureType: "REST_CONTROLLER",
      interactionCategory: "HTTP",
      confidence: 1.0,
    };
  });
}

export function interactionsToCatalogEntries(
  interactions: FrontendInteraction[],
  graph: ApplicationGraph,
  analysisRunId: number,
  projectId: number,
  architectureType: ArchitectureType = "REST_CONTROLLER"
): InsertCatalogEntry[] {
  const stats: MatchStats = {
    byOperationName: 0,
    byMethodName: 0,
    bySuffix: 0,
    byStructural: 0,
    noMatch: 0,
    total: 0,
  };

  const controllers = graph.getNodesByType("CONTROLLER");
  const validControllers = getControllerCandidates(graph);
  console.log(`[graph-connector] Architecture type: ${architectureType}`);
  console.log(`[graph-connector] Controller nodes in graph: ${controllers.length} total, ${validControllers.length} valid (excluding health/ping)`);
  for (const c of validControllers.slice(0, 10)) {
    const meta = c.metadata as { httpMethod?: string; fullPath?: string };
    console.log(`[graph-connector]   ${c.className}.${c.methodName} → ${meta.httpMethod || "?"} ${meta.fullPath || "no-path"}`);
  }
  if (validControllers.length > 10) {
    console.log(`[graph-connector]   ... and ${validControllers.length - 10} more`);
  }

  const entries = interactions.map((interaction) => {
    let controllerClass: string | null = null;
    let controllerMethod: string | null = null;
    let serviceMethods: string[] = [];
    let repositoryMethods: string[] = [];
    let entitiesTouched: string[] = [];
    let fullCallChain: string[] = [];
    let persistenceOperations: string[] = [];
    let technicalOperation = "UNKNOWN";

    let resolvedNode: GraphNode | null = null;

    if (interaction.url) {
      stats.total++;
      resolvedNode = matchUrlToController(interaction.url, interaction.httpMethod, graph, stats, architectureType);
    }

    if (resolvedNode) {
      controllerClass = resolvedNode.className;
      controllerMethod = resolvedNode.methodName;

      const chain = walkCallChain(graph, resolvedNode.id);
      serviceMethods = chain.serviceMethods;
      repositoryMethods = chain.repositoryMethods;
      entitiesTouched = chain.entitiesTouched;
      fullCallChain = chain.fullCallChain;
      persistenceOperations = chain.persistenceOperations;

      technicalOperation = inferOperationType(
        serviceMethods,
        repositoryMethods,
        interaction.httpMethod,
        persistenceOperations
      );
    } else {
      technicalOperation = inferOperationType([], [], interaction.httpMethod, []);
    }

    const interactionDesc = interaction.url
      ? `${interaction.elementType}: ${interaction.actionName} → ${interaction.httpMethod} ${interaction.url}`
      : `${interaction.elementType}: ${interaction.actionName}`;

    return {
      analysisRunId,
      projectId,
      screen: interaction.component,
      interaction: interactionDesc,
      interactionType: interaction.elementType,
      endpoint: interaction.url || null,
      httpMethod: interaction.httpMethod,
      controllerClass,
      controllerMethod,
      serviceMethods,
      repositoryMethods,
      entitiesTouched,
      fullCallChain,
      persistenceOperations,
      technicalOperation,
      criticalityScore: null,
      suggestedMeaning: null,
      humanClassification: null,
      sourceFile: interaction.sourceFile,
      lineNumber: interaction.lineNumber,
      resolutionPath: interaction.resolutionPath || null,
      architectureType: architectureType,
      interactionCategory: interaction.interactionCategory || null,
      confidence: computeStructuralConfidence(interaction.resolutionPath, controllerClass, repositoryMethods),
    };
  });

  console.log(`[graph-connector] === MATCHING SUMMARY ===`);
  console.log(`[graph-connector]   Interactions with URLs: ${stats.total}`);
  console.log(`[graph-connector]   Matched by operation:   ${stats.byOperationName} (${stats.total ? Math.round(stats.byOperationName / stats.total * 100) : 0}%)`);
  console.log(`[graph-connector]   Matched by method name: ${stats.byMethodName} (${stats.total ? Math.round(stats.byMethodName / stats.total * 100) : 0}%)`);
  console.log(`[graph-connector]   Matched by suffix:      ${stats.bySuffix} (${stats.total ? Math.round(stats.bySuffix / stats.total * 100) : 0}%)`);
  console.log(`[graph-connector]   Matched by keyword:     ${stats.byStructural} (${stats.total ? Math.round(stats.byStructural / stats.total * 100) : 0}%)`);
  console.log(`[graph-connector]   No match:               ${stats.noMatch} (${stats.total ? Math.round(stats.noMatch / stats.total * 100) : 0}%)`);
  console.log(`[graph-connector] === END SUMMARY ===`);

  return entries;
}

function inferOperationType(
  serviceMethods: string[],
  repoMethods: string[],
  httpMethod: string | null,
  persistenceOps: string[]
): string {
  const allMethods = [...serviceMethods, ...repoMethods].map((m) => m.toLowerCase());
  const allOps = persistenceOps.map((o) => o.toLowerCase());

  if (allOps.includes("delete") || allMethods.some((m) => m.includes("delete") || m.includes("remove"))) {
    return "DELETE";
  }
  if (allOps.includes("save") || allOps.includes("state_change")) {
    if (httpMethod === "POST") return "CREATE";
    if (httpMethod === "PUT" || httpMethod === "PATCH") return "UPDATE";
  }
  if (allMethods.some((m) => m.includes("create") || m.includes("add") || m.includes("insert"))) {
    return "CREATE";
  }
  if (allMethods.some((m) => m.includes("update") || m.includes("edit") || m.includes("modify") || m.includes("toggle") || m.includes("change"))) {
    return "UPDATE";
  }
  if (allMethods.some((m) => m.includes("export") || m.includes("download") || m.includes("csv"))) {
    return "EXPORT";
  }
  if (allMethods.some((m) => m.includes("find") || m.includes("get") || m.includes("list") || m.includes("fetch") || m.includes("search"))) {
    return "READ";
  }

  switch (httpMethod?.toUpperCase()) {
    case "GET": return "READ";
    case "POST": return "CREATE";
    case "PUT": return "UPDATE";
    case "PATCH": return "UPDATE";
    case "DELETE": return "DELETE";
    default: return "UNKNOWN";
  }
}

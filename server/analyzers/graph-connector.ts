import type { FrontendInteraction } from "./frontend-analyzer";
import type { ApplicationGraph, EndpointImpact, GraphNode } from "./application-graph";
import type { InsertCatalogEntry } from "@shared/schema";
import type { ArchitectureType } from "./architecture-detector";

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

function findNodeByClassAndMethod(
  graph: ApplicationGraph,
  className: string,
  methodName: string | null
): GraphNode | null {
  const controllers = graph.getNodesByType("CONTROLLER");
  for (const node of controllers) {
    if (node.className === className && node.methodName === methodName) {
      return node;
    }
  }
  for (const node of controllers) {
    if (node.className === className) {
      return node;
    }
  }
  return null;
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
  let resolved = 0;
  let unresolved = 0;

  const entries = interactions.map((interaction) => {
    let controllerClass: string | null = null;
    let controllerMethod: string | null = null;
    let serviceMethods: string[] = [];
    let repositoryMethods: string[] = [];
    let entitiesTouched: string[] = [];
    let fullCallChain: string[] = [];
    let persistenceOperations: string[] = [];
    let technicalOperation = "UNKNOWN";

    const controllerStep = interaction.resolutionPath?.find(s => s.tier === "controller");

    if (controllerStep) {
      const node = findNodeByClassAndMethod(graph, controllerStep.file, controllerStep.function);

      if (node) {
        controllerClass = node.className;
        controllerMethod = node.methodName;

        const chain = walkCallChain(graph, node.id);
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
        resolved++;
      } else {
        controllerClass = controllerStep.file;
        controllerMethod = controllerStep.function;
        technicalOperation = inferOperationType([], [], interaction.httpMethod, []);
        unresolved++;
      }
    } else {
      technicalOperation = inferOperationType([], [], interaction.httpMethod, []);
      unresolved++;
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

  console.log(`[graph-connector] === RESOLUTION SUMMARY ===`);
  console.log(`[graph-connector]   Total interactions: ${interactions.length}`);
  console.log(`[graph-connector]   Resolved via resolutionPath: ${resolved}`);
  console.log(`[graph-connector]   No controller in resolutionPath: ${unresolved}`);
  console.log(`[graph-connector] === END SUMMARY ===`);

  return entries;
}

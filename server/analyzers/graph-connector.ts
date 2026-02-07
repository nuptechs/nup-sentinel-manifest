import type { FrontendInteraction } from "./frontend-analyzer";
import type { ApplicationGraph } from "./application-graph";
import type { InsertCatalogEntry } from "@shared/schema";

export function interactionsToCatalogEntries(
  interactions: FrontendInteraction[],
  graph: ApplicationGraph,
  analysisRunId: number,
  projectId: number
): InsertCatalogEntry[] {
  return interactions.map((interaction) => {
    const backendNode = interaction.mappedBackendNode;
    let controllerClass: string | null = null;
    let controllerMethod: string | null = null;
    let serviceMethods: string[] = [];
    let repositoryMethods: string[] = [];
    let entitiesTouched: string[] = [];
    let fullCallChain: string[] = [];
    let persistenceOperations: string[] = [];
    let technicalOperation = "UNKNOWN";

    if (backendNode) {
      controllerClass = backendNode.className;
      controllerMethod = backendNode.methodName;

      const reachable = graph.reachableFrom(backendNode.id);
      const visited = new Set<string>();
      const entityNames = new Set<string>();
      const persistenceOps = new Set<string>();
      const serviceMethodNames: string[] = [];
      const repoMethodNames: string[] = [];
      const callChain: string[] = [];

      const walkChain = (nodeId: string, depth: number) => {
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
            walkChain(edge.toNode, depth + 1);
          }
        }
      };

      walkChain(backendNode.id, 0);

      serviceMethods = serviceMethodNames;
      repositoryMethods = repoMethodNames;
      entitiesTouched = Array.from(entityNames);
      fullCallChain = callChain;
      persistenceOperations = Array.from(persistenceOps);
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
    };
  });
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

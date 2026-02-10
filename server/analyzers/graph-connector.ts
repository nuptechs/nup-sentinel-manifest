import type { FrontendInteraction } from "./frontend-analyzer";
import type { ApplicationGraph, EndpointImpact, GraphNode } from "./application-graph";
import type { InsertCatalogEntry } from "@shared/schema";
import type { ArchitectureType } from "./architecture-detector";

interface EntityFieldMeta {
  entity: string;
  fields: { name: string; type: string; isId: boolean; isSensitive: boolean; validations?: string[] }[];
}

interface SecurityAnnotationMeta {
  type: string;
  expression: string;
  roles: string[];
}

interface CallChainResult {
  serviceMethods: string[];
  repositoryMethods: string[];
  entitiesTouched: string[];
  fullCallChain: string[];
  persistenceOperations: string[];
  requiredRoles: string[];
  securityAnnotations: SecurityAnnotationMeta[];
  entityFieldsMetadata: EntityFieldMeta[];
  sensitiveFieldsAccessed: string[];
}

function walkCallChain(
  graph: ApplicationGraph,
  startNodeId: string
): CallChainResult {
  const visited = new Set<string>();
  const entityNames = new Set<string>();
  const persistenceOps = new Set<string>();
  const serviceMethodNames: string[] = [];
  const repoMethodNames: string[] = [];
  const callChain: string[] = [];
  const roles = new Set<string>();
  const secAnnotations: SecurityAnnotationMeta[] = [];
  const entityFieldsMeta: EntityFieldMeta[] = [];
  const sensitiveFields = new Set<string>();

  const walk = (nodeId: string, depth: number) => {
    if (depth > 15 || visited.has(nodeId)) return;
    visited.add(nodeId);

    const n = graph.getNode(nodeId);
    if (!n) return;

    if (n.methodName) {
      callChain.push(`${n.className}.${n.methodName}`);
    }

    const meta = n.metadata as Record<string, unknown>;
    if (meta.requiredRoles && Array.isArray(meta.requiredRoles)) {
      for (const r of meta.requiredRoles as string[]) roles.add(r);
    }
    if (meta.securityAnnotations && Array.isArray(meta.securityAnnotations)) {
      for (const sa of meta.securityAnnotations as SecurityAnnotationMeta[]) {
        secAnnotations.push(sa);
      }
    }

    if (n.type === "SERVICE" && n.methodName) {
      serviceMethodNames.push(`${n.className}.${n.methodName}`);
    }
    if (n.type === "REPOSITORY" && n.methodName) {
      repoMethodNames.push(`${n.className}.${n.methodName}`);
    }
    if (n.type === "ENTITY") {
      entityNames.add(n.className);
      if (meta.enrichedFields && Array.isArray(meta.enrichedFields)) {
        const fields = meta.enrichedFields as { name: string; type: string; isId: boolean; isSensitive: boolean; validations?: string[] }[];
        entityFieldsMeta.push({ entity: n.className, fields });
        for (const f of fields) {
          if (f.isSensitive) sensitiveFields.add(`${n.className}.${f.name}`);
        }
      }
      if (meta.sensitiveFields && Array.isArray(meta.sensitiveFields)) {
        for (const sf of meta.sensitiveFields as string[]) {
          sensitiveFields.add(`${n.className}.${sf}`);
        }
      }
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
          const targetMeta = targetNode.metadata as Record<string, unknown>;
          if (targetMeta.enrichedFields && Array.isArray(targetMeta.enrichedFields)) {
            const fields = targetMeta.enrichedFields as { name: string; type: string; isId: boolean; isSensitive: boolean; validations?: string[] }[];
            entityFieldsMeta.push({ entity: targetNode.className, fields });
            for (const f of fields) {
              if (f.isSensitive) sensitiveFields.add(`${targetNode.className}.${f.name}`);
            }
          }
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
    requiredRoles: Array.from(roles),
    securityAnnotations: secAnnotations,
    entityFieldsMetadata: entityFieldsMeta,
    sensitiveFieldsAccessed: Array.from(sensitiveFields),
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
  graph: ApplicationGraph,
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

    const controllerNode = impact.involvedNodes.find(n => n.type === "CONTROLLER");
    let requiredRoles: string[] = [];
    let securityAnns: SecurityAnnotationMeta[] = [];
    let entityFieldsMeta: EntityFieldMeta[] = [];
    let sensitiveFieldsAccessed: string[] = [];

    if (controllerNode) {
      const chain = walkCallChain(graph, controllerNode.id);
      requiredRoles = chain.requiredRoles;
      securityAnns = chain.securityAnnotations;
      entityFieldsMeta = chain.entityFieldsMetadata;
      sensitiveFieldsAccessed = chain.sensitiveFieldsAccessed;
    }

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
      requiredRoles,
      securityAnnotations: securityAnns,
      entityFieldsMetadata: entityFieldsMeta,
      sensitiveFieldsAccessed,
      frontendRoute: null,
      routeGuards: [],
      duplicateCount: 1,
      operationHint: null,
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

    let requiredRoles: string[] = [];
    let securityAnns: SecurityAnnotationMeta[] = [];
    let entityFieldsMeta: EntityFieldMeta[] = [];
    let sensitiveFieldsAccessed: string[] = [];

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
        requiredRoles = chain.requiredRoles;
        securityAnns = chain.securityAnnotations;
        entityFieldsMeta = chain.entityFieldsMetadata;
        sensitiveFieldsAccessed = chain.sensitiveFieldsAccessed;

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

    let screenName = interaction.component;
    const category = interaction.interactionCategory || "HTTP";
    if (category === "SERVICE_BRIDGE") {
      screenName = `[Service Bridge] ${interaction.component}`;
    } else if (category === "EXTERNAL_SERVICE") {
      const domain = interaction.externalDomain || "unknown";
      screenName = `[External: ${domain}] ${interaction.component}`;
    }

    return {
      analysisRunId,
      projectId,
      screen: screenName,
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
      interactionCategory: category,
      confidence: computeStructuralConfidence(interaction.resolutionPath, controllerClass, repositoryMethods),
      requiredRoles,
      securityAnnotations: securityAnns,
      entityFieldsMetadata: entityFieldsMeta,
      sensitiveFieldsAccessed,
      frontendRoute: interaction.frontendRoute || null,
      routeGuards: interaction.routeGuards || [],
      duplicateCount: 1,
      operationHint: interaction.operationHint || null,
    };
  });

  const gatewayResolved = resolveGatewayOperations(entries, graph);

  const deduped = deduplicateEntries(gatewayResolved);
  const duplicatesRemoved = gatewayResolved.length - deduped.length;

  console.log(`[graph-connector] === RESOLUTION SUMMARY ===`);
  console.log(`[graph-connector]   Total interactions: ${interactions.length}`);
  console.log(`[graph-connector]   Resolved via resolutionPath: ${resolved}`);
  console.log(`[graph-connector]   No controller in resolutionPath: ${unresolved}`);
  if (duplicatesRemoved > 0) {
    console.log(`[graph-connector]   Deduplication: ${gatewayResolved.length} → ${deduped.length} (${duplicatesRemoved} exact duplicates merged, multiplicity preserved in duplicateCount)`);
  }
  console.log(`[graph-connector] === END SUMMARY ===`);

  return deduped;
}

function resolveGatewayOperations(entries: InsertCatalogEntry[], graph: ApplicationGraph): InsertCatalogEntry[] {
  const endpointFanIn = new Map<string, number>();
  for (const entry of entries) {
    if (entry.endpoint) {
      endpointFanIn.set(entry.endpoint, (endpointFanIn.get(entry.endpoint) || 0) + 1);
    }
  }

  const GATEWAY_THRESHOLD = 5;
  const gatewayEndpoints = new Set<string>();
  for (const [ep, count] of Array.from(endpointFanIn.entries())) {
    if (count >= GATEWAY_THRESHOLD) {
      gatewayEndpoints.add(ep);
    }
  }

  if (gatewayEndpoints.size === 0) return entries;

  console.log(`[graph-connector] Gateway detection: ${gatewayEndpoints.size} concentrator endpoint(s) found (${GATEWAY_THRESHOLD}+ references)`);
  for (const ep of Array.from(gatewayEndpoints)) {
    console.log(`[graph-connector]   Gateway endpoint: ${ep} (${endpointFanIn.get(ep)} references)`);
  }

  const controllers = graph.getNodesByType("CONTROLLER");
  const controllerIndex = new Map<string, GraphNode>();
  for (const c of controllers) {
    controllerIndex.set(c.className.toLowerCase(), c);
    const shortName = c.className.replace(/Controller$/i, "").replace(/WsV\d+$/i, "").replace(/Ws$/i, "");
    if (shortName) controllerIndex.set(shortName.toLowerCase(), c);
  }

  let gatewayMatches = 0;

  const result = entries.map(entry => {
    if (!entry.endpoint || !gatewayEndpoints.has(entry.endpoint)) return entry;
    if (entry.controllerClass && entry.controllerMethod) return entry;

    const hint = entry.operationHint;
    if (!hint) return entry;

    const normalizedHint = hint.replace(/\./g, "").replace(/[-_]/g, "").replace(/v\d+$/i, "").toLowerCase();
    const MIN_SUBSTRING_MATCH_LEN = 6;

    let matchedNode: GraphNode | null = null;
    let bestMatchLen = 0;

    for (const [key, node] of Array.from(controllerIndex.entries())) {
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if (normalizedHint === normalizedKey) {
        matchedNode = node;
        break;
      }
      if (normalizedHint.includes(normalizedKey) && normalizedKey.length >= MIN_SUBSTRING_MATCH_LEN && normalizedKey.length > bestMatchLen) {
        matchedNode = node;
        bestMatchLen = normalizedKey.length;
      }
      if (normalizedKey.includes(normalizedHint) && normalizedHint.length >= MIN_SUBSTRING_MATCH_LEN && normalizedHint.length > bestMatchLen) {
        matchedNode = node;
        bestMatchLen = normalizedHint.length;
      }
    }

    if (matchedNode) {
      const chain = walkCallChain(graph, matchedNode.id);

      const resPath = entry.resolutionPath ? [...(entry.resolutionPath as any[])] : [];
      resPath.push({
        tier: "gateway_operation",
        file: matchedNode.className,
        function: matchedNode.methodName,
        detail: `gateway operation hint "${hint}" matched to ${matchedNode.className}.${matchedNode.methodName}`,
      });

      const technicalOperation = inferOperationType(
        chain.serviceMethods,
        chain.repositoryMethods,
        entry.httpMethod || null,
        chain.persistenceOperations
      );

      gatewayMatches++;

      return {
        ...entry,
        controllerClass: matchedNode.className,
        controllerMethod: matchedNode.methodName,
        serviceMethods: chain.serviceMethods,
        repositoryMethods: chain.repositoryMethods,
        entitiesTouched: chain.entitiesTouched,
        fullCallChain: chain.fullCallChain,
        persistenceOperations: chain.persistenceOperations,
        technicalOperation,
        resolutionPath: resPath,
        architectureType: "WS_OPERATION_BASED",
        confidence: computeStructuralConfidence(resPath, matchedNode.className, chain.repositoryMethods),
        requiredRoles: chain.requiredRoles,
        securityAnnotations: chain.securityAnnotations,
        entityFieldsMetadata: chain.entityFieldsMetadata,
        sensitiveFieldsAccessed: chain.sensitiveFieldsAccessed,
      };
    }

    return entry;
  });

  if (gatewayMatches > 0) {
    console.log(`[graph-connector]   Gateway resolution: ${gatewayMatches} entries matched to specific controllers via operation hints`);
  }

  return result;
}

function deduplicateEntries(entries: InsertCatalogEntry[]): InsertCatalogEntry[] {
  const groups = new Map<string, InsertCatalogEntry[]>();

  for (const entry of entries) {
    const key = [
      entry.sourceFile || "",
      String(entry.lineNumber || 0),
      entry.interaction || "",
      entry.httpMethod || "",
      entry.endpoint || "",
      entry.controllerClass || "",
      entry.controllerMethod || "",
    ].join("||");

    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }

  const result: InsertCatalogEntry[] = [];
  groups.forEach((group) => {
    const representative = group[0];
    representative.duplicateCount = group.length;
    result.push(representative);
  });

  return result;
}

export type NodeType = "CONTROLLER" | "SERVICE" | "REPOSITORY" | "ENTITY";
export type EdgeRelation = "CALLS" | "WRITES_ENTITY" | "READS_ENTITY";

export class GraphNode {
  readonly id: string;
  readonly type: NodeType;
  readonly className: string;
  readonly methodName: string | null;
  readonly metadata: Record<string, unknown>;

  constructor(
    type: NodeType,
    className: string,
    methodName: string | null,
    metadata: Record<string, unknown> = {}
  ) {
    this.type = type;
    this.className = className;
    this.methodName = methodName;
    this.id = methodName ? `${type}:${className}.${methodName}` : `${type}:${className}`;
    this.metadata = metadata;
  }
}

export class GraphEdge {
  readonly fromNode: string;
  readonly toNode: string;
  readonly relationType: EdgeRelation;
  readonly metadata: Record<string, unknown>;

  constructor(
    fromNode: string,
    toNode: string,
    relationType: EdgeRelation,
    metadata: Record<string, unknown> = {}
  ) {
    this.fromNode = fromNode;
    this.toNode = toNode;
    this.relationType = relationType;
    this.metadata = metadata;
  }
}

export class ApplicationGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private outgoing: Map<string, GraphEdge[]> = new Map();
  private incoming: Map<string, GraphEdge[]> = new Map();

  addNode(node: GraphNode): void {
    if (!this.nodes.has(node.id)) {
      this.nodes.set(node.id, node);
    }
  }

  addEdge(edge: GraphEdge): void {
    const key = `${edge.fromNode}->${edge.toNode}:${edge.relationType}`;
    for (const existing of this.edges) {
      if (`${existing.fromNode}->${existing.toNode}:${existing.relationType}` === key) {
        return;
      }
    }
    this.edges.push(edge);

    if (!this.outgoing.has(edge.fromNode)) {
      this.outgoing.set(edge.fromNode, []);
    }
    this.outgoing.get(edge.fromNode)!.push(edge);

    if (!this.incoming.has(edge.toNode)) {
      this.incoming.set(edge.toNode, []);
    }
    this.incoming.get(edge.toNode)!.push(edge);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getOutgoingEdges(nodeId: string): GraphEdge[] {
    return this.outgoing.get(nodeId) || [];
  }

  getIncomingEdges(nodeId: string): GraphEdge[] {
    return this.incoming.get(nodeId) || [];
  }

  getNodesByType(type: NodeType): GraphNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.type === type);
  }

  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getAllEdges(): GraphEdge[] {
    return this.edges.slice();
  }

  getCallees(nodeId: string): GraphNode[] {
    return this.getOutgoingEdges(nodeId)
      .filter((e) => e.relationType === "CALLS")
      .map((e) => this.nodes.get(e.toNode))
      .filter((n): n is GraphNode => n !== undefined);
  }

  getEntitiesWrittenBy(nodeId: string): GraphNode[] {
    return this.getOutgoingEdges(nodeId)
      .filter((e) => e.relationType === "WRITES_ENTITY")
      .map((e) => this.nodes.get(e.toNode))
      .filter((n): n is GraphNode => n !== undefined);
  }

  getEntitiesReadBy(nodeId: string): GraphNode[] {
    return this.getOutgoingEdges(nodeId)
      .filter((e) => e.relationType === "READS_ENTITY")
      .map((e) => this.nodes.get(e.toNode))
      .filter((n): n is GraphNode => n !== undefined);
  }

  reachableFrom(startNodeId: string, maxDepth: number = 15): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visitedNodes = new Set<string>();
    const collectedEdges: GraphEdge[] = [];

    const walk = (nodeId: string, depth: number) => {
      if (depth > maxDepth || visitedNodes.has(nodeId)) return;
      visitedNodes.add(nodeId);

      for (const edge of this.getOutgoingEdges(nodeId)) {
        collectedEdges.push(edge);
        walk(edge.toNode, depth + 1);
      }
    };

    walk(startNodeId, 0);

    return {
      nodes: Array.from(visitedNodes)
        .map((id) => this.nodes.get(id))
        .filter((n): n is GraphNode => n !== undefined),
      edges: collectedEdges,
    };
  }

  toJSON(): { nodes: ReturnType<typeof nodeToJSON>[]; edges: ReturnType<typeof edgeToJSON>[] } {
    return {
      nodes: this.getAllNodes().map(nodeToJSON),
      edges: this.getAllEdges().map(edgeToJSON),
    };
  }
}

function nodeToJSON(n: GraphNode) {
  return { id: n.id, type: n.type, className: n.className, methodName: n.methodName, metadata: n.metadata };
}

function edgeToJSON(e: GraphEdge) {
  return { fromNode: e.fromNode, toNode: e.toNode, relationType: e.relationType, metadata: e.metadata };
}

export interface EndpointImpact {
  endpoint: string;
  httpMethod: string;
  controllerClass: string;
  controllerMethod: string;
  involvedNodes: GraphNode[];
  entitiesTouched: string[];
  callDepth: number;
  fullCallChain: string[];
  persistenceOperations: string[];
  sourceFile: string;
  lineNumber: number;
}

export function analyzeEndpoints(graph: ApplicationGraph): EndpointImpact[] {
  const controllerNodes = graph.getNodesByType("CONTROLLER");
  const impacts: EndpointImpact[] = [];

  for (const node of controllerNodes) {
    const meta = node.metadata as {
      httpMethod?: string;
      fullPath?: string;
      sourceFile?: string;
      lineNumber?: number;
    };
    if (!meta.httpMethod || !meta.fullPath) continue;

    const reachable = graph.reachableFrom(node.id);

    const callChain: string[] = [];
    const persistenceOps = new Set<string>();
    const entityNames = new Set<string>();
    const visited = new Set<string>();

    const walkChain = (nodeId: string, depth: number) => {
      if (depth > 15 || visited.has(nodeId)) return;
      visited.add(nodeId);

      const n = graph.getNode(nodeId);
      if (!n) return;

      if (n.methodName) {
        callChain.push(`${n.className}.${n.methodName}`);
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

    walkChain(node.id, 0);

    let maxDepth = 0;
    const depthVisited = new Set<string>();
    const measureDepth = (nodeId: string, depth: number) => {
      if (depth > 15 || depthVisited.has(nodeId)) return;
      depthVisited.add(nodeId);
      if (depth > maxDepth) maxDepth = depth;
      for (const edge of graph.getOutgoingEdges(nodeId)) {
        if (edge.relationType === "CALLS") {
          measureDepth(edge.toNode, depth + 1);
        }
      }
    };
    measureDepth(node.id, 0);

    impacts.push({
      endpoint: meta.fullPath,
      httpMethod: meta.httpMethod,
      controllerClass: node.className,
      controllerMethod: node.methodName || "",
      involvedNodes: reachable.nodes,
      entitiesTouched: Array.from(entityNames),
      callDepth: maxDepth,
      fullCallChain: callChain,
      persistenceOperations: Array.from(persistenceOps),
      sourceFile: meta.sourceFile || "",
      lineNumber: meta.lineNumber || 0,
    });
  }

  return impacts;
}

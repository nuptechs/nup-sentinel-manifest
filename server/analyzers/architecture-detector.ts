import type { ApplicationGraph, GraphNode } from "./application-graph";

export type ArchitectureType =
  | "REST_CONTROLLER"
  | "WS_OPERATION_BASED"
  | "MVC_ACTION_BASED"
  | "EXTERNAL_API_GATEWAY";

export interface ArchitectureDetectionResult {
  type: ArchitectureType;
  confidence: number;
  evidence: string[];
}

const WS_CLASS_SUFFIXES = /(?:WsV\d+|ServiceV\d+|Ws)$/i;
const VERB_ENTITY_PATTERN = /^(?:Find|Create|Update|Delete|Save|List|Get|Set|Remove|Restore|Overwrite|Import|Export|Revoke|Grant|Apply|Validate|Generate|Calculate|Process|Check|Search|Upload|Download|Send|Activate|Deactivate|Toggle|Execute|Cancel|Approve|Reject)[A-Z]/;
const MVC_INDICATORS = /(?:Servlet|Action|Controller|Bean|Managed|Faces|Struts)/i;

export function detectArchitecture(
  graph: ApplicationGraph,
  fileData?: { filePath: string }[]
): ArchitectureDetectionResult {
  const controllers = graph.getNodesByType("CONTROLLER");
  const evidence: string[] = [];

  if (controllers.length === 0) {
    evidence.push("No controller nodes found in graph");
    return { type: "EXTERNAL_API_GATEWAY", confidence: 0.9, evidence };
  }

  const wsScore = checkWsOperationBased(controllers, evidence);
  const restScore = checkRestController(controllers, evidence);
  const mvcScore = checkMvcActionBased(controllers, fileData, evidence);

  if (wsScore >= 0.5 && wsScore >= mvcScore) {
    return { type: "WS_OPERATION_BASED", confidence: wsScore, evidence };
  }

  if (mvcScore >= 0.7 && mvcScore > wsScore) {
    return { type: "MVC_ACTION_BASED", confidence: mvcScore, evidence };
  }

  if (wsScore > restScore && wsScore >= 0.5) {
    return { type: "WS_OPERATION_BASED", confidence: wsScore, evidence };
  }

  if (restScore >= 0.3) {
    return { type: "REST_CONTROLLER", confidence: restScore, evidence };
  }

  evidence.push("Defaulting to REST_CONTROLLER (no strong signals)");
  return { type: "REST_CONTROLLER", confidence: 0.3, evidence };
}

function checkWsOperationBased(controllers: GraphNode[], evidence: string[]): number {
  let score = 0;

  const handleMethodCount = controllers.filter(
    (c) => c.methodName === "handle"
  ).length;
  const handleRatio = handleMethodCount / controllers.length;

  if (handleRatio >= 0.7) {
    score += 0.35;
    evidence.push(
      `${(handleRatio * 100).toFixed(0)}% of controllers have methodName="handle" (${handleMethodCount}/${controllers.length})`
    );
  } else if (handleRatio >= 0.4) {
    score += 0.15;
    evidence.push(
      `${(handleRatio * 100).toFixed(0)}% of controllers have methodName="handle"`
    );
  }

  const wsSuffixCount = controllers.filter((c) =>
    WS_CLASS_SUFFIXES.test(c.className)
  ).length;
  const wsSuffixRatio = wsSuffixCount / controllers.length;

  if (wsSuffixRatio >= 0.7) {
    score += 0.3;
    evidence.push(
      `${(wsSuffixRatio * 100).toFixed(0)}% of controllers have WsV*/ServiceV* suffix (${wsSuffixCount}/${controllers.length})`
    );
  } else if (wsSuffixRatio >= 0.4) {
    score += 0.15;
    evidence.push(
      `${(wsSuffixRatio * 100).toFixed(0)}% have WsV*/ServiceV* suffix`
    );
  }

  const verbEntityCount = controllers.filter((c) =>
    VERB_ENTITY_PATTERN.test(c.className)
  ).length;
  const verbEntityRatio = verbEntityCount / controllers.length;

  if (verbEntityRatio >= 0.5) {
    score += 0.2;
    evidence.push(
      `${(verbEntityRatio * 100).toFixed(0)}% follow Verb+Entity naming (${verbEntityCount}/${controllers.length})`
    );
  }

  const rootPathCount = controllers.filter((c) => {
    const meta = c.metadata as { fullPath?: string };
    return !meta.fullPath || meta.fullPath === "/" || meta.fullPath === "";
  }).length;
  const rootPathRatio = rootPathCount / controllers.length;

  if (rootPathRatio >= 0.7) {
    score += 0.15;
    evidence.push(
      `${(rootPathRatio * 100).toFixed(0)}% have root/empty path (${rootPathCount}/${controllers.length})`
    );
  }

  return score;
}

function checkRestController(controllers: GraphNode[], evidence: string[]): number {
  let score = 0;

  const uniqueMethods = new Set(
    controllers.map((c) => c.methodName).filter(Boolean)
  );
  const methodDiversity = uniqueMethods.size / Math.max(controllers.length, 1);

  if (methodDiversity >= 0.3) {
    score += 0.3;
    evidence.push(
      `High method name diversity: ${uniqueMethods.size} unique methods across ${controllers.length} controllers`
    );
  }

  const meaningfulPathCount = controllers.filter((c) => {
    const meta = c.metadata as { fullPath?: string };
    return meta.fullPath && meta.fullPath !== "/" && meta.fullPath.length > 1;
  }).length;
  const meaningfulPathRatio = meaningfulPathCount / controllers.length;

  if (meaningfulPathRatio >= 0.5) {
    score += 0.35;
    evidence.push(
      `${(meaningfulPathRatio * 100).toFixed(0)}% have meaningful endpoint paths (${meaningfulPathCount}/${controllers.length})`
    );
  }

  const nonWsCount = controllers.filter(
    (c) => !WS_CLASS_SUFFIXES.test(c.className)
  ).length;
  const nonWsRatio = nonWsCount / controllers.length;

  if (nonWsRatio >= 0.7) {
    score += 0.2;
    evidence.push(
      `${(nonWsRatio * 100).toFixed(0)}% have standard Controller naming`
    );
  }

  return score;
}

function checkMvcActionBased(
  controllers: GraphNode[],
  fileData: { filePath: string }[] | undefined,
  evidence: string[]
): number {
  let score = 0;

  if (fileData) {
    const mvcFileCount = fileData.filter(
      (f) =>
        f.filePath.endsWith(".jsp") ||
        f.filePath.endsWith(".xhtml") ||
        f.filePath.endsWith(".jsf") ||
        MVC_INDICATORS.test(f.filePath)
    ).length;

    if (mvcFileCount > 0) {
      score += 0.4;
      evidence.push(`Found ${mvcFileCount} JSP/JSF/MVC files`);
    }
  }

  const mvcClassCount = controllers.filter((c) => {
    const meta = c.metadata as { annotations?: string[] };
    const hasNoRestAnnotation =
      !meta.annotations ||
      !meta.annotations.some((a) =>
        a.includes("RestController") || a.includes("ResponseBody")
      );
    return hasNoRestAnnotation && MVC_INDICATORS.test(c.className);
  }).length;

  if (mvcClassCount > 0) {
    score += 0.3;
    evidence.push(`Found ${mvcClassCount} MVC/Action-style classes`);
  }

  return score;
}

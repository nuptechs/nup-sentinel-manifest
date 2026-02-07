import {
  ApplicationGraph,
  GraphNode,
  GraphEdge,
  analyzeEndpoints,
} from "./application-graph";
import type {
  NodeType,
  EdgeRelation,
  EndpointImpact,
} from "./application-graph";
import { spawn, type ChildProcess } from "child_process";
import path from "path";

const JAVA_ENGINE_PORT = 9876;
const JAVA_ENGINE_URL = `http://127.0.0.1:${JAVA_ENGINE_PORT}`;
const JAR_PATH = path.resolve(
  "java-analyzer-engine/target/java-analyzer-engine-1.0.0.jar",
);

let javaProcess: ChildProcess | null = null;
let engineReady = false;

async function waitForEngine(maxWaitMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${JAVA_ENGINE_URL}/health`);
      if (res.ok) {
        engineReady = true;
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Java analyzer engine failed to start within timeout");
}

async function ensureEngineRunning(): Promise<void> {
  if (engineReady) {
    try {
      const res = await fetch(`${JAVA_ENGINE_URL}/health`);
      if (res.ok) return;
    } catch {
      engineReady = false;
    }
  }

  if (javaProcess) {
    try {
      javaProcess.kill();
    } catch {}
    javaProcess = null;
  }

  javaProcess = spawn("java", ["-jar", JAR_PATH, String(JAVA_ENGINE_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  javaProcess.stdout?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log("[java-engine]", msg);
  });

  javaProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error("[java-engine:err]", msg);
  });

  javaProcess.on("exit", (code) => {
    engineReady = false;
    javaProcess = null;
    if (code !== 0 && code !== null) {
      console.error(`[java-engine] exited with code ${code}`);
    }
  });

  await waitForEngine();
}

interface JavaEngineResult {
  nodes: Array<{
    id: string;
    type: string;
    className: string;
    methodName: string | null;
    qualifiedSignature: string | null;
    metadata: Record<string, unknown>;
  }>;
  edges: Array<{
    fromNode: string;
    toNode: string;
    relationType: string;
    metadata: Record<string, unknown>;
  }>;
  resolutionErrors?: string[];
}

export interface GraphBuildResult {
  graph: ApplicationGraph;
  resolutionErrors: string[];
}

async function callJavaEngine(
  javaFiles: Record<string, string>,
): Promise<JavaEngineResult> {
  await ensureEngineRunning();

  const res = await fetch(`${JAVA_ENGINE_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(javaFiles),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Java engine returned ${res.status}: ${errBody}`);
  }

  return res.json() as Promise<JavaEngineResult>;
}

function reconstructGraph(result: JavaEngineResult): ApplicationGraph {
  const graph = new ApplicationGraph();

  for (const n of result.nodes) {
    const node = new GraphNode(
      n.id,
      n.type as NodeType,
      n.className,
      n.methodName || null,
      n.qualifiedSignature || null,
      n.metadata || {},
    );
    graph.addNode(node);
  }

  for (const e of result.edges) {
    const edge = new GraphEdge(
      e.fromNode,
      e.toNode,
      e.relationType as EdgeRelation,
      e.metadata || {},
    );
    graph.addEdge(edge);
  }

  return graph;
}

export async function buildApplicationGraph(
  files: { filePath: string; content: string }[],
): Promise<GraphBuildResult> {
  const javaFiles: Record<string, string> = {};

  for (const f of files) {
    if (f.filePath.endsWith(".java")) {
      javaFiles[f.filePath] = f.content;
    }
  }

  if (Object.keys(javaFiles).length === 0) {
    return { graph: new ApplicationGraph(), resolutionErrors: [] };
  }

  const result = await callJavaEngine(javaFiles);
  return {
    graph: reconstructGraph(result),
    resolutionErrors: result.resolutionErrors || [],
  };
}

export function analyzeGraphEndpoints(
  graph: ApplicationGraph,
): EndpointImpact[] {
  return analyzeEndpoints(graph);
}

export function shutdownJavaEngine(): void {
  if (javaProcess) {
    try {
      javaProcess.kill();
    } catch {}
    javaProcess = null;
    engineReady = false;
  }
}

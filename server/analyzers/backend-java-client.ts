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

  javaProcess = spawn("java", ["-Xmx2g", "-Xms512m", "-jar", JAR_PATH, String(JAVA_ENGINE_PORT)], {
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
  const fileCount = Object.keys(javaFiles).length;
  const totalBytes = Object.values(javaFiles).reduce((sum, content) => sum + content.length, 0);
  const totalKB = (totalBytes / 1024).toFixed(1);
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
  console.log(`[java-client] Preparing to send ${fileCount} Java files (${totalKB} KB / ${totalMB} MB) to Java engine...`);

  const engineStart = Date.now();
  await ensureEngineRunning();
  console.log(`[java-client] Engine ready in ${Date.now() - engineStart}ms`);

  console.log(`[java-client] Serializing JSON payload...`);
  const serializeStart = Date.now();
  const jsonBody = JSON.stringify(javaFiles);
  const jsonSizeMB = (jsonBody.length / (1024 * 1024)).toFixed(1);
  console.log(`[java-client] JSON payload: ${jsonSizeMB} MB — serialized in ${Date.now() - serializeStart}ms`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1000);

  const sendStart = Date.now();
  console.log(`[java-client] Sending POST /analyze (${jsonSizeMB} MB payload)...`);
  let res: Response;
  try {
    res = await fetch(`${JAVA_ENGINE_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: jsonBody,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeout);
    const elapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
    if (err.name === "AbortError") {
      throw new Error(`Java engine analysis timed out after ${elapsed}s (20 min limit). The project may be too large for a single analysis pass.`);
    }
    console.error(`[java-client] Fetch failed after ${elapsed}s: ${err.message}`);
    throw err;
  }
  clearTimeout(timeout);
  const fetchElapsed = ((Date.now() - sendStart) / 1000).toFixed(1);
  console.log(`[java-client] Engine responded in ${fetchElapsed}s (status ${res.status})`);

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[java-client] Engine error response: ${errBody.substring(0, 500)}`);
    throw new Error(`Java engine returned ${res.status}: ${errBody}`);
  }

  const parseStart = Date.now();
  const result = await res.json() as JavaEngineResult;
  console.log(`[java-client] JSON response parsed in ${Date.now() - parseStart}ms — ${result.nodes.length} nodes, ${result.edges.length} edges, ${result.resolutionErrors?.length || 0} resolution errors`);
  return result;
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

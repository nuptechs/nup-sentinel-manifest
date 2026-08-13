// ─────────────────────────────────────────────────────────────────────────
// Reasoner — DOMÍNIO da suíte de diagramas UML (puro, sem I/O, nunca lança).
//
// Um modelo NEUTRO (nós + relações, cada um com CONFIANÇA) que os builders por
// tipo preenchem a partir do grafo PROVADO do snapshot, e um renderer por tipo
// desenha em Mermaid. A confiança é POR ELEMENTO (observed > proven > inferred)
// — a assinatura do Sentinel: o diagrama nunca finge o que não provou.
//
// Fontes de verdade (grafo shaped): ENTITY/SERVICE/CONTROLLER/REPOSITORY/ROUTE/
// VIEW/MODULE + arestas CALLS/READS_ENTITY/WRITES_ENTITY/ASSOCIATES/EXTENDS/
// IMPLEMENTS/RUNTIME_OBSERVED. Cada nó traz `layer`/`stack`/`sourceFile`.
// ─────────────────────────────────────────────────────────────────────────

export type UmlType =
  | "class"
  | "component"
  | "package"
  | "deployment"
  | "usecase"
  | "activity"
  | "state"
  | "sequence";

export type UmlConfidence = "observed" | "proven" | "inferred";

export interface UmlGroup {
  id: string;
  label: string;
}
export interface UmlNode {
  id: string;
  label: string;
  /** papel visual: class | actor | usecase | component | node(host) | package | state | activity | decision | start | end | db */
  kind: string;
  group?: string; // id do grupo (subgraph)
  stereotype?: string; // «entity» «service» «controller» …
  confidence?: UmlConfidence;
}
export interface UmlRel {
  from: string;
  to: string;
  label?: string;
  /** association | inheritance | realization | dependency | call | reads | writes | uses | include | transition | flow */
  kind: string;
  confidence: UmlConfidence;
}
export interface UmlModel {
  type: UmlType;
  title: string;
  nodes: UmlNode[];
  rels: UmlRel[];
  groups: UmlGroup[];
  notes: string[];
  stats: Record<string, number>;
}

// ── shape do grafo shaped (só o que usamos) ────────────────────────────────
export interface GNode {
  id: string;
  type?: string;
  className?: string;
  methodName?: string;
  label?: string;
  sourceFile?: string;
  layer?: string;
  stack?: string;
  role?: string;
  observed?: boolean;
  runtimeHot?: boolean;
  entryPoint?: unknown[];
  httpMethod?: string;
  endpoint?: string;
  metadata?: Record<string, unknown>;
}
export interface GEdge {
  fromNode: string;
  toNode: string;
  relationType?: string;
  resolution?: string;
  evidence?: { method?: string };
}
export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
}

// ── helpers compartilhados ─────────────────────────────────────────────────

/** id seguro p/ Mermaid (alfanumérico + underscore, nunca vazio). */
export function safeId(raw: string): string {
  const s = String(raw || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "n";
}
const MAXL = 40;
export function clamp(s: string, n = MAXL): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
/** rótulo curto de um id de nó (`ENTITY:a.b.Contract` → `Contract`). */
export function shortLabel(n: GNode | undefined, id: string): string {
  if (n?.className) return n.className;
  if (n?.label) return n.label;
  const afterColon = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const seg = afterColon.split(/[.#/]/).filter(Boolean).pop() || afterColon;
  return seg.replace(/\.[tj]sx?$/, "");
}
export function sourceFileOf(n: GNode | undefined): string {
  const sf = n?.sourceFile ?? (n?.metadata as { sourceFile?: unknown } | undefined)?.sourceFile;
  return typeof sf === "string" ? sf : "";
}
export function edgeConfidence(e: GEdge): UmlConfidence {
  const m = e.evidence?.method || (e.resolution === "compiler" ? "STATIC_PROVEN" : "");
  if (m === "RUNTIME_OBSERVED") return "observed";
  if (m === "STATIC_PROVEN" || m === "CONFIG_PROVEN" || e.resolution === "compiler") return "proven";
  return "inferred";
}
export function nodeConfidence(n: GNode): UmlConfidence {
  if (n.observed === true || n.runtimeHot === true) return "observed";
  return "proven"; // um nó tipado do snapshot é uma estrutura provada
}
export function nodeById(graph: Graph): Map<string, GNode> {
  const m = new Map<string, GNode>();
  for (const n of graph.nodes || []) if (n?.id) m.set(n.id, n);
  return m;
}

/** modelo vazio honesto. */
export function emptyModel(type: UmlType, title: string, why: string): UmlModel {
  return { type, title, nodes: [], rels: [], groups: [], notes: [why], stats: {} };
}

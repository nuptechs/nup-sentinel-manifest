// ─────────────────────────────────────────────
// Reasoner — GAP DE RUNTIME: o que EXISTE mas nunca foi EXERCITADO (above-SOTA).
//
// O observedRatio é o TETO honesto: o OTel só instrumenta as fronteiras, então
// "sem tráfego" quase nunca quer dizer "morto" — quer dizer NÃO-EXERCITADO. Esta
// feature torna esse teto ACIONÁVEL: lista os pontos de entrada (rotas/controllers)
// que o grafo conhece mas que NENHUM traço tocou na janela, para o gestor saber o
// que o robô/os testes ainda não cobrem. A IA explica por que a cobertura está
// baixa e prioriza o que exercitar — grounded (cada rota citada é um nó real).
//
// É o oposto do dead-code: ali "não observado + não chamado + não entrada" sugere
// remover; aqui "não observado + É entrada" sugere COBRIR (gerar tráfego/teste).
// ─────────────────────────────────────────────

import type { ShapedGraph, ShapedNode } from "../analyzers/system-graph";
import type { ReasonerLLM } from "./llm";
import { parseJsonArray } from "./llm";
import { groundClaims, emptyLedger, type GroundingLedger, type GroundableClaim } from "./grounding";

/** Tipos que são PONTO DE ENTRADA exercitável por tráfego (o que a cobertura mede). */
const ENTRY_TYPES = new Set(["ROUTE", "CONTROLLER"]);

export interface UncoveredEntry {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  /** pra onde este ponto de entrada leva (nº de nós a jusante no grafo). */
  reach: number;
  /** sugestão da IA de por que/como exercitar — grounded, ou template. */
  hint: string;
}

export interface RuntimeGapReport {
  /** total de pontos de entrada conhecidos. */
  totalEntries: number;
  /** quantos foram observados em runtime. */
  observedEntries: number;
  /** cobertura = observed/total (0..1) — o número honesto, não estimado. */
  coverage: number;
  /** os pontos de entrada NUNCA exercitados, priorizados por alcance (impacto potencial). */
  uncovered: UncoveredEntry[];
  mode: "deterministic" | "llm-grounded";
  grounding: GroundingLedger;
  summary: string;
}

function labelOf(n: ShapedNode): string {
  return n.className || n.methodName || n.id.split(":").pop() || n.id;
}
function isObserved(n: ShapedNode): boolean {
  return n.observed === true || n.runtimeHot === true || n.evidence?.method === "RUNTIME_OBSERVED";
}

/** Núcleo determinístico: separa entradas observadas × não-exercitadas. Puro. */
export function findRuntimeGap(graph: ShapedGraph): {
  totalEntries: number;
  observedEntries: number;
  uncovered: Array<{ node: ShapedNode; reach: number }>;
} {
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((n) => n && typeof n.id === "string");

  // alcance a jusante (nº de nós distintos) por ponto de entrada — BFS sobre arestas.
  const out = new Map<string, string[]>();
  for (const e of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (!e || typeof e.fromNode !== "string" || typeof e.toNode !== "string") continue;
    (out.get(e.fromNode) || out.set(e.fromNode, []).get(e.fromNode)!).push(e.toNode);
  }
  const reachOf = (id: string): number => {
    const seen = new Set<string>([id]);
    const q = [id];
    let steps = 0;
    while (q.length && steps < 5000) {
      const cur = q.shift()!;
      steps++;
      for (const nb of out.get(cur) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    return seen.size - 1;
  };

  const entries = nodes.filter((n) => ENTRY_TYPES.has(String(n.type)));
  let observedEntries = 0;
  const uncovered: Array<{ node: ShapedNode; reach: number }> = [];
  for (const n of entries) {
    if (isObserved(n)) observedEntries++;
    else uncovered.push({ node: n, reach: reachOf(n.id) });
  }
  // prioriza por ALCANCE (o ponto de entrada não-coberto que move mais sistema primeiro).
  uncovered.sort((a, b) => b.reach - a.reach || a.node.id.localeCompare(b.node.id));
  return { totalEntries: entries.length, observedEntries, uncovered };
}

function templateHint(u: { node: ShapedNode; reach: number }): string {
  return `Exercitar ${labelOf(u.node)} (${u.node.type}) — alcança ${u.reach} nó(s) a jusante ainda sem prova de runtime.`;
}

interface HintClaim extends GroundableClaim {}

/**
 * Camada de IA GROUNDED: para os top-N pontos não-cobertos, a IA sugere como
 * exercitá-los e explica a prioridade — sob o gate (nodeId inexistente cai). Sem
 * LLM → template determinístico.
 */
export async function explainRuntimeGap(
  graph: ShapedGraph,
  llm: ReasonerLLM | null,
  opts: { topN?: number } = {},
): Promise<RuntimeGapReport> {
  const topN = opts.topN ?? 25;
  const { totalEntries, observedEntries, uncovered: rawAll } = findRuntimeGap(graph);
  const top = rawAll.slice(0, topN);

  const provenAnchors = new Set(top.map((u) => u.node.id));
  let ledger = emptyLedger();
  let mode: RuntimeGapReport["mode"] = "deterministic";
  const hintByNode = new Map<string, string>();

  if (llm && top.length > 0) {
    const facts = top.map((u) => ({ nodeId: u.node.id, label: labelOf(u.node), type: u.node.type, reach: u.reach }));
    const system =
      "Você é um motor de intelligence de código que fala português do Brasil. " +
      "Recebe PONTOS DE ENTRADA (rotas/controllers) que existem no grafo mas que NENHUM traço de runtime exercitou ainda (cada um com nodeId estável e o alcance a jusante). " +
      "Para CADA um, escreva UMA sugestão curta de como exercitá-lo (que fluxo/requisição dispararia) e por que priorizá-lo. " +
      "REGRAS INVIOLÁVEIS: use SOMENTE os nodeId fornecidos; NUNCA invente rota, símbolo ou fato; uma sugestão por nodeId. " +
      'Responda SOMENTE com um array JSON de { "nodeId": string, "text": string }.';
    const content = await llm(system, JSON.stringify(facts, null, 2));
    const parsed = parseJsonArray(content)
      .filter((c): c is { nodeId: string; text: string } => !!c && typeof (c as any).nodeId === "string" && typeof (c as any).text === "string")
      .map((c) => ({ anchorId: c.nodeId, text: String(c.text).trim() }) as HintClaim);
    const { kept, ledger: l } = groundClaims(parsed, provenAnchors);
    ledger = l;
    if (kept.length > 0) {
      mode = "llm-grounded";
      for (const k of kept) hintByNode.set(k.anchorId, k.text);
    }
  }

  const uncovered: UncoveredEntry[] = top.map((u) => ({
    nodeId: u.node.id,
    type: u.node.type,
    label: labelOf(u.node),
    ...(u.node.sourceFile ? { sourceFile: u.node.sourceFile } : {}),
    reach: u.reach,
    hint: hintByNode.get(u.node.id) || templateHint(u),
  }));

  const coverage = totalEntries === 0 ? 1 : observedEntries / totalEntries;
  const pct = Math.round(coverage * 100);
  const summary =
    totalEntries === 0
      ? "Nenhum ponto de entrada (rota/controller) no grafo."
      : `Cobertura de runtime dos pontos de entrada: ${observedEntries}/${totalEntries} (${pct}%). ` +
        `${rawAll.length} ponto(s) de entrada NUNCA exercitados — NÃO é código morto (são alcançáveis de fora), é falta de tráfego/teste. ` +
        `Priorizados por alcance a jusante${top.length ? ` (topo: ${top[0] ? labelOf(top[0].node) : ""} → ${top[0]?.reach || 0} nós)` : ""}.`;

  return { totalEntries, observedEntries, coverage, uncovered, mode, grounding: ledger, summary };
}

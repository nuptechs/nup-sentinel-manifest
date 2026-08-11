// ─────────────────────────────────────────────
// Reasoner — MECANISMO VERIFICADO: o Sentinel ORQUESTRA o agente, aterrado.
//
// Este é o eixo em que um agente cru ainda vencia o Sentinel: descrever o COMO —
// a sequência, os ramos, o fail-closed. O grafo (nós/arestas) codifica ESTRUTURA,
// não fluxo de controle; as arestas RUNTIME_OBSERVED dizem "tocou", não a ORDEM.
//
// A resposta não é competir com o agente — é ORQUESTRÁ-LO sobre o substrato provado
// e ATERRAR cada passo. O núcleo determinístico monta o ESQUELETO do mecanismo
// (BFS forward a partir de um símbolo, sobre arestas PROVADAS, em ordem de
// alcance ≈ sequência), com o método de evidência e se o runtime confirmou por
// passo. A camada de LLM (o "agente") só NOMEIA a intenção de cada passo provado —
// e todo passo cujo `edgeId` não existe no esqueleto é DESCARTADO pelo gate.
//
// Resultado: a narrativa de mecanismo que o agente dá, mas onde CADA passo é uma
// aresta provada (o agente dá passos sem âncora), marcado RUNTIME-CONFIRMADO ou
// SÓ-ESTÁTICO (o agente não sabe), e onde o chute do agente é rejeitado e contado.
// Estritamente dominante: tudo que o agente faz + o que ele não pode.
// ─────────────────────────────────────────────

import type { ShapedGraph, ShapedNode, ShapedEdge } from "../analyzers/system-graph";
import type { ReasonerLLM } from "./llm";
import { parseJsonArray } from "./llm";
import { groundClaims, emptyLedger, type GroundingLedger, type GroundableClaim } from "./grounding";

/** Relações que fazem parte do FLUXO de execução (não herança/associação estrutural). */
const FLOW_RELATIONS = new Set(["CALLS", "READS_ENTITY", "WRITES_ENTITY", "RUNTIME_OBSERVED"]);

export interface MechanismStep {
  /** id estável da aresta = a ÂNCORA do grounding. */
  edgeId: string;
  /** ordem ≈ profundidade de alcance a partir da entrada (a sequência aproximada). */
  order: number;
  fromLabel: string;
  toLabel: string;
  relationType: string;
  /** método de evidência da aresta: RUNTIME_OBSERVED / STATIC_PROVEN / … */
  method: string;
  /** a aresta foi EXERCITADA por tráfego real? (o que o agente cru não sabe). */
  runtimeConfirmed: boolean;
  /** proveniência estática (compiler/interface-impl/convention-name/…). */
  resolution?: string;
  /** intenção nomeada pela IA sob gate (ou o template determinístico). */
  text: string;
}

export interface MechanismReport {
  entry: string;
  resolvedEntryId: string | null;
  /** os passos do mecanismo, em ordem de alcance, cada um uma aresta PROVADA. */
  steps: MechanismStep[];
  /** quantos passos o runtime confirmou (vs só-estático). */
  runtimeConfirmed: number;
  /** ramos/pontos de decisão detectados deterministicamente (nós com fan-out > 1). */
  branches: Array<{ atLabel: string; fanOut: number }>;
  mode: "deterministic" | "llm-grounded";
  grounding: GroundingLedger;
  summary: string;
}

function labelOf(n: ShapedNode | undefined, id: string): string {
  return n?.className || n?.methodName || id.split(":").pop() || id;
}
function edgeIdOf(e: ShapedEdge): string {
  return `${e.fromNode}|${e.relationType}|${e.toNode}`;
}
function isFlow(e: ShapedEdge): boolean {
  return FLOW_RELATIONS.has(String(e.relationType));
}

/** Resolve a entrada: id exato, senão o 1º nó cujo id/label contém a query (determinístico). */
function resolveEntry(graph: ShapedGraph, query: string): string | null {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  if (nodes.some((n) => n.id === query)) return query;
  const q = query.toLowerCase();
  const hits = nodes
    .filter((n) => n.id.toLowerCase().includes(q) || (n.className || "").toLowerCase().includes(q))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hits[0]?.id ?? null;
}

/**
 * Núcleo DETERMINÍSTICO: monta o esqueleto do mecanismo por BFS forward a partir da
 * entrada, sobre arestas de FLUXO provadas. Ordem = profundidade de alcance
 * (≈ sequência). Puro, nunca lança. Cap de profundidade e de passos.
 */
export function buildMechanismSkeleton(
  graph: ShapedGraph,
  entryId: string,
  opts: { maxDepth?: number; maxSteps?: number } = {},
): { steps: Omit<MechanismStep, "text">[]; branches: Array<{ atLabel: string; fanOut: number }> } {
  const maxDepth = opts.maxDepth ?? 6;
  const maxSteps = opts.maxSteps ?? 60;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = (Array.isArray(graph?.edges) ? graph.edges : []).filter(isFlow);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // adjacência forward (dedup por edgeId), ordenada determinística.
  const out = new Map<string, ShapedEdge[]>();
  const seenEdge = new Set<string>();
  for (const e of edges) {
    if (typeof e.fromNode !== "string" || typeof e.toNode !== "string") continue;
    const eid = edgeIdOf(e);
    if (seenEdge.has(eid)) continue;
    seenEdge.add(eid);
    (out.get(e.fromNode) || out.set(e.fromNode, []).get(e.fromNode)!).push(e);
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => {
      // runtime-observado primeiro (mais forte), depois por alvo (determinístico)
      const ao = a.observed || a.evidence?.method === "RUNTIME_OBSERVED" ? 0 : 1;
      const bo = b.observed || b.evidence?.method === "RUNTIME_OBSERVED" ? 0 : 1;
      return ao - bo || a.toNode.localeCompare(b.toNode) || a.relationType.localeCompare(b.relationType);
    });
  }

  const steps: Omit<MechanismStep, "text">[] = [];
  const branches: Array<{ atLabel: string; fanOut: number }> = [];
  const visitedNode = new Set<string>([entryId]);
  const usedEdge = new Set<string>();
  // BFS por camadas: cada camada é uma "profundidade de sequência".
  let frontier = [entryId];
  for (let depth = 0; depth < maxDepth && frontier.length && steps.length < maxSteps; depth++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const outs = out.get(cur) || [];
      if (outs.length > 1) branches.push({ atLabel: labelOf(byId.get(cur), cur), fanOut: outs.length });
      for (const e of outs) {
        const eid = edgeIdOf(e);
        if (usedEdge.has(eid)) continue;
        usedEdge.add(eid);
        if (steps.length >= maxSteps) break;
        steps.push({
          edgeId: eid,
          order: steps.length + 1,
          fromLabel: labelOf(byId.get(e.fromNode), e.fromNode),
          toLabel: labelOf(byId.get(e.toNode), e.toNode),
          relationType: String(e.relationType),
          method: e.evidence?.method || "UNKNOWN",
          runtimeConfirmed: e.observed === true || e.evidence?.method === "RUNTIME_OBSERVED",
          ...(e.resolution ? { resolution: e.resolution } : {}),
        });
        if (!visitedNode.has(e.toNode)) {
          visitedNode.add(e.toNode);
          next.push(e.toNode);
        }
      }
    }
    frontier = next.sort();
  }
  // dedup de branches por label (mantém o maior fanOut), ordenado
  const branchMap = new Map<string, number>();
  for (const b of branches) branchMap.set(b.atLabel, Math.max(branchMap.get(b.atLabel) || 0, b.fanOut));
  const dedupBranches = Array.from(branchMap.entries())
    .map(([atLabel, fanOut]) => ({ atLabel, fanOut }))
    .sort((a, b) => b.fanOut - a.fanOut || a.atLabel.localeCompare(b.atLabel));
  return { steps, branches: dedupBranches };
}

function templateText(s: Omit<MechanismStep, "text">): string {
  const verb =
    s.relationType === "CALLS" ? "chama" : s.relationType === "READS_ENTITY" ? "lê" : s.relationType === "WRITES_ENTITY" ? "escreve" : s.relationType === "RUNTIME_OBSERVED" ? "→ (observado)" : s.relationType.toLowerCase();
  const tag = s.runtimeConfirmed ? "PROVADO (runtime)" : "PROVADO (estático)";
  return `${tag}: ${s.fromLabel} ${verb} ${s.toLabel}.`;
}

interface StepClaim extends GroundableClaim {}

/**
 * Camada de ORQUESTRAÇÃO: o LLM (o "agente") recebe o esqueleto PROVADO (+ trechos
 * de source opcionais) e NOMEIA a intenção de cada passo, citando o `edgeId`. O gate
 * descarta qualquer passo cujo `edgeId` não exista no esqueleto (o chute do agente).
 * Sem LLM → texto determinístico. Runtime-confirmação é do esqueleto, não do LLM.
 */
export async function traceMechanism(
  graph: ShapedGraph,
  entryQuery: string,
  llm: ReasonerLLM | null,
  opts: { maxDepth?: number; maxSteps?: number; sourceByFile?: Map<string, string> } = {},
): Promise<MechanismReport> {
  const resolvedEntryId = resolveEntry(graph, entryQuery);
  if (!resolvedEntryId) {
    return {
      entry: entryQuery,
      resolvedEntryId: null,
      steps: [],
      runtimeConfirmed: 0,
      branches: [],
      mode: "deterministic",
      grounding: emptyLedger(),
      summary: `Nenhum nó casou a entrada "${entryQuery}" — nada a traçar.`,
    };
  }

  const { steps: raw, branches } = buildMechanismSkeleton(graph, resolvedEntryId, opts);
  const provenAnchors = new Set(raw.map((s) => s.edgeId));
  const textByEdge = new Map<string, string>();
  let ledger = emptyLedger();
  let mode: MechanismReport["mode"] = "deterministic";

  if (llm && raw.length > 0) {
    const facts = raw.slice(0, 40).map((s) => ({ edgeId: s.edgeId, order: s.order, from: s.fromLabel, to: s.toLabel, relation: s.relationType, method: s.method }));
    const system =
      "Você é um motor de intelligence de código que EXPLICA o MECANISMO de uma feature em português do Brasil. " +
      "Recebe os PASSOS PROVADOS do fluxo (arestas verificadas, em ordem de alcance, cada uma com um edgeId estável) e, se houver, trechos de código-fonte. " +
      "Para CADA passo, escreva UMA frase curta que NOMEIA a intenção técnica/de negócio daquele passo (o QUE acontece ali no fluxo). " +
      "REGRAS INVIOLÁVEIS: use SOMENTE os edgeId fornecidos; NUNCA invente um passo, símbolo ou relação fora da lista; não descreva ordem além da dada; uma frase por edgeId. " +
      'Responda SOMENTE com um array JSON de { "edgeId": string, "text": string }.';
    // trechos de source (opcional) — o "agente" lê o código como o agente cru faria
    let srcBlock = "";
    if (opts.sourceByFile && opts.sourceByFile.size > 0) {
      const files = Array.from(opts.sourceByFile.entries()).slice(0, 6);
      srcBlock = "\n\nTrechos de código-fonte relevantes (para inferir a intenção):\n" + files.map(([f, c]) => `--- ${f} ---\n${c.slice(0, 2500)}`).join("\n");
    }
    const user = "Passos provados do fluxo:\n" + JSON.stringify(facts, null, 2) + srcBlock;
    const content = await llm(system, user);
    const parsed = parseJsonArray(content)
      .filter((c): c is { edgeId: string; text: string } => !!c && typeof (c as any).edgeId === "string" && typeof (c as any).text === "string")
      .map((c) => ({ anchorId: c.edgeId, text: String(c.text).trim() }) as StepClaim);
    const { kept, ledger: l } = groundClaims(parsed, provenAnchors);
    ledger = l;
    if (kept.length > 0) {
      mode = "llm-grounded";
      for (const k of kept) textByEdge.set(k.anchorId, k.text);
    }
  }

  const steps: MechanismStep[] = raw.map((s) => ({ ...s, text: textByEdge.get(s.edgeId) || templateText(s) }));
  const runtimeConfirmed = steps.filter((s) => s.runtimeConfirmed).length;
  const summary =
    steps.length === 0
      ? `A entrada "${labelOf(graph.nodes.find((n) => n.id === resolvedEntryId), resolvedEntryId)}" não tem arestas de fluxo a jusante no grafo provado.`
      : `Mecanismo de ${entryQuery}: ${steps.length} passo(s) PROVADO(s) em ordem de alcance, ${runtimeConfirmed} confirmado(s) por runtime, ${branches.length} ponto(s) de decisão. ` +
        `${mode === "llm-grounded" ? `IA nomeou a intenção sob gate (${ledger.rejected} chute(s) rejeitado(s)).` : "Modo determinístico (sem LLM)."} ` +
        `Cada passo é uma aresta provada — nenhum é chute não-ancorado.`;

  return { entry: entryQuery, resolvedEntryId, steps, runtimeConfirmed, branches, mode, grounding: ledger, summary };
}

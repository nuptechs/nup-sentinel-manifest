// ─────────────────────────────────────────────
// Reasoner — DOMÍNIOS por COMUNIDADE do grafo provado (net-new, above-SOTA).
//
// Transforma "o impacto toca 47 nós" em "toca o domínio de Execução Financeira".
// O agente cru nomeia domínios pela PASTA (folder) — que é declaração, não
// comportamento. Aqui os domínios EMERGEM do que DE FATO se chama no grafo provado
// (as arestas CALLS/READS/WRITES), via detecção de comunidade — e a IA só NOMEIA
// cada comunidade a partir dos seus membros reais, sob o gate de grounding (nome
// cujo communityId não existe é DESCARTADO).
//
// O problema clássico (blob): num call-graph denso, um util/logger/config
// compartilhado tem grau altíssimo e COLA todos os domínios num aglomerado só. A
// defesa é o DAMPING DE HUBS — nós de grau muito alto NÃO propagam rótulo (não
// deixam a comunidade vazar por eles). É o que faz as fronteiras aparecerem.
//
// Algoritmo: label-propagation DETERMINÍSTICO (ordem de id fixa, empate pelo menor
// rótulo) sobre o grafo NÃO-dirigido, ignorando arestas que tocam hubs. Puro.
// ─────────────────────────────────────────────

import type { ShapedGraph, ShapedNode } from "../analyzers/system-graph";
import type { ReasonerLLM } from "./llm";
import { parseJsonArray } from "./llm";
import { groundClaims, emptyLedger, type GroundingLedger, type GroundableClaim } from "./grounding";

/** Relações que contam como "co-pertence ao mesmo domínio" (comportamento, não herança). */
const DOMAIN_EDGE_TYPES = new Set(["CALLS", "READS_ENTITY", "WRITES_ENTITY", "ASSOCIATES"]);

export interface Domain {
  /** id estável da comunidade (o menor id de nó dela) — a ÂNCORA do grounding. */
  id: string;
  /** nome de negócio (IA sob gate) OU derivado do prefixo de pacote (determinístico). */
  name: string;
  size: number;
  /** amostra de membros (labels legíveis) para leitura e para o prompt da IA. */
  members: string[];
  /** distribuição de tipos na comunidade (SERVICE/CONTROLLER/…). */
  byType: Record<string, number>;
  /** nós observados em runtime nesta comunidade / total (quão "viva" ela é). */
  runtimeHot: number;
  nodeIds: string[];
}

export interface DomainSeam {
  from: string; // domain id
  to: string; // domain id
  /** nº de arestas provadas cruzando a fronteira (o acoplamento entre domínios). */
  edges: number;
}

export interface DomainsReport {
  domains: Domain[];
  /** as fronteiras: acoplamento inter-domínio (o "seam" que a arquitetura paga). */
  seams: DomainSeam[];
  /** nós hub (grau alto) que NÃO propagaram — reportados para transparência. */
  hubs: string[];
  mode: "deterministic" | "llm-grounded";
  grounding: GroundingLedger;
  summary: string;
}

function labelOf(n: ShapedNode): string {
  return n.className || n.methodName || n.id.split(":").pop() || n.id;
}

/** Prefixo de pacote/caminho comum dos membros — o nome determinístico (fallback). */
function commonPrefixName(members: string[]): string {
  const pkgs = members
    .map((m) => {
      // "easynup.services.contract.Foo" → "easynup.services.contract"
      const dot = m.lastIndexOf(".");
      return dot > 0 ? m.slice(0, dot) : m;
    })
    .filter(Boolean);
  if (pkgs.length === 0) return "domínio";
  // segmento mais frequente após o penúltimo ponto (ex.: "contract", "financial")
  const segCount = new Map<string, number>();
  for (const p of pkgs) {
    const segs = p.split(".");
    const seg = segs[segs.length - 1] || segs[0];
    segCount.set(seg, (segCount.get(seg) || 0) + 1);
  }
  let best = "domínio";
  let bestN = 0;
  for (const [seg, n] of Array.from(segCount.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n > bestN) {
      best = seg;
      bestN = n;
    }
  }
  return best;
}

interface DetectOptions {
  /** comunidades menores que isto são descartadas do relatório (ruído). default 3. */
  minSize?: number;
  /** percentil de grau acima do qual o nó é HUB e não propaga. default 0.97. */
  hubPercentile?: number;
  /** teto de iterações do label-propagation. default 20. */
  maxIter?: number;
}

/**
 * Detecção de comunidade DETERMINÍSTICA (label-propagation, não-dirigido, com
 * damping de hubs). Puro, nunca lança.
 */
export function detectDomains(graph: ShapedGraph, opts: DetectOptions = {}): {
  domains: Omit<Domain, "name">[];
  seams: DomainSeam[];
  hubs: string[];
} {
  const minSize = opts.minSize ?? 3;
  const hubPct = opts.hubPercentile ?? 0.97;
  const maxIter = opts.maxIter ?? 20;

  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((n) => n && typeof n.id === "string");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ids = nodes.map((n) => n.id).sort(); // ordem determinística

  // adjacência NÃO-dirigida das arestas de domínio (dedup), só entre nós existentes.
  const undirected = new Map<string, Set<string>>();
  for (const id of ids) undirected.set(id, new Set());
  for (const e of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (!e || !DOMAIN_EDGE_TYPES.has(String(e.relationType))) continue;
    if (!byId.has(e.fromNode) || !byId.has(e.toNode) || e.fromNode === e.toNode) continue;
    undirected.get(e.fromNode)!.add(e.toNode);
    undirected.get(e.toNode)!.add(e.fromNode);
  }

  // HUBS: grau no percentil alto → não propagam (senão colam tudo num blob).
  const degrees = ids.map((id) => undirected.get(id)!.size).sort((a, b) => a - b);
  const hubThreshold = degrees.length ? degrees[Math.min(degrees.length - 1, Math.floor(degrees.length * hubPct))] : Infinity;
  const isHub = (id: string) => undirected.get(id)!.size > hubThreshold && undirected.get(id)!.size >= 8;
  const hubs = ids.filter(isHub);

  // label-propagation determinístico: cada nó começa com o próprio id; adota o
  // rótulo mais frequente entre vizinhos NÃO-hub (empate = menor rótulo).
  const label = new Map<string, string>();
  for (const id of ids) label.set(id, id);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (const id of ids) {
      if (isHub(id)) continue; // hub não muda de rótulo nem propaga
      const counts = new Map<string, number>();
      for (const nb of undirected.get(id)!) {
        if (isHub(nb)) continue; // ignora aresta que passa por hub
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) || 0) + 1);
      }
      if (counts.size === 0) continue;
      // melhor rótulo: maior contagem, empate pelo menor id de rótulo (determinismo)
      let best = label.get(id)!;
      let bestN = -1;
      for (const [l, n] of Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        if (n > bestN) {
          best = l;
          bestN = n;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // agrupa por rótulo (comunidade). O id da comunidade = menor id de membro.
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    if (isHub(id)) continue; // hubs ficam fora das comunidades (são pontes)
    const l = label.get(id)!;
    (groups.get(l) || groups.set(l, []).get(l)!).push(id);
  }

  const communityOf = new Map<string, string>();
  const domains: Omit<Domain, "name">[] = [];
  for (const [, memberIds] of groups) {
    if (memberIds.length < minSize) continue;
    const cid = memberIds.slice().sort()[0];
    for (const m of memberIds) communityOf.set(m, cid);
    const byType: Record<string, number> = {};
    let runtimeHot = 0;
    for (const m of memberIds) {
      const n = byId.get(m)!;
      byType[n.type] = (byType[n.type] || 0) + 1;
      if (n.runtimeHot || n.observed) runtimeHot++;
    }
    const memberLabels = memberIds
      .map((m) => labelOf(byId.get(m)!))
      .sort()
      .slice(0, 12);
    domains.push({
      id: cid,
      size: memberIds.length,
      members: memberLabels,
      byType,
      runtimeHot,
      nodeIds: memberIds.slice().sort(),
    });
  }
  domains.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));

  // SEAMS: acoplamento inter-domínio (arestas dirigidas cruzando a fronteira).
  const seamCount = new Map<string, number>();
  for (const e of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (!e || !DOMAIN_EDGE_TYPES.has(String(e.relationType))) continue;
    const a = communityOf.get(e.fromNode);
    const b = communityOf.get(e.toNode);
    if (!a || !b || a === b) continue;
    const k = `${a} ${b}`;
    seamCount.set(k, (seamCount.get(k) || 0) + 1);
  }
  const seams: DomainSeam[] = Array.from(seamCount.entries())
    .map(([k, edges]) => {
      const [from, to] = k.split(" ");
      return { from, to, edges };
    })
    .sort((a, b) => b.edges - a.edges || a.from.localeCompare(b.from));

  return { domains, seams, hubs };
}

interface NameClaim extends GroundableClaim {
  /** anchorId = domain id. */
}

/**
 * Nomeia cada domínio com o LLM, GROUNDED: o modelo recebe communityId + membros
 * reais e devolve um nome de negócio; nome cujo communityId ∉ comunidades é
 * DESCARTADO. Sem LLM → nome determinístico do prefixo de pacote.
 */
export async function nameDomains(graph: ShapedGraph, llm: ReasonerLLM | null, opts: DetectOptions = {}): Promise<DomainsReport> {
  const { domains: raw, seams, hubs } = detectDomains(graph, opts);
  const provenAnchors = new Set(raw.map((d) => d.id));
  let ledger = emptyLedger();
  let mode: DomainsReport["mode"] = "deterministic";
  const nameById = new Map<string, string>();

  if (llm && raw.length > 0) {
    const facts = raw.slice(0, 30).map((d) => ({
      communityId: d.id,
      size: d.size,
      types: d.byType,
      members: d.members,
    }));
    const system =
      "Você é um motor de intelligence de código que fala português do Brasil. " +
      "Recebe COMUNIDADES já detectadas no grafo de chamadas de um sistema (cada uma com communityId estável e uma amostra de membros reais). " +
      "Para CADA comunidade, dê um NOME curto de DOMÍNIO DE NEGÓCIO (ex.: 'Execução Financeira', 'Motor de Regras', 'Gestão de Contratos') que descreva o que aqueles membros fazem juntos. " +
      "REGRAS INVIOLÁVEIS: use SOMENTE os communityId fornecidos; NUNCA invente uma comunidade; o nome deve ser plausível para os membros dados; um nome por communityId. " +
      'Responda SOMENTE com um array JSON de { "communityId": string, "text": string } (text = o nome).';
    const user = JSON.stringify(facts, null, 2);
    const content = await llm(system, user);
    const parsed = parseJsonArray(content)
      .filter((c): c is { communityId: string; text: string } => !!c && typeof (c as any).communityId === "string" && typeof (c as any).text === "string")
      .map((c) => ({ anchorId: c.communityId, text: String(c.text).trim() }) as NameClaim);
    const { kept, ledger: l } = groundClaims(parsed, provenAnchors);
    ledger = l;
    if (kept.length > 0) {
      mode = "llm-grounded";
      for (const k of kept) nameById.set(k.anchorId, k.text);
    }
  }

  const domains: Domain[] = raw.map((d) => ({
    ...d,
    name: nameById.get(d.id) || commonPrefixName(d.members),
  }));

  const totalMembers = domains.reduce((s, d) => s + d.size, 0);
  const summary =
    domains.length === 0
      ? "Nenhum domínio emergiu do grafo de chamadas (grafo pequeno ou sem arestas de domínio)."
      : `${domains.length} domínio(s) emergiram do grafo de chamadas provado (${totalMembers} nós agrupados), ${seams.length} fronteira(s) de acoplamento inter-domínio, ${hubs.length} hub(s) compartilhado(s) mantidos fora das comunidades (pontes). Nomes ${mode === "llm-grounded" ? "sugeridos pela IA sob gate de grounding" : "derivados do pacote (sem LLM)"}.`;

  return { domains, seams, hubs, mode, grounding: ledger, summary };
}

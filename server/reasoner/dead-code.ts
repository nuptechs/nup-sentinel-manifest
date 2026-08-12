// ─────────────────────────────────────────────
// Reasoner — TRIAGEM DE CÓDIGO MORTO por CONVERGÊNCIA TRI-EIXO (net-new, above-SOTA).
//
// A pergunta que NENHUM dos dois agentes (leitura só-código) conseguiu responder e
// que o próprio manifest não tinha: "o que está MORTO?". Ferramentas de dead-code
// do SOTA cruzam só o eixo ESTÁTICO (alcançabilidade). Aqui a decisão converge os
// TRÊS eixos do substrato provado:
//
//   ESTÁTICO   — o nó não tem chamador (inDegree 0) OU só chamadores REFUTADOS.
//   RUNTIME    — o nó nunca foi observado por tráfego real (¬observed/¬runtimeHot).
//   CONFIG/ROLE— o nó não é PONTO DE ENTRADA legítimo (@Scheduled/listener/rota):
//                um root sem chamadores é vivo por design, não morto.
//
// HONESTIDADE (o muro, ADR-0032 §5): um nó cujo único sinal de "não roda" é
// `REFUTED_UNREACHABLE_BY_ROBOT` (auth/admin/sem-sandbox) é UNKNOWN, NÃO morto —
// entra na lista de EXCLUÍDOS por honestidade, não na de candidatos. Igualmente,
// nada aqui é afirmado como "morto": são CANDIDATOS com confiança < 1 (análise
// estática erra por reflexão/DI/serialização), e a IA só redige a PERGUNTA "vale
// investigar remover?" — a decisão é humana.
//
// Núcleo determinístico puro (`findDeadCodeCandidates`) + camada de IA grounded
// (`triageDeadCode`) sob o gate. Sem chave → só o determinístico, byte-a-byte.
// ─────────────────────────────────────────────

import type { ShapedGraph, ShapedNode, ShapedEdge } from "../analyzers/system-graph";
import type { ReasonerLLM } from "./llm";
import { parseJsonArray } from "./llm";
import { groundClaims, emptyLedger, type GroundingLedger, type GroundableClaim } from "./grounding";

/** Tipos ESTRUTURAIS que não são "código a remover" — dados/contratos, outra pergunta. */
const STRUCTURAL_TYPES = new Set(["ENTITY", "INTERFACE", "SUPERTYPE"]);

/**
 * Tipos SUPERFÍCIE-DE-ENTRADA: alcançados DE FORA do grafo de código (o framework
 * HTTP roteia até o CONTROLLER/ROUTE; o router de frontend monta a VIEW). "inDegree
 * 0" neles é o NORMAL — nenhum código os chama — logo NÃO é sinal de morte. Detectar
 * um controller/rota realmente órfão exige o wiring de roteamento (rota→handler), não
 * o grafo de chamada; até lá, honestamente NÃO os acusamos. (Num sistema de baixa
 * cobertura de runtime, "controller sem tráfego" = não-exercitado, não morto.)
 */
const ENTRY_SURFACE_TYPES = new Set(["CONTROLLER", "ROUTE", "VIEW"]);

/**
 * Grau de evidência do candidato — honesto sobre o ponto-cego de DI/reflexão:
 *   isolated        — nó TOTALMENTE isolado (sem chamador E sem chamadas) + ¬runtime.
 *                     Nada o conecta ao grafo em nenhuma direção → forte candidato.
 *   runtime-refuted — TEM chamador estático, mas o laço ativo dirigiu tráfego e a
 *                     chamada nunca apareceu (refutada). Confirmado por runtime.
 *   no-proven-caller— sem aresta de entrada PROVADA (estática nem DI-config), MAS
 *                     tem saída → PODE ser wiring por injeção/reflexão não resolvida.
 *                     Advisory (confiança baixa): o backend Spring é cheio de DI que
 *                     não vira aresta de chamada. A ressalva vem na cara.
 */
export type DeadCodeTier = "isolated" | "runtime-refuted" | "no-proven-caller";

export interface DeadCodeCandidate {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  tier: DeadCodeTier;
  /** motivos DETERMINÍSTICOS em pt-BR (o que o substrato diz, não o que a IA acha). */
  reasons: string[];
  /** 0..1, nunca 1 — estático erra por reflexão/DI. strong≈0.8, medium≈0.55. */
  confidence: number;
  /** pergunta "vale investigar remover?" — redigida pela IA sob gate, OU template. */
  question: string;
}

export interface DeadCodeExclusions {
  /** roots legítimos: sem chamador MAS ponto de entrada (@Scheduled/listener/gatilho). */
  entryPoints: number;
  /** superfícies de entrada (CONTROLLER/ROUTE/VIEW) sem chamador — alcançadas de fora, não mortas. */
  entrySurfaces: number;
  /** vivo de fato: observado em runtime. */
  runtimeObserved: number;
  /** o MURO: "não alcançável pelo robô" = UNKNOWN honesto, NÃO morto. */
  unreachableByRobot: number;
  /** IMPORT-REACHABLE: o arquivo é IMPORTADO por outro arquivo do projeto (barril de
   *  re-export / namespace-import / tipos / wiring de DI). Modelo Knip: arquivo
   *  importado NÃO é morto, mesmo sem chamada de função resolvida. */
  importReachable: number;
}

export interface DeadCodeReport {
  candidates: DeadCodeCandidate[];
  /** o que foi HONESTAMENTE excluído (transparência: por que N nós não são candidatos). */
  excluded: DeadCodeExclusions;
  mode: "deterministic" | "llm-grounded";
  grounding: GroundingLedger;
  summary: string;
}

interface RawCandidate {
  node: ShapedNode;
  tier: DeadCodeTier;
  reasons: string[];
  confidence: number;
}

function labelOf(n: ShapedNode): string {
  return n.className || n.methodName || n.id.split(":").pop() || n.id;
}

/** arquivo-fonte do nó (top-level ou metadata) — chave da import-reachability. */
function sourceFileOfNode(n: ShapedNode): string | undefined {
  const sf = n.sourceFile ?? (n as { metadata?: { sourceFile?: unknown } }).metadata?.sourceFile;
  return typeof sf === "string" && sf ? sf : undefined;
}

function isObserved(n: ShapedNode): boolean {
  return n.observed === true || n.runtimeHot === true || n.evidence?.method === "RUNTIME_OBSERVED";
}

function isEntryPoint(n: ShapedNode): boolean {
  return Array.isArray(n.entryPoint) && n.entryPoint.length > 0;
}

/**
 * Núcleo DETERMINÍSTICO: varre o grafo shaped e classifica cada nó em
 * candidato-a-morto / excluído-por-honestidade / vivo. Puro, nunca lança.
 *
 * strong  = sem chamador estático (inDegree 0) ∧ ¬runtime ∧ ¬entrypoint ∧ não-estrutural.
 * medium  = TEM chamador estático, mas TODAS as arestas de entrada foram REFUTADAS
 *           como likely-dead pelo laço ativo, ∧ ¬runtime. (estático diz que chamam,
 *           o robô dirigiu tráfego e nunca apareceu → provável falso-positivo estático.)
 */
export function findDeadCodeCandidates(
  graph: ShapedGraph,
  importReachableFiles?: Set<string>,
  configEntryFiles?: Set<string>,
): {
  candidates: RawCandidate[];
  excluded: DeadCodeExclusions;
} {
  const excluded: DeadCodeExclusions = { entryPoints: 0, entrySurfaces: 0, runtimeObserved: 0, unreachableByRobot: 0, importReachable: 0 };
  const importReach = importReachableFiles ?? new Set<string>();
  const configEntry = configEntryFiles ?? new Set<string>();
  const candidates: RawCandidate[] = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  // Índice de arestas de ENTRADA por nó (para inspecionar refutação).
  const inbound = new Map<string, ShapedEdge[]>();
  // ROLLUP de sub-nó → módulo pai: a agregação scip resolve a chamada em
  // granularidade de FUNÇÃO — a aresta aterrissa em `node:<file>::<fn>`, não no
  // MÓDULO `node:<file>`. Sem rolar isso, um serviço cuja FUNÇÃO é chamada (mas o
  // módulo não recebe aresta direta) parece "isolado" → falso-positivo de dead-code
  // (caso real identify: audit-verify.service chamado de audit.routes via
  // `verifyAuditChain`). Um módulo NÃO é morto se qualquer função sua tem entrada.
  const moduleHasCalledChild = new Set<string>();
  for (const e of edges) {
    if (!e || typeof e.toNode !== "string") continue;
    const arr = inbound.get(e.toNode);
    if (arr) arr.push(e);
    else inbound.set(e.toNode, [e]);
    const sep = e.toNode.indexOf("::");
    if (sep > 0) moduleHasCalledChild.add(e.toNode.slice(0, sep)); // credita o módulo pai
  }

  for (const n of nodes) {
    if (!n || typeof n.id !== "string") continue;
    const type = String(n.type || "");
    if (STRUCTURAL_TYPES.has(type)) continue; // dado/contrato — outra pergunta

    // Eixo RUNTIME: observado = VIVO, fim de papo (nunca candidato).
    if (isObserved(n)) {
      if ((n.inDegree ?? 0) === 0 && !isEntryPoint(n)) excluded.runtimeObserved++;
      continue;
    }

    // Superfície de entrada (CONTROLLER/ROUTE/VIEW): alcançada de fora do grafo de
    // código. "Sem chamador" é o normal — NÃO acusamos (honesto; num sistema de
    // baixa cobertura, sem-tráfego≠morto). Conta pra transparência.
    if (ENTRY_SURFACE_TYPES.has(type)) {
      if ((n.inDegree ?? 0) === 0) excluded.entrySurfaces++;
      continue;
    }

    const ins = inbound.get(n.id) || [];
    // in-degree efetivo: entrada direta OU entrada num sub-nó de função do módulo
    // (rollup acima). `n.inDegree` do grafo pode não rolar sub-nós; quando ele diz 0
    // mas há entrada direta ou de função, resgatamos para 1 (não-isolado).
    const baseInDeg = n.inDegree ?? ins.length;
    const inDeg = baseInDeg > 0 ? baseInDeg : ins.length > 0 || moduleHasCalledChild.has(n.id) ? 1 : 0;
    const outDeg = n.outDegree ?? 0;

    // ── sem chamador provado (estático nem DI-config) ──
    if (inDeg === 0) {
      // Eixo IMPORT-REACHABILITY (modelo Knip): o arquivo é IMPORTADO por outro arquivo
      // do projeto → NÃO é morto, mesmo sem chamada de função resolvida. Cobre barril de
      // re-export (`export * from`), namespace-import (`import * as`), arquivo só-de-tipos
      // e wiring de DI — que o call-graph não captura como chamada. Honesto: importado =
      // remover quebra a compilação. Conta pra transparência.
      const sf = sourceFileOfNode(n);
      if (sf && importReach.has(sf)) {
        excluded.importReachable++;
        continue;
      }
      // Eixo CONFIG_PROVEN (entry-files): arquivo RODADO DIRETO (package.json/index.html)
      // é raiz legítima — não morto, mesmo sem chamador nem importador.
      if (sf && configEntry.has(sf)) {
        excluded.entryPoints++;
        continue;
      }
      // Eixo CONFIG/ROLE: root legítimo (gatilho @Scheduled/listener) NÃO é morto.
      if (isEntryPoint(n)) {
        excluded.entryPoints++;
        continue;
      }
      if (outDeg === 0) {
        // TOTALMENTE isolado: nada o conecta ao grafo, em direção alguma. Forte.
        candidates.push({
          node: n,
          tier: "isolated",
          confidence: 0.75,
          reasons: [
            "nó totalmente isolado: sem chamador E sem chamadas resolvidas",
            "sem tráfego observado em runtime",
            "não é ponto de entrada (@Scheduled/listener/rota)",
          ],
        });
      } else {
        // Sem entrada mas COM saída: forte suspeita de wiring por DI/reflexão não
        // resolvido (o backend Spring é cheio disso). Advisory, confiança baixa.
        candidates.push({
          node: n,
          tier: "no-proven-caller",
          confidence: 0.4,
          reasons: [
            "sem aresta de entrada PROVADA (nem estática, nem DI-config)",
            "PODE ser injeção de dependência/reflexão que o analisador não resolveu — VERIFICAR antes de remover",
            "sem tráfego observado em runtime",
          ],
        });
      }
      continue;
    }

    // ── TEM chamadores, mas todos refutados como likely-dead pelo laço ativo ──
    if (ins.length > 0) {
      const refutedLikelyDead = ins.filter((e) => e.refuted?.subtype === "REFUTED_LIKELY_DEAD");
      const unreachableByRobot = ins.filter((e) => e.refuted?.subtype === "REFUTED_UNREACHABLE_BY_ROBOT");
      // O MURO: se há aresta "não alcançável pelo robô", é UNKNOWN honesto — NÃO morto.
      if (unreachableByRobot.length > 0) {
        excluded.unreachableByRobot++;
        continue;
      }
      // Todas as entradas refutadas como likely-dead (e há ≥1) → confirmado por runtime.
      if (refutedLikelyDead.length > 0 && refutedLikelyDead.length === ins.length) {
        candidates.push({
          node: n,
          tier: "runtime-refuted",
          confidence: 0.7,
          reasons: [
            `${refutedLikelyDead.length} aresta(s) de entrada refutada(s) como provável-morta pelo laço ativo`,
            "o robô dirigiu tráfego e a chamada nunca apareceu",
            "sem tráfego observado em runtime",
          ],
        });
      }
    }
  }

  // Ordena por confiança desc, depois por tipo/label estável.
  candidates.sort(
    (a, b) => b.confidence - a.confidence || a.node.type.localeCompare(b.node.type) || labelOf(a.node).localeCompare(labelOf(b.node)),
  );
  return { candidates, excluded };
}

const TIER_LABEL: Record<DeadCodeTier, string> = {
  isolated: "forte (isolado)",
  "runtime-refuted": "confirmado por runtime",
  "no-proven-caller": "a verificar (possível DI/reflexão)",
};

/** Pergunta-template determinística (o fallback sem IA, byte-a-byte estável). */
function templateQuestion(rc: RawCandidate): string {
  const label = labelOf(rc.node);
  return `Candidato ${TIER_LABEL[rc.tier]} a código morto: ${label} (${rc.node.type}). ${rc.reasons.join("; ")}. Vale investigar a remoção?`;
}

interface QuestionClaim extends GroundableClaim {
  /** anchorId = nodeId do candidato. */
}

/**
 * Camada de IA GROUNDED: redige, por candidato do top-N, uma pergunta pt-BR
 * "vale investigar remover?" — recebendo SÓ os fatos determinísticos do candidato
 * (nodeId, tipo, motivos). A saída passa pelo gate: pergunta cujo `anchorId` não é
 * um nodeId de candidato é DESCARTADA. Sem LLM → template determinístico.
 */
export async function triageDeadCode(
  graph: ShapedGraph,
  llm: ReasonerLLM | null,
  opts: { topN?: number; importReachableFiles?: Set<string>; configEntryFiles?: Set<string> } = {},
): Promise<DeadCodeReport> {
  const topN = opts.topN ?? 20;
  const { candidates: raw, excluded } = findDeadCodeCandidates(graph, opts.importReachableFiles, opts.configEntryFiles);
  const top = raw.slice(0, topN);

  const provenAnchors = new Set(top.map((rc) => rc.node.id));
  let ledger = emptyLedger();
  let mode: DeadCodeReport["mode"] = "deterministic";
  const questionByNode = new Map<string, string>();

  if (llm && top.length > 0) {
    const facts = top.map((rc) => ({
      nodeId: rc.node.id,
      label: labelOf(rc.node),
      type: rc.node.type,
      tier: rc.tier,
      reasons: rc.reasons,
    }));
    const system =
      "Você é um motor de intelligence de código que fala português do Brasil. " +
      "Recebe CANDIDATOS a código morto já detectados deterministicamente (cada um com nodeId estável e os motivos). " +
      "Para CADA candidato, escreva UMA pergunta curta e acionável de investigação (ex.: 'Vale confirmar se X ainda é usado por reflexão antes de remover?'). " +
      "REGRAS INVIOLÁVEIS: use SOMENTE os nodeId fornecidos; NUNCA invente um símbolo, chamador ou fato fora dos motivos dados; " +
      "não afirme que está morto (é candidato); uma pergunta por nodeId. " +
      'Responda SOMENTE com um array JSON de { "nodeId": string, "text": string }.';
    const user = JSON.stringify(facts, null, 2);
    const content = await llm(system, user);
    const parsed = parseJsonArray(content)
      .filter((c): c is { nodeId: string; text: string } => !!c && typeof (c as any).nodeId === "string" && typeof (c as any).text === "string")
      .map((c) => ({ anchorId: c.nodeId, text: String(c.text).trim() }) as QuestionClaim);
    const { kept, ledger: l } = groundClaims(parsed, provenAnchors);
    ledger = l;
    if (kept.length > 0) {
      mode = "llm-grounded";
      for (const k of kept) questionByNode.set(k.anchorId, k.text);
    }
  }

  const candidates: DeadCodeCandidate[] = top.map((rc) => ({
    nodeId: rc.node.id,
    type: rc.node.type,
    label: labelOf(rc.node),
    ...(rc.node.sourceFile ? { sourceFile: rc.node.sourceFile } : {}),
    tier: rc.tier,
    reasons: rc.reasons,
    confidence: rc.confidence,
    question: questionByNode.get(rc.node.id) || templateQuestion(rc),
  }));

  const isolated = raw.filter((c) => c.tier === "isolated").length;
  const refuted = raw.filter((c) => c.tier === "runtime-refuted").length;
  const diSuspect = raw.filter((c) => c.tier === "no-proven-caller").length;
  const summary =
    raw.length === 0
      ? "Nenhum candidato a código morto: todo nó ou tem chamador, ou roda em runtime, ou é superfície/ponto de entrada legítimo."
      : `${raw.length} candidato(s) a código morto por convergência tri-eixo: ${isolated} isolado(s) (forte), ${refuted} refutado(s) por runtime, ${diSuspect} sem-chamador-provado (VERIFICAR — pode ser DI/reflexão)` +
        ` — excluídos por honestidade: ${excluded.entrySurfaces} superfície(s) de entrada (controller/rota/tela), ${excluded.entryPoints} gatilho(s) (@Scheduled/listener), ${excluded.runtimeObserved} observado(s) em runtime, ${excluded.importReachable} importado(s) por outro arquivo (re-export/tipos/DI — não morto), ${excluded.unreachableByRobot} não-alcançável(is) pelo robô (UNKNOWN, não morto).`;

  return { candidates, excluded, mode, grounding: ledger, summary };
}

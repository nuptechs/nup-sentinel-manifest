// ─────────────────────────────────────────────
// Reasoner — VEREDITO TRI-EIXO explicável (above-SOTA).
//
// A convergência das três fontes num TIER honesto, com a IA EXPLICANDO — nunca
// decidindo. Reusa o censo epistêmico que o grafo já carrega (ShapedGraph.coverage
// — arestas por método RUNTIME_OBSERVED/STATIC_PROVEN/CONFIG_PROVEN/…), calcula um
// tier determinístico e deixa a IA prosar o porquê. O grounding aqui NÃO é por
// âncora de nó (o claim é sobre NÚMEROS): o tier é decidido deterministicamente e
// a prosa do LLM é ACEITA só se não contradisser esse tier — senão cai no template.
// Assim o "juiz" segue sendo o determinístico; a IA é o escrivão.
//
// (O Tribunal de convergência multi-fonte completo vive no nup-sentinel; aqui é a
// leitura tri-eixo do lado do manifest, sobre o mesmo censo.)
// ─────────────────────────────────────────────

import type { ShapedGraph } from "../analyzers/system-graph";
import type { ReasonerLLM } from "./llm";

export type EvidenceTier = "STRONG" | "MODERATE" | "WEAK";

export interface EvidenceVerdict {
  tier: EvidenceTier;
  /** fração de arestas RUNTIME_OBSERVED (o eixo dinâmico — pega o que o estático não vê). */
  observedRatio: number;
  /**
   * Fração de arestas PROVADAS por ALGUM método rigoroso: RUNTIME_OBSERVED (traço)
   * + STATIC_PROVEN (compilador/scip) + CONFIG_PROVEN (wiring de DI). É o número da
   * "leitura máxima" — quanto do grafo está ancorado em evidência, não em heurística
   * declarada. O teto real (não 100%): o dinâmico (DI/reflexão/higher-order) que só o
   * runtime pega + o que nenhum método alcança.
   */
  provenRatio: number;
  /** fração só-declarada/heurística (STATIC_UNRESOLVED + UNKNOWN) — o que o mapa admite NÃO ter provado. */
  unresolvedRatio: number;
  /** contagem por método de evidência (do censo do grafo). */
  byMethod: Record<string, number>;
  nodes: { observed: number; total: number };
  /** motivos DETERMINÍSTICOS do tier, em pt-BR. */
  reasons: string[];
  /** explicação em prosa — IA sob checagem de consistência, ou template. */
  explanation: string;
  mode: "deterministic" | "llm-grounded";
}

/**
 * Decide o tier DETERMINÍSTICO a partir do censo — PROVEN-AWARE. Puro.
 *
 * A leitura é forte quando muito do grafo está PROVADO (por compilador OU runtime
 * OU config) E há convergência DINÂMICA real (o runtime pega o que o estático não
 * vê). Medir só o runtime seria perverso: mesclar mais arestas provadas pelo
 * compilador CRESCE o denominador e BAIXA o observedRatio — adicionar prova não
 * pode rebaixar o veredito. Por isso o eixo primário é o `provenRatio` (união dos
 * três métodos), com o runtime como sinal de convergência.
 *
 *  STRONG   = muito provado (≥45%) com runtime real, OU runtime cobre ≥15% (o
 *             dinâmico sozinho já é prova forte do que roda).
 *  WEAK     = pouco provado por qualquer método (<20%) — mapa quase todo heurístico.
 *  MODERATE = provado estaticamente domina mas runtime ralo (sabe a ESTRUTURA, não
 *             o que de fato EXECUTA), ou zona intermediária.
 */
export function computeEvidenceVerdict(graph: ShapedGraph): Omit<EvidenceVerdict, "explanation" | "mode"> {
  const cov = graph?.coverage;
  const byMethod: Record<string, number> = (cov?.edges?.byMethod as Record<string, number>) || {};
  const total = cov?.edges?.total ?? 0;
  const observedRatio = cov?.edges?.observedRatio ?? 0;
  const nodes = cov?.nodes ?? { observed: 0, total: (graph?.nodes?.length ?? 0) };

  const runtime = byMethod.RUNTIME_OBSERVED || 0;
  const proven = runtime + (byMethod.STATIC_PROVEN || 0) + (byMethod.CONFIG_PROVEN || 0);
  const unresolved = (byMethod.UNKNOWN || 0) + (byMethod.STATIC_UNRESOLVED || 0);
  const provenRatio = total > 0 ? proven / total : 0;
  const unresolvedRatio = total > 0 ? unresolved / total : 0;

  const reasons: string[] = [];
  let tier: EvidenceTier;
  // Sinal de runtime INVARIANTE AO TAMANHO: capturar o call-graph provado pelo
  // compilador (Leitura-Máxima) cresce o denominador e faz o observedRatio (runtime/
  // total) despencar — usar SÓ ele rebaixaria um sistema bem-lido ao ADICIONAR prova.
  // "Convergência dinâmica real" = ≥25 arestas observadas (absoluto, robusto ao
  // tamanho do call-graph) OU ≥5% observado (cobre sistema pequeno bem-exercitado).
  const hasRealRuntime = runtime >= 25 || observedRatio >= 0.05;
  // STRONG por DOIS caminhos: (a) runtime domina (≥15% observado — dinâmico forte);
  // (b) muito provado (≥45%) COM convergência dinâmica real. Só provar muito com
  // runtime quase nulo NÃO é STRONG — é MODERATE (sabe a estrutura, não o que executa).
  if (observedRatio >= 0.15 || (provenRatio >= 0.45 && hasRealRuntime)) {
    tier = "STRONG";
    reasons.push(
      `${(provenRatio * 100).toFixed(1)}% do grafo PROVADO (compilador+runtime+config) com convergência dinâmica real ` +
        `(${(observedRatio * 100).toFixed(1)}% observado em runtime)`,
    );
  } else if (provenRatio < 0.2) {
    tier = "WEAK";
    reasons.push(`só ${(provenRatio * 100).toFixed(1)}% do grafo está provado por algum método — o mapa é quase todo heurístico/declarado`);
  } else {
    tier = "MODERATE";
    reasons.push(
      `${(provenRatio * 100).toFixed(1)}% provado (o compilador domina), mas runtime cobre só ${(observedRatio * 100).toFixed(1)}% ` +
        `— sabe a ESTRUTURA, pouco do que de fato EXECUTA`,
    );
  }
  reasons.push(`${(unresolvedRatio * 100).toFixed(1)}% ainda só-declarado/heurístico (teto: dinâmico que só o runtime pega)`);
  if (nodes.total > 0) reasons.push(`${nodes.observed}/${nodes.total} nós exercitados por tráfego`);
  if (runtime === 0) reasons.push("nenhuma aresta observada nesta janela — leitura depende só do estático");

  return { tier, observedRatio, provenRatio, unresolvedRatio, byMethod, nodes, reasons };
}

function templateExplanation(v: Omit<EvidenceVerdict, "explanation" | "mode">): string {
  const t = v.tier === "STRONG" ? "FORTE" : v.tier === "MODERATE" ? "MODERADA" : "FRACA";
  return `Confiança da leitura: ${t}. ${v.reasons.join("; ")}.`;
}

/** O LLM não pode trocar o tier: se citar um tier diferente do decidido, sua prosa é REJEITADA. */
function contradictsTier(text: string, tier: EvidenceTier): boolean {
  const others: EvidenceTier[] = (["STRONG", "MODERATE", "WEAK"] as EvidenceTier[]).filter((t) => t !== tier);
  const map: Record<EvidenceTier, RegExp> = {
    STRONG: /\b(forte|strong)\b/i,
    MODERATE: /\b(moderad|moderate)\w*/i,
    WEAK: /\b(frac|weak)\w*/i,
  };
  // contradiz se menciona OUTRO tier e NÃO o próprio
  const mentionsOther = others.some((t) => map[t].test(text));
  const mentionsSelf = map[tier].test(text);
  return mentionsOther && !mentionsSelf;
}

/**
 * Explica o veredito com o LLM, sob CHECAGEM DE CONSISTÊNCIA: a prosa é aceita só
 * se não contradisser o tier determinístico. Sem LLM → template.
 */
export async function explainVerdict(graph: ShapedGraph, llm: ReasonerLLM | null): Promise<EvidenceVerdict> {
  const v = computeEvidenceVerdict(graph);
  let explanation = templateExplanation(v);
  let mode: EvidenceVerdict["mode"] = "deterministic";

  if (llm) {
    const system =
      "Você é um motor de intelligence de código que fala português do Brasil. " +
      "Recebe o VEREDITO já decidido sobre a confiança da leitura de um sistema (tier + números do censo de evidência). " +
      "Escreva 2-3 frases explicando, para um gestor, o que esse tier significa e o que dá pra confiar. " +
      "REGRAS INVIOLÁVEIS: NÃO mude o tier nem invente números — explique EXATAMENTE o veredito e os números dados. " +
      "Responda só com a explicação em texto corrido.";
    const user = JSON.stringify({ tier: v.tier, provenRatio: v.provenRatio, observedRatio: v.observedRatio, unresolvedRatio: v.unresolvedRatio, byMethod: v.byMethod, nodes: v.nodes, reasons: v.reasons }, null, 2);
    const content = await llm(system, user);
    const text = typeof content === "string" ? content.trim() : "";
    if (text && !contradictsTier(text, v.tier)) {
      explanation = text;
      mode = "llm-grounded";
    }
    // LLM que contradiz o tier → prosa DESCARTADA, fica o template (o juiz é o determinístico).
  }

  return { ...v, explanation, mode };
}

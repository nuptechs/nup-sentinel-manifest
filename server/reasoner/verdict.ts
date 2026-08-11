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
  /** fração de arestas RUNTIME_OBSERVED (o eixo mais forte). */
  observedRatio: number;
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
 * Decide o tier DETERMINÍSTICO a partir do censo. Puro.
 *  STRONG   = runtime cobre uma fatia real do grafo (convergência de eixos).
 *  MODERATE = provado estaticamente/config domina, runtime ralo (existe, pouco exercitado).
 *  WEAK     = muita aresta só-declarada/UNKNOWN (o mapa admite que sabe pouco).
 */
export function computeEvidenceVerdict(graph: ShapedGraph): Omit<EvidenceVerdict, "explanation" | "mode"> {
  const cov = graph?.coverage;
  const byMethod: Record<string, number> = (cov?.edges?.byMethod as Record<string, number>) || {};
  const total = cov?.edges?.total ?? 0;
  const observedRatio = cov?.edges?.observedRatio ?? 0;
  const nodes = cov?.nodes ?? { observed: 0, total: (graph?.nodes?.length ?? 0) };

  const runtime = byMethod.RUNTIME_OBSERVED || 0;
  const unknownish = (byMethod.UNKNOWN || 0) + (byMethod.STATIC_UNRESOLVED || 0);
  const unknownRatio = total > 0 ? unknownish / total : 0;

  const reasons: string[] = [];
  let tier: EvidenceTier;
  if (observedRatio >= 0.15 && runtime > 0) {
    tier = "STRONG";
    reasons.push(`${(observedRatio * 100).toFixed(1)}% das arestas foram OBSERVADAS em runtime — convergência estático×runtime real`);
  } else if (unknownRatio > 0.4) {
    tier = "WEAK";
    reasons.push(`${(unknownRatio * 100).toFixed(1)}% das arestas são só-declaradas/UNKNOWN — o mapa sabe pouco sobre o que roda`);
  } else {
    tier = "MODERATE";
    reasons.push(`estrutura provada estaticamente domina; runtime cobre ${(observedRatio * 100).toFixed(1)}% (existe, pouco exercitado)`);
  }
  if (nodes.total > 0) reasons.push(`${nodes.observed}/${nodes.total} nós exercitados por tráfego`);
  if (runtime === 0) reasons.push("nenhuma aresta observada nesta janela — leitura depende só do estático");

  return { tier, observedRatio, byMethod, nodes, reasons };
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
    const user = JSON.stringify({ tier: v.tier, observedRatio: v.observedRatio, byMethod: v.byMethod, nodes: v.nodes, reasons: v.reasons }, null, 2);
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

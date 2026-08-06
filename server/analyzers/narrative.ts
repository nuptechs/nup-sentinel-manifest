// ─────────────────────────────────────────────
// Narrativa travada ao grafo — ADR-0033 P4.2/P4.3 (gate de grounding ESTRUTURAL).
//
// A narrativa é um PASSEIO sobre arestas VERIFICADAS. Cada afirmação de aresta
// referencia um `edgeId` do subgrafo; um verificador determinístico casa a
// afirmação a uma aresta verificada — afirmação sem `edgeId` válido é DESCARTADA
// na geração (bloqueia, NÃO sinaliza; ADR-0033 §4 pilar 2, espírito interval-
// arithmetic da §3.2). O LLM PROPÕE frases de aresta; o gate REJEITA as que citam
// aresta inexistente. Sem chave de LLM → narrativa-template determinística montada
// do subgrafo (byte-a-byte, sem alucinação possível; §4 pilar 5).
//
// A abertura garante×possível×cego e o fecho de ponto-cego são gerados da PARTIÇÃO
// já pronta (proven/possible/blindSpots/disclosure) — não do LLM (P4.3). Subgrafo
// verificado vazio → ABSTENÇÃO honesta (§3.3), nunca fabricação.
//
// Puro, determinístico dado os `edgeClaims` (a busca ao LLM é do chamador — mantém
// este módulo testável e o LLM fora do caminho crítico).
// ─────────────────────────────────────────────

import type { EvidenceMethod } from "./system-graph";
import type { NarrativeSubgraph, NarrativeEdge } from "./narrative-subgraph";

/** Tipos de afirmação da narrativa (a proveniência de CADA frase). */
export type StatementKind =
  | "partition" // abertura garante×possível×cego — determinística, da partição
  | "edge" // frase sobre UMA aresta verificada — sujeita ao gate de `edgeId`
  | "blindspot" // fecho: o que NÃO sei — determinístico, dos blindSpots
  | "coverage" // censo do grafo — determinístico
  | "abstain"; // subgrafo vazio — abstenção honesta

/** Uma afirmação da narrativa, com sua âncora de proveniência. */
export interface NarrativeStatement {
  kind: StatementKind;
  text: string;
  /** presente SÓ em kind==='edge': a aresta verificada que sustenta a frase. */
  edgeId?: string;
  /** método de evidência (edge: da aresta; demais: piso do subgrafo). */
  method?: EvidenceMethod;
  /** origem da frase: determinística (do subgrafo) ou nomeada pelo LLM sob gate. */
  origin: "deterministic" | "llm";
}

/** Uma frase de aresta PROPOSTA (pelo LLM) — entra no gate antes de virar statement. */
export interface EdgeClaim {
  /** a aresta que a frase afirma. Sem match no subgrafo → DESCARTADA. */
  edgeId: string;
  /** o texto proposto (o LLM nomeia a INTENÇÃO da aresta verificada). */
  text: string;
}

/** Uma frase REJEITADA pelo gate — auditoria de "bloqueia, não sinaliza". */
export interface DiscardedClaim {
  edgeId: string;
  text: string;
  reason: "off-map" | "empty-text";
}

export interface NarrativeResult {
  symbol: string;
  /** true quando o subgrafo verificado é vazio — a narrativa se ABSTÉM. */
  abstained: boolean;
  /** 'llm-grounded' quando o LLM contribuiu frases (todas sob gate); senão template. */
  mode: "deterministic" | "llm-grounded";
  statements: NarrativeStatement[];
  /** prosa pt-BR = statements juntas. Em modo determinístico é byte-a-byte estável. */
  prose: string;
  overallConfidence: number;
  overallMethod: EvidenceMethod;
  /** auditoria do gate: quantas frases de aresta o LLM propôs, quantas passaram, quais caíram. */
  grounding: {
    proposed: number;
    kept: number;
    discarded: number;
    discardedClaims: DiscardedClaim[];
  };
}

// ─────────────────────────────────────────────
// O GATE — o coração do P4.2. Puro, testável isoladamente.
// ─────────────────────────────────────────────

/**
 * Casa cada frase PROPOSTA a uma aresta verificada do subgrafo. Frase cujo
 * `edgeId` NÃO está no conjunto verificado é DESCARTADA (não rebaixada, não
 * marcada "confiança baixa" — REMOVIDA). Frase com texto vazio também cai.
 * Determinístico; nunca lança.
 *
 * @param claims frases propostas (tipicamente por LLM)
 * @param verifiedEdgeIds os `edgeId` que o subgrafo garante (a lei)
 */
export function applyGroundingGate(
  claims: EdgeClaim[] | null | undefined,
  verifiedEdgeIds: Set<string>,
): { kept: EdgeClaim[]; discarded: DiscardedClaim[] } {
  const kept: EdgeClaim[] = [];
  const discarded: DiscardedClaim[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(claims) ? claims : []) {
    const edgeId = typeof c?.edgeId === "string" ? c.edgeId : "";
    const text = typeof c?.text === "string" ? c.text.trim() : "";
    if (!text) {
      discarded.push({ edgeId, text: "", reason: "empty-text" });
      continue;
    }
    if (!edgeId || !verifiedEdgeIds.has(edgeId)) {
      // AFIRMAÇÃO OFF-MAP — bloqueada. NÃO entra na saída.
      discarded.push({ edgeId, text, reason: "off-map" });
      continue;
    }
    if (seen.has(edgeId)) continue; // uma frase por aresta (a mais forte/primeira)
    seen.add(edgeId);
    kept.push({ edgeId, text });
  }
  return { kept, discarded };
}

// ─────────────────────────────────────────────
// Montagem determinística das frases (a espinha; também o fallback sem LLM).
// ─────────────────────────────────────────────

function relationPhrase(rel: string): string {
  switch (rel) {
    case "CALLS":
      return "chama";
    case "READS_ENTITY":
      return "lê a entidade";
    case "WRITES_ENTITY":
      return "escreve a entidade";
    case "EXTENDS":
      return "estende";
    case "IMPLEMENTS":
      return "implementa";
    default:
      return rel.toLowerCase().replace(/_/g, " ");
  }
}

/** Frase determinística de uma aresta verificada (o template — o fallback sem LLM). */
function templateEdgeText(e: NarrativeEdge): string {
  const tag = e.method === "RUNTIME_OBSERVED" ? "PROVADO (runtime)" : "PROVADO (estático)";
  return `${tag}: ${e.fromLabel} ${relationPhrase(e.relationType)} ${e.toLabel} — ${e.provenance}.`;
}

/** Abertura garante×possível×cego, gerada da partição (P4.3). Determinística. */
function partitionStatement(sub: NarrativeSubgraph): NarrativeStatement {
  const P = sub.proven.length;
  const M = sub.possible.length;
  const K = sub.blindSpotCount;
  const parts: string[] = [];
  if (P > 0) {
    const obs = sub.proven.filter((a) => a.weakestMethod === "RUNTIME_OBSERVED").length;
    const stat = P - obs;
    const detail: string[] = [];
    if (obs) detail.push(`${obs} observado(s) em runtime`);
    if (stat) detail.push(`${stat} provado(s) estaticamente`);
    parts.push(`PROVADO afetado: ${P} alvo(s)${detail.length ? ` (${detail.join(", ")})` : ""}`);
  } else {
    parts.push("PROVADO afetado: nenhum alvo por rota inteiramente provada");
  }
  if (M > 0) parts.push(`POSSÍVEL: ${M} alvo(s) por rota que passa por aresta não-resolvida`);
  if (K > 0) parts.push(`PONTO-CEGO: ${K} aresta(s) não-resolvida(s)/desconhecida(s) tocam o raio — podem esconder impacto (dispatch dinâmico/DI)`);
  return { kind: "partition", text: `${parts.join(" · ")}.`, method: sub.overallMethod, origin: "deterministic" };
}

/** Fecho de ponto-cego, dos blindSpots reais (P4.3). Determinístico. */
function blindSpotStatement(sub: NarrativeSubgraph): NarrativeStatement | null {
  if (sub.blindSpotCount <= 0) return null;
  const sample = sub.blindSpots.slice(0, 3).map((b) => `${b.fromNode.split(":").pop()}→${b.toNode.split(":").pop()}`);
  const more = sub.blindSpotCount > sample.length ? ` (+${sub.blindSpotCount - sample.length} outra(s))` : "";
  return {
    kind: "blindspot",
    text: `Estou CEGO em ${sub.blindSpotCount} aresta(s) que não descarto: ${sample.join(", ")}${more}. NÃO afirmo o que passa por elas — mostro-as como ponto-cego, não como fato.`,
    method: "STATIC_UNRESOLVED",
    origin: "deterministic",
  };
}

function coverageStatement(sub: NarrativeSubgraph): NarrativeStatement | null {
  if (!sub.coverage) return null;
  const pct = Math.round((sub.coverage.edges.observedRatio || 0) * 100);
  return {
    kind: "coverage",
    text: `(Cobertura do grafo: ${pct}% das arestas observadas em runtime, ${sub.coverage.edges.total} no total.)`,
    origin: "deterministic",
  };
}

// ─────────────────────────────────────────────
// Orquestração — monta a narrativa a partir do subgrafo (+ frases de LLM sob gate).
// ─────────────────────────────────────────────

/**
 * Produz a narrativa travada ao grafo. Puro dado `edgeClaims` (o chamador busca
 * o LLM e passa as frases já propostas; sem elas → template determinístico).
 *
 * Garantias:
 *   • subgrafo verificado vazio ⇒ ABSTENÇÃO (não fabrica).
 *   • toda frase de aresta na saída referencia um `edgeId` verificado (gate).
 *   • abertura/fecho garante×possível×cego vêm da partição, não do LLM.
 *   • sem `edgeClaims` ⇒ prosa determinística byte-a-byte.
 */
export function narrate(sub: NarrativeSubgraph, edgeClaims?: EdgeClaim[] | null): NarrativeResult {
  const hasLlm = Array.isArray(edgeClaims);
  const mode: NarrativeResult["mode"] = hasLlm ? "llm-grounded" : "deterministic";

  // ABSTENÇÃO: nada verificado (nenhuma aresta andável E nenhum proven). §3.3.
  if (sub.edges.length === 0 && sub.proven.length === 0) {
    const reason = !sub.symbolLocatedInGraph
      ? `Nada verificado para "${sub.symbol}" no grafo de evidência: o raio veio só do manifest.`
      : `Nenhuma aresta verificada (runtime/estática) sustenta uma afirmação de impacto sobre "${sub.symbol}" aqui.`;
    const statements: NarrativeStatement[] = [
      { kind: "abstain", text: `Abstenho-me: ${reason} ${sub.disclosure}`.trim(), method: sub.overallMethod, origin: "deterministic" },
    ];
    const bs = blindSpotStatement(sub);
    if (bs) statements.push(bs);
    return {
      symbol: sub.symbol,
      abstained: true,
      mode,
      statements,
      prose: statements.map((s) => s.text).join(" "),
      overallConfidence: sub.overallConfidence,
      overallMethod: sub.overallMethod,
      grounding: { proposed: hasLlm ? edgeClaims!.length : 0, kept: 0, discarded: hasLlm ? edgeClaims!.length : 0, discardedClaims: gateAbstain(edgeClaims) },
    };
  }

  const statements: NarrativeStatement[] = [];
  // 1) abertura garante×possível×cego (determinística, da partição).
  statements.push(partitionStatement(sub));

  // 2) frases de aresta: LLM sob gate, OU template determinístico.
  let proposed = 0;
  let discardedClaims: DiscardedClaim[] = [];
  if (hasLlm) {
    proposed = edgeClaims!.length;
    const { kept, discarded } = applyGroundingGate(edgeClaims, sub.edgeIds);
    discardedClaims = discarded;
    const edgeById = new Map(sub.edges.map((e) => [e.edgeId, e] as const));
    for (const c of kept) {
      const e = edgeById.get(c.edgeId)!; // garantido pelo gate
      statements.push({ kind: "edge", text: c.text, edgeId: c.edgeId, method: e.method, origin: "llm" });
    }
    // qualquer aresta verificada que o LLM NÃO nomeou é preenchida pelo template
    // (a espinha verificada nunca é omitida por silêncio do LLM).
    const named = new Set(kept.map((c) => c.edgeId));
    for (const e of sub.edges) {
      if (named.has(e.edgeId)) continue;
      statements.push({ kind: "edge", text: templateEdgeText(e), edgeId: e.edgeId, method: e.method, origin: "deterministic" });
    }
  } else {
    for (const e of sub.edges) {
      statements.push({ kind: "edge", text: templateEdgeText(e), edgeId: e.edgeId, method: e.method, origin: "deterministic" });
    }
  }

  // 3) fecho de ponto-cego (determinístico) + censo.
  const bs = blindSpotStatement(sub);
  if (bs) statements.push(bs);
  const cov = coverageStatement(sub);
  if (cov) statements.push(cov);

  return {
    symbol: sub.symbol,
    abstained: false,
    mode,
    statements,
    prose: statements.map((s) => s.text).join(" "),
    overallConfidence: sub.overallConfidence,
    overallMethod: sub.overallMethod,
    grounding: {
      proposed,
      kept: statements.filter((s) => s.kind === "edge" && s.origin === "llm").length,
      discarded: discardedClaims.length,
      discardedClaims,
    },
  };
}

/** Na abstenção, TODA frase de aresta proposta pelo LLM é off-map por definição. */
function gateAbstain(edgeClaims?: EdgeClaim[] | null): DiscardedClaim[] {
  if (!Array.isArray(edgeClaims)) return [];
  return edgeClaims.map((c) => ({
    edgeId: typeof c?.edgeId === "string" ? c.edgeId : "",
    text: typeof c?.text === "string" ? c.text : "",
    reason: "off-map" as const,
  }));
}

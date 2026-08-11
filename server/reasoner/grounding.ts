// ─────────────────────────────────────────────
// Reasoner — GATE DE GROUNDING generalizado + livro-razão MEDIDO (a lei).
//
// Generaliza o `applyGroundingGate` da narrativa (que só casava `edgeId` de
// aresta) para QUALQUER âncora provada: um nó, uma aresta, um candidato. Toda
// feature do Reasoner (dead-code, domínios, gap de runtime, blast-radius) faz o
// LLM PROPOR claims ancorados a um id, e este gate DESCARTA — não rebaixa, não
// marca "confiança baixa": REMOVE — qualquer claim cujo `anchorId` não exista no
// conjunto provado do snapshot.
//
// O diferencial acima do SOTA não é o gate (a narrativa já tinha o princípio) —
// é o LIVRO-RAZÃO EXPOSTO: toda resposta do Reasoner carrega `proposed/kept/
// rejected/groundingRate`, tornando a honestidade um NÚMERO na tela. Um agente de
// IA cru não sabe quantas das próprias afirmações eram infundadas; o Reasoner diz.
//
// Determinístico, puro, nunca lança.
// ─────────────────────────────────────────────

/** Um claim PROPOSTO (tipicamente por LLM), ancorado a um id que deve ser provado. */
export interface GroundableClaim {
  /** o id (de nó OU aresta) que o claim afirma. Sem match no conjunto provado → DESCARTADO. */
  anchorId: string;
  /** o texto proposto. Vazio → descartado. */
  text: string;
}

/** Um claim REJEITADO pelo gate — auditoria de "bloqueia, não sinaliza". */
export interface RejectedClaim {
  anchorId: string;
  text: string;
  reason: "off-map" | "empty-text";
}

/**
 * O livro-razão da honestidade: quantos claims a IA propôs, quantos sobreviveram
 * ao gate, quantos caíram e por quê. `groundingRate` = kept/proposed (1 quando
 * nada foi proposto — vacuamente honesto). É o número que fica na tela.
 */
export interface GroundingLedger {
  proposed: number;
  kept: number;
  rejected: number;
  /** kept/proposed em [0,1]; 1 quando proposed=0. */
  groundingRate: number;
  rejectedClaims: RejectedClaim[];
}

/**
 * Casa cada claim PROPOSTO a uma âncora provada. Claim cujo `anchorId` ∉ conjunto
 * provado é DESCARTADO (`off-map`); texto vazio também (`empty-text`). Uma entrada
 * por âncora (a primeira vence). Determinístico; nunca lança.
 *
 * @param claims        claims propostos (tipicamente por LLM)
 * @param provenAnchors os ids provados pelo snapshot (a lei)
 */
export function groundClaims<T extends GroundableClaim>(
  claims: T[] | null | undefined,
  provenAnchors: Set<string>,
): { kept: T[]; ledger: GroundingLedger } {
  const kept: T[] = [];
  const rejectedClaims: RejectedClaim[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(claims) ? claims : [];
  for (const c of list) {
    const anchorId = typeof c?.anchorId === "string" ? c.anchorId : "";
    const text = typeof c?.text === "string" ? c.text.trim() : "";
    if (!text) {
      rejectedClaims.push({ anchorId, text: "", reason: "empty-text" });
      continue;
    }
    if (!anchorId || !provenAnchors.has(anchorId)) {
      // CLAIM OFF-MAP — bloqueado. NÃO entra na saída.
      rejectedClaims.push({ anchorId, text, reason: "off-map" });
      continue;
    }
    if (seen.has(anchorId)) continue; // um claim por âncora
    seen.add(anchorId);
    kept.push({ ...c, text } as T);
  }
  const proposed = list.length;
  const keptN = kept.length;
  return {
    kept,
    ledger: {
      proposed,
      kept: keptN,
      rejected: rejectedClaims.length,
      groundingRate: proposed === 0 ? 1 : keptN / proposed,
      rejectedClaims,
    },
  };
}

/** Livro-razão vazio (caminho determinístico: nenhum claim de LLM foi proposto). */
export function emptyLedger(): GroundingLedger {
  return { proposed: 0, kept: 0, rejected: 0, groundingRate: 1, rejectedClaims: [] };
}

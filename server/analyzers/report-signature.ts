// ─────────────────────────────────────────────
// report-signature — ADR-0018 Onda 5 (D6: relatório 2-faces ASSINÁVEL)
//
// Assina o relatório de impacto com HMAC-SHA256 sobre o JSON CANÔNICO
// (chaves ordenadas, determinístico) — o artefato vira anexável a TRP/TRD
// (Lei 14.133) com integridade verificável: mesmo conteúdo + mesma chave ⇒
// mesma assinatura; 1 byte mudado ⇒ assinatura inválida.
//
// Desenho de honestidade:
//   - a assinatura cobre o CONTEÚDO (contentHash = sha256 do canônico);
//     `signedAt` é metadado FORA do material assinado (não quebra verificação);
//   - SEM chave (env ausente) o relatório sai SEM o bloco — OFF byte-a-byte
//     (nunca uma assinatura fake/vazia);
//   - verificação: recompute `canonicalStringify` → sha256 → HMAC e compare.
//
// Puro; Node crypto; sem dependência.
// ─────────────────────────────────────────────

import crypto from "node:crypto";

export interface ReportSignature {
  algorithm: "HMAC-SHA256";
  /** sha256 hex do JSON canônico do relatório (o material assinado) */
  contentHash: string;
  /** HMAC-SHA256(key, contentHash) em hex */
  value: string;
  /** metadado informativo — FORA do material assinado */
  signedAt: string;
  /** id derivado da chave (sha256 truncado) p/ rotação sem vazar a chave */
  keyId: string;
}

/**
 * JSON canônico: chaves de objeto ORDENADAS em toda profundidade; arrays
 * preservam ordem (ordem de array é semântica no relatório). Determinístico —
 * a mesma estrutura serializa idêntico independente da ordem de inserção.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function contentHashOf(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}

/** assina o payload com a chave; determinístico exceto `signedAt` (metadado). */
export function signReport(payload: unknown, key: string, now?: Date): ReportSignature {
  const contentHash = contentHashOf(payload);
  const value = crypto.createHmac("sha256", key).update(contentHash).digest("hex");
  const keyId = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
  return {
    algorithm: "HMAC-SHA256",
    contentHash,
    value,
    signedAt: (now ?? new Date()).toISOString(),
    keyId,
  };
}

/** verifica assinatura contra o payload (recomputa canônico + HMAC). */
export function verifyReportSignature(payload: unknown, key: string, sig: ReportSignature): boolean {
  if (!sig || sig.algorithm !== "HMAC-SHA256") return false;
  const contentHash = contentHashOf(payload);
  if (contentHash !== sig.contentHash) return false;
  const expect = crypto.createHmac("sha256", key).update(contentHash).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expect, "hex"), Buffer.from(sig.value, "hex"));
}

/** bloco de rodapé pro relatório markdown (`?format=md`). */
export function renderSignatureFooter(sig: ReportSignature): string {
  return [
    "---",
    "",
    "**Assinatura do relatório (verificável)**",
    "",
    `- Algoritmo: ${sig.algorithm} · keyId \`${sig.keyId}\``,
    `- Hash do conteúdo (sha256 do JSON canônico): \`${sig.contentHash}\``,
    `- Assinatura: \`${sig.value}\``,
    `- Emitida em: ${sig.signedAt}`,
    "",
    "_Verificação: recompute o JSON canônico do relatório (chaves ordenadas), sha256, e o HMAC-SHA256 com a chave do servidor. Qualquer byte alterado invalida a assinatura._",
  ].join("\n");
}

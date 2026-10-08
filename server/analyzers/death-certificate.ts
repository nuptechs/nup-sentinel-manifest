// ─────────────────────────────────────────────────────────────────────────
// OBS-E08 (ADR-0036 WS-E) — DEATH-CERTIFICATE com prova e recibo.
//
// A ponta final da trilha de morte: um ARTEFATO AUDITÁVEL que afirma "este nó está
// morto" APENAS com a prova por trás e um RECIBO verificável (sha256 do corpo
// canônico). Compõe, sem I/O, o veredito de convergência tri-eixo (OBS-E06) numa
// sentença selada.
//
// FAIL-CLOSED (§2.4 da ADR-0036): só emite certificado para o estado `confirmed`.
// Um `unknown-no-runtime` ou `refuted` NUNCA vira certificado — a ausência de prova
// não é um atestado de óbito. Sem os 3 eixos, não há certidão.
//
// RECIBO: sha256 do JSON CANÔNICO do CORPO (chaves ordenadas, determinístico — o
// mesmo `contentHashOf` do report-signature). O `issuedAt` é metadado FORA do corpo
// assinado (não quebra a verificação). Mesmo corpo ⇒ mesmo recibo; 1 byte muda ⇒
// recibo inválido. `verifyDeathCertificate` recomputa e compara. PURO; nunca lança.
// ─────────────────────────────────────────────────────────────────────────

import { contentHashOf } from "./report-signature";
import type { TripleOrphanReport, TripleOrphanVerdict } from "./triple-orphan";

export interface DeathCertificateReceipt {
  algorithm: "sha256";
  /** sha256 hex do JSON canônico do CORPO do certificado (material selado). */
  contentHash: string;
}

export interface DeathCertificate {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  verdict: "dead-confirmed";
  /** confiança combinada dos 3 eixos — alta, nunca 1 (herdada do veredito E06). */
  confidence: number;
  /** as três provas, como vieram do veredito tri-eixo. */
  axes: TripleOrphanVerdict["axes"];
  /** prova legível (pt-BR): o que cada eixo afirma. */
  proof: string[];
  /** recibo verificável sobre o corpo acima. */
  receipt: DeathCertificateReceipt;
  /** metadado informativo — FORA do material do recibo. */
  issuedAt?: string;
}

/** Corpo SELADO (o que o recibo cobre): tudo menos `receipt` e `issuedAt`. */
function certificateBody(c: Omit<DeathCertificate, "receipt" | "issuedAt">): Omit<DeathCertificate, "receipt" | "issuedAt"> {
  return {
    nodeId: c.nodeId,
    type: c.type,
    label: c.label,
    ...(c.sourceFile ? { sourceFile: c.sourceFile } : {}),
    verdict: c.verdict,
    confidence: c.confidence,
    axes: c.axes,
    proof: c.proof,
  };
}

function proofLines(v: TripleOrphanVerdict): string[] {
  const src = v.axes.static.source ? ` (${v.axes.static.source})` : "";
  const reasons = v.axes.static.reasons.length ? v.axes.static.reasons.join("; ") : "sem chamador/wiring provado";
  return [
    `Eixo estático${src}: ${reasons}.`,
    "Eixo runtime: cobertura de tráfego presente e este nó NUNCA foi observado nela.",
    `Eixo config: não é ponto de entrada (${!v.axes.config.entryPoint}), não é import-reachable (${!v.axes.config.importReachable}), não roda por config (${!v.axes.config.configEntry}).`,
    `Convergência tri-eixo: confiança ${v.confidence ?? v.axes.static.confidence} (< 1 — o ponto-cego de DI/reflexão permanece; revisão humana decide a remoção).`,
  ];
}

/**
 * Emite UM certificado a partir de um veredito. Retorna null se o veredito não for
 * `confirmed` (fail-closed). PURO. `issuedAt` entra como metadado (não afeta o recibo).
 */
export function issueDeathCertificate(verdict: TripleOrphanVerdict, opts: { issuedAt?: Date } = {}): DeathCertificate | null {
  if (!verdict || verdict.state !== "confirmed") return null;
  const bodyOnly: Omit<DeathCertificate, "receipt" | "issuedAt"> = {
    nodeId: verdict.nodeId,
    type: verdict.type,
    label: verdict.label,
    ...(verdict.sourceFile ? { sourceFile: verdict.sourceFile } : {}),
    verdict: "dead-confirmed",
    confidence: verdict.confidence ?? verdict.axes.static.confidence,
    axes: verdict.axes,
    proof: proofLines(verdict),
  };
  const receipt: DeathCertificateReceipt = { algorithm: "sha256", contentHash: contentHashOf(certificateBody(bodyOnly)) };
  return {
    ...bodyOnly,
    receipt,
    ...(opts.issuedAt ? { issuedAt: opts.issuedAt.toISOString() } : {}),
  };
}

/**
 * Emite certificados para TODOS os confirmados de um relatório tri-eixo. Os
 * `unknown`/`refuted` são ignorados por desenho (fail-closed). PURO.
 */
export function issueDeathCertificates(report: TripleOrphanReport | null | undefined, opts: { issuedAt?: Date } = {}): DeathCertificate[] {
  const confirmed = Array.isArray(report?.confirmed) ? report!.confirmed : [];
  const out: DeathCertificate[] = [];
  for (const v of confirmed) {
    const cert = issueDeathCertificate(v, opts);
    if (cert) out.push(cert);
  }
  return out;
}

/**
 * Verifica a integridade de um certificado: recomputa o recibo sobre o corpo
 * canônico e compara. Qualquer byte alterado no corpo invalida. PURO, nunca lança.
 */
export function verifyDeathCertificate(cert: DeathCertificate | null | undefined): boolean {
  if (!cert || cert.verdict !== "dead-confirmed" || !cert.receipt || cert.receipt.algorithm !== "sha256") return false;
  try {
    const expected = contentHashOf(certificateBody(cert));
    return typeof cert.receipt.contentHash === "string" && cert.receipt.contentHash === expected;
  } catch {
    return false;
  }
}

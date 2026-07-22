// ─────────────────────────────────────────────
// token-vault — ADR-0019 Onda 4 (persistência CIFRADA de token de git)
//
// A maior fricção do caminho server-side era o token de git viver SÓ em memória
// (routes.ts gitTokens Map): todo restart quebrava os repos conectados. Este
// vault cifra o token com AES-256-GCM sob MANIFEST_TOKEN_ENCRYPTION_KEY
// (64 hex = 32 bytes) e persiste no projeto.
//
// FAIL-CLOSED (padrão MANIFEST_REPORT_HMAC_KEY): sem a chave no ambiente, NADA
// muda — o comportamento memória-only atual permanece (nunca grava plaintext,
// nunca grava com chave fraca). Blob versionado "v1:<iv>:<tag>:<ct>" pra
// rotação futura. Decrypt de blob adulterado/chave errada → null (nunca lança
// no caminho de request).
// ─────────────────────────────────────────────

import crypto from "node:crypto";

const KEY_ENV = "MANIFEST_TOKEN_ENCRYPTION_KEY";

/** chave válida do ambiente (64 hex) ou null — null ⇒ vault desligado. */
export function vaultKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env[KEY_ENV];
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return Buffer.from(raw, "hex");
}

/** cifra o token; retorna o blob versionado ou null (sem chave = desligado). */
export function encryptToken(plain: string, key: Buffer | null): string | null {
  if (!key || !plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

/** decifra o blob; null em QUALQUER falha (chave errada, adulterado, formato). */
export function decryptToken(blob: string | null | undefined, key: Buffer | null): string | null {
  if (!key || !blob) return null;
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const ct = Buffer.from(parts[3], "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null; // GCM detecta adulteração — fail-closed silencioso
  }
}

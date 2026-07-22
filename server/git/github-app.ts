// ─────────────────────────────────────────────
// github-app — ADR-0019 Onda 5 (o "1 clique" do topo do funil)
//
// Backend do GitHub App: o cliente INSTALA o App na org e todo PR passa a
// receber o laudo de impacto — sem escrever workflow, sem criar projeto, sem
// colar chave (auto-onboarding no 1º PR). Peças:
//
//   • appJwt        — JWT RS256 do App (node:crypto puro; iss=appId, 9 min)
//   • installationToken — troca o JWT por token de instalação (1h)
//   • verifyWebhookSignature — HMAC-SHA256 do corpo (x-hub-signature-256)
//   • appConfigFromEnv — GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (PEM ou
//     base64 do PEM) + GITHUB_APP_WEBHOOK_SECRET. FAIL-CLOSED: sem os três, o
//     endpoint responde "não configurado" e NADA muda.
//
// A parte de request/efeito (auto-onboard + comentário) vive no routes.ts;
// aqui é o núcleo testável (o JWT é verificável offline com a chave pública).
// ─────────────────────────────────────────────

import crypto from "node:crypto";

export interface GithubAppConfig {
  appId: string;
  privateKeyPem: string;
  webhookSecret: string;
  apiBase: string;
}

/** Config do App do ambiente. null ⇒ App desligado (fail-closed, nada muda). */
export function appConfigFromEnv(env: Record<string, string | undefined> = process.env): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID;
  let pem = env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
  if (!appId || !pem || !webhookSecret) return null;
  // aceita o PEM em base64 (mais fácil de colar em env de PaaS)
  if (!pem.includes("BEGIN")) {
    try {
      const decoded = Buffer.from(pem, "base64").toString("utf8");
      if (decoded.includes("BEGIN")) pem = decoded;
      else return null;
    } catch {
      return null;
    }
  }
  return {
    appId,
    privateKeyPem: pem,
    webhookSecret,
    apiBase: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
  };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * JWT RS256 do App (10 min máx; usamos 9 com clock-skew de -60s), sem lib —
 * header.payload assinados com RSA-SHA256. Verificável offline com a pública.
 */
export function appJwt(appId: string, privateKeyPem: string, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

/** Troca o JWT do App por um token de INSTALAÇÃO (1h) — é ele que fala com o repo. */
export async function installationToken(cfg: GithubAppConfig, installationId: number): Promise<string> {
  const jwt = appJwt(cfg.appId, cfg.privateKeyPem);
  const res = await fetch(`${cfg.apiBase}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nuptechs-sentinel",
    },
  });
  if (!res.ok) throw new Error(`installation token ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { token: string };
  return data.token;
}

/** HMAC-SHA256 do corpo cru vs x-hub-signature-256 (timing-safe). */
export function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = signatureHeader.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"));
  } catch {
    return false;
  }
}

/** eventos de PR que disparam o bot (abertura + novos pushes). */
export function isRelevantPrAction(action: string | undefined): boolean {
  return action === "opened" || action === "synchronize" || action === "reopened";
}

// ─────────────────────────────────────────────────────────────────────────
// Drift de SHA — "o mapa cobre o BINÁRIO QUE RODA?".
//
// Os quatro eixos do evidence-health respondem se a evidência ainda CHEGA.
// Este quinto eixo responde outra coisa, ortogonal e igualmente silenciosa: se
// o que foi analisado é o que está no ar. O mapa pode estar perfeitamente
// fresco — índice de hoje, traços de agora, análise de 2 h — e ainda assim
// descrever um commit que o ambiente já deixou para trás. Nada no sistema
// gritava isso.
//
// Origem: um confronto adversarial em que um agente, lendo apenas código,
// concluiu que o ambiente rodava binário velho. A conclusão estava ERRADA, mas
// a pergunta é legítima — e merecia resposta MEDIDA, não palpite de leitura.
//
// ─── §AS DUAS PONTAS (contratos externos, já acertados) ─────────────────
//   analisado → `POST /api/analyze` recebe `options.gitSha` (40-hex), que o
//               pipeline grava em `analysis_runs.diagnostics.gitSha`.
//   no ar     → `GET <healthUrl>` devolve `{ commit: "<40-hex>" | null }`, com
//               a URL em `conventionProfile.appInfo.healthUrl` do projeto
//               (config POR PROJETO, mesmo lugar do `runtimeOverlay` — uma
//               instância do Manifest serve vários sistemas).
//
// ─── §HONESTIDADE CRAVADA (a regra que este módulo não pode quebrar) ────
// ZERO FABRICADO: **sem SHA ≠ SHA errado**. Health fora do ar, URL não
// configurada, run sem carimbo, `commit: null` — tudo isso é `unknown` com
// motivo NOMEADO, nunca `drift`. Acusar drift sem as duas pontas medidas seria
// inventar o alarme que o eixo existe para dar de verdade.
//
// FAIL-SOFT ABSOLUTO: a sonda tem timeout curto e engole toda falha. Um
// medidor de cobertura que derruba o relatório de saúde é pior que nenhum.
// ─────────────────────────────────────────────────────────────────────────
import { normalizeGitSha } from "../git/sha";

export type DriftStatus = "in-sync" | "drift" | "unknown";

export interface DriftHealth {
  /** SHA do último run COMPLETADO que carimbou o commit. `null` = não sabemos. */
  analyzedSha: string | null;
  /** quando esse run terminou (ISO). */
  analyzedAt: string | null;
  /** SHA que o ambiente reportou no `/healthz`. `null` = não sabemos. */
  deployedSha: string | null;
  status: DriftStatus;
  /** por que não deu para comparar (ou por que deu drift). Sempre nomeado. */
  reason?: string;
}

/** Teto de espera da sonda de health: curto de propósito (não é a análise). */
export const HEALTH_PROBE_TIMEOUT_MS = 8000;

// ─── config por projeto ───

export interface AppInfoConfig {
  /** URL absoluta do endpoint de health do ambiente (ex. `https://app/healthz`). */
  healthUrl?: string;
  [k: string]: unknown;
}

/**
 * Lê o bag `appInfo` do `conventionProfile` (defensivo, nunca lança) — espelha
 * o `projectOverlayConfig` do runtime-overlay.
 */
export function projectAppInfo(project: unknown): AppInfoConfig | null {
  const cp = (project as { conventionProfile?: unknown } | null)?.conventionProfile;
  if (!cp || typeof cp !== "object") return null;
  const ai = (cp as Record<string, unknown>).appInfo;
  return ai && typeof ai === "object" && !Array.isArray(ai) ? (ai as AppInfoConfig) : null;
}

/** URL de health efetiva do projeto (`null` quando não configurada/ inválida). */
export function healthUrlOf(project: unknown): string | null {
  const url = projectAppInfo(project)?.healthUrl;
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  // só http(s): um `file://`/`ftp://` aqui seria config errada, não evidência.
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

// ─── sonda ───

export interface DeployedProbe {
  sha: string | null;
  /** presente quando NÃO deu para saber (nunca acompanha um sha resolvido). */
  reason?: string;
}

/**
 * Pergunta ao ambiente qual commit ele está rodando. Mesmo padrão fail-soft do
 * `probeJaeger`: `AbortController` com teto, toda exceção capturada, e a
 * distinção entre "não consegui perguntar" (`health-unreachable`) e "perguntei
 * e ele não sabe" (`health-no-commit`) — que é a mesma separação vazio ≠ falhou
 * que o resto do mapa respeita. NUNCA lança.
 */
export async function probeDeployedSha(
  healthUrl: string,
  deps: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<DeployedProbe> {
  const fetchFn = deps.fetchFn || fetch;
  const timeoutMs = deps.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(healthUrl, { signal: ctrl.signal });
    if (!res.ok) return { sha: null, reason: "health-unreachable" };
    const json = (await res.json()) as unknown;
    const body = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
    const sha = normalizeGitSha(body?.commit);
    // 200 sem commit utilizável: o ambiente respondeu, mas não carimba versão.
    // É "ele não sabe", não "eu não perguntei" — e a diferença dirige o conserto.
    return sha ? { sha } : { sha: null, reason: "health-no-commit" };
  } catch {
    return { sha: null, reason: "health-unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// ─── veredito ───

export interface AnalyzedRef {
  sha: string | null;
  at: string | null;
  /** motivo de não haver SHA analisado (ex. `runs-unavailable`). */
  reason?: string;
}

/**
 * Cruza as duas pontas. PURA.
 *
 * A ordem das guardas é deliberada: sem o lado ANALISADO não há comparação
 * possível, e dizer "health fora do ar" nesse caso apontaria o conserto errado
 * (o buraco é nosso, não do ambiente).
 */
export function driftHealthFrom(analyzed: AnalyzedRef, deployed: DeployedProbe): DriftHealth {
  const analyzedSha = normalizeGitSha(analyzed.sha);
  const base = { analyzedSha, analyzedAt: analyzed.at ?? null, deployedSha: deployed.sha ?? null };

  if (!analyzedSha) {
    return { ...base, status: "unknown", reason: analyzed.reason ?? "no-analyzed-sha" };
  }
  if (deployed.reason || !deployed.sha) {
    return { ...base, status: "unknown", reason: deployed.reason ?? "health-no-commit" };
  }
  return analyzedSha === deployed.sha
    ? { ...base, status: "in-sync" }
    : { ...base, status: "drift", reason: "sha-mismatch" };
}

/** Atalho do caso "ninguém configurou health" — o `unknown` mais comum. */
export function driftNotConfigured(analyzed: AnalyzedRef): DriftHealth {
  return {
    analyzedSha: normalizeGitSha(analyzed.sha),
    analyzedAt: analyzed.at ?? null,
    deployedSha: null,
    status: "unknown",
    reason: "health-url-not-configured",
  };
}

// ─── o lado analisado, extraído dos runs ───

export interface RunWithDiagnostics {
  id: number;
  status?: string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  diagnostics?: unknown;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Lê `diagnostics.gitSha` de um run (ausente/lixo ⇒ `null`). PURA. */
export function gitShaFromDiagnostics(diagnostics: unknown): string | null {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null;
  return normalizeGitSha((diagnostics as Record<string, unknown>).gitSha);
}

/**
 * O SHA que o mapa VIGENTE descreve: o do último run **completado** que carimbou
 * commit. Runs vêm DESC (mais novo primeiro).
 *
 * Por que só `completed`: um run falho não substituiu o snapshot — o `/graph`
 * segue servindo o anterior. Atribuir o SHA de um run que morreu no meio diria
 * que o mapa cobre um commit que ele nunca chegou a analisar.
 */
export function analyzedRefFrom(runs: RunWithDiagnostics[] | null | undefined): AnalyzedRef {
  if (!Array.isArray(runs) || runs.length === 0) return { sha: null, at: null, reason: "no-analyzed-sha" };
  for (const r of runs) {
    if (r?.status !== "completed") continue;
    const sha = gitShaFromDiagnostics(r.diagnostics);
    if (sha) return { sha, at: iso(r.completedAt) ?? iso(r.startedAt) };
  }
  return { sha: null, at: null, reason: "no-analyzed-sha" };
}

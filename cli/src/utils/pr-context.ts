// ─────────────────────────────────────────────
// pr-context — ADR-0019 Onda 1 (CI-native impact bot)
//
// Helpers PUROS (sem I/O) para o fluxo "rodar no CI do cliente e comentar no
// PR": resolve o contexto de PR do ambiente de CI, decide o range de diff, e
// monta o corpo do comentário idempotente (upsert por marcador oculto). O
// posting real (fetch pro GitHub) e o `git diff` (child_process) ficam no
// comando; aqui é só a lógica testável.
// ─────────────────────────────────────────────

/** Contexto de PR resolvido do ambiente de CI (GitHub Actions hoje). */
export interface PrContext {
  provider: "github";
  owner: string;
  repo: string;
  prNumber: number;
  /** ref base do PR (ex.: "main") — o lado ANTES da entrega */
  baseRef: string;
  /** SHA/ref head do PR — o lado DEPOIS */
  headRef: string;
  /** token do CI p/ postar comentário (nunca logar) */
  token: string;
  /** base da API (github.com ou GHES) */
  apiBase: string;
}

/** Marcador HTML oculto que identifica NOSSO comentário para upsert. */
export const COMMENT_MARKER = "<!-- nuptechs-sentinel-impact -->";

type Env = Record<string, string | undefined>;

/**
 * Resolve o contexto de PR do ambiente do GitHub Actions. Retorna null (com a
 * razão) quando não há PR — o chamador degrada para "imprime o laudo, não
 * comenta" (nunca quebra o CI por falta de contexto).
 *
 * Lê: GITHUB_REPOSITORY (owner/repo), GITHUB_REF_NAME/GITHUB_HEAD_REF/
 * GITHUB_BASE_REF, GITHUB_TOKEN, GITHUB_API_URL, e o número do PR do
 * GITHUB_REF (refs/pull/<n>/merge) ou do evento.
 */
export function resolveGithubPrContext(env: Env): { ctx: PrContext } | { skip: string } {
  const repoFull = env.GITHUB_REPOSITORY || "";
  const slash = repoFull.indexOf("/");
  if (slash <= 0) return { skip: "GITHUB_REPOSITORY ausente — não está em GitHub Actions" };
  const owner = repoFull.slice(0, slash);
  const repo = repoFull.slice(slash + 1);

  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const apiBase = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

  // número do PR: do ref refs/pull/<n>/merge, ou de PR_NUMBER explícito
  let prNumber = 0;
  const ref = env.GITHUB_REF || "";
  const m = ref.match(/^refs\/pull\/(\d+)\//);
  if (m) prNumber = parseInt(m[1], 10);
  else if (env.PR_NUMBER && /^\d+$/.test(env.PR_NUMBER)) prNumber = parseInt(env.PR_NUMBER, 10);

  if (!prNumber) return { skip: "sem número de PR (não é um evento pull_request)" };

  // base/head do PR
  const baseRef = env.GITHUB_BASE_REF || "";
  const headRef = env.GITHUB_HEAD_REF || env.GITHUB_SHA || "";
  if (!baseRef) return { skip: "GITHUB_BASE_REF ausente — evento não é de PR" };

  if (!token) return { skip: "GITHUB_TOKEN ausente — não é possível comentar no PR" };

  return { ctx: { provider: "github", owner, repo, prNumber, baseRef, headRef, token, apiBase } };
}

/**
 * Resolve o range de `git diff` para o PR. Prefere `origin/<base>...<head>`
 * (three-dot = mudanças do head desde o merge-base — o que o PR de fato
 * introduz). Quando head é um SHA já em HEAD (checkout do actions/checkout com
 * fetch-depth 0), usa `origin/<base>...HEAD`.
 */
export function diffRangeForPr(baseRef: string, headRef: string): string {
  const base = baseRef.includes("/") ? baseRef : `origin/${baseRef}`;
  const head = headRef && headRef !== baseRef ? headRef : "HEAD";
  return `${base}...${head}`;
}

/**
 * Monta o corpo do comentário: marcador oculto (para upsert) + o relatório
 * markdown + um rodapé de proveniência. Puro.
 */
export function buildCommentBody(reportMarkdown: string, opts: { projectName?: string; ranAt?: string } = {}): string {
  const footer =
    `\n\n<sub>🛰️ Análise de impacto por **NuPtechs Sentinel**` +
    (opts.projectName ? ` · projeto \`${opts.projectName}\`` : "") +
    (opts.ranAt ? ` · ${opts.ranAt}` : "") +
    ` · atualizado a cada push</sub>`;
  return `${COMMENT_MARKER}\n${reportMarkdown}${footer}`;
}

/** Acha, numa lista de comentários do PR, o NOSSO (pelo marcador). Puro. */
export function findExistingBotComment(
  comments: Array<{ id: number; body?: string | null }>,
): number | null {
  for (const c of comments) {
    if (typeof c.body === "string" && c.body.includes(COMMENT_MARKER)) return c.id;
  }
  return null;
}

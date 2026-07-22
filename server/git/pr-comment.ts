// ─────────────────────────────────────────────
// pr-comment — ADR-0019 Ondas 4–5 (write-back: o laudo aparece NO PR)
//
// Upsert idempotente de comentário de PR (1 comentário por PR, atualizado a
// cada push) — GitHub (issues comments) e GitLab (MR notes). O marcador oculto
// identifica o NOSSO comentário; MESMO marcador do CLI impact-pr
// (cli/src/utils/pr-context.ts) — os dois caminhos (CI-native e server-side)
// convergem no mesmo comentário, nunca duplicam.
// ─────────────────────────────────────────────

export const COMMENT_MARKER = "<!-- nuptechs-sentinel-impact -->";

export function buildServerCommentBody(reportMarkdown: string, opts: { projectName?: string; ranAt?: string } = {}): string {
  const footer =
    `\n\n<sub>🛰️ Análise de impacto por **NuPtechs Sentinel**` +
    (opts.projectName ? ` · projeto \`${opts.projectName}\`` : "") +
    (opts.ranAt ? ` · ${opts.ranAt}` : "") +
    ` · atualizado a cada push</sub>`;
  return `${COMMENT_MARKER}\n${reportMarkdown}${footer}`;
}

export function findBotComment(comments: Array<{ id: number; body?: string | null }>): number | null {
  for (const c of comments) {
    if (typeof c.body === "string" && c.body.includes(COMMENT_MARKER)) return c.id;
  }
  return null;
}

interface UpsertOpts {
  apiBase: string;
  token: string;
}

/** Upsert no GitHub: repos/:owner/:repo/issues/:n/comments (PR = issue). */
export async function upsertGithubPrComment(
  opts: UpsertOpts & { owner: string; repo: string; prNumber: number },
  body: string,
): Promise<{ action: "created" | "updated" }> {
  const h = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "nuptechs-sentinel",
  };
  const listUrl = `${opts.apiBase}/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments`;
  const existing: Array<{ id: number; body?: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${listUrl}?per_page=100&page=${page}`, { headers: h });
    if (!res.ok) break;
    const chunk = (await res.json()) as Array<{ id: number; body?: string }>;
    existing.push(...chunk);
    if (chunk.length < 100) break;
  }
  const id = findBotComment(existing);
  if (id) {
    const res = await fetch(`${opts.apiBase}/repos/${opts.owner}/${opts.repo}/issues/comments/${id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`github PATCH comment ${res.status}: ${await res.text()}`);
    return { action: "updated" };
  }
  const res = await fetch(listUrl, { method: "POST", headers: h, body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`github POST comment ${res.status}: ${await res.text()}`);
  return { action: "created" };
}

/** Upsert no GitLab: projects/:id/merge_requests/:iid/notes. */
export async function upsertGitlabMrNote(
  opts: UpsertOpts & { projectId: string | number; mrIid: number },
  body: string,
): Promise<{ action: "created" | "updated" }> {
  const h = { "PRIVATE-TOKEN": opts.token, "Content-Type": "application/json" };
  const pid = encodeURIComponent(String(opts.projectId));
  const listUrl = `${opts.apiBase}/projects/${pid}/merge_requests/${opts.mrIid}/notes`;
  const existing: Array<{ id: number; body?: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${listUrl}?per_page=100&page=${page}`, { headers: h });
    if (!res.ok) break;
    const chunk = (await res.json()) as Array<{ id: number; body?: string }>;
    existing.push(...chunk);
    if (chunk.length < 100) break;
  }
  const id = findBotComment(existing);
  if (id) {
    const res = await fetch(`${listUrl}/${id}`, { method: "PUT", headers: h, body: JSON.stringify({ body }) });
    if (!res.ok) throw new Error(`gitlab PUT note ${res.status}: ${await res.text()}`);
    return { action: "updated" };
  }
  const res = await fetch(listUrl, { method: "POST", headers: h, body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`gitlab POST note ${res.status}: ${await res.text()}`);
  return { action: "created" };
}

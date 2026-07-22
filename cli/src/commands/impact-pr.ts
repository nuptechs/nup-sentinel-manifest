// ─────────────────────────────────────────────
// impact-pr — ADR-0019 Onda 1 (o bot de PR CI-native)
//
// Roda no CI do cliente: computa o diff do PR LOCALMENTE, chama o impact-diff
// da instância do cliente, e posta o laudo 2-faces assinado como comentário de
// PR (upsert — 1 comentário por PR, atualizado a cada push). Diff-aware por
// natureza. Não precisa que o servidor guarde token de git (o CI já tem tudo).
// ─────────────────────────────────────────────

import { Command } from 'commander';
import { execFileSync } from 'child_process';
import { ManifestClient } from '../utils/api-client';
import { loadConfig, mergeConfig } from '../utils/config';
import {
  resolveGithubPrContext,
  diffRangeForPr,
  buildCommentBody,
  findExistingBotComment,
  type PrContext,
} from '../utils/pr-context';

/** Runner de git injetável (testável). Retorna stdout. */
export type GitRunner = (args: string[]) => string;

const defaultGitRunner: GitRunner = (args) =>
  execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });

/**
 * Computa o unified diff do PR. Garante que o base está buscado (fetch raso do
 * ref base) antes do diff three-dot. Fail-soft: se o fetch falha (já presente),
 * segue pro diff.
 */
export function computePrDiff(range: string, baseRef: string, git: GitRunner): string {
  try {
    // garante o ref base localmente (actions/checkout às vezes é raso)
    git(['fetch', '--no-tags', '--depth=1', 'origin', baseRef]);
  } catch {
    // já presente ou sem rede — segue; o diff falha claro se faltar mesmo
  }
  return git(['diff', '--unified=3', range]);
}

/** Posta/atualiza o comentário no PR via API do GitHub. */
async function upsertGithubComment(ctx: PrContext, body: string): Promise<{ action: 'created' | 'updated'; url: string }> {
  const fetch = (await import('node-fetch')).default;
  const h = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'nuptechs-sentinel',
  };
  const issueUrl = `${ctx.apiBase}/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments`;

  // 1) procurar comentário existente (paginado, teto defensivo)
  const existing: Array<{ id: number; body?: string }> = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${issueUrl}?per_page=100&page=${page}`, { headers: h });
    if (!res.ok) break;
    const chunk = (await res.json()) as Array<{ id: number; body?: string }>;
    existing.push(...chunk);
    if (chunk.length < 100) break;
  }
  const existingId = findExistingBotComment(existing);

  if (existingId) {
    const res = await fetch(`${ctx.apiBase}/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existingId}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`GitHub PATCH comment ${res.status}: ${await res.text()}`);
    return { action: 'updated', url: (await res.json() as any).html_url };
  }

  const res = await fetch(issueUrl, { method: 'POST', headers: h, body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`GitHub POST comment ${res.status}: ${await res.text()}`);
  return { action: 'created', url: (await res.json() as any).html_url };
}

export function createImpactPrCommand(): Command {
  const cmd = new Command('impact-pr');
  cmd
    .description('Computa o impacto do PR e posta o laudo como comentário (rodar no CI)')
    .requiredOption('--project <id>', 'ID do projeto no servidor Sentinel')
    .option('--base <ref>', 'ref base (default: do ambiente de CI)')
    .option('--head <ref>', 'ref head (default: do ambiente de CI)')
    .option('--no-comment', 'só imprime o laudo, não posta no PR')
    .option('--fail-on-alert', 'sai com código 1 se houver quebra alcançada (gate de CI)')
    .action(async (opts) => {
      const parent = cmd.parent?.opts() || {};
      const cfg = mergeConfig({ server: parent.server, key: parent.key }, loadConfig(parent.config));
      const projectId = parseInt(String(opts.project), 10);
      if (!Number.isFinite(projectId)) {
        console.error('--project inválido');
        process.exit(2);
      }

      const resolved = resolveGithubPrContext(process.env);
      const ctx = 'ctx' in resolved ? resolved.ctx : null;
      const baseRef = opts.base || ctx?.baseRef || 'main';
      const headRef = opts.head || ctx?.headRef || 'HEAD';

      const range = diffRangeForPr(baseRef, headRef);
      let diff = '';
      try {
        diff = computePrDiff(range, baseRef, defaultGitRunner);
      } catch (err: any) {
        console.error(`Falha ao computar o diff (${range}): ${err.message}`);
        console.error('Dica: use actions/checkout com fetch-depth: 0');
        process.exit(2);
      }
      if (!diff.trim()) {
        console.log('Nenhuma mudança no diff — nada a analisar.');
        return;
      }

      const client = new ManifestClient(cfg.serverUrl, cfg.apiKey);

      // JSON para o gate (--fail-on-alert) e MD para o comentário.
      let report: any = null;
      if (opts.failOnAlert) {
        report = await client.impactDiff(projectId, diff, 'json');
      }
      const markdown = (await client.impactDiff(projectId, diff, 'md')) as string;
      const body = buildCommentBody(markdown, { ranAt: new Date().toISOString() });

      if (opts.comment !== false && ctx) {
        try {
          const r = await upsertGithubComment(ctx, body);
          console.log(`Comentário ${r.action === 'created' ? 'criado' : 'atualizado'}: ${r.url}`);
        } catch (err: any) {
          console.error(`Falha ao postar comentário (o laudo segue abaixo): ${err.message}`);
          console.log('\n' + markdown);
        }
      } else {
        if (!ctx && opts.comment !== false && 'skip' in resolved) {
          console.error(`(sem comentário: ${resolved.skip})`);
        }
        console.log(markdown);
      }

      if (opts.failOnAlert) {
        const alerts = report?.breaking?.summary?.alerts ?? 0;
        if (alerts > 0) {
          console.error(`\n❌ ${alerts} quebra(s) de contrato ALCANÇADA(S) — gate de CI reprovado.`);
          process.exit(1);
        }
      }
    });
  return cmd;
}

// ─────────────────────────────────────────────
// index — ADR-0019 Onda 2 (auto-map no CI)
//
// Roda no push pra branch principal: zipa o checkout e refresca o MAPA do
// projeto na instância Sentinel (POST /api/projects/:id/reindex-zip). O cache
// por hash do pipeline torna o refresh barato quando pouco mudou. Com isto, o
// mapa nunca envelhece em silêncio (o frescor do impact-diff avisa se
// envelhecer mesmo assim).
// ─────────────────────────────────────────────

import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import { ManifestClient } from '../utils/api-client';
import { loadConfig, mergeConfig } from '../utils/config';

/** Diretórios que nunca entram no índice (puro, testável). */
export function shouldIndexEntry(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  const EXCLUDE = /(^|\/)(node_modules|\.git|dist|build|target|out|coverage|\.next|\.venv|__pycache__|vendor)(\/|$)/;
  if (EXCLUDE.test(norm)) return false;
  return true;
}

/**
 * SÓ arquivos-FONTE entram no zip (o scanner do servidor descarta o resto de
 * qualquer forma — espelha SOURCE_EXTENSIONS do repository-scanner). Sem isto
 * o zip do checkout real do easynup dava 251 MB (docs/imagens/locks) → 502.
 */
const SOURCE_EXT = /\.(java|kt|ts|tsx|js|jsx|mjs|cjs|vue|py|cs)$/i;
export function shouldIndexFile(relPath: string): boolean {
  if (!shouldIndexEntry(relPath)) return false;
  const norm = relPath.replace(/\\/g, '/');
  if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(norm)) return false;
  if (/\.(test|spec)\./.test(norm)) return true; // testes são fonte também
  return SOURCE_EXT.test(norm);
}

/** Zipa `rootDir` (filtrado) num arquivo temporário; retorna o path do zip. */
export function zipWorkspace(rootDir: string): string {
  const zip = new AdmZip();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const rel = path.relative(rootDir, abs);
      if (!shouldIndexEntry(rel)) continue;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (shouldIndexFile(rel) && st.size <= 1_500_000) zip.addLocalFile(abs, path.dirname(rel));
    }
  };
  walk(rootDir);
  const out = path.join(os.tmpdir(), `sentinel-index-${Date.now()}.zip`);
  zip.writeZip(out);
  return out;
}

export function createIndexCommand(): Command {
  const cmd = new Command('index');
  cmd
    .description('Refresca o mapa do projeto a partir do checkout atual (rodar no push da branch principal)')
    .requiredOption('--project <id>', 'ID do projeto no servidor Sentinel')
    .option('--dir <path>', 'diretório raiz a indexar', '.')
    .action(async (opts) => {
      const parent = cmd.parent?.opts() || {};
      const cfg = mergeConfig({ server: parent.server, key: parent.key }, loadConfig(parent.config));
      const projectId = parseInt(String(opts.project), 10);
      if (!Number.isFinite(projectId)) {
        console.error('--project inválido');
        process.exit(2);
      }
      const root = path.resolve(opts.dir);
      console.log(`Zipando ${root} (excluindo node_modules/.git/dist/build/target)…`);
      const zipPath = zipWorkspace(root);
      const size = fs.statSync(zipPath).size;
      console.log(`Zip: ${(size / 1024 / 1024).toFixed(1)} MB — enviando…`);
      try {
        const client = new ManifestClient(cfg.serverUrl, cfg.apiKey);
        const r = await client.reindexZip(projectId, zipPath);
        console.log(
          `✅ Mapa refrescado: ${r.files} arquivos · ${r.analysis?.totalEndpoints ?? '?'} endpoints · run #${r.analysis?.analysisRunId ?? '?'}`,
        );
      } finally {
        try { fs.unlinkSync(zipPath); } catch {}
      }
    });
  return cmd;
}

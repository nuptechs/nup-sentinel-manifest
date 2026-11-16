#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────
// CLI do produtor Codelens (ADR-044 Onda 1).
//
// Roda `extractCodelens` contra um DIRETÓRIO de fonte (um checkout local),
// VALIDA o payload contra `codelensExtractionSchema`, imprime um resumo
// (contagens + exemplos com `.vue` resolvido) e grava o JSON.
//
// Uso:
//   tsx scripts/codelens-extract.ts <dir> [--out <arquivo.json>] [--root <sub>]
//
//   <dir>          raiz a varrer (ex.: o checkout do easynup)
//   --root <sub>   prefixo relativo a preservar no filePath (default: <dir>)
//   --out <file>   onde gravar o payload (default: stdout-resumo só)
//
// NÃO faz NENHUM POST. A ativação em prod (curl) é responsabilidade do
// orquestrador, com o PO ciente — ver o relatório.
// ─────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { extractCodelens, type SourceInput } from "../server/analyzers/frontend/codelens-extractor";
import { codelensExtractionSchema } from "../server/manifest-lookup-schema";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".idea",
  ".next",
  "coverage",
  ".turbo",
  ".claude",
]);

const EXTS = new Set([".vue", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".java"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function walk(dir: string, rootForRel: string, acc: SourceInput[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(full, rootForRel, acc);
    } else if (e.isFile()) {
      if (!EXTS.has(path.extname(e.name).toLowerCase())) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(rootForRel, full) || e.name;
      acc.push({ filePath: rel, content });
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith("--")) {
    console.error("uso: tsx scripts/codelens-extract.ts <dir> [--out <file>] [--root <sub>]");
    process.exit(2);
  }
  const dir = path.resolve(argv[0]);
  let out: string | undefined;
  let root = dir;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--out") out = path.resolve(argv[++i]);
    else if (argv[i] === "--root") root = path.resolve(argv[++i]);
  }

  if (!fs.existsSync(dir)) {
    console.error(`diretório não existe: ${dir}`);
    process.exit(2);
  }

  const files: SourceInput[] = [];
  walk(dir, root, files);
  console.error(`[codelens-extract] varreu ${files.length} arquivo(s) sob ${dir}`);

  const { payload, diagnostics } = extractCodelens(files);

  // VALIDA contra o schema do ingest — prova de forma EXATA.
  const parsed = codelensExtractionSchema.safeParse(payload);
  if (!parsed.success) {
    console.error("[codelens-extract] ❌ payload NÃO valida no codelensExtractionSchema:");
    console.error(JSON.stringify(parsed.error.format(), null, 2));
    process.exit(1);
  }

  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
  const summary = {
    valid: true,
    counts: {
      routes: parsed.data.routes.length,
      pages: parsed.data.pages.length,
      composables: parsed.data.composables.length,
      entities: parsed.data.entities.length,
      i18nKeys: parsed.data.i18nKeys.length,
    },
    payloadBytes: bytes,
    payloadMB: +(bytes / 1024 / 1024).toFixed(2),
    diagnostics: {
      routerFiles: diagnostics.routerFiles,
      routesWithComponentPath: diagnostics.routesWithComponentPath,
      routesComponentResolvedToFile: diagnostics.routesComponentResolvedToFile,
      routesUnresolvedComponent: diagnostics.routesUnresolvedComponent.length,
      vueFiles: diagnostics.vueFiles,
      composableFiles: diagnostics.composableFiles,
      javaEntityFiles: diagnostics.javaEntityFiles,
      i18nKeysDropped: diagnostics.i18nKeysDropped,
    },
    exampleRoutes: parsed.data.routes.slice(0, 3),
    examplePages: parsed.data.pages.slice(0, 2).map((p) => ({
      name: p.name,
      sourcePath: p.sourcePath,
      composables: p.composables.slice(0, 5),
      i18nKeys: p.i18nKeys.slice(0, 3),
    })),
    exampleComposables: parsed.data.composables.slice(0, 2),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (out) {
    fs.writeFileSync(out, JSON.stringify(parsed.data, null, 2));
    console.error(`[codelens-extract] payload gravado em ${out} (${summary.payloadMB} MB)`);
  }
}

main();

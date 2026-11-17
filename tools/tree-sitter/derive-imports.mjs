#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// ADR-0021 (nup-sentinel) — Produtor POLIGLOTA baseado em tree-sitter · 1ª fatia.
//
// O QUE FAZ: varre um diretório de projeto (default: os `.vue`), extrai via
// tree-sitter os IMPORTS do `<script>`/`<script setup>` que resolvem para um
// ARQUIVO REAL do projeto, e emite o payload `imports[]` que o manifest já ingere
// (`POST /api/projects/:id/scip-edges/vue`). Fecha o ponto-cego dos 521 `.vue` do
// easynup que o scip-typescript puro não enxerga (sem parser de SFC). Ver o
// `vue-imports-lib.mjs` e o README desta pasta.
//
// ESPELHA o `tools/scip-typescript/derive-edges.mjs`: stdout = JSON compacto,
// stderr = diagnóstico; aceita `--web-tree-sitter <path>` como o deriver aceita
// `--scip-lib` (caminho ABSOLUTO do módulo instalado isolado no CI).
//
// SINTÁTICO, não semântico: `edges: []` sempre (nunca uma aresta de call-graph
// com resolução de compilador). Só `imports[]` (arquivo→arquivo). Fail-soft em
// cada arquivo: um `.vue` que não parseia vira 0 imports + log, nunca derruba.
//
// Uso:
//   node derive-imports.mjs <scanDir> --root <repoRoot> --grammars <wasmDir> \
//        [--web-tree-sitter <abs path do pacote web-tree-sitter>] \
//        [--tsconfig <scanDir/tsconfig.json>] [--source vue] [--ext .vue]
//
// Caminhos emitidos = relativos a --root (default: cwd). Rodar do REPO ROOT com
// `<scanDir>=frontend --root .` produz `frontend/src/...`, casando o `sourceFile`
// repo-relativo que o manifest guarda (igual ao scip-typescript-index.yml).
// ─────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import {
  extractScriptBlocks,
  grammarForLang,
  buildAliasResolver,
  resolveSpecifier,
  collectImportSpecifiers,
} from "./vue-imports-lib.mjs";

function arg(name, def = undefined) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const scanDir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!scanDir) {
  console.error("uso: node derive-imports.mjs <scanDir> --root <repoRoot> --grammars <wasmDir> [--web-tree-sitter <path>] [--source vue] [--ext .vue]");
  process.exit(2);
}
const repoRoot = path.resolve(arg("--root", process.cwd()));
const grammarsDir = path.resolve(arg("--grammars", path.join(path.dirname(fileURLToPath(import.meta.url)), "grammars")));
const wtsPath = arg("--web-tree-sitter", null); // caminho absoluto do pacote (opcional)
const source = arg("--source", "vue");
const srcExt = arg("--ext", ".vue");
const tsconfigPath = arg("--tsconfig", path.join(path.resolve(scanDir), "tsconfig.json"));

const CODE_EXTS = new Set([".vue", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".d.ts"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nuxt", ".output", ".vite"]);

function toRel(abs) {
  return path.relative(repoRoot, abs).split(path.sep).join("/");
}

// 1) fileset repo-relativo (para resolver `./`, `../`, `@/`). Varre scanDir.
function buildFileset(dirAbs) {
  const set = new Set();
  const vue = [];
  const stack = [dirAbs];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".") {
        // permite dotfiles de código raros, mas pula dirs ocultos pesados
      }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          const rel = toRel(full);
          set.add(rel);
          if (ext === srcExt) vue.push(rel);
        }
      }
    }
  }
  vue.sort();
  return { set, vue };
}

// 2) tree-sitter (web-tree-sitter WASM). Carregado dinamicamente (não é dep do
//    manifest; o CI aponta --web-tree-sitter p/ o install isolado). Fail-hard
//    aqui é aceitável: sem o motor não há o que produzir (o CI trata como step
//    auxiliar com continue-on-error).
async function loadTreeSitter() {
  const spec = wtsPath ? pathToFileURL(wtsPath).href : "web-tree-sitter";
  const mod = await import(spec);
  const Parser = mod.Parser ?? mod.default?.Parser ?? mod.default;
  const Language = mod.Language ?? mod.default?.Language;
  if (!Parser || !Language) throw new Error("web-tree-sitter: Parser/Language não encontrados no módulo");
  await Parser.init();
  const load = async (wasm) => Language.load(path.join(grammarsDir, wasm));
  const langs = {
    typescript: await load("tree-sitter-typescript.wasm"),
    javascript: await load("tree-sitter-javascript.wasm"),
  };
  const parser = new Parser();
  return { parser, langs };
}

async function main() {
  const scanAbs = path.resolve(scanDir);
  const { set: fileset, vue } = buildFileset(scanAbs);

  let tsconfig = null;
  try {
    tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
  } catch {
    /* sem tsconfig → sem alias (só `./`,`../` resolvem) */
  }
  const tsconfigDirRel = toRel(path.dirname(path.resolve(tsconfigPath)));
  const aliasResolve = buildAliasResolver(tsconfig, tsconfigDirRel === "." ? "" : tsconfigDirRel);

  const { parser, langs } = await loadTreeSitter();

  const importsSet = new Set(); // "from => to"
  const imports = [];
  let nFiles = 0, nBlocks = 0, nSpecs = 0, nResolved = 0, nUnresolvedProj = 0, nBare = 0, nParseErr = 0;

  for (const rel of vue) {
    nFiles++;
    let content;
    try {
      content = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const blocks = extractScriptBlocks(content, rel);
    for (const block of blocks) {
      nBlocks++;
      let specs = [];
      try {
        parser.setLanguage(langs[grammarForLang(block.lang)]);
        const tree = parser.parse(block.content);
        specs = collectImportSpecifiers(tree.rootNode);
        tree.delete?.();
      } catch {
        nParseErr++;
        continue;
      }
      for (const spec of specs) {
        nSpecs++;
        const to = resolveSpecifier(spec, rel, fileset, aliasResolve);
        if (!to) {
          if (spec.startsWith("./") || spec.startsWith("../") || (aliasResolve(spec) || []).length) nUnresolvedProj++;
          else nBare++;
          continue;
        }
        if (to === rel) continue; // auto-import (não deveria, mas por segurança)
        nResolved++;
        const key = rel + " => " + to;
        if (importsSet.has(key)) continue;
        importsSet.add(key);
        imports.push({ from: rel, to });
      }
    }
  }

  const payload = {
    tool: "tree-sitter-vue",
    schema: "adr-0021.vue-imports.v1",
    counts: {
      vueFiles: nFiles,
      scriptBlocks: nBlocks,
      specifiers: nSpecs,
      imports: imports.length,
      resolvedProject: nResolved,
      unresolvedProject: nUnresolvedProj,
      barePackages: nBare,
      parseErrors: nParseErr,
    },
    edges: [], // SINTÁTICO: nunca aresta de call-graph com resolução de compilador
    imports,
    entryFiles: [],
  };

  process.stdout.write(JSON.stringify(payload) + "\n");
  console.error(
    `[derive-imports] fonte=${source} vueFiles=${nFiles} blocks=${nBlocks} specifiers=${nSpecs}` +
      ` | imports(resolvidos p/ arquivo do projeto)=${imports.length} unresolvedProject=${nUnresolvedProj}` +
      ` barePackages=${nBare} parseErrors=${nParseErr} | distinctTargets=${new Set(imports.map((e) => e.to)).size}`,
  );
}

main().catch((e) => {
  console.error(`[derive-imports] FALHA: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});

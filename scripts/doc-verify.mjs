#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// doc-verify — guarda anti-drift de documentação.
//
// PROBLEMA: docs citam `arquivo:linha` que deixa de bater a cada edição do
// código → passamos a trabalhar com premissas erradas (queima crédito/energia).
//
// CURA: a doc autoritativa ancora afirmações por SÍMBOLO, não por número de
// linha. Uma âncora é um trecho de código-inline no formato:
//
//     `caminho/relativo.ext:TOKEN`
//
//   - TOKEN é um identificador grep-ável (nome de função/classe/const/enum, ou
//     uma string distintiva). O linter confirma: (a) o arquivo existe, (b) o
//     TOKEN aparece no arquivo. Robusto a deslocamento de linha.
//   - Se depois do ':' vier só dígitos (`arquivo.ext:294` ou `:12-40`), é uma
//     referência de linha de conveniência humana: só checa que o arquivo existe
//     e a linha cabe no arquivo (AVISO, não falha — número de linha é frágil).
//
// Uso:
//   node doc-verify.mjs --root <repo> <doc1.md> [doc2.md ...]
//   node doc-verify.mjs --root <repo> --marked        # varre docs c/ marcador
//
// Marcador (coloque no topo do doc autoritativo p/ o modo --marked pegá-lo):
//   <!-- doc-verify: on -->
//
// Saída: relatório por doc; exit 1 se QUALQUER âncora de símbolo falhar.
// Zero dependência (Node ≥ 18). Determinístico.
// ─────────────────────────────────────────────────────────────
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const args = process.argv.slice(2);
let root = ".";
let marked = false;
const docs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--root") root = args[++i];
  else if (args[i] === "--marked") marked = true;
  else docs.push(args[i]);
}
root = resolve(root);

// Regex de âncora: `path.ext:ref` dentro de crase. ext limitado a fontes/config.
const EXT = "ts|tsx|js|mjs|cjs|jsx|java|json|yml|yaml|sql|py|go|rs|md";
const ANCHOR = new RegExp("`([A-Za-z0-9_./-]+\\.(?:" + EXT + ")):([^`]+)`", "g");
const IS_LINE = /^\d+(?:-\d+)?$/;

function walkDocs(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "dist" || e === "build") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkDocs(p));
    else if (/\.mdx?$/.test(e)) {
      const txt = readFileSync(p, "utf8");
      if (txt.includes("<!-- doc-verify: on -->")) out.push(p);
    }
  }
  return out;
}

// tokens grep-áveis dentro de uma ref de símbolo (ignora #membros, <>, (), etc.)
function tokensOf(ref) {
  return [...ref.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map((m) => m[0]);
}

const docList = marked ? walkDocs(root) : docs.map((d) => resolve(d));
let totalFail = 0;
let totalOk = 0;
let totalWarn = 0;

for (const doc of docList) {
  if (!existsSync(doc)) { console.log(`\n✗ DOC AUSENTE: ${doc}`); totalFail++; continue; }
  const text = readFileSync(doc, "utf8");
  const fails = [];
  const warns = [];
  let ok = 0;
  const seen = new Set();
  for (const m of text.matchAll(ANCHOR)) {
    const key = m[1] + ":" + m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    const [, path, ref] = m;
    const abs = join(root, path);
    if (!existsSync(abs)) { fails.push(`${path}:${ref}  →  ARQUIVO NÃO EXISTE`); continue; }
    if (IS_LINE.test(ref.trim())) {
      const nlines = readFileSync(abs, "utf8").split("\n").length;
      const start = parseInt(ref, 10);
      if (start > nlines) warns.push(`${path}:${ref}  →  linha ${start} > ${nlines} (arquivo encolheu)`);
      else ok++; // referência de linha válida (mas não é o contrato forte)
      continue;
    }
    // ref de símbolo: pelo menos 1 token tem que aparecer no arquivo
    const src = readFileSync(abs, "utf8");
    const toks = tokensOf(ref);
    if (toks.length === 0) { warns.push(`${path}:${ref}  →  sem token grep-ável`); continue; }
    const present = toks.filter((t) => src.includes(t));
    if (present.length === 0) fails.push(`${path}:${ref}  →  NENHUM símbolo [${toks.join(", ")}] existe no arquivo`);
    else ok++;
  }
  totalOk += ok; totalFail += fails.length; totalWarn += warns.length;
  const rel = relative(root, doc);
  if (fails.length === 0 && warns.length === 0) {
    console.log(`✓ ${rel}  (${ok} âncoras de símbolo OK)`);
  } else {
    console.log(`\n${fails.length ? "✗" : "⚠"} ${rel}  (${ok} OK, ${fails.length} FALHA, ${warns.length} aviso)`);
    for (const f of fails) console.log(`    ✗ ${f}`);
    for (const w of warns) console.log(`    ⚠ ${w}`);
  }
}

console.log(`\n── total: ${totalOk} OK · ${totalFail} FALHA · ${totalWarn} aviso ──`);
process.exit(totalFail > 0 ? 1 : 0);

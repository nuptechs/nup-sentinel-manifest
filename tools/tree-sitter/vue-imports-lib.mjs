// ─────────────────────────────────────────────────────────────────────────
// ADR-0021 (nup-sentinel) — Fundação de análise POLIGLOTA via tree-sitter.
// 1ª FATIA CONCRETA: extrair do `<script>`/`<script setup>` dos arquivos `.vue`
// os IMPORTS (arquivo→arquivo) que o scip-typescript NÃO enxerga (ele não tem
// parser de SFC Vue — ver o comentário do `scip-typescript-index.yml` do easynup).
//
// POR QUE ISSO IMPORTA (o ponto-cego concreto): o deriver scip-typescript emite o
// eixo IMPORT-REACHABILITY (modelo Knip/ts-prune) — um arquivo só é "morto" se NEM
// chamado NEM importado NEM com tráfego. Como o `<script>` dos 521 `.vue` fica
// invisível, os `.ts` que SÓ são importados por `.vue` aparecem sem importador →
// falso "dead-code advisory". Este produtor fecha exatamente esse buraco: emite
// `imports: [{from: '<vue>', to: '<ts resolvido>'}]` na MESMA forma que o
// `derive-edges.mjs` já produz, para o balde/fonte `vue` do store multi-fonte
// (`POST /api/projects/:id/scip-edges/vue`). O reasoner de dead-code lê
// `imports[].to` e marca esses arquivos como import-reachable (graph-load.ts:113).
//
// HONESTIDADE (guarda-corpo do §8 da ADR-0021 "nunca vender sintático como
// semântico"): tree-sitter é SINTÁTICO. Por isso este produtor emite `edges: []`
// (NUNCA uma aresta de call-graph com `resolution:'compiler'`) e SÓ o eixo
// `imports` (arquivo→arquivo), que o schema do manifest aceita SEM campo de
// resolução — é um sinal dedicado, não o grafo de chamadas provado.
//
// Módulo PURO e testável (node:test): sem I/O, sem import de web-tree-sitter aqui
// (o motor tree-sitter é injetado pelo CLI `derive-imports.mjs`). Usa
// `@vue/compiler-sfc` (já é dependência do manifest) só como SPLITTER do SFC —
// a ANÁLISE de import é tree-sitter. Fail-soft: entrada malformada → vazio.
// ─────────────────────────────────────────────────────────────────────────
import { parse as parseSfc } from "@vue/compiler-sfc";

/** posix: diretório de um caminho repo-relativo ("a/b/c.ts" → "a/b"). */
export function posixDirname(p) {
  const i = String(p).lastIndexOf("/");
  return i < 0 ? "" : String(p).slice(0, i);
}

/** posix: normaliza removendo "." e resolvendo ".." (sem tocar o filesystem). */
export function posixNormalize(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  const out = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** junta dois trechos repo-relativos e normaliza. */
export function joinRel(a, b) {
  return posixNormalize((a ? a + "/" : "") + String(b));
}

/**
 * Extrai AMBOS os blocos de script de um SFC `.vue`: `<script>` E `<script setup>`
 * (o `extractVueScript` do analyzer do manifest descarta um dos dois — não copiar).
 * Usa o descriptor do `@vue/compiler-sfc` (robusto a `</script>` dentro de string,
 * ao contrário de regex). Fail-soft: parse quebrado → lista vazia.
 * @returns {{content:string, lang:string, setup:boolean}[]}
 */
export function extractScriptBlocks(vueSource, filename = "anonymous.vue") {
  const out = [];
  try {
    const { descriptor } = parseSfc(String(vueSource), { filename });
    if (descriptor.script && descriptor.script.content) {
      out.push({ content: descriptor.script.content, lang: (descriptor.script.lang || "js").toLowerCase(), setup: false });
    }
    if (descriptor.scriptSetup && descriptor.scriptSetup.content) {
      out.push({ content: descriptor.scriptSetup.content, lang: (descriptor.scriptSetup.lang || "js").toLowerCase(), setup: true });
    }
  } catch {
    /* SFC malformado → sem blocos (fail-soft) */
  }
  return out;
}

/** lang do bloco → chave de gramática tree-sitter ('typescript' | 'javascript'). */
export function grammarForLang(lang) {
  const l = String(lang || "js").toLowerCase();
  if (l === "ts" || l === "tsx" || l === "mts" || l === "cts" || l === "typescript") return "typescript";
  return "javascript";
}

/**
 * Resolvedor de alias a partir do `compilerOptions.paths`/`baseUrl` de um tsconfig
 * (em vez de cravar `@/`). `tsconfigDirRel` = diretório repo-relativo do tsconfig
 * (ex.: "frontend"); `baseUrl` default "." → esse diretório.
 * @returns {(spec:string)=>string[]} candidatos repo-relativos (sem extensão).
 */
export function buildAliasResolver(tsconfig, tsconfigDirRel = "") {
  const co = (tsconfig && tsconfig.compilerOptions) || {};
  const baseRel = joinRel(tsconfigDirRel, co.baseUrl || ".");
  const paths = co.paths || {};
  const entries = Object.entries(paths).map(([key, v]) => ({ key, targets: Array.isArray(v) ? v : [v] }));
  return function aliasResolve(spec) {
    const candidates = [];
    for (const { key, targets } of entries) {
      const starIdx = key.indexOf("*");
      if (starIdx >= 0) {
        const pre = key.slice(0, starIdx);
        const post = key.slice(starIdx + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) {
          const captured = spec.slice(pre.length, spec.length - post.length);
          for (const t of targets) {
            const tStar = t.indexOf("*");
            const resolved = tStar >= 0 ? t.slice(0, tStar) + captured + t.slice(tStar + 1) : t;
            candidates.push(joinRel(baseRel, resolved));
          }
        }
      } else if (spec === key) {
        for (const t of targets) candidates.push(joinRel(baseRel, t));
      }
    }
    return candidates;
  };
}

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".json"];
const INDEX_FILES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.vue"];

/** Tenta casar um caminho-base (sem/ com extensão) contra o fileset do projeto. */
function resolveAgainstFileset(base, fileset) {
  for (const ext of RESOLVE_EXTS) {
    const cand = base + ext;
    if (fileset.has(cand)) return cand;
  }
  for (const idx of INDEX_FILES) {
    const cand = base + idx;
    if (fileset.has(cand)) return cand;
  }
  return null;
}

/**
 * Resolve um ESPECIFICADOR de import para um ARQUIVO repo-relativo REAL do projeto.
 * - `./`, `../`  → relativo ao diretório do arquivo importador.
 * - alias (`@/…`) → via `aliasResolve`.
 * - bare (`vue`, `lodash`, `@scope/pkg`) → `null` (pacote npm; NÃO é arquivo do
 *   projeto nem candidato a dead-code). Nunca chuta: só devolve algo que EXISTE
 *   no `fileset`.
 * @returns {string|null}
 */
export function resolveSpecifier(spec, fromFileRel, fileset, aliasResolve) {
  if (!spec || typeof spec !== "string") return null;
  // ignora especificadores com query/hash (ex.: `foo.svg?url`, `worker?worker`)
  const clean = spec.replace(/[?#].*$/, "");
  let bases = [];
  if (clean.startsWith("./") || clean.startsWith("../")) {
    bases = [joinRel(posixDirname(fromFileRel), clean)];
  } else {
    const aliased = aliasResolve ? aliasResolve(clean) : [];
    if (aliased && aliased.length) bases = aliased;
    else return null; // bare import (npm) — fora do escopo do projeto
  }
  for (const base of bases) {
    const hit = resolveAgainstFileset(base, fileset);
    if (hit) return hit;
  }
  return null;
}

function stripQuotes(s) {
  if (!s || s.length < 2) return s;
  const q = s[0];
  if ((q === '"' || q === "'" || q === "`") && s[s.length - 1] === q) return s.slice(1, -1);
  return s;
}

/** Percurso iterativo (sem recursão) da árvore tree-sitter. */
function walk(root, visit) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    visit(n);
    for (let i = n.childCount - 1; i >= 0; i--) stack.push(n.child(i));
  }
}

function firstStringDescendant(node) {
  let found = null;
  walk(node, (n) => {
    if (found) return;
    if (n.type === "string") found = n;
  });
  return found;
}

/**
 * Extrai os ESPECIFICADORES de módulo de uma árvore tree-sitter (TS ou JS):
 *   • `import … from 'x'`                (import_statement)
 *   • `export … from 'x'` / `export * from 'x'`   (export_statement com source)
 *   • `import('x')`  (dinâmico, string literal)    (call_expression)
 *   • `require('x')`                               (call_expression)
 * Dedup por string. Operar sobre a árvore mantém a lógica testável com o parser
 * real; o CLI injeta o parser já carregado.
 * @returns {string[]}
 */
export function collectImportSpecifiers(rootNode) {
  const specs = [];
  const seen = new Set();
  const push = (s) => {
    if (s && typeof s === "string" && !seen.has(s)) {
      seen.add(s);
      specs.push(s);
    }
  };
  walk(rootNode, (node) => {
    const t = node.type;
    if (t === "import_statement" || t === "export_statement") {
      const src = node.childForFieldName ? node.childForFieldName("source") : null;
      if (src) push(stripQuotes(src.text));
    } else if (t === "call_expression") {
      const fn = node.childForFieldName ? node.childForFieldName("function") : node.child(0);
      const fnText = fn ? fn.text : "";
      if (fnText === "import" || fnText === "require") {
        const args = node.childForFieldName ? node.childForFieldName("arguments") : node;
        const str = firstStringDescendant(args || node);
        if (str) push(stripQuotes(str.text));
      }
    }
  });
  return specs;
}

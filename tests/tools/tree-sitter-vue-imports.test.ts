import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
// @ts-expect-error — .mjs puro (sem tipos); testado por comportamento.
import {
  extractScriptBlocks,
  grammarForLang,
  buildAliasResolver,
  resolveSpecifier,
  collectImportSpecifiers,
  posixNormalize,
  joinRel,
} from "../../tools/tree-sitter/vue-imports-lib.mjs";

// ── Puros (sempre rodam; @vue/compiler-sfc é dependência do manifest) ──────────

describe("vue-imports-lib — extractScriptBlocks", () => {
  it("captura AMBOS <script> e <script setup> com lang", () => {
    const sfc = `<template><div/></template>
<script lang="ts">export default {}</script>
<script setup lang="ts">import { ref } from "vue";</script>`;
    const blocks = extractScriptBlocks(sfc, "X.vue");
    assert.equal(blocks.length, 2);
    assert.equal(blocks.some((b: any) => b.setup === false), true);
    assert.equal(blocks.some((b: any) => b.setup === true), true);
    assert.equal(blocks.every((b: any) => b.lang === "ts"), true);
  });

  it("SFC sem script → vazio; entrada malformada → fail-soft vazio", () => {
    assert.equal(extractScriptBlocks("<template><p/></template>", "Y.vue").length, 0);
    assert.equal(Array.isArray(extractScriptBlocks("<<<lixo", "Z.vue")), true);
  });

  it("lang default js quando não declarado", () => {
    const b = extractScriptBlocks(`<script>const a=1</script>`, "J.vue");
    assert.equal(b[0].lang, "js");
  });
});

describe("vue-imports-lib — grammarForLang", () => {
  it("ts/tsx/mts → typescript; resto → javascript", () => {
    for (const l of ["ts", "tsx", "mts", "cts", "typescript"]) assert.equal(grammarForLang(l), "typescript");
    for (const l of ["js", "jsx", "mjs", "", undefined]) assert.equal(grammarForLang(l as any), "javascript");
  });
});

describe("vue-imports-lib — posix helpers", () => {
  it("normaliza e resolve .. / .", () => {
    assert.equal(posixNormalize("a/./b/../c"), "a/c");
    assert.equal(joinRel("frontend/src/comp", "../stores/x"), "frontend/src/stores/x");
    assert.equal(joinRel("", "src/x"), "src/x");
  });
});

describe("vue-imports-lib — alias + resolução", () => {
  const tsconfig = { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } };
  const alias = buildAliasResolver(tsconfig, "frontend"); // tsconfig em frontend/
  const fileset = new Set<string>([
    "frontend/src/App.vue",
    "frontend/src/stores/auth.ts",
    "frontend/src/components/Foo.vue",
    "frontend/src/utils/index.ts",
  ]);

  it("alias @/ resolve p/ frontend/src/*", () => {
    assert.equal(resolveSpecifier("@/stores/auth", "frontend/src/App.vue", fileset, alias), "frontend/src/stores/auth.ts");
  });
  it("import relativo resolve + extensão inferida", () => {
    assert.equal(resolveSpecifier("./components/Foo.vue", "frontend/src/App.vue", fileset, alias), "frontend/src/components/Foo.vue");
  });
  it("resolve index.ts de diretório", () => {
    assert.equal(resolveSpecifier("@/utils", "frontend/src/App.vue", fileset, alias), "frontend/src/utils/index.ts");
  });
  it("pacote npm (bare) → null (não é arquivo do projeto)", () => {
    assert.equal(resolveSpecifier("vue", "frontend/src/App.vue", fileset, alias), null);
    assert.equal(resolveSpecifier("@vueuse/core", "frontend/src/App.vue", fileset, alias), null);
  });
  it("não-existente → null (nunca chuta)", () => {
    assert.equal(resolveSpecifier("@/stores/missing", "frontend/src/App.vue", fileset, alias), null);
  });
  it("especificador com ?query é limpo antes de resolver", () => {
    assert.equal(resolveSpecifier("@/stores/auth?raw", "frontend/src/App.vue", fileset, alias), "frontend/src/stores/auth.ts");
  });
});

// ── E2E com tree-sitter (GUARDADO): só roda se web-tree-sitter estiver
// resolvível. No CI do manifest (sem a dep) o teste é PULADO, nunca vermelho.
// Para rodar localmente:
//   WEB_TREE_SITTER_PATH=/abs/.../web-tree-sitter/web-tree-sitter.js \
//   TREE_SITTER_GRAMMARS=/abs/.../tools/tree-sitter/grammars npm test
async function tryLoadTreeSitter() {
  const envPath = process.env.WEB_TREE_SITTER_PATH;
  const spec = envPath ? pathToFileURL(envPath).href : "web-tree-sitter";
  const mod: any = await import(spec);
  const Parser = mod.Parser ?? mod.default?.Parser ?? mod.default;
  const Language = mod.Language ?? mod.default?.Language;
  await Parser.init();
  const gdir =
    process.env.TREE_SITTER_GRAMMARS ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../../tools/tree-sitter/grammars");
  const ts = await Language.load(path.join(gdir, "tree-sitter-typescript.wasm"));
  const parser = new Parser();
  parser.setLanguage(ts);
  return parser;
}

describe("vue-imports-lib — collectImportSpecifiers (tree-sitter)", () => {
  it("extrai import/export-from/dynamic-import/require", async (t) => {
    let parser: any;
    try {
      parser = await tryLoadTreeSitter();
    } catch {
      t.skip("web-tree-sitter indisponível (não é dep do manifest) — e2e pulado");
      return;
    }
    const code = `
import a from "./a";
import { b } from "@/b";
export { c } from "./c";
export * from "./d";
const e = await import("./e");
const f = require("./f");
import "vue";
`;
    const tree = parser.parse(code);
    const specs = collectImportSpecifiers(tree.rootNode) as string[];
    for (const s of ["./a", "@/b", "./c", "./d", "./e", "./f", "vue"]) {
      assert.equal(specs.includes(s), true, `faltou especificador ${s}`);
    }
  });
});

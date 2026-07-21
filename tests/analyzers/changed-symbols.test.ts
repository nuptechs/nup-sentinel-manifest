// ─────────────────────────────────────────────
// changed-symbols — testes (ADR-0018 Onda 1). Puro, determinístico.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseUnifiedDiff,
  extractChangedSymbols,
  changedSymbolsFromDiff,
} from "../../server/analyzers/changed-symbols.ts";

const JAVA_DIFF = `diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
index 1111111..2222222 100644
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,7 +40,9 @@ public Contract update(Long id, ContractDto dto) {
         Contract existing = repo.findById(id);
-        return repo.save(existing);
+        auditLog.record(existing);
+        private BigDecimal glosaValue;
+        return repo.save(existing);
     }
`;

const VUE_DIFF = `diff --git a/frontend/src/pages/ChatIa.vue b/frontend/src/pages/ChatIa.vue
--- a/frontend/src/pages/ChatIa.vue
+++ b/frontend/src/pages/ChatIa.vue
@@ -10,6 +10,7 @@ export default defineComponent({
-  name: "ChatIa",
+  name: "ChatIaPanel",
   setup() {
`;

const DELETED_DIFF = `diff --git a/scripts/old.sh b/scripts/old.sh
deleted file mode 100644
--- a/scripts/old.sh
+++ /dev/null
@@ -1,2 +0,0 @@
-#!/bin/bash
-echo hi
`;

describe("parseUnifiedDiff", () => {
  it("extrai path, status e hunks (contexto + linhas +/-)", () => {
    const files = parseUnifiedDiff(JAVA_DIFF);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "src/main/java/ContractService.java");
    assert.equal(files[0].status, "modified");
    assert.equal(files[0].hunks.length, 1);
    assert.match(files[0].hunks[0].context, /update\(Long id/);
    assert.ok(files[0].hunks[0].addedLines.some((l) => l.includes("auditLog.record")));
    assert.ok(files[0].hunks[0].removedLines.some((l) => l.includes("repo.save")));
  });

  it("detecta arquivo DELETADO (/dev/null no +++)", () => {
    const files = parseUnifiedDiff(DELETED_DIFF);
    assert.equal(files[0].status, "removed");
    assert.equal(files[0].path, "scripts/old.sh");
  });

  it("multi-arquivo num diff só", () => {
    const files = parseUnifiedDiff(JAVA_DIFF + "\n" + VUE_DIFF);
    assert.deepEqual(files.map((f) => f.path), ["src/main/java/ContractService.java", "frontend/src/pages/ChatIa.vue"]);
  });

  it("entrada vazia/inválida → []", () => {
    assert.deepEqual(parseUnifiedDiff(""), []);
    // @ts-expect-error teste de robustez
    assert.deepEqual(parseUnifiedDiff(null), []);
  });
});

describe("extractChangedSymbols", () => {
  it("Java: método do contexto (@@ update) + campo declarado (glosaValue)", () => {
    const [file] = parseUnifiedDiff(JAVA_DIFF);
    const syms = extractChangedSymbols(file);
    assert.ok(syms.includes("update"), `esperava 'update' em ${JSON.stringify(syms)}`);
    assert.ok(syms.includes("glosaValue"), `esperava 'glosaValue' em ${JSON.stringify(syms)}`);
  });

  it("NÃO emite keyword/tipo como símbolo (private/BigDecimal/return)", () => {
    const [file] = parseUnifiedDiff(JAVA_DIFF);
    const syms = extractChangedSymbols(file).map((s) => s.toLowerCase());
    for (const junk of ["private", "return", "bigdecimal", "contract"]) {
      // 'contract' pode aparecer só se for identificador declarado; aqui não é.
      if (junk === "bigdecimal" || junk === "private" || junk === "return") {
        assert.ok(!syms.includes(junk), `não deveria emitir '${junk}'`);
      }
    }
  });

  it("Vue/TS: nome do componente (name: 'ChatIaPanel')", () => {
    const [file] = parseUnifiedDiff(VUE_DIFF);
    const syms = extractChangedSymbols(file);
    assert.ok(syms.includes("ChatIaPanel") || syms.includes("ChatIa"), JSON.stringify(syms));
  });

  it("arquivo não-código sem declaração (.sh) → sem símbolo (cai no fallback do consumidor)", () => {
    const [file] = parseUnifiedDiff(DELETED_DIFF);
    assert.deepEqual(extractChangedSymbols(file), []);
  });
});

describe("changedSymbolsFromDiff", () => {
  it("mapeia cada arquivo aos seus símbolos alterados", () => {
    const out = changedSymbolsFromDiff(JAVA_DIFF + "\n" + VUE_DIFF);
    const java = out.find((o) => o.path.endsWith("ContractService.java"));
    assert.ok(java && java.symbols.includes("update"));
    const vue = out.find((o) => o.path.endsWith("ChatIa.vue"));
    assert.ok(vue && vue.symbols.length > 0);
  });
});

// ── anti-SUPERALARME (D7): prosa em pt-BR NÃO vira símbolo ──
// Regressões travadas contra o diff real do easynup (ADR-089): comentário de
// linha, comentário no fim da linha, e prosa dentro de string literal
// (mensagem de erro / @Operation(summary=…)) disparavam as regexes de método.

describe("prosa não vira símbolo (anti-superalarme)", () => {
  it("comentário Javadoc `* … da pausa (Onda 3b)` não emite 'pausa'", () => {
    const diff = `diff --git a/src/main/java/Foo.java b/src/main/java/Foo.java
--- a/src/main/java/Foo.java
+++ b/src/main/java/Foo.java
@@ -1,1 +1,4 @@
+    /** Snapshot serializável do run no ponto da pausa (Onda 3b): outputs. */
+    private String pausedState;
`;
    const [f] = changedSymbolsFromDiff(diff);
    assert.ok(f.symbols.includes("pausedState"), JSON.stringify(f.symbols));
    assert.ok(!f.symbols.some((s) => s.toLowerCase() === "pausa"), JSON.stringify(f.symbols));
  });

  it("comentário no FIM da linha `return; // roda como antes` não emite 'antes'", () => {
    const diff = `diff --git a/src/main/java/Bar.java b/src/main/java/Bar.java
--- a/src/main/java/Bar.java
+++ b/src/main/java/Bar.java
@@ -1,1 +1,2 @@
+        if (params == null) return; // opcional — roda como antes (byte-a-byte)
`;
    const [f] = changedSymbolsFromDiff(diff);
    assert.ok(!f.symbols.some((s) => s.toLowerCase() === "antes"), JSON.stringify(f.symbols));
  });

  it("prosa dentro de string `@Operation(summary=\"… funcionalidade (grant…\")` não emite 'funcionalidade'", () => {
    const diff = `diff --git a/src/main/java/Ws.java b/src/main/java/Ws.java
--- a/src/main/java/Ws.java
+++ b/src/main/java/Ws.java
@@ -1,1 +1,3 @@
+    @Operation(summary = "Concede execução de uma funcionalidade (grant durável)")
+    public UserFlowGrant createUserFlowGrant(Long id) {
`;
    const [f] = changedSymbolsFromDiff(diff);
    // o método declarado É extraído; a prosa da string NÃO. (o tipo de retorno
    // UserFlowGrant não é "símbolo alterado" — só o nome declarado conta.)
    assert.ok(f.symbols.includes("createUserFlowGrant"), JSON.stringify(f.symbols));
    assert.ok(!f.symbols.some((s) => s.toLowerCase() === "funcionalidade"), JSON.stringify(f.symbols));
  });

  it("Vue `name: \"ChatIa\"` (string legítima) AINDA é extraído — a máscara não cega o que importa", () => {
    const [f] = changedSymbolsFromDiff(VUE_DIFF);
    assert.ok(f.symbols.some((s) => s === "ChatIaPanel" || s === "ChatIa"), JSON.stringify(f.symbols));
  });
});

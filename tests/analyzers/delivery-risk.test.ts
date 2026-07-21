// ─────────────────────────────────────────────
// delivery-risk — testes (ADR-0018 Onda 3). Puro, determinístico.
//
// Critério da onda (ADR §6): "diff arriscado ranqueado; zona-cega declarada".
// Facetas advisory (nunca veredito), limiares declarados, sinais não
// computáveis SEMPRE presentes em notComputed (nunca fingidos).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseUnifiedDiff } from "../../server/analyzers/changed-symbols.ts";
import { classifyBreakingChanges, crossBreakingWithGraph } from "../../server/analyzers/breaking-changes.ts";
import {
  computeChurn,
  computeHotSymbols,
  computeDeliveryRisk,
} from "../../server/analyzers/delivery-risk.ts";
import { computeImpactForDiff, computeImpactForFiles, renderImpactDiffMarkdown } from "../../server/analyzers/impact-analyzer.ts";

const MANIFEST = {
  impactEndpoints: [
    {
      path: "/easynup/updateContract.v1", method: "POST",
      controller: "UpdateContractWsV1", controllerMethod: "handle",
      fullCallChain: ["UpdateContractWsV1.handle", "ContractService.update", "UserComponent.findAuthenticated"],
      entitiesTouched: ["Contract"],
    },
    {
      path: "/easynup/findContracts.v1", method: "POST",
      controller: "FindContractsWsV1", controllerMethod: "handle",
      fullCallChain: ["FindContractsWsV1.handle", "ContractService.list", "UserComponent.findAuthenticated"],
      entitiesTouched: ["Contract"],
    },
    {
      path: "/easynup/createOs.v1", method: "POST",
      controller: "CreateOsWsV1", controllerMethod: "handle",
      fullCallChain: ["CreateOsWsV1.handle", "OsService.create", "UserComponent.findAuthenticated"],
      entitiesTouched: ["ServiceOrder"],
    },
    {
      path: "/easynup/findOs.v1", method: "POST",
      controller: "FindOsWsV1", controllerMethod: "handle",
      fullCallChain: ["FindOsWsV1.handle", "OsService.list", "UserComponent.findAuthenticated"],
      entitiesTouched: ["ServiceOrder"],
    },
    {
      path: "/easynup/ping.v1", method: "GET",
      controller: "PingWsV1", controllerMethod: "handle",
      fullCallChain: ["PingWsV1.handle", "UserComponent.findAuthenticated"],
      entitiesTouched: [],
    },
  ],
  screens: [],
  entities: [],
};

const SMALL_DIFF = `diff --git a/src/main/java/PingService.java b/src/main/java/PingService.java
--- a/src/main/java/PingService.java
+++ b/src/main/java/PingService.java
@@ -5,2 +5,3 @@ public class PingService {
     public String ping() {
+        log.info("ping");
`;

function bigDiff(nFiles: number, linesPerFile: number): string {
  const parts: string[] = [];
  for (let i = 0; i < nFiles; i++) {
    const adds = Array.from({ length: linesPerFile }, (_, j) => `+        int v${j} = ${j};`).join("\n");
    parts.push(`diff --git a/src/main/java/mod${i}/Svc${i}.java b/src/main/java/mod${i}/Svc${i}.java
--- a/src/main/java/mod${i}/Svc${i}.java
+++ b/src/main/java/mod${i}/Svc${i}.java
@@ -1,1 +1,${linesPerFile + 1} @@ public class Svc${i} {
${adds}
`);
  }
  return parts.join("\n");
}

describe("computeChurn", () => {
  it("conta linhas/arquivos/diretórios e entropia normalizada", () => {
    const c = computeChurn(parseUnifiedDiff(bigDiff(4, 10)));
    assert.equal(c.filesTouched, 4);
    assert.equal(c.dirsTouched, 4);
    assert.equal(c.linesAdded, 40);
    assert.equal(c.linesRemoved, 0);
    // churn UNIFORME em 4 arquivos → entropia normalizada = 1.0 (difusão máxima)
    assert.equal(c.entropy, 1);
  });

  it("1 arquivo só → entropia 0 (concentrado)", () => {
    const c = computeChurn(parseUnifiedDiff(SMALL_DIFF));
    assert.equal(c.filesTouched, 1);
    assert.equal(c.entropy, 0);
  });

  it("determinístico: mesma entrada ⇒ mesmo relatório (deep equal)", () => {
    const files = parseUnifiedDiff(bigDiff(3, 5));
    assert.deepEqual(computeChurn(files), computeChurn(files));
  });
});

describe("computeHotSymbols", () => {
  it("fan-in por símbolo qualificado (entrada INTEIRA da cadeia) + fan-in de classe", () => {
    const files = parseUnifiedDiff(`diff --git a/src/main/java/UserComponent.java b/src/main/java/UserComponent.java
--- a/src/main/java/UserComponent.java
+++ b/src/main/java/UserComponent.java
@@ -30,2 +30,3 @@ public User findAuthenticated() {
     User u = repository.findByLogin(x);
+    audit.log(u);
`);
    const hot = computeHotSymbols(MANIFEST, files);
    // findAuthenticated está em TODAS as 5 cadeias
    const top = hot[0];
    assert.equal(top.symbol, "UserComponent.findAuthenticated");
    assert.equal(top.fanIn, 5);
  });

  it("símbolo homônimo NÃO infla: tocar OutroService.update não conta ContractService.update", () => {
    const files = parseUnifiedDiff(`diff --git a/src/main/java/OutroService.java b/src/main/java/OutroService.java
--- a/src/main/java/OutroService.java
+++ b/src/main/java/OutroService.java
@@ -5,2 +5,3 @@ public void update(Long id) {
     validate(id);
+    log.info(id);
`);
    const hot = computeHotSymbols(MANIFEST, files);
    assert.ok(!hot.some((h) => h.fanIn > 0 && h.symbol.toLowerCase().includes("update")), JSON.stringify(hot));
  });

  it("arquivo frontend não entra (cadeias do grafo são backend)", () => {
    const files = parseUnifiedDiff(`diff --git a/frontend/src/pages/X.vue b/frontend/src/pages/X.vue
--- a/frontend/src/pages/X.vue
+++ b/frontend/src/pages/X.vue
@@ -1,1 +1,2 @@
+const a = 1;
`);
    assert.deepEqual(computeHotSymbols(MANIFEST, files), []);
  });
});

describe("computeDeliveryRisk", () => {
  it("diff pequeno e frio → level LOW com todas as facetas em evidência", () => {
    const files = parseUnifiedDiff(SMALL_DIFF);
    const r = computeDeliveryRisk(MANIFEST, files, undefined);
    assert.equal(r.level, "low");
    assert.equal(r.facets.length, 5);
    for (const f of r.facets) assert.ok(f.evidence.length > 0, f.name);
  });

  it("churn alto (muitos arquivos/linhas) → faceta churn-difusao HIGH e level HIGH", () => {
    const files = parseUnifiedDiff(bigDiff(30, 40)); // 30 arquivos, 1200 linhas
    const r = computeDeliveryRisk(MANIFEST, files, undefined);
    const churn = r.facets.find((f) => f.name === "churn-difusao")!;
    assert.equal(churn.level, "high");
    assert.equal(r.level, "high");
    // entropia uniforme em 30 arquivos → difusão máxima
    const ent = r.facets.find((f) => f.name === "entropia")!;
    assert.equal(ent.level, "high");
  });

  it("tocar símbolo-hub (fan-in ≥ 5) → faceta simbolo-hub sobe", () => {
    const files = parseUnifiedDiff(`diff --git a/src/main/java/UserComponent.java b/src/main/java/UserComponent.java
--- a/src/main/java/UserComponent.java
+++ b/src/main/java/UserComponent.java
@@ -30,2 +30,3 @@ public User findAuthenticated() {
     User u = repository.findByLogin(x);
+    audit.log(u);
`);
    const r = computeDeliveryRisk(MANIFEST, files, undefined);
    const hub = r.facets.find((f) => f.name === "simbolo-hub")!;
    assert.equal(hub.level, "medium"); // fanIn 5 = corte do médio
    assert.match(hub.evidence, /UserComponent\.findAuthenticated/);
  });

  it("quebra ALCANÇADA (Onda 2) → faceta quebra-alcancada HIGH", () => {
    const removal = parseUnifiedDiff(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,2 +40,0 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
-    }
`);
    const breaking = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(removal));
    const r = computeDeliveryRisk(MANIFEST, removal, breaking);
    const f = r.facets.find((x) => x.name === "quebra-alcancada")!;
    assert.equal(f.level, "high");
    assert.match(f.evidence, /ContractService\.update/);
    assert.equal(r.level, "high");
  });

  it("migration + segurança tocadas → area-sensivel HIGH; só uma → MEDIUM", () => {
    const both = parseUnifiedDiff(`diff --git a/src/main/resources/db/migrations/0400-x.xml b/src/main/resources/db/migrations/0400-x.xml
--- a/src/main/resources/db/migrations/0400-x.xml
+++ b/src/main/resources/db/migrations/0400-x.xml
@@ -1,1 +1,2 @@
+<changeSet/>
diff --git a/src/main/java/security/TokenFilter.java b/src/main/java/security/TokenFilter.java
--- a/src/main/java/security/TokenFilter.java
+++ b/src/main/java/security/TokenFilter.java
@@ -1,1 +1,2 @@
+// x
`);
    const r = computeDeliveryRisk(MANIFEST, both, undefined);
    assert.equal(r.facets.find((f) => f.name === "area-sensivel")!.level, "high");

    const one = parseUnifiedDiff(`diff --git a/src/main/resources/db/migrations/0400-x.xml b/src/main/resources/db/migrations/0400-x.xml
--- a/src/main/resources/db/migrations/0400-x.xml
+++ b/src/main/resources/db/migrations/0400-x.xml
@@ -1,1 +1,2 @@
+<changeSet/>
`);
    const r2 = computeDeliveryRisk(MANIFEST, one, undefined);
    assert.equal(r2.facets.find((f) => f.name === "area-sensivel")!.level, "medium");
  });

  it("ZONA-CEGA declarada SEMPRE: co-change e comportamento em notComputed com razão", () => {
    const r = computeDeliveryRisk(MANIFEST, parseUnifiedDiff(SMALL_DIFF), undefined);
    const signals = r.notComputed.map((n) => n.signal).sort();
    assert.deepEqual(signals, ["co-change", "comportamento-antes-depois"]);
    for (const n of r.notComputed) assert.ok(n.reason.length > 20);
  });

  it("agregação = MÁXIMO das facetas (natureza alta não dilui na média)", () => {
    const files = parseUnifiedDiff(SMALL_DIFF); // tudo low
    const breaking = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(parseUnifiedDiff(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,2 +40,0 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
-    }
`)));
    const r = computeDeliveryRisk(MANIFEST, files, breaking);
    // 4 facetas low + 1 high ⇒ HIGH (nunca média)
    assert.equal(r.level, "high");
  });
});

describe("integração impact-diff (aditivo + OFF + markdown)", () => {
  it("computeImpactForDiff carrega `risk`; computeImpactForFiles NÃO (OFF byte-a-byte)", () => {
    const rd = computeImpactForDiff(MANIFEST, SMALL_DIFF);
    assert.ok(rd.risk, "risk presente no caminho diff");
    assert.equal(rd.risk!.facets.length, 5);
    const rf = computeImpactForFiles(MANIFEST, ["src/main/java/PingService.java"]);
    assert.equal((rf as any).risk, undefined);
    assert.equal((rf as any).breaking, undefined);
  });

  it("markdown ganha a seção de risco com tabela de naturezas + não-computados", () => {
    const md = renderImpactDiffMarkdown(computeImpactForDiff(MANIFEST, SMALL_DIFF));
    assert.match(md, /Risco da entrega \(naturezas — advisory\)/);
    assert.match(md, /churn-difusao/);
    assert.match(md, /co-change: não computado/);
    assert.match(md, /comportamento-antes-depois: não computado/);
  });
});

// ─────────────────────────────────────────────
// breaking-changes — testes (ADR-0018 Onda 2). Puro, determinístico.
//
// Critério de pronto da onda (ADR §6): "alarme só em BC alcançada; teste com
// BC-morta = 0 alerta". Os dois lados estão cravados aqui, mais o
// anti-superalarme por segmento (remover `OutroService.update` NÃO acende
// cadeias com `ContractService.update`).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseUnifiedDiff, declarationsFromDiffFile } from "../../server/analyzers/changed-symbols.ts";
import {
  classifyBreakingChanges,
  crossBreakingWithGraph,
  breakingReportForDiff,
} from "../../server/analyzers/breaking-changes.ts";

// ── manifesto fixture (mesmo shape do snapshot real: impactEndpoints + screens + entities) ──

const MANIFEST = {
  impactEndpoints: [
    {
      path: "/easynup/updateContract.v1", method: "POST",
      controller: "UpdateContractWsV1", controllerMethod: "handle",
      fullCallChain: ["UpdateContractWsV1.handle", "UpdateContractServiceV1.handle", "ContractService.update", "ContractBalanceComponent.calculateBalance"],
      entitiesTouched: ["Contract"],
    },
    {
      path: "/easynup/findContracts.v1", method: "POST",
      controller: "FindContractsWsV1", controllerMethod: "handle",
      fullCallChain: ["FindContractsWsV1.handle", "ContractService.list"],
      entitiesTouched: ["Contract"],
    },
    {
      path: "/easynup/findSlas.v1", method: "POST",
      controller: "FindSlasWsV1", controllerMethod: "handle",
      fullCallChain: ["FindSlasWsV1.handle", "FindSlasServiceV1.handle"],
      entitiesTouched: ["Sla"],
    },
  ],
  screens: [
    { name: "ContractEdit", route: "/contratos/editar", interactions: [{ endpoint: "/easynup/updateContract.v1", httpMethod: "POST" }] },
    { name: "ContractList", route: "/contratos", interactions: [{ endpoint: "/easynup/findContracts.v1", httpMethod: "POST" }] },
    // NENHUMA tela chama findSlas.v1 — o caso real do sunset Sla (PR #936 easynup)
  ],
  entities: [
    { name: "Contract", fieldMetadata: [{ name: "glosaValue" }, { name: "number" }], accessedBy: [] },
  ],
  allEntitiesFromGraph: [
    { name: "Contract", fields: [{ name: "glosaValue" }, { name: "number" }] },
  ],
};

function diffOf(body: string): ReturnType<typeof parseUnifiedDiff> {
  return parseUnifiedDiff(body);
}

// ── classificação ──

describe("classifyBreakingChanges", () => {
  it("método removido (decl em `-`, nome ausente dos `+`) → candidato removed qualificado", () => {
    const files = diffOf(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,9 +40,5 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
-        Contract existing = repo.findById(id);
-        return repo.save(existing);
-    }
     private final ContractRepo repo;
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 1, JSON.stringify(c));
    assert.deepEqual(
      { symbol: c.candidates[0].symbol, kind: c.candidates[0].kind, change: c.candidates[0].change },
      { symbol: "ContractService.update", kind: "method", change: "removed" },
    );
    // variável LOCAL do corpo removido (existing) NÃO vira candidato
    assert.ok(!c.candidates.some((x) => x.bare === "existing"));
  });

  it("assinatura mudou (mesmo nome redeclarado com params diferentes) → signature-changed com antes/depois", () => {
    const files = diffOf(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,3 +40,3 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
+    public Contract update(Long id, ContractDto dto, boolean force) {
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 1);
    const cand = c.candidates[0];
    assert.equal(cand.change, "signature-changed");
    assert.equal(cand.symbol, "ContractService.update");
    assert.match(cand.before!, /Long id, ContractDto dto\)/);
    assert.match(cand.after!, /boolean force\)/);
  });

  it("mudança cosmética (whitespace) → NÃO é quebra", () => {
    const files = diffOf(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,2 +40,2 @@ public class ContractService {
-    public Contract update(Long id,  ContractDto dto) {
+    public Contract update(Long id, ContractDto dto) {
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 0, JSON.stringify(c.candidates));
  });

  it("rename puro (linha igual módulo-nome) → REFACTOR, nunca candidato (D7)", () => {
    const files = diffOf(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,2 +40,2 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
+    public Contract updateContract(Long id, ContractDto dto) {
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 0, JSON.stringify(c.candidates));
    assert.equal(c.refactors.length, 1);
    assert.deepEqual({ from: c.refactors[0].from, to: c.refactors[0].to }, { from: "update", to: "updateContract" });
  });

  it("nome removido mas AINDA referenciado nos `+` → inconclusive (conservador), nunca alerta", () => {
    const files = diffOf(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,3 +40,3 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
+    // delega pro caminho novo mas o update segue declarado mais abaixo
+    private void delegate() { update(null, null); }
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 0, JSON.stringify(c.candidates));
    assert.equal(c.inconclusive.length, 1);
    assert.equal(c.inconclusive[0].symbol, "ContractService.update");
  });

  it("arquivo DELETADO → UM candidato class-level (não N métodos redundantes)", () => {
    const files = diffOf(`diff --git a/src/main/java/FindSlasWsV1.java b/src/main/java/FindSlasWsV1.java
deleted file mode 100644
--- a/src/main/java/FindSlasWsV1.java
+++ /dev/null
@@ -1,5 +0,0 @@
-public class FindSlasWsV1 {
-    public FindSlasReturnV1 handle(FindSlasParamsV1 params) {
-        return service.handle(params);
-    }
-}
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 1);
    assert.deepEqual(
      { symbol: c.candidates[0].symbol, kind: c.candidates[0].kind, change: c.candidates[0].change },
      { symbol: "FindSlasWsV1", kind: "class", change: "removed" },
    );
  });

  it("campo de ENTIDADE removido → candidato field qualificado", () => {
    const files = diffOf(`diff --git a/src/main/java/Contract.java b/src/main/java/Contract.java
--- a/src/main/java/Contract.java
+++ b/src/main/java/Contract.java
@@ -10,3 +10,2 @@ public class Contract {
     private String number;
-    private BigDecimal glosaValue;
     private String name;
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 1);
    assert.deepEqual(
      { symbol: c.candidates[0].symbol, kind: c.candidates[0].kind },
      { symbol: "Contract.glosaValue", kind: "field" },
    );
  });

  it("arquivo NOVO nunca quebra; frontend com remoção é PULADO e contado (ponto-cego declarado)", () => {
    const files = diffOf(`diff --git a/src/main/java/NovoService.java b/src/main/java/NovoService.java
--- /dev/null
+++ b/src/main/java/NovoService.java
@@ -0,0 +1,2 @@
+public class NovoService {
+}
diff --git a/frontend/src/utils/helper.ts b/frontend/src/utils/helper.ts
--- a/frontend/src/utils/helper.ts
+++ b/frontend/src/utils/helper.ts
@@ -1,2 +1,1 @@
-export function fmtGlosa(v: number): string {
-}
`);
    const c = classifyBreakingChanges(files);
    assert.equal(c.candidates.length, 0, JSON.stringify(c.candidates));
    assert.equal(c.frontendFilesSkipped, 1);
  });
});

// ── cruzamento com o grafo (breaking × reachable) ──

describe("crossBreakingWithGraph", () => {
  it("BC ALCANÇADA: remover ContractService.update → ALERTA com dependente + tela (o critério da onda)", () => {
    const files = diffOf(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,3 +40,1 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
-    }
`);
    const r = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(files));
    assert.equal(r.alerts.length, 1, JSON.stringify(r.summary));
    assert.equal(r.suppressedDead.length, 0);
    const a = r.alerts[0];
    assert.equal(a.symbol, "ContractService.update");
    assert.equal(a.reachable, true);
    // dependente = o endpoint cuja CADEIA passa pelo símbolo (controller ≠ ContractService)
    assert.deepEqual(a.consumers.endpoints.map((e) => e.path), ["/easynup/updateContract.v1"]);
    // tela que chama o endpoint dependente
    assert.deepEqual(a.consumers.screens.map((s) => s.name), ["ContractEdit"]);
  });

  it("BC MORTA = 0 ALERTA (critério ADR §6): remover método fora de qualquer cadeia → suprimida e CONTADA", () => {
    const files = diffOf(`diff --git a/src/main/java/OrphanService.java b/src/main/java/OrphanService.java
--- a/src/main/java/OrphanService.java
+++ b/src/main/java/OrphanService.java
@@ -8,2 +8,0 @@ public class OrphanService {
-    public void unusedHelper(String x) {
-    }
`);
    const r = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(files));
    assert.equal(r.alerts.length, 0);
    assert.equal(r.suppressedDead.length, 1);
    assert.equal(r.suppressedDead[0].symbol, "OrphanService.unusedHelper");
    assert.equal(r.summary.suppressedDead, 1);
  });

  it("ANTI-SUPERALARME por segmento: remover OutroService.update NÃO acende cadeias com ContractService.update", () => {
    const files = diffOf(`diff --git a/src/main/java/OutroService.java b/src/main/java/OutroService.java
--- a/src/main/java/OutroService.java
+++ b/src/main/java/OutroService.java
@@ -5,2 +5,0 @@ public class OutroService {
-    public void update(Long id) {
-    }
`);
    const r = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(files));
    // "update" existe nas cadeias como ContractService.update — igualdade da
    // ENTRADA INTEIRA impede o casamento por segmento
    assert.equal(r.alerts.length, 0, JSON.stringify(r.alerts));
    assert.equal(r.suppressedDead.length, 1);
  });

  it("CASO REAL (sunset Sla): controller deletado SEM tela consumidora → superfície listada, 0 alerta, morta contada", () => {
    const files = diffOf(`diff --git a/src/main/java/FindSlasWsV1.java b/src/main/java/FindSlasWsV1.java
deleted file mode 100644
--- a/src/main/java/FindSlasWsV1.java
+++ /dev/null
@@ -1,3 +0,0 @@
-public class FindSlasWsV1 {
-    public FindSlasReturnV1 handle(FindSlasParamsV1 params) { return null; }
-}
`);
    const r = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(files));
    assert.equal(r.alerts.length, 0, "sem tela consumidora ⇒ não alarma");
    assert.equal(r.suppressedDead.length, 1);
    const d = r.suppressedDead[0];
    // a superfície quebrada (o endpoint do controller) é registrada mesmo morta
    assert.deepEqual(d.surfaceEndpoints.map((s) => s.path), ["/easynup/findSlas.v1"]);
    assert.equal(d.consumers.screens.length, 0);
  });

  it("controller deletado COM tela consumidora → ALERTA cross-stack (tela como consumidor)", () => {
    const files = diffOf(`diff --git a/src/main/java/UpdateContractWsV1.java b/src/main/java/UpdateContractWsV1.java
deleted file mode 100644
--- a/src/main/java/UpdateContractWsV1.java
+++ /dev/null
@@ -1,3 +0,0 @@
-public class UpdateContractWsV1 {
-    public UpdateContractReturnV1 handle(UpdateContractParamsV1 params) { return null; }
-}
`);
    const r = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(files));
    assert.equal(r.alerts.length, 1);
    const a = r.alerts[0];
    assert.deepEqual(a.surfaceEndpoints.map((s) => s.path), ["/easynup/updateContract.v1"]);
    assert.deepEqual(a.consumers.screens.map((s) => s.name), ["ContractEdit"]);
  });

  it("campo de ENTIDADE removido → alerta em nível de campo com endpoints que tocam a entidade", () => {
    const files = diffOf(`diff --git a/src/main/java/Contract.java b/src/main/java/Contract.java
--- a/src/main/java/Contract.java
+++ b/src/main/java/Contract.java
@@ -10,2 +10,1 @@ public class Contract {
-    private BigDecimal glosaValue;
     private String name;
`);
    const r = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(files));
    assert.equal(r.alerts.length, 1);
    const a = r.alerts[0];
    assert.equal(a.via, "entity-field:Contract.glosaValue");
    // os DOIS endpoints que tocam a entidade Contract
    assert.deepEqual(a.consumers.endpoints.map((e) => e.path).sort(), ["/easynup/findContracts.v1", "/easynup/updateContract.v1"]);
  });

  it("campo removido de classe NÃO-entidade → morta com razão explícita (nunca alerta)", () => {
    const files = diffOf(`diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -5,2 +5,1 @@ public class ContractService {
-    private final AuditClient auditClient;
     private final ContractRepo repo;
`);
    const r = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges(files));
    assert.equal(r.alerts.length, 0);
    assert.equal(r.suppressedDead.length, 1);
    assert.match(r.suppressedDead[0].via, /campo interno/);
  });

  it("pontos-cegos declarados SEMPRE presentes; +frontend quando pulado", () => {
    const none = crossBreakingWithGraph(MANIFEST, classifyBreakingChanges([]));
    assert.ok(none.blindSpots.length >= 3);
    assert.ok(none.blindSpots.some((b) => /FORA do grafo/i.test(b)));
    assert.ok(none.blindSpots.some((b) => /COMPORTAMENTAL/i.test(b)));
    const withFe = breakingReportForDiff(MANIFEST, diffOf(`diff --git a/frontend/src/x.ts b/frontend/src/x.ts
--- a/frontend/src/x.ts
+++ b/frontend/src/x.ts
@@ -1,1 +1,0 @@
-export function morto(): void {}
`));
    assert.ok(withFe.blindSpots.some((b) => /frontend/i.test(b)));
  });
});

// ── declarações tipadas (a base da classificação) ──

describe("declarationsFromDiffFile", () => {
  it("separa added×removed com kind (method/field/class) e ignora o contexto de hunk", () => {
    const [f] = diffOf(`diff --git a/src/main/java/Foo.java b/src/main/java/Foo.java
--- a/src/main/java/Foo.java
+++ b/src/main/java/Foo.java
@@ -3,3 +3,3 @@ public class Foo {
-    private BigDecimal velho;
+    public Contract novo(Long id) {
`);
    const d = declarationsFromDiffFile(f);
    assert.deepEqual(d.removed.map((x) => ({ name: x.name, kind: x.kind })), [{ name: "velho", kind: "field" }]);
    assert.deepEqual(d.added.map((x) => ({ name: x.name, kind: x.kind })), [{ name: "novo", kind: "method" }]);
    // o contexto `public class Foo {` NÃO entra (a classe não foi redeclarada)
    assert.ok(!d.removed.some((x) => x.name === "Foo") && !d.added.some((x) => x.name === "Foo"));
  });
});

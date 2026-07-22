// ─────────────────────────────────────────────
// functional-impact — testes (ADR-0018 Onda 4). Puro, determinístico, sem LLM.
//
// Critério da onda (ADR §6): "'Este diff acende a caixa Glosa/SLA' com âncora
// no grafo, determinístico". Grounding forçado: caixa sem âncora NÃO existe.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseUnifiedDiff } from "../../server/analyzers/changed-symbols.ts";
import { computeFunctionalImpact, parseProjectOntology } from "../../server/analyzers/functional-impact.ts";
import { computeImpactForDiff, computeImpactForFiles, renderImpactDiffMarkdown } from "../../server/analyzers/impact-analyzer.ts";

const MANIFEST = {
  impactEndpoints: [
    {
      path: "/easynup/applyDeflator.v1", method: "POST",
      controller: "ApplyDeflatorWsV1", controllerMethod: "handle",
      fullCallChain: ["ApplyDeflatorWsV1.handle", "DeflatorService.apply"],
      entitiesTouched: ["Deflator"],
    },
    {
      path: "/easynup/findSlas.v1", method: "POST",
      controller: "FindSlasWsV1", controllerMethod: "handle",
      fullCallChain: ["FindSlasWsV1.handle"],
      entitiesTouched: ["Sla"],
    },
  ],
  screens: [
    { name: "GlosaPanel", route: "/glosas", interactions: [{ endpoint: "/easynup/applyDeflator.v1", httpMethod: "POST" }] },
  ],
  entities: [{ name: "Deflator", fieldMetadata: [{ name: "percent" }], accessedBy: [] }],
  allEntitiesFromGraph: [{ name: "Deflator", fields: [{ name: "percent" }] }],
};

const DEFLATOR_DIFF = `diff --git a/src/main/java/DeflatorService.java b/src/main/java/DeflatorService.java
--- a/src/main/java/DeflatorService.java
+++ b/src/main/java/DeflatorService.java
@@ -10,3 +10,4 @@ public class DeflatorService {
     public void apply(Long id) {
+        audit.log(id);
`;

describe("computeFunctionalImpact", () => {
  it("O CRITÉRIO DA ONDA: diff no Deflator ACENDE a caixa Glosa com âncora + base legal", () => {
    const files = parseUnifiedDiff(DEFLATOR_DIFF);
    const r = computeFunctionalImpact(files, { entitiesTouched: ["Deflator"] });
    const glosa = r.boxes.find((b) => /Glosa/i.test(b.concept));
    assert.ok(glosa, JSON.stringify(r.boxes.map((b) => b.concept)));
    assert.match(glosa!.legalBasis, /14\.133/);
    assert.match(glosa!.legalBasis, /156/); // Art. 156 — sanções
    // âncora CONCRETA obrigatória (grounding)
    assert.ok(glosa!.anchors.length >= 1);
    assert.ok(glosa!.anchors.some((a) => a.kind === "entity" && a.value === "Deflator"), JSON.stringify(glosa!.anchors));
  });

  it("âncora por ENDPOINT (path do SLA) acende a caixa SLA/IMR", () => {
    const r = computeFunctionalImpact([], {
      impactedEndpoints: [{ path: "/easynup/findSlas.v1", method: "POST", controller: "FindSlasWsV1" }],
    });
    const sla = r.boxes.find((b) => /SLA/i.test(b.concept));
    assert.ok(sla, JSON.stringify(r.boxes.map((b) => b.concept)));
    assert.ok(sla!.anchors.some((a) => a.kind === "endpoint" && /findSlas/i.test(a.value)));
  });

  it("âncora por TELA (route /glosas) acende Glosa mesmo sem entidade", () => {
    const r = computeFunctionalImpact([], {
      impactedScreens: [{ name: "GlosaPanel", route: "/glosas" }],
    });
    const glosa = r.boxes.find((b) => /Glosa/i.test(b.concept));
    assert.ok(glosa);
    assert.ok(glosa!.anchors.every((a) => a.kind === "screen"));
  });

  it("âncora por SÍMBOLO/ARQUIVO do próprio diff (DeflatorService.java sem grafo)", () => {
    const files = parseUnifiedDiff(DEFLATOR_DIFF);
    const r = computeFunctionalImpact(files, {});
    const glosa = r.boxes.find((b) => /Glosa/i.test(b.concept));
    assert.ok(glosa);
    assert.ok(glosa!.anchors.some((a) => a.kind === "file" || a.kind === "symbol"));
  });

  it("GROUNDING FORÇADO: diff sem nenhum casamento → ZERO caixas (nada inventado) + unmapped contado", () => {
    const files = parseUnifiedDiff(`diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -1,1 +1,2 @@
+# título
`);
    const r = computeFunctionalImpact(files, {});
    assert.equal(r.boxes.length, 0, JSON.stringify(r.boxes.map((b) => b.concept)));
    assert.deepEqual(r.unmapped.files, ["docs/README.md"]);
    assert.match(r.unmapped.note, /≠ sem impacto de negócio/);
  });

  it("ordenação: core primeiro; dentro do tier, mais âncoras primeiro", () => {
    const r = computeFunctionalImpact([], {
      entitiesTouched: ["Deflator", "Sla", "ServiceOrder"],
    });
    // Glosa (core) vem antes de SLA (recommended) e OS (recommended)
    const idxGlosa = r.boxes.findIndex((b) => /Glosa/i.test(b.concept));
    const idxSla = r.boxes.findIndex((b) => /SLA/i.test(b.concept));
    assert.ok(idxGlosa >= 0 && idxSla >= 0 && idxGlosa < idxSla, JSON.stringify(r.boxes.map((b) => [b.concept, b.importance])));
    for (const b of r.boxes) assert.ok(b.anchors.length >= 1); // invariante: nunca caixa sem âncora
  });

  it("determinístico: mesma entrada ⇒ mesmo relatório", () => {
    const files = parseUnifiedDiff(DEFLATOR_DIFF);
    const a = computeFunctionalImpact(files, { entitiesTouched: ["Deflator"] });
    const b = computeFunctionalImpact(files, { entitiesTouched: ["Deflator"] });
    assert.deepEqual(a, b);
  });

  it("method declara o que o relatório É e o que NÃO cobre (ausência/IR)", () => {
    const r = computeFunctionalImpact([], {});
    assert.match(r.method, /Reflexion determin/i);
    assert.match(r.method, /NÃO cobre ausência/);
    assert.match(r.method, /ADR-080/);
  });
});

describe("integração impact-diff (aditivo + OFF + markdown)", () => {
  it("computeImpactForDiff carrega `functional` (as caixas do blast); files path NÃO", () => {
    const rd = computeImpactForDiff(MANIFEST, DEFLATOR_DIFF);
    assert.ok(rd.functional, "functional presente no caminho diff");
    // o blast da Onda 1 achou o endpoint applyDeflator → entidade Deflator → caixa Glosa
    const glosa = rd.functional!.boxes.find((b) => /Glosa/i.test(b.concept));
    assert.ok(glosa, JSON.stringify(rd.functional!.boxes.map((b) => b.concept)));
    const rf = computeImpactForFiles(MANIFEST, ["src/main/java/DeflatorService.java"]);
    assert.equal((rf as any).functional, undefined);
  });

  it("markdown ganha a seção 'Face funcional' com conceito + base legal + âncoras", () => {
    const md = renderImpactDiffMarkdown(computeImpactForDiff(MANIFEST, DEFLATOR_DIFF));
    assert.match(md, /Face funcional — caixas de negócio acesas/);
    assert.match(md, /Glosa/);
    assert.match(md, /14\.133/);
    assert.match(md, /âncora \[/);
  });

  it("diff fora do mapa → seção diz explicitamente que NADA acendeu (não inventa)", () => {
    const md = renderImpactDiffMarkdown(computeImpactForDiff(MANIFEST, `diff --git a/docs/x.md b/docs/x.md
--- a/docs/x.md
+++ b/docs/x.md
@@ -1,1 +1,2 @@
+t
`));
    assert.match(md, /Nenhuma caixa do mapa de negócio acendeu/);
  });
});


// ── ADR-0018 (fidelidade multi-projeto): ontologia POR PROJETO ──

describe("parseProjectOntology", () => {
  it("valida e compila (regex case-insensitive); null passa como null", () => {
    assert.equal(parseProjectOntology(null), null);
    const o = parseProjectOntology([
      { concept: "Pedido", importance: "core", patterns: ["\\border\\b", "pedido"], legalBasis: "", why: "" },
    ])!;
    assert.equal(o.length, 1);
    assert.ok(o[0].patterns[0].test("OrderService") === false); // \border\b não casa OrderService
    assert.ok(o[0].patterns[1].test("PedidoRepository"));
  });

  it("FAIL-CLOSED: regex inválida / campo faltando / vazio → erro NOMEANDO o problema", () => {
    assert.throws(() => parseProjectOntology([{ concept: "X", importance: "core", patterns: ["("] }]), /patterns\[0\].*inválida/);
    assert.throws(() => parseProjectOntology([{ importance: "core", patterns: ["x"] }]), /concept/);
    assert.throws(() => parseProjectOntology([{ concept: "X", importance: "alta", patterns: ["x"] }]), /importance/);
    assert.throws(() => parseProjectOntology([]), /vazia/);
    assert.throws(() => parseProjectOntology({}), /array/);
  });
});

describe("mapSource (fidelidade de domínio)", () => {
  it("SEM ontologia do projeto → default-procurement COM aviso explícito no method", () => {
    const r = computeFunctionalImpact([], { entitiesTouched: ["Deflator"] });
    assert.equal(r.mapSource, "default-procurement");
    assert.match(r.method, /mapa de negócio DEFAULT/i);
    assert.match(r.method, /PUT \/api\/projects\/:id\/ontology/);
  });

  it("COM ontologia do projeto → mapSource 'project', SEM aviso, e as caixas são AS DO CLIENTE", () => {
    const clientOntology = parseProjectOntology([
      { concept: "Faturamento hospitalar", importance: "core", patterns: ["fatura", "billing"], legalBasis: "ANS RN 501", why: "núcleo do cliente" },
    ])!;
    const r = computeFunctionalImpact([], { entitiesTouched: ["FaturaGuia", "Deflator"] }, undefined, clientOntology);
    assert.equal(r.mapSource, "project");
    assert.ok(!/mapa de negócio DEFAULT/i.test(r.method));
    // acende a caixa do CLIENTE (fatura) e NÃO a de contratação pública (Deflator/glosa não existe no mapa dele)
    assert.deepEqual(r.boxes.map((b) => b.concept), ["Faturamento hospitalar"]);
    assert.match(r.boxes[0].legalBasis, /ANS RN 501/);
  });
});

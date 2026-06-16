// ─────────────────────────────────────────────
// domain-coverage — unit tests (ADR-070 Onda 7)
//
// Crítica de negócio ancorada em texto regulatório: conceitos do domínio que o
// sistema não modela. Determinístico, citável, advisory.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkDomainCoverage, renderDomainCoverageMarkdown } from "../../server/analyzers/domain-coverage.ts";
import { PUBLIC_PROCUREMENT_ONTOLOGY } from "../../server/analyzers/domain-ontology.ts";

const fromGraph = (...names: string[]) => ({ allEntitiesFromGraph: names.map((name) => ({ name })) });

describe("checkDomainCoverage", () => {
  it("reconhece conceitos cobertos pelos nomes de entidade (PT/EN)", () => {
    const r = checkDomainCoverage(fromGraph("Contract", "ContractGuarantee", "ContractPriceAdjustment", "Deflator"));
    const garantia = r.coverage.find((c) => c.concept === "Garantia de execução")!;
    assert.equal(garantia.covered, true);
    assert.ok(garantia.matchedEntities.includes("ContractGuarantee"));
    const reajuste = r.coverage.find((c) => c.concept === "Reajuste/Repactuação")!;
    assert.equal(reajuste.covered, true);
    const sancao = r.coverage.find((c) => c.concept.startsWith("Sanção"))!;
    assert.ok(sancao.matchedEntities.includes("Deflator"));
  });

  it("flagga conceito CORE ausente como gap forte", () => {
    // sistema só com Contract → falta garantia, reajuste, sanção, recebimento, pagamento...
    const r = checkDomainCoverage(fromGraph("Contract"));
    assert.ok(r.coreMissing >= 3);
    const garantia = r.gaps.find((g) => g.concept === "Garantia de execução");
    assert.ok(garantia, "garantia deveria ser um gap");
    assert.equal(garantia!.importance, "core");
    assert.match(garantia!.legalBasis, /Art\. 96/);
    // core vem primeiro nos gaps
    assert.equal(r.gaps[0].importance, "core");
  });

  it("sistema completo (easynup-like) → poucos/zero gaps core", () => {
    const r = checkDomainCoverage(fromGraph(
      "Contract", "ContractGuarantee", "ContractPriceAdjustment", "Deflator",
      "Acceptance", "Sla", "SlaIndicator", "FinancialEntry", "ContractObligation",
      "ServiceOrder", "ContractFiscal",
    ));
    assert.equal(r.coreMissing, 0, "um sistema que modela tudo não tem gap core");
  });

  it("lê entidades de impactEndpoints e do catálogo como fallback", () => {
    const r1 = checkDomainCoverage({ impactEndpoints: [{ entitiesTouched: ["ContractGuarantee"] }] });
    assert.ok(r1.coverage.find((c) => c.concept === "Garantia de execução")!.covered);
    const r2 = checkDomainCoverage({ entities: [{ name: "Acceptance" }] });
    assert.ok(r2.coverage.find((c) => c.concept.startsWith("Recebimento"))!.covered);
  });

  it("ontologia é citável e tem core (confiabilidade)", () => {
    assert.ok(PUBLIC_PROCUREMENT_ONTOLOGY.every((c) => c.legalBasis && c.why));
    assert.ok(PUBLIC_PROCUREMENT_ONTOLOGY.some((c) => c.importance === "core"));
  });

  it("manifest vazio → todos os conceitos viram gap, não estoura", () => {
    const r = checkDomainCoverage({});
    assert.equal(r.entitiesConsidered, 0);
    assert.equal(r.conceptsCovered, 0);
    assert.equal(r.gaps.length, r.conceptsTotal);
  });
});

describe("renderDomainCoverageMarkdown", () => {
  it("renderiza gaps com base legal; sistema completo é honesto", () => {
    const md = renderDomainCoverageMarkdown(checkDomainCoverage(fromGraph("Contract")), { projectName: "vendor-x" });
    assert.match(md, /# Crítica de domínio/);
    assert.match(md, /Garantia de execução/);
    assert.match(md, /Art\. 96/);
    assert.match(md, /🔴 core/);

    const full = checkDomainCoverage(fromGraph(
      "Contract", "ContractGuarantee", "ContractPriceAdjustment", "Deflator",
      "Acceptance", "Sla", "FinancialEntry", "ContractObligation", "ServiceOrder", "ContractFiscal",
    ));
    // pode ter gaps recommended, mas o texto deve sair sem erro
    const mdFull = renderDomainCoverageMarkdown(full);
    assert.match(mdFull, /Conceitos cobertos:/);
  });
});

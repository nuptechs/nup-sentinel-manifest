// ─────────────────────────────────────────────
// adr-retrieval — unit tests (ADR-070 Onda 1)
//
// Recuperação determinística de ADRs relevantes p/ um conjunto de arquivos, por
// sobreposição de símbolos fortes. Advisory: "estas decisões governam o que
// você mexeu", não "você violou X".
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isAdrFile,
  parseAdr,
  buildAdrIndex,
  retrieveAdrsForFiles,
  renderApplicableAdrsMarkdown,
} from "../../server/analyzers/adr-retrieval.ts";

const ADR_063 = {
  filePath: "docs/adr/ADR-063-garantia-reajuste-entidades.md",
  content: `# ADR-063 — Garantia de Execução e Reajuste/Repactuação como Entidades de 1ª Classe

**Status:** Aceita
**Data:** 2026-06-08

Modela \`ContractGuarantee\` (1+ por contrato) e \`ContractPriceAdjustment\` como
entidades de 1ª classe ligadas ao \`Contract\`. Advisory: alerta vencimento da
garantia, NÃO bloqueia pagamento. Reusa FinancialEntry.`,
};

const ADR_064 = {
  filePath: "docs/adr/ADR-064-extracao-persistencia-fiel-wizard.md",
  content: `# ADR-064 — Extração ↔ Persistência Fiel e Consolidação do Wizard de Contrato

**Status:** Aceita

Nada que a extração produz pode ser descartado. Watch-points viram
\`ContractObligation\` SUGGESTED; sanções viram \`Deflator\` inativo; produtos
viram \`LicencaContratada\`. Toca o \`Contract\` e o ContractWizard.`,
};

const ADR_025 = {
  filePath: "docs/adr/ADR-025-i18n-automacao-completa.md",
  content: `# ADR-025 — i18n automação completa

**Status:** Aceita

Pilares de i18n type-safe com TolgeeMessageSource e o MissingKeyHandler.`,
};

describe("isAdrFile / parseAdr", () => {
  it("reconhece arquivo de ADR por path docs/adr e por nome ADR-NNN", () => {
    assert.equal(isAdrFile("docs/adr/ADR-063-x.md"), true);
    assert.equal(isAdrFile("any/where/ADR-099-y.md"), true);
    assert.equal(isAdrFile("docs/adr/README.md"), false); // sem ADR-NNN e não casa
    assert.equal(isAdrFile("src/main/java/Contract.java"), false);
  });

  it("parseia id, título, status e símbolos fortes", () => {
    const a = parseAdr(ADR_063.filePath, ADR_063.content)!;
    assert.equal(a.id, "ADR-063");
    assert.match(a.title, /Garantia de Execução/);
    assert.equal(a.status, "Aceita");
    assert.ok(a.symbols.includes("ContractGuarantee"));
    assert.ok(a.symbols.includes("ContractPriceAdjustment"));
    assert.ok(a.symbols.includes("Contract"));
    // stopword de prosa não entra
    assert.ok(!a.symbols.includes("Status"));
    assert.ok(!a.symbols.includes("Aceita"));
  });

  it("não-ADR → null", () => {
    assert.equal(parseAdr("src/x/Contract.java", "class Contract {}"), null);
  });
});

describe("buildAdrIndex", () => {
  it("indexa só os ADRs, dedup por id, ignora não-ADRs", () => {
    const idx = buildAdrIndex([
      ADR_063,
      ADR_064,
      { filePath: "src/main/java/easynup/persistence/entities/Contract.java", content: "class Contract {}" },
      { filePath: "docs/adr/ADR-063-garantia-reajuste-entidades.md", content: ADR_063.content }, // dup id
    ]);
    assert.equal(idx.length, 2);
    assert.deepEqual(idx.map((a) => a.id).sort(), ["ADR-063", "ADR-064"]);
  });
});

describe("retrieveAdrsForFiles", () => {
  const index = buildAdrIndex([ADR_063, ADR_064, ADR_025]);

  it("entrega tocando ContractGuarantee → ADR-063 no topo", () => {
    const r = retrieveAdrsForFiles(index, [
      "src/main/java/easynup/persistence/entities/ContractGuarantee.java",
    ]);
    assert.ok(r.length >= 1);
    assert.equal(r[0].id, "ADR-063");
    assert.ok(r[0].matchedSymbols.includes("ContractGuarantee"));
  });

  it("entrega no ContractWizard → ADR-064 (que cita o wizard e o Contract)", () => {
    const r = retrieveAdrsForFiles(index, ["frontend/src/pages/contracts/ContractWizard.vue"]);
    const ids = r.map((m) => m.id);
    assert.ok(ids.includes("ADR-064"));
  });

  it("ranking por sobreposição: mais símbolos casados → score maior", () => {
    const r = retrieveAdrsForFiles(index, [
      "ContractGuarantee.java",
      "ContractPriceAdjustment.java",
    ]);
    assert.equal(r[0].id, "ADR-063");
    assert.ok(r[0].score >= 2);
  });

  it("NÃO casa ADR irrelevante (i18n) numa entrega de Contract — sem ruído", () => {
    const r = retrieveAdrsForFiles(index, ["ContractGuarantee.java"]);
    assert.ok(!r.some((m) => m.id === "ADR-025"));
  });

  it("limit corta o ranking", () => {
    const r = retrieveAdrsForFiles(index, ["Contract.java"], { limit: 1 });
    assert.ok(r.length <= 1);
  });

  it("guardas: índice vazio / sem arquivos → []", () => {
    assert.deepEqual(retrieveAdrsForFiles([], ["Contract.java"]), []);
    assert.deepEqual(retrieveAdrsForFiles(index, []), []);
  });
});

describe("renderApplicableAdrsMarkdown", () => {
  it("renderiza seção advisory com id/status/símbolos; vazio → string vazia", () => {
    const index = buildAdrIndex([ADR_063]);
    const r = retrieveAdrsForFiles(index, ["ContractGuarantee.java"]);
    const md = renderApplicableAdrsMarkdown(r);
    assert.match(md, /## Decisões arquiteturais aplicáveis/);
    assert.match(md, /\*\*ADR-063\*\*/);
    assert.match(md, /_\(Aceita\)_/);
    assert.match(md, /ContractGuarantee/);
    assert.equal(renderApplicableAdrsMarkdown([]), "");
  });
});

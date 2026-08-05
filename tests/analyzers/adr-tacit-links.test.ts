// ─────────────────────────────────────────────
// adr-tacit-links — unit tests (ADR-0028 P5, fundação)
//
// Conhecimento tácito: liga cada CITAÇÃO de símbolo/arquivo dentro de uma ADR ao
// grafo de símbolos, com proveniência (arquivo:linha). Contrato epistêmico
// determinístico: STATIC_PROVEN quando o símbolo existe no grafo, senão
// STATIC_UNRESOLVED. LLM_CONJECTURED fica reservado (não emitido aqui).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractLineCitations,
  buildAdrLinks,
  knownSymbolsFromSystemGraph,
} from "../../server/analyzers/adr-tacit-links.ts";

const ADR_063 = {
  filePath: "docs/adr/ADR-063-garantia-reajuste-entidades.md",
  content: `# ADR-063 — Garantia de Execução e Reajuste/Repactuação como Entidades de 1ª Classe

**Status:** Aceita
**Data:** 2026-06-08

Modela \`ContractGuarantee\` (1+ por contrato) e \`ContractPriceAdjustment\` como
entidades de 1ª classe ligadas ao \`Contract\`. Verificado em
\`ContractBalanceComponent.java:207\` que o preço não é tocado. Reusa FinancialEntry.`,
};

describe("extractLineCitations", () => {
  it("símbolo em crase → citation backtick (tokenizer é raw; prosa 'Modela' é ruído filtrado só no buildAdrLinks)", () => {
    const c = extractLineCitations("contrato tem `ContractGuarantee` vinculado.");
    assert.deepEqual(c, [{ symbol: "ContractGuarantee", citation: "backtick" }]);
  });

  it("Arquivo.java:linha em crase → citation file, symbol = basename sem ext", () => {
    const c = extractLineCitations("checado em `ContractBalanceComponent.java:207`.");
    assert.deepEqual(c, [{ symbol: "ContractBalanceComponent", citation: "file" }]);
  });

  it("Arquivo.java em prosa (sem crase) → file", () => {
    const c = extractLineCitations("O setter fica em UpdateContractServiceV1.java no fluxo.");
    assert.ok(c.some((x) => x.symbol === "UpdateContractServiceV1" && x.citation === "file"));
  });

  it("path/x/Foo.java:12 → symbol Foo", () => {
    const c = extractLineCitations("cita `src/main/java/easynup/Foo.java:12` aqui");
    assert.deepEqual(c, [{ symbol: "Foo", citation: "file" }]);
  });

  it("símbolo forte solto na prosa → prose", () => {
    const c = extractLineCitations("O ContractBalanceComponent decide o saldo.");
    assert.deepEqual(c, [{ symbol: "ContractBalanceComponent", citation: "prose" }]);
  });

  it("dedupe por símbolo na linha, mantendo a citação de maior sinal (file > prose)", () => {
    const c = extractLineCitations("Contract e `Contract.java` no mesmo lugar.");
    const contract = c.filter((x) => x.symbol === "Contract");
    assert.equal(contract.length, 1);
    assert.equal(contract[0].citation, "file");
  });

  it("stopword de prosa não vira citação", () => {
    assert.deepEqual(extractLineCitations("Status Aceita Onda Contexto Decisao"), []);
  });

  it("linha sem citação → vazio", () => {
    assert.deepEqual(extractLineCitations("prosa comum sem símbolo forte algum aqui"), []);
  });
});

describe("buildAdrLinks — contrato epistêmico", () => {
  it("símbolo citado que EXISTE no grafo → STATIC_PROVEN com sourceRef arquivo:linha", () => {
    const { links } = buildAdrLinks([ADR_063], ["ContractGuarantee", "Contract"]);
    const g = links.find((l) => l.targetSymbol === "ContractGuarantee");
    assert.ok(g, "esperava ligação p/ ContractGuarantee");
    assert.equal(g!.adrId, "ADR-063");
    assert.equal(g!.confidence, "STATIC_PROVEN");
    // proveniência: aponta o arquivo da ADR + a linha exata da citação
    assert.match(g!.sourceRef, /^docs\/adr\/ADR-063-.*\.md:\d+$/);
    assert.equal(g!.sourceRef, `${ADR_063.filePath}:${g!.sourceLine}`);
    assert.ok(g!.sourceText.includes("ContractGuarantee"));
  });

  it("símbolo citado DESCONHECIDO do grafo → STATIC_UNRESOLVED", () => {
    // grafo conhece só Contract; ContractPriceAdjustment não existe nele
    const { links } = buildAdrLinks([ADR_063], ["Contract"]);
    const adj = links.find((l) => l.targetSymbol === "ContractPriceAdjustment");
    assert.ok(adj);
    assert.equal(adj!.confidence, "STATIC_UNRESOLVED");
  });

  it("sem grafo (knownSymbols vazio/ausente) → tudo STATIC_UNRESOLVED (honesto)", () => {
    const { links } = buildAdrLinks([ADR_063]);
    assert.ok(links.length > 0);
    assert.ok(links.every((l) => l.confidence === "STATIC_UNRESOLVED"));
  });

  it("citação de arquivo é resolvida ao símbolo da classe do grafo", () => {
    const { links } = buildAdrLinks([ADR_063], ["ContractBalanceComponent"]);
    const cbc = links.find((l) => l.targetSymbol === "ContractBalanceComponent");
    assert.ok(cbc);
    assert.equal(cbc!.confidence, "STATIC_PROVEN");
    assert.equal(cbc!.citation, "file");
    assert.match(cbc!.sourceText, /ContractBalanceComponent\.java:207/);
  });

  it("ruído de prosa pt-BR (Modela/Reusa) NÃO vira ligação — só citação explícita ou símbolo conhecido", () => {
    // "Modela" e "Reusa"/"FinancialEntry" aparecem só em prosa; grafo não os conhece.
    const { links } = buildAdrLinks([ADR_063], ["ContractGuarantee", "Contract"]);
    assert.ok(!links.some((l) => l.targetSymbol === "Modela"));
    assert.ok(!links.some((l) => l.targetSymbol === "Reusa"));
    // FinancialEntry é citado só em prosa e não está no grafo → filtrado
    assert.ok(!links.some((l) => l.targetSymbol === "FinancialEntry"));
  });

  it("símbolo conhecido citado em prosa É resgatado (prose + known → link)", () => {
    const { links } = buildAdrLinks([ADR_063], ["FinancialEntry"]);
    const fe = links.find((l) => l.targetSymbol === "FinancialEntry");
    assert.ok(fe, "FinancialEntry é conhecido → prosa vira ligação");
    assert.equal(fe!.citation, "prose");
    assert.equal(fe!.confidence, "STATIC_PROVEN");
  });

  it("uma ligação por (ADR, símbolo): primeira citação vence", () => {
    const { links } = buildAdrLinks([ADR_063], ["ContractGuarantee"]);
    assert.equal(links.filter((l) => l.targetSymbol === "ContractGuarantee").length, 1);
  });

  it("arquivo que NÃO é ADR → nenhuma ligação", () => {
    const { links, stats } = buildAdrLinks(
      [{ filePath: "src/main/java/Contract.java", content: "class Contract { ContractGuarantee g; }" }],
      ["ContractGuarantee"],
    );
    assert.deepEqual(links, []);
    assert.equal(stats.adrs, 0);
  });

  it("ADR sem citação de código → links vazio, adrs contado", () => {
    const empty = {
      filePath: "docs/adr/ADR-099-prosa.md",
      content: "# ADR-099 — só prosa\n\n**Status:** Proposta\n\nnenhum símbolo forte de domínio aqui.",
    };
    const { links, stats } = buildAdrLinks([empty], ["Contract"]);
    assert.deepEqual(links, []);
    assert.equal(stats.adrs, 1);
  });

  it("stats agregam proven/unresolved", () => {
    const { stats } = buildAdrLinks([ADR_063], ["ContractGuarantee", "Contract", "ContractBalanceComponent"]);
    assert.equal(stats.links, stats.proven + stats.unresolved);
    assert.ok(stats.proven >= 3);
    assert.equal(stats.adrs, 1);
  });

  it("guardas: entrada inválida / vazia → []", () => {
    assert.deepEqual(buildAdrLinks([]).links, []);
    // @ts-expect-error teste de robustez com entrada malformada
    assert.deepEqual(buildAdrLinks(null).links, []);
    // @ts-expect-error item malformado é ignorado
    assert.deepEqual(buildAdrLinks([{ filePath: 1, content: 2 }]).links, []);
  });
});

describe("knownSymbolsFromSystemGraph", () => {
  it("extrai className dos nós; shape inesperado → conjunto vazio", () => {
    const s = knownSymbolsFromSystemGraph({
      nodes: [{ className: "Contract" }, { className: "SlaIndicator" }, { className: "" }, {}],
    });
    assert.deepEqual(Array.from(s).sort(), ["Contract", "SlaIndicator"]);
    assert.equal(knownSymbolsFromSystemGraph(null).size, 0);
    assert.equal(knownSymbolsFromSystemGraph({ nodes: "nope" }).size, 0);
  });
});

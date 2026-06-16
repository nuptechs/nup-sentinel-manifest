// ─────────────────────────────────────────────
// market-coverage — unit tests (ADR-070 Onda 7, fatia 2 segura)
//
// "Grandes players já fazem Y" via base curada citável (sem scraping). Advisory.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkMarketCoverage, renderMarketCoverageMarkdown } from "../../server/analyzers/market-coverage.ts";
import { PUBLIC_SECTOR_CAPABILITIES } from "../../server/analyzers/market-capabilities.ts";

const fromGraph = (...names: string[]) => ({ allEntitiesFromGraph: names.map((name) => ({ name })) });
const withEndpoints = (...ops: string[]) => ({ impactEndpoints: ops.map((op) => ({ path: `/easynup/${op}.v1`, entitiesTouched: [] })) });

describe("checkMarketCoverage", () => {
  it("reconhece capacidade por entidade e por operação de endpoint", () => {
    const r = checkMarketCoverage(fromGraph("AuditLog", "Section"));
    assert.ok(r.coverage.find((c) => c.capability.startsWith("Trilha de auditoria"))!.present);
    assert.ok(r.coverage.find((c) => c.capability.startsWith("Gestão documental"))!.present);
  });

  it("reconhece PNCP por operação de endpoint", () => {
    const r = checkMarketCoverage(withEndpoints("publishToPncp"));
    assert.ok(r.coverage.find((c) => c.capability === "Publicação no PNCP")!.present);
  });

  it("flagga capacidade MANDADA ausente como gap forte (PNCP, Art. 174)", () => {
    const r = checkMarketCoverage(fromGraph("Contract")); // sem PNCP
    const pncp = r.gaps.find((g) => g.capability === "Publicação no PNCP");
    assert.ok(pncp);
    assert.equal(pncp!.tier, "mandatory");
    assert.match(pncp!.source, /Art\. 174/);
    assert.equal(r.gaps[0].tier, "mandatory"); // mandadas primeiro
    assert.ok(r.mandatoryMissing >= 1);
  });

  it("sistema com integrações → menos gaps", () => {
    const r = checkMarketCoverage(fromGraph("PncpPublication", "DigitalSignature", "SicafConsulta", "PriceSearchCatmat", "AuditLog", "DocumentSection"));
    assert.equal(r.mandatoryMissing, 0);
    assert.ok(r.capabilitiesPresent >= 5);
  });

  it("toda capacidade é citável (confiabilidade) + disclaimer presente", () => {
    assert.ok(PUBLIC_SECTOR_CAPABILITIES.every((c) => c.source && c.why));
    const r = checkMarketCoverage({});
    assert.match(r.disclaimer, /verificação humana/i);
  });

  it("manifest vazio → tudo gap, não estoura", () => {
    const r = checkMarketCoverage({});
    assert.equal(r.capabilitiesPresent, 0);
    assert.equal(r.gaps.length, r.capabilitiesTotal);
  });
});

describe("renderMarketCoverageMarkdown", () => {
  it("renderiza gaps com fonte + disclaimer; honesto", () => {
    const md = renderMarketCoverageMarkdown(checkMarketCoverage(fromGraph("Contract")), { projectName: "vendor-x" });
    assert.match(md, /# Capacidades de mercado/);
    assert.match(md, /Publicação no PNCP/);
    assert.match(md, /Art\. 174/);
    assert.match(md, /🔴 mandada por lei/);
    assert.match(md, /verificação humana/i);
  });
});

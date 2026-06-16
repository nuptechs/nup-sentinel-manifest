// ─────────────────────────────────────────────
// completeness-detector — unit tests (ADR-070 Onda 4)
//
// Incompletude de ciclo de vida: entidade escrita sem leitura (alto) / lida sem
// escrita (info). Precisão > recall; advisory.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectCompletenessGaps, renderCompletenessMarkdown } from "../../server/analyzers/completeness-detector.ts";

const ep = (path: string, entitiesTouched: string[]) => ({ path, entitiesTouched });

describe("detectCompletenessGaps", () => {
  it("flagga entidade escrita mas não lida (alto)", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/createAuditEvent.v1", ["AuditEvent"]),
        ep("/easynup/updateAuditEvent.v1", ["AuditEvent"]),
        // nenhum find/get de AuditEvent
      ],
    };
    const r = detectCompletenessGaps(m);
    const g = r.findings.find((f) => f.entity === "AuditEvent");
    assert.ok(g, "deveria flaggar AuditEvent");
    assert.equal(g!.kind, "WRITABLE_NOT_READABLE");
    assert.equal(g!.severity, "high");
    assert.deepEqual(g!.has.sort(), ["CREATE", "UPDATE"]);
    assert.deepEqual(g!.missing, ["READ"]);
  });

  it("NÃO flagga entidade com escrita E leitura (CRUD completo)", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/createContract.v1", ["Contract"]),
        ep("/easynup/findContract.v1", ["Contract"]),
      ],
    };
    const r = detectCompletenessGaps(m);
    assert.equal(r.gaps, 0);
    const cap = r.capabilities.find((c) => c.entity === "Contract")!;
    assert.equal(cap.create, true);
    assert.equal(cap.read, true);
  });

  it("flagga entidade lida mas não escrita (info — dado de referência)", () => {
    const m = {
      impactEndpoints: [ep("/easynup/findLegalFramework.v1", ["LegalFramework"])],
    };
    const r = detectCompletenessGaps(m);
    const g = r.findings.find((f) => f.entity === "LegalFramework");
    assert.ok(g);
    assert.equal(g!.kind, "READABLE_NOT_WRITABLE");
    assert.equal(g!.severity, "info");
    assert.equal(r.highGaps, 0);
  });

  it("um read por op convencional SUPRIME o achado de writable-not-readable", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/createSla.v1", ["Sla"]),
        ep("/easynup/getSla.v1", ["Sla"]), // 'get' conta como READ
      ],
    };
    const r = detectCompletenessGaps(m);
    assert.ok(!r.findings.some((f) => f.entity === "Sla"));
  });

  it("transições de estado (OTHER) não contam como escrita de ciclo de vida", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/approveAcceptance.v1", ["Acceptance"]),
        ep("/easynup/findAcceptance.v1", ["Acceptance"]),
      ],
    };
    const r = detectCompletenessGaps(m);
    const cap = r.capabilities.find((c) => c.entity === "Acceptance")!;
    // approve = OTHER → não vira write; só READ presente → info (lida sem escrita)
    assert.equal(cap.create, false);
    assert.equal(cap.read, true);
    assert.equal(r.findings.find((f) => f.entity === "Acceptance")!.kind, "READABLE_NOT_WRITABLE");
  });

  it("ordena alto antes de info", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/findLegalFramework.v1", ["LegalFramework"]),
        ep("/easynup/createAuditEvent.v1", ["AuditEvent"]),
      ],
    };
    const r = detectCompletenessGaps(m);
    assert.equal(r.findings[0].severity, "high");
  });

  it("guardas: manifest vazio/nulo → zero", () => {
    assert.equal(detectCompletenessGaps({}).gaps, 0);
    assert.equal(detectCompletenessGaps(null).gaps, 0);
  });
});

describe("renderCompletenessMarkdown", () => {
  it("renderiza buracos; vazio é honesto", () => {
    const m = { impactEndpoints: [ep("/easynup/createAuditEvent.v1", ["AuditEvent"])] };
    const md = renderCompletenessMarkdown(detectCompletenessGaps(m), { projectName: "easynup" });
    assert.match(md, /# Incompletude de ciclo de vida/);
    assert.match(md, /\*\*AuditEvent\*\*/);
    assert.match(md, /escreve mas não lê/);

    const empty = renderCompletenessMarkdown(detectCompletenessGaps({ impactEndpoints: [] }));
    assert.match(empty, /Nenhum buraco de ciclo de vida/);
  });
});

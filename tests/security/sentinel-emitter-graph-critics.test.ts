// ─────────────────────────────────────────────
// sentinel-emitter — críticos de grafo (ADR-070 Onda 4)
//
// emitOverlapFindings / emitCompletenessFindings: best-effort, filtram por
// severidade (precisão) e nunca estouram.
// ─────────────────────────────────────────────
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { emitOverlapFindings, emitCompletenessFindings } from "../../server/security/sentinel-emitter.ts";

const ctx = { manifestProjectId: "1", analysisRunId: 99 };

describe("emitOverlapFindings", () => {
  beforeEach(() => { delete process.env.SENTINEL_URL; });

  it("sem grupos de escrita → skipped (só info não emite)", async () => {
    const r = await emitOverlapFindings(
      [{ entity: "contract", opClass: "READ", severity: "info", reason: "...", endpoints: [{ operation: "findContracts" }, { operation: "searchContracts" }] }],
      ctx,
    );
    assert.equal(r.skipped, true);
    assert.match((r as any).reason, /no overlap findings/);
  });

  it("com grupo de escrita mas SENTINEL_URL ausente → skipped best-effort (não estoura)", async () => {
    const r = await emitOverlapFindings(
      [{ entity: "contract", opClass: "CREATE", severity: "review", reason: "3 caminhos criam contract", endpoints: [{ operation: "createContract" }, { operation: "importContract" }] }],
      ctx,
    );
    assert.equal(r.skipped, true);
    assert.match((r as any).reason, /SENTINEL_URL/);
  });
});

describe("emitCompletenessFindings", () => {
  beforeEach(() => { delete process.env.SENTINEL_URL; });

  it("sem buracos altos → skipped (info não emite)", async () => {
    const r = await emitCompletenessFindings(
      [{ entity: "LegalFramework", kind: "READABLE_NOT_WRITABLE", severity: "info", reason: "...", has: ["READ"] }],
      ctx,
    );
    assert.equal(r.skipped, true);
    assert.match((r as any).reason, /no lifecycle findings/);
  });

  it("com buraco alto mas SENTINEL_URL ausente → skipped best-effort", async () => {
    const r = await emitCompletenessFindings(
      [{ entity: "LicencaContratada", kind: "WRITABLE_NOT_READABLE", severity: "high", reason: "escrita sem leitura", has: ["CREATE", "UPDATE", "DELETE"] }],
      ctx,
    );
    assert.equal(r.skipped, true);
    assert.match((r as any).reason, /SENTINEL_URL/);
  });
});

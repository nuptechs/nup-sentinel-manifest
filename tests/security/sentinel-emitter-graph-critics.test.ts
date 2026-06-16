// ─────────────────────────────────────────────
// sentinel-emitter — críticos de grafo (ADR-070 Onda 4)
//
// emitOverlapFindings / emitCompletenessFindings: best-effort, filtram por
// severidade (precisão) e nunca estouram.
// ─────────────────────────────────────────────
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { emitOverlapFindings, emitCompletenessFindings } from "../../server/security/sentinel-emitter.ts";

const ctx = { manifestProjectId: "1", analysisRunId: 99 };

describe("emitToSentinel — projectId é o do Sentinel, não o numérico do Manifest (fix de órfão)", () => {
  const realFetch = globalThis.fetch;
  let ingested: any[] = [];
  beforeEach(() => {
    ingested = [];
    process.env.SENTINEL_URL = "https://sentinel.test";
    process.env.SENTINEL_API_KEY = "k:org-uuid";
    process.env.SENTINEL_PROJECT_ID = "6805c8cf-sentinel-uuid";
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (String(url).endsWith("/api/sessions")) {
        return { status: 201, text: async () => JSON.stringify({ data: { id: "sess-1" } }) } as any;
      }
      // /api/findings/ingest
      ingested = JSON.parse(init.body);
      return { status: 200, text: async () => JSON.stringify({ data: { accepted: ingested.length, rejected: 0 } }) } as any;
    };
  });
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    delete process.env.SENTINEL_URL; delete process.env.SENTINEL_API_KEY; delete process.env.SENTINEL_PROJECT_ID;
  });

  it("payload.projectId = SENTINEL_PROJECT_ID; manifestProjectId fica separado", async () => {
    await emitCompletenessFindings(
      [{ entity: "LicencaContratada", kind: "WRITABLE_NOT_READABLE", severity: "high", reason: "x", has: ["CREATE"] }],
      ctx,
    );
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].projectId, "6805c8cf-sentinel-uuid", "deve usar o projeto Sentinel, não '1'");
    assert.equal(ingested[0].manifestProjectId, "1", "manifestProjectId preservado");
    assert.equal(ingested[0].symbolRef.kind, "entity");
  });
});

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

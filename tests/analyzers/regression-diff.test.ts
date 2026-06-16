// ─────────────────────────────────────────────
// regression-diff — unit tests (ADR-070 Onda 3, braço differential)
//
// Guarda de não-regressão: o que PIOROU entre dois snapshots.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRegressionDiff, renderRegressionMarkdown } from "../../server/analyzers/regression-diff.ts";

const ep = (path: string, entitiesTouched: string[] = []) => ({ path, entitiesTouched });
const snap = (eps: any[]) => ({ impactEndpoints: eps });

describe("buildRegressionDiff", () => {
  it("flagga conexão endpoint→entidade perdida (alto)", () => {
    const prev = snap([ep("/easynup/findContract.v1", ["Contract"])]);
    const curr = snap([ep("/easynup/findContract.v1", [])]);
    const r = buildRegressionDiff(prev, curr);
    const lost = r.findings.find((f) => f.kind === "LOST_ENTITY_LINK");
    assert.ok(lost);
    assert.equal(lost!.severity, "high");
    assert.match(lost!.detail, /Contract/);
  });

  it("flagga endpoint removido (advisory low)", () => {
    const prev = snap([ep("/easynup/findContract.v1", ["Contract"]), ep("/easynup/deleteContract.v1", ["Contract"])]);
    const curr = snap([ep("/easynup/findContract.v1", ["Contract"])]);
    const r = buildRegressionDiff(prev, curr);
    const rem = r.findings.find((f) => f.kind === "REMOVED_ENDPOINT");
    assert.ok(rem);
    assert.equal(rem!.severity, "low");
  });

  it("flagga queda de cobertura", () => {
    const prev = snap([ep("/a.v1", ["X"]), ep("/b.v1", ["Y"])]); // 100%
    const curr = snap([ep("/a.v1", ["X"]), ep("/b.v1", [])]);     // 50%
    const r = buildRegressionDiff(prev, curr);
    assert.ok(r.findings.some((f) => f.kind === "COVERAGE_DROP"));
  });

  it("flagga nova sobreposição de escrita", () => {
    const prev = snap([ep("/easynup/createContract.v1", ["Contract"])]);
    const curr = snap([ep("/easynup/createContract.v1", ["Contract"]), ep("/easynup/importContract.v1", ["Contract"])]);
    const r = buildRegressionDiff(prev, curr);
    assert.ok(r.findings.some((f) => f.kind === "NEW_OVERLAP"));
  });

  it("flagga novo buraco de ciclo de vida", () => {
    const prev = snap([ep("/easynup/findSla.v1", ["Sla"])]);
    const curr = snap([ep("/easynup/findSla.v1", ["Sla"]), ep("/easynup/createAuditEvent.v1", ["AuditEvent"])]);
    const r = buildRegressionDiff(prev, curr);
    assert.ok(r.findings.some((f) => f.kind === "NEW_LIFECYCLE_GAP" && f.target === "AuditEvent"));
  });

  it("conta melhorias (problema do anterior que sumiu)", () => {
    // anterior tinha overlap de CREATE Contract; atual não
    const prev = snap([ep("/easynup/createContract.v1", ["Contract"]), ep("/easynup/importContract.v1", ["Contract"])]);
    const curr = snap([ep("/easynup/createContract.v1", ["Contract"])]);
    const r = buildRegressionDiff(prev, curr);
    assert.ok(r.improvements >= 1);
    assert.ok(r.resolved.some((x) => /Sobreposição resolvida/.test(x)));
  });

  it("sem mudança → zero regressões", () => {
    const s = snap([ep("/easynup/findContract.v1", ["Contract"])]);
    const r = buildRegressionDiff(s, s);
    assert.equal(r.regressions, 0);
  });

  it("falta um snapshot → não comparável", () => {
    assert.equal(buildRegressionDiff(null, snap([])).comparable, false);
    assert.equal(buildRegressionDiff(snap([]), null).comparable, false);
  });
});

describe("renderRegressionMarkdown", () => {
  it("renderiza regressões + melhorias; sem-diff é honesto", () => {
    const prev = snap([ep("/easynup/findContract.v1", ["Contract"])]);
    const curr = snap([ep("/easynup/findContract.v1", [])]);
    const md = renderRegressionMarkdown(buildRegressionDiff(prev, curr), { projectName: "easynup" });
    assert.match(md, /# Regressão entre snapshots/);
    assert.match(md, /LOST_ENTITY_LINK/);

    const clean = renderRegressionMarkdown(buildRegressionDiff(prev, prev));
    assert.match(clean, /Nenhuma regressão/);

    const incomp = renderRegressionMarkdown(buildRegressionDiff(null, null));
    assert.match(incomp, /Sem dois snapshots/);
  });
});

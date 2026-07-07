// ─────────────────────────────────────────────
// compareBaseline — unit tests (ADR-0015 G1, comparador do baseline full-repo).
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { compareBaseline, type BaselineSpec } from "../../script/check-goldset-baseline.ts";

const SPEC: BaselineSpec = {
  floors: { totalEndpoints: 1330, totalEntities: 214 },
  ceilings: { fakeEndpoints: 0 },
};

describe("compareBaseline (ADR-0015 G1)", () => {
  it("aprova medição igual ao baseline", () => {
    const r = compareBaseline({ totalEndpoints: 1330, totalEntities: 214, fakeEndpoints: 0 }, SPEC);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 3);
    assert.deepEqual(r.failures, []);
  });

  it("aprova melhoria (acima do piso) e sugere subir o piso", () => {
    const r = compareBaseline({ totalEndpoints: 1400, totalEntities: 214, fakeEndpoints: 0 }, SPEC);
    assert.equal(r.ok, true);
    assert.equal(r.improvements.length, 1);
    assert.match(r.improvements[0], /totalEndpoints/);
  });

  it("REPROVA queda abaixo do piso (o gate central do 'não regredir em nada')", () => {
    const r = compareBaseline({ totalEndpoints: 1329, totalEntities: 214, fakeEndpoints: 0 }, SPEC);
    assert.equal(r.ok, false);
    assert.match(r.failures[0], /REGRESSÃO totalEndpoints: medido 1329 < piso 1330/);
  });

  it("REPROVA estouro de teto (fakeEndpoints voltar)", () => {
    const r = compareBaseline({ totalEndpoints: 1330, totalEntities: 214, fakeEndpoints: 2 }, SPEC);
    assert.equal(r.ok, false);
    assert.match(r.failures[0], /fakeEndpoints: medido 2 > teto 0/);
  });

  it("fail-closed: métrica ausente na medição REPROVA (não se declara ok sobre o não-medido)", () => {
    const r = compareBaseline({ totalEndpoints: 1330, fakeEndpoints: 0 }, SPEC);
    assert.equal(r.ok, false);
    assert.match(r.failures[0], /ausente.*totalEntities/);
  });

  it("fail-closed: métrica não-numérica REPROVA", () => {
    const r = compareBaseline(
      { totalEndpoints: "1330", totalEntities: 214, fakeEndpoints: 0 } as Record<string, unknown>,
      SPEC,
    );
    assert.equal(r.ok, false);
  });

  it("o baseline versionado carrega os números medidos do goldset easynup", () => {
    const spec = JSON.parse(
      readFileSync(join(import.meta.dirname, "baseline-easynup-full.json"), "utf-8"),
    ) as BaselineSpec;
    assert.equal(spec.floors.totalEndpoints, 1330);
    assert.equal(spec.floors.totalEntities, 214);
    assert.equal(spec.floors.columnNamesResolved, 2119);
    assert.equal(spec.floors.endpointsWithPermission, 672);
    assert.equal(spec.ceilings.fakeEndpoints, 0);
  });
});

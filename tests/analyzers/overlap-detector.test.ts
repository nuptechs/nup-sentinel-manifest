// ─────────────────────────────────────────────
// overlap-detector — unit tests (ADR-070 Onda 4)
//
// Sobreposição funcional: endpoints que fazem a mesma coisa com a mesma entidade
// por caminhos diferentes. Precisão > recall; advisory.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectFunctionalOverlap, renderOverlapMarkdown } from "../../server/analyzers/overlap-detector.ts";

const ep = (path: string, controller = "") => ({ path, controller });

describe("detectFunctionalOverlap", () => {
  it("flagga 2+ caminhos de CREATE para a mesma entidade", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/createContract.v1", "CreateContractWsV1"),
        ep("/easynup/importContract.v1", "ImportContractWsV1"),
        ep("/easynup/bulkCreateContract.v1", "BulkCreateContractWsV1"),
        // ruído que NÃO deve casar:
        ep("/easynup/updateContract.v1", "UpdateContractWsV1"), // classe diferente
        ep("/easynup/findContract.v1", "FindContractWsV1"),     // leitura
      ],
    };
    const r = detectFunctionalOverlap(m);
    const create = r.overlaps.find((o) => o.opClass === "CREATE" && o.entity === "contract");
    assert.ok(create, "deveria achar overlap de CREATE Contract");
    assert.equal(create!.endpoints.length, 3);
    assert.equal(create!.severity, "review");
    assert.deepEqual(create!.endpoints.map((e) => e.operation).sort(), ["bulkCreateContract", "createContract", "importContract"]);
  });

  it("NÃO flagga CRUD normal (create+update+delete são classes distintas)", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/createSla.v1"),
        ep("/easynup/updateSla.v1"),
        ep("/easynup/deleteSla.v1"),
        ep("/easynup/findSla.v1"),
      ],
    };
    const r = detectFunctionalOverlap(m);
    assert.equal(r.groups, 0, "CRUD único por classe não é sobreposição");
  });

  it("NÃO flagga transições de estado (approve/reject/cancel ficam em OTHER)", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/approveAcceptance.v1"),
        ep("/easynup/rejectAcceptance.v1"),
        ep("/easynup/cancelAcceptance.v1"),
      ],
    };
    const r = detectFunctionalOverlap(m);
    assert.equal(r.groups, 0);
  });

  it("distingue cardinalidade: findContract (registro) ≠ findContracts (coleção)", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/findContract.v1"),
        ep("/easynup/findContracts.v1"),
      ],
    };
    const r = detectFunctionalOverlap(m);
    // são semânticas diferentes (1 vs N) → não é overlap
    assert.equal(r.groups, 0);
  });

  it("flagga 2 caminhos de leitura de coleção da mesma entidade (info, não review)", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/findContracts.v1"),
        ep("/easynup/searchContracts.v1"),
      ],
    };
    const r = detectFunctionalOverlap(m);
    const g = r.overlaps.find((o) => o.opClass === "READ" && o.cardinality === "collection");
    assert.ok(g, "find+search de Contracts agrupam como READ coleção");
    assert.equal(g!.severity, "info");
    assert.equal(r.reviewGroups, 0);
  });

  it("ordena escrita antes de leitura", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/findContracts.v1"),
        ep("/easynup/searchContracts.v1"),
        ep("/easynup/createSla.v1"),
        ep("/easynup/importSla.v1"),
      ],
    };
    const r = detectFunctionalOverlap(m);
    assert.equal(r.overlaps[0].severity, "review"); // CREATE Sla primeiro
  });

  it("ignora paths sem operação /easynup/<op>.v<N> (ex.: '/')", () => {
    const m = { impactEndpoints: [ep("/"), ep("/api/webhooks/x"), ep("/easynup/createX.v1")] };
    const r = detectFunctionalOverlap(m);
    assert.equal(r.groups, 0); // só 1 createX, sem par
  });

  it("manifest vazio/sem impactEndpoints → zero, não estoura", () => {
    assert.equal(detectFunctionalOverlap({}).groups, 0);
    assert.equal(detectFunctionalOverlap(null).groups, 0);
  });
});

describe("renderOverlapMarkdown", () => {
  it("renderiza grupos com severidade; vazio é honesto", () => {
    const m = {
      impactEndpoints: [
        ep("/easynup/createContract.v1", "CreateContractWsV1"),
        ep("/easynup/importContract.v1", "ImportContractWsV1"),
      ],
    };
    const md = renderOverlapMarkdown(detectFunctionalOverlap(m), { projectName: "easynup" });
    assert.match(md, /# Sobreposição funcional/);
    assert.match(md, /\*\*Sistema:\*\* easynup/);
    assert.match(md, /CREATE de `contract`/);
    assert.match(md, /createContract\.v1/);
    assert.match(md, /advisory/i);

    const empty = renderOverlapMarkdown(detectFunctionalOverlap({ impactEndpoints: [] }));
    assert.match(empty, /Nenhuma sobreposição funcional candidata/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectEntityAccess, renderEntityAccessMarkdown } from "../../server/analyzers/entity-access.ts";

const ep = (path: string, entitiesTouched: string[], persistenceOperations: string[], method = "POST") => ({
  path,
  method,
  entitiesTouched,
  persistenceOperations,
});

describe("detectEntityAccess", () => {
  it("classifica leitura vs escrita por endpoint", () => {
    const r = detectEntityAccess({
      endpoints: [
        ep("/easynup/updateContract.v1", ["Contract"], ["write"]),
        ep("/easynup/createContract.v1", ["Contract"], ["write"]),
        ep("/easynup/findContract.v1", ["Contract"], ["read"]),
      ],
    });
    const c = r.entities.find((e) => e.entity === "Contract")!;
    assert.deepEqual(c.writtenBy.map((x) => x.path), ["/easynup/createContract.v1", "/easynup/updateContract.v1"]);
    assert.deepEqual(c.readBy.map((x) => x.path), ["/easynup/findContract.v1"]);
  });

  it("summary conta entidades e endpoints com entidade", () => {
    const r = detectEntityAccess({
      endpoints: [
        ep("/a", ["Contract"], ["write"]),
        ep("/b", ["SlaMeasurement"], ["read"]),
        ep("/c", [], ["read"]), // sem entidade → não conta
      ],
    });
    assert.equal(r.summary.totalEntities, 2);
    assert.equal(r.summary.totalEndpointsWithEntity, 2);
  });

  it("ordena entidades por total de acessos desc", () => {
    const r = detectEntityAccess({
      endpoints: [
        ep("/a", ["A"], ["read"]),
        ep("/b", ["B"], ["read"]),
        ep("/c", ["B"], ["write"]),
        ep("/d", ["B"], ["read"]),
      ],
    });
    assert.deepEqual(r.entities.map((e) => e.entity), ["B", "A"]);
  });

  it("op desconhecida não classifica (nem read nem write)", () => {
    const r = detectEntityAccess({ endpoints: [ep("/x", ["Z"], ["frobnicate"])] });
    const z = r.entities.find((e) => e.entity === "Z")!;
    assert.deepEqual(z.readBy, []);
    assert.deepEqual(z.writtenBy, []);
  });

  it("vazio≠falhou e null-safe", () => {
    assert.deepEqual(detectEntityAccess({ endpoints: [] }).entities, []);
    assert.equal(detectEntityAccess(null).summary.totalEntities, 0);
    assert.equal(detectEntityAccess({}).summary.totalEntities, 0);
    // lixo não-string em entitiesTouched é ignorado
    const r = detectEntityAccess({ endpoints: [{ path: "/x", method: "POST", entitiesTouched: [null, "OK"] as any, persistenceOperations: ["write"] }] });
    assert.deepEqual(r.entities.map((e) => e.entity), ["OK"]);
  });
});

describe("renderEntityAccessMarkdown", () => {
  it("rende seções por entidade com leitura/escrita", () => {
    const r = detectEntityAccess({
      endpoints: [ep("/easynup/updateContract.v1", ["Contract"], ["write"]), ep("/easynup/findContract.v1", ["Contract"], ["read"])],
    });
    const md = renderEntityAccessMarkdown(r, { projectName: "easynup" });
    assert.match(md, /Acesso por Entidade — easynup/);
    assert.match(md, /Contract — 1 escrita\(s\) · 1 leitura\(s\)/);
  });
});

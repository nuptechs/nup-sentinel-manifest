// ─────────────────────────────────────────────
// sentinel-emitter — parseSentinelKey
//
// O Sentinel autentica comparando só a parte `chave` (antes do `:`). O header
// deve levar a chave nua, não `chave:orgId` (senão 401). Bug real: toda emissão
// manifest→Sentinel tomava 401 porque enviava a chave inteira.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSentinelKey } from "../../server/security/sentinel-emitter.ts";

describe("parseSentinelKey", () => {
  it("separa `chave:orgId` → chave nua + orgId", () => {
    const r = parseSentinelKey("abc123:dd5f6461-dee9-4bec-a20a-cf2550de019d");
    assert.equal(r.apiKey, "abc123");
    assert.equal(r.organizationId, "dd5f6461-dee9-4bec-a20a-cf2550de019d");
  });

  it("chave sem orgId → orgId undefined", () => {
    const r = parseSentinelKey("abc123");
    assert.equal(r.apiKey, "abc123");
    assert.equal(r.organizationId, undefined);
  });

  it("múltiplas entradas → usa a primeira", () => {
    const r = parseSentinelKey("k1:orgA,k2:orgB");
    assert.equal(r.apiKey, "k1");
    assert.equal(r.organizationId, "orgA");
  });

  it("vazio/undefined → chave vazia (emitter então skipa)", () => {
    assert.equal(parseSentinelKey(undefined).apiKey, "");
    assert.equal(parseSentinelKey("").apiKey, "");
  });

  it("NÃO devolve a chave com o sufixo :orgId (regressão do 401)", () => {
    const r = parseSentinelKey("hex64:uuid");
    assert.ok(!r.apiKey.includes(":"), "chave nua não pode conter ':'");
  });
});

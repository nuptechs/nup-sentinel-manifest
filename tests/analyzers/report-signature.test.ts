// ─────────────────────────────────────────────
// report-signature — testes (ADR-0018 Onda 5). Puro, determinístico.
//
// Critério da onda (ADR §6): "Relatório assinado HMAC, cada afirmação com
// citação; OFF byte-a-byte". A assinatura cobre o CONTEÚDO canônico; 1 byte
// alterado invalida; sem chave não existe bloco (nunca assinatura fake).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalStringify,
  contentHashOf,
  signReport,
  verifyReportSignature,
  renderSignatureFooter,
} from "../../server/analyzers/report-signature.ts";

const KEY = "chave-de-teste-nao-usar-em-prod";

describe("canonicalStringify", () => {
  it("ordem de INSERÇÃO das chaves não muda o canônico (determinismo)", () => {
    const a = { b: 1, a: { z: 2, y: [3, { k: 4, j: 5 }] } };
    const b = { a: { y: [3, { j: 5, k: 4 }], z: 2 }, b: 1 };
    assert.equal(canonicalStringify(a), canonicalStringify(b));
  });

  it("ordem de ARRAY é semântica — preservada (não ordena)", () => {
    assert.notEqual(canonicalStringify({ x: [1, 2] }), canonicalStringify({ x: [2, 1] }));
  });
});

describe("signReport / verifyReportSignature", () => {
  const payload = { projectId: 16, breaking: { alerts: [{ symbol: "ContractService.update" }] } };

  it("mesmo conteúdo + mesma chave ⇒ mesma assinatura (verificável offline)", () => {
    const s1 = signReport(payload, KEY, new Date("2026-07-21T00:00:00Z"));
    const s2 = signReport({ breaking: { alerts: [{ symbol: "ContractService.update" }] }, projectId: 16 }, KEY, new Date("2026-07-22T00:00:00Z"));
    // signedAt difere (metadado), mas hash e HMAC são idênticos — o material
    // assinado é o CONTEÚDO, não o carimbo de hora
    assert.equal(s1.contentHash, s2.contentHash);
    assert.equal(s1.value, s2.value);
    assert.ok(verifyReportSignature(payload, KEY, s1));
  });

  it("1 BYTE alterado no relatório ⇒ assinatura INVÁLIDA", () => {
    const sig = signReport(payload, KEY);
    const tampered = { ...payload, projectId: 17 };
    assert.equal(verifyReportSignature(tampered, KEY, sig), false);
  });

  it("chave errada ⇒ inválida; keyId identifica a chave sem vazá-la", () => {
    const sig = signReport(payload, KEY);
    assert.equal(verifyReportSignature(payload, "outra-chave", sig), false);
    assert.equal(sig.keyId.length, 12);
    assert.ok(!sig.keyId.includes(KEY));
  });

  it("conteúdos diferentes ⇒ hashes diferentes", () => {
    assert.notEqual(contentHashOf({ a: 1 }), contentHashOf({ a: 2 }));
  });
});

describe("renderSignatureFooter", () => {
  it("rodapé markdown carrega algoritmo, hash, assinatura e instrução de verificação", () => {
    const sig = signReport({ x: 1 }, KEY, new Date("2026-07-21T12:00:00Z"));
    const md = renderSignatureFooter(sig);
    assert.match(md, /HMAC-SHA256/);
    assert.match(md, new RegExp(sig.contentHash));
    assert.match(md, new RegExp(sig.value));
    assert.match(md, /Verificação: recompute/);
  });
});

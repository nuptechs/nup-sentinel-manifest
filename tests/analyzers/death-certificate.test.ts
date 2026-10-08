import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  issueDeathCertificate,
  issueDeathCertificates,
  verifyDeathCertificate,
} from "../../server/analyzers/death-certificate";
import { confirmTripleOrphan, type StaticSuspect } from "../../server/analyzers/triple-orphan";

// OBS-E08 — certidão de óbito com prova e recibo. Fail-closed: só o `confirmed`
// vira certificado; o recibo (sha256 do corpo canônico) é determinístico e
// verificável — 1 byte muda ⇒ inválido.

const confirmedReport = () =>
  confirmTripleOrphan([{ nodeId: "svc:Dead", type: "SERVICE", label: "DeadSvc", sourceFile: "server/dead.ts", staticConfidence: 0.75, staticReasons: ["isolado"], staticSource: "dead-code" } satisfies StaticSuspect], {
    runtimeCoveragePresent: true,
  });

describe("death-certificate — emissão fail-closed", () => {
  it("emite certificado só para confirmado; unknown/refuted → nada", () => {
    const report = confirmedReport();
    const certs = issueDeathCertificates(report);
    assert.equal(certs.length, 1);
    assert.equal(certs[0].verdict, "dead-confirmed");
    assert.equal(certs[0].nodeId, "svc:Dead");
    assert.ok(certs[0].proof.length >= 3, "prova dos 3 eixos presente");
    assert.ok(certs[0].confidence < 1);

    // um veredito unknown nunca vira certificado
    const unknown = confirmTripleOrphan([{ nodeId: "svc:X", type: "SERVICE", label: "X", staticConfidence: 0.7, staticReasons: [] }], { runtimeCoveragePresent: false });
    assert.equal(issueDeathCertificates(unknown).length, 0);
    assert.equal(issueDeathCertificate(unknown.unknownNoRuntime[0]), null);
  });
});

describe("death-certificate — recibo verificável e determinístico", () => {
  it("verifyDeathCertificate aceita o certificado íntegro", () => {
    const cert = issueDeathCertificates(confirmedReport())[0];
    assert.equal(verifyDeathCertificate(cert), true);
  });

  it("recibo é determinístico: mesmo corpo ⇒ mesmo hash (issuedAt não entra)", () => {
    const a = issueDeathCertificate(confirmedReport().confirmed[0], { issuedAt: new Date("2020-01-01T00:00:00Z") })!;
    const b = issueDeathCertificate(confirmedReport().confirmed[0], { issuedAt: new Date("2026-10-08T12:00:00Z") })!;
    assert.equal(a.receipt.contentHash, b.receipt.contentHash, "issuedAt é metadado fora do recibo");
    assert.notEqual(a.issuedAt, b.issuedAt);
  });

  it("1 byte alterado no corpo invalida o recibo", () => {
    const cert = issueDeathCertificates(confirmedReport())[0];
    const tampered = { ...cert, label: "OutroNome" };
    assert.equal(verifyDeathCertificate(tampered), false);
    const tamperedConf = { ...cert, confidence: 0.99 };
    assert.equal(verifyDeathCertificate(tamperedConf), false);
  });

  it("certificado malformado → verify retorna false, nunca lança", () => {
    assert.equal(verifyDeathCertificate(null), false);
    assert.equal(verifyDeathCertificate(undefined), false);
    assert.equal(verifyDeathCertificate({ verdict: "dead-confirmed" } as never), false);
  });
});

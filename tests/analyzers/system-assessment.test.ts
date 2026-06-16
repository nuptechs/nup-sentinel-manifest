// ─────────────────────────────────────────────
// system-assessment — unit tests (ADR-070)
//
// Dossiê: agrega superfície + sobreposição + incompletude num relatório único.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSystemAssessment, renderSystemAssessmentMarkdown } from "../../server/analyzers/system-assessment.ts";

const ep = (path: string, entitiesTouched: string[] = []) => ({ path, entitiesTouched });

const MANIFEST = {
  impactEndpoints: [
    ep("/easynup/createContract.v1", ["Contract"]),
    ep("/easynup/importContract.v1", ["Contract"]),
    ep("/easynup/findContract.v1", ["Contract"]),
    ep("/easynup/createAuditEvent.v1", ["AuditEvent"]), // escrita sem leitura
    ep("/easynup/health.v1", []), // não toca entidade
  ],
  adrIndex: [{ id: "ADR-063" }, { id: "ADR-064" }],
};

describe("buildSystemAssessment", () => {
  it("agrega superfície, sinais e os relatórios", () => {
    const a = buildSystemAssessment(MANIFEST);
    assert.equal(a.surface.endpoints, 5);
    assert.equal(a.surface.endpointsTouchingEntity, 4);
    assert.equal(a.surface.entitiesTouched, 2); // Contract, AuditEvent
    assert.equal(a.surface.adrsIndexed, 2);
    // overlap: create+import Contract = 1 grupo de escrita
    assert.equal(a.signals.overlapWrites, 1);
    // lifecycle: AuditEvent escrito sem leitura = 1 alto
    assert.equal(a.signals.lifecycleHigh, 1);
  });

  it("manifest vazio → tudo zero, não estoura", () => {
    const a = buildSystemAssessment({});
    assert.equal(a.surface.endpoints, 0);
    assert.equal(a.signals.overlapWrites, 0);
    assert.equal(a.signals.lifecycleHigh, 0);
  });
});

describe("renderSystemAssessmentMarkdown", () => {
  it("renderiza manchete + seções com os sinais", () => {
    const md = renderSystemAssessmentMarkdown(buildSystemAssessment(MANIFEST), { projectName: "easynup" });
    assert.match(md, /# Dossiê de Avaliação do Sistema/);
    assert.match(md, /\*\*Sistema:\*\* easynup/);
    assert.match(md, /Sinais acionáveis:\*\* 2/);
    assert.match(md, /CREATE `contract`/);
    assert.match(md, /\*\*AuditEvent\*\*/);
    assert.match(md, /ADRs indexadas:\*\* 2/);
  });

  it("sistema limpo → seções dizem honestamente que está OK", () => {
    const clean = { impactEndpoints: [ep("/easynup/findContract.v1", ["Contract"])] };
    const md = renderSystemAssessmentMarkdown(buildSystemAssessment(clean));
    assert.match(md, /Nenhuma sobreposição de escrita/);
    assert.match(md, /Nenhuma entidade escrita sem leitura própria/);
  });
});

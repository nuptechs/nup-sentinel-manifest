import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFactSheet, checkClaim } from "../../server/analyzers/fact-sheet.ts";

const N = (id: string, type: string, extra: any = {}) => ({ id, type, ...extra });
const E = (a: string, b: string, t = "CALLS") => ({ fromNode: a, toNode: b, relationType: t });

function graph() {
  return {
    inventory: { routedPages: 143, vueComponents: 238, composableFns: 236 },
    nodes: [
      N("wsv1:POST:/easynup/findContract.v1", "CONTROLLER"),
      N("CONTROLLER:a.FindContractWsV1.handle()", "CONTROLLER"),
      N("SERVICE:a.ContractService.find()", "SERVICE"),
      N("ENTITY:a.Contract", "ENTITY", { className: "Contract", metadata: { sensitiveFields: ["cpf"] } }),
      N("SERVICE:a.Orphan.x()", "SERVICE"), // isolado injustificado
      N("SERVICE:a.Cron.tick()", "SERVICE", { metadata: { entryPoint: "Scheduled" } }), // isolado JUSTIFICADO
    ],
    edges: [
      E("wsv1:POST:/easynup/findContract.v1", "CONTROLLER:a.FindContractWsV1.handle()"),
      E("CONTROLLER:a.FindContractWsV1.handle()", "SERVICE:a.ContractService.find()"),
      E("SERVICE:a.ContractService.find()", "ENTITY:a.Contract", "READS_ENTITY"),
    ],
  };
}

describe("buildFactSheet — fonte-da-verdade canônica (Obra 4)", () => {
  it("conta camadas, proveniência com frescor, inventário e hub sensível", () => {
    const now = Date.parse("2026-08-01T12:00:00Z");
    const s = buildFactSheet(graph(), { analysisRunId: 70, snapshotAt: "2026-08-01T11:59:00Z", now });
    assert.equal(s.provenance.analysisRunId, 70);
    assert.equal(s.provenance.freshnessSeconds, 60, "60s desde o snapshot");
    assert.equal(s.layers.ENDPOINT, 1);
    assert.equal(s.layers.CONTROLLER, 1);
    assert.equal(s.layers.SERVICE, 3);
    assert.equal(s.layers.ENTITY, 1);
    assert.equal((s.inventory as any).routedPages, 143);
    assert.equal(s.topHubs[0].id, "Contract");
    assert.equal(s.topHubs[0].sensitive, true);
    assert.equal(s.isolatedInjustified, 1, "Orphan conta; Cron (entryPoint) NÃO");
    assert.equal(s.totals.nodes, 6);
  });

  it("checkClaim CORRIGE o agente: bate/não-bate com delta e proveniência", () => {
    const s = buildFactSheet(graph(), { analysisRunId: 70, snapshotAt: "2026-08-01T11:59:00Z", now: Date.parse("2026-08-01T12:00:00Z") });
    const ok = checkClaim(s, "inventory.routedPages", 143);
    assert.equal(ok.matches, true); assert.equal(ok.delta, 0);
    const wrong = checkClaim(s, "inventory.routedPages", 301); // o número inflado que o agente daria
    assert.equal(wrong.matches, false);
    assert.equal(wrong.canonical, 143);
    assert.equal(wrong.delta, 158, "expõe o exagero do agente");
    assert.equal(wrong.provenance.analysisRunId, 70, "resposta vem carimbada");
    const unknown = checkClaim(s, "layers.INEXISTENTE", 5);
    assert.equal(unknown.canonical, null, "métrica desconhecida = null, não finge");
    assert.equal(unknown.matches, false);
  });
});

// ─────────────────────────────────────────────
// ADR-0015 Onda 0 — harness anti-regressão (gates G1/G2/G3).
//
// G1 (fixture): o snapshot do pipeline sobre o fixture mini-easynup é
//     comparado byte-a-byte com o golden versionado. QUALQUER mudança de
//     comportamento (endpoint que some, permissão que se perde, entidade
//     sem campo, resolução que muda) quebra aqui — e só passa de novo
//     regenerando o golden DELIBERADAMENTE no mesmo PR, com justificativa.
//     ⚠️ Regenerar: npx tsx -e "…runPipelineSlice… writeFileSync(golden)"
//     (receita no header de pipeline-slice.ts). Regenerar para "fazer o CI
//     passar" sem explicar o diff no PR = violação do gate.
//
// G2 (flags OFF = byte-a-byte): flags multistack default OFF; setar as
//     envs HOJE não muda nada (nada as consome ainda). Quando a Onda 1
//     ligar comportamento nelas, o teste de flags-ON vira SUPERSET (G3)
//     — atualização deliberada, nunca silenciosa.
//
// Canários (provas do superset G3 na Onda 1) — ver mini-easynup.fixture.ts:
//     C1: rota Express `/webhooks/inbound/:id` NÃO é endpoint hoje.
//     C2: GET via queryKey (rest-express) NÃO é interação hoje.
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runPipelineSlice } from "./pipeline-slice.ts";
import { MINI_EASYNUP } from "./mini-easynup.fixture.ts";
import { readMultistackFlags } from "../../server/config/multistack.ts";

const GOLDEN_PATH = join(import.meta.dirname, "baseline-fixture.golden.json");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));

describe("ADR-0015 G1 — golden do fixture mini-easynup (baseline congelado)", () => {
  it("snapshot do pipeline == golden versionado (byte-a-byte)", () => {
    const snap = runPipelineSlice(MINI_EASYNUP);
    assert.deepEqual(
      snap,
      golden,
      "Snapshot divergiu do golden. Se a mudança é INTENCIONAL, regenere o golden no MESMO PR e explique o diff (G1); se não é, você regrediu o pipeline.",
    );
  });

  it("invariantes legíveis do baseline (falha nomeada, não só diff gigante)", () => {
    const snap = runPipelineSlice(MINI_EASYNUP);
    // Superfície WsV1: updateContract sobrevive como entry de API com permissão.
    const upd = snap.endpoints.find((e) => e.endpoint === "/easynup/updateContract.v1");
    assert.ok(upd, "endpoint WsV1 /easynup/updateContract.v1 sumiu do catálogo");
    assert.deepEqual(upd!.requiredRoles, ["UPDATE_CONTRACT"], "permissão @HasPermission se perdeu");
    assert.deepEqual(upd!.entitiesTouched, ["Contract"], "vínculo endpoint→entidade se perdeu");
    // Entidade JPA com campos.
    assert.deepEqual(snap.graph.entities, ["Contract"], "entidade @Entity sumiu do grafo");
    // Interação da tela resolve pro WsV1 (find) — e o dedup (método, endpoint)
    // do connectGraph faz a entry de tela representar o endpoint.
    const load = snap.screens.find((s) => s.interaction === "loadContracts");
    assert.ok(load?.resolved, "fetch /easynup/findContracts.v1 deixou de resolver pro backend");
    // Prefixo de gateway segue extraído e cobrindo a chamada /webhooks/*.
    assert.deepEqual(snap.gatewayPrefixes, ["/webhooks"], "prefixo app.use('/webhooks') se perdeu");
    assert.equal(snap.totals.coveredByGatewayPrefix, 1, "auto-supressão por prefixo mudou");
    assert.equal(snap.architecture.type, "WS_OPERATION_BASED", "detecção de arquitetura WsV1 mudou");
  });
});

describe("ADR-0015 — canários da Onda 1 (estado ATUAL: invisíveis; Onda 1 vira superset G3)", () => {
  it("C1: rota Express /webhooks/inbound/:id NÃO é endpoint hoje (só o prefixo existe)", () => {
    const snap = runPipelineSlice(MINI_EASYNUP);
    const expressRoute = snap.endpoints.find((e) => e.endpoint?.includes("/webhooks/inbound"));
    assert.equal(
      expressRoute,
      undefined,
      "Rota Express virou endpoint — isso é a Onda 1 (D2). Atualize este teste DELIBERADAMENTE para asserção de superset (G3), junto com o golden.",
    );
  });

  it("C2: GET via queryKey (rest-express) NÃO é interação hoje", () => {
    const snap = runPipelineSlice(MINI_EASYNUP);
    // As 3 interações vêm dos fetch(); a useQuery({queryKey:[...]}) é invisível.
    assert.equal(
      snap.totals.interactions,
      3,
      "Contagem de interações mudou — se a captura queryKey ligou (Onda 1 D6), atualize para asserção de superset (G3).",
    );
  });
});

describe("ADR-0015 Onda 0 — sensibilidade do harness (1º teste do DoD)", () => {
  it("derrubar 1 endpoint (remover o WsV1 do update) ⇒ snapshot ≠ golden (CI ficaria vermelho)", () => {
    const sabotaged = MINI_EASYNUP.filter((f) => !f.filePath.includes("UpdateContractWsV1"));
    const snap = runPipelineSlice(sabotaged);
    assert.notDeepEqual(
      snap,
      golden,
      "Harness INSENSÍVEL: remover um endpoint não mudou o snapshot — o gate G1 não protege nada.",
    );
  });

  it("perder a permissão do endpoint ⇒ snapshot ≠ golden", () => {
    const sabotaged = MINI_EASYNUP.map((f) =>
      f.filePath.includes("UpdateContractWsV1")
        ? { ...f, content: f.content.replace("@HasPermission(P.UPDATE_CONTRACT)\n", "") }
        : f,
    );
    const snap = runPipelineSlice(sabotaged);
    assert.notDeepEqual(
      snap,
      golden,
      "Harness INSENSÍVEL: remover @HasPermission não mudou o snapshot — regressão de permissão passaria em silêncio.",
    );
  });
});

describe("ADR-0015 G2 — flags multistack (default OFF, byte-a-byte)", () => {
  it("sem env ⇒ tudo OFF", () => {
    assert.deepEqual(readMultistackFlags({}), {
      nodeBackend: false,
      frontendHttpTemplate: false,
    });
  });

  it("parsing: 1/true/on/yes ligam (case-insensitive); resto não", () => {
    for (const v of ["1", "true", "TRUE", "on", "yes", " On "]) {
      assert.equal(readMultistackFlags({ MANIFEST_MULTISTACK_NODE: v }).nodeBackend, true, `"${v}" deveria ligar`);
    }
    for (const v of ["0", "false", "off", "no", "", "  ", "banana"]) {
      assert.equal(readMultistackFlags({ MANIFEST_MULTISTACK_NODE: v }).nodeBackend, false, `"${v}" NÃO deveria ligar`);
    }
    assert.equal(
      readMultistackFlags({ MANIFEST_MULTISTACK_HTTP_TEMPLATE: "true" }).frontendHttpTemplate,
      true,
    );
  });

  it("flags setadas HOJE não mudam o snapshot (nada as consome ainda — contrato G2/G3)", () => {
    process.env.MANIFEST_MULTISTACK_NODE = "1";
    process.env.MANIFEST_MULTISTACK_HTTP_TEMPLATE = "1";
    try {
      const snap = runPipelineSlice(MINI_EASYNUP);
      assert.deepEqual(
        snap,
        golden,
        "Flag multistack mudou o pipeline SEM atualização deliberada deste contrato. Onda 1: substitua esta asserção por superset (G3) explícito.",
      );
    } finally {
      delete process.env.MANIFEST_MULTISTACK_NODE;
      delete process.env.MANIFEST_MULTISTACK_HTTP_TEMPLATE;
    }
  });
});

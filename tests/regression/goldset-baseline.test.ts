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

describe("ADR-0015 — canários da Onda 1 com as flags OFF (invisíveis; ON = superset G3)", () => {
  it("C1: rota Express /webhooks/inbound/:id NÃO é endpoint com nodeBackend OFF (só o prefixo existe)", () => {
    // Sem env ⇒ flag OFF ⇒ o parser de rotas Express não roda. O gate G3 abaixo
    // prova o outro lado (flag ON ⇒ vira endpoint como superset estrito).
    const snap = runPipelineSlice(MINI_EASYNUP);
    const expressRoute = snap.endpoints.find((e) => e.endpoint?.includes("/webhooks/inbound"));
    assert.equal(
      expressRoute,
      undefined,
      "Rota Express virou endpoint com a flag OFF — isso viola o contrato G2 (OFF = byte-a-byte). O superset é só com MANIFEST_MULTISTACK_NODE ligado (ver G3).",
    );
  });

  it("C2: GET via queryKey (rest-express) NÃO é interação com frontendHttpTemplate OFF", () => {
    // Sem env ⇒ flag OFF ⇒ a useQuery({queryKey:[...]}) segue invisível; as 3
    // interações vêm dos fetch(). O gate G3 abaixo prova o lado ON (vira interação).
    const snap = runPipelineSlice(MINI_EASYNUP);
    assert.equal(
      snap.totals.interactions,
      3,
      "queryKey virou interação com a flag OFF — viola o contrato G2. O superset é só com MANIFEST_MULTISTACK_HTTP_TEMPLATE ligado (ver G3).",
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

  it("cada flag é independente: nodeBackend OFF + só HTTP_TEMPLATE ON não mexe nos endpoints", () => {
    // Isola o efeito do D6: com só a flag de frontend ligada, a superfície de
    // ENDPOINTS (lado backend) segue idêntica ao baseline — o D6 só toca telas.
    process.env.MANIFEST_MULTISTACK_HTTP_TEMPLATE = "1";
    try {
      const snap = runPipelineSlice(MINI_EASYNUP);
      assert.deepEqual(snap.endpoints, golden.endpoints, "D6 (frontend) não deveria alterar endpoints");
      assert.deepEqual(snap.graph, golden.graph);
      assert.deepEqual(snap.architecture, golden.architecture);
    } finally {
      delete process.env.MANIFEST_MULTISTACK_HTTP_TEMPLATE;
    }
  });
});

describe("ADR-0015 G3 — MANIFEST_MULTISTACK_HTTP_TEMPLATE ON ⇒ superset estrito (Onda 1 D6: rest-express)", () => {
  it("C2: useQuery({queryKey:['/easynup/findContracts.v1']}) vira interação GET resolvida", () => {
    process.env.MANIFEST_MULTISTACK_HTTP_TEMPLATE = "1";
    try {
      const snap = runPipelineSlice(MINI_EASYNUP);

      // Superset estrito de interações: +1 (a queryKey), nada some.
      assert.equal(
        snap.totals.interactions,
        golden.totals.interactions + 1,
        "esperado exatamente 1 interação nova (o canário C2 via queryKey)",
      );
      for (const g of golden.screens) {
        const still = snap.screens.find(
          (s) => s.screen === g.screen && s.interaction === g.interaction && s.endpoint === g.endpoint,
        );
        assert.ok(still, `interação do baseline sumiu com a flag ON: ${g.interaction}`);
        assert.deepEqual(still, g, `interação do baseline mudou com a flag ON: ${g.interaction}`);
      }

      // O canário C2 entrou como HTTP resolvida pro WsV1 de findContracts.
      const c2 = snap.screens.find((s) => s.interaction === "contractsQuery");
      assert.ok(c2, "C2: useQuery(queryKey) NÃO virou interação com a flag ON");
      assert.equal(c2!.endpoint, "/easynup/findContracts.v1", "C2: URL do queryKey se perdeu");
      assert.equal(c2!.httpMethod, "GET", "C2: queryKey deveria ser GET (leitura)");
      assert.equal(c2!.resolved, true, "C2: interação do queryKey não resolveu pro backend WsV1");

      // Superset limpo: endpoints/entidades/arquitetura intactos (D6 só toca telas).
      assert.deepEqual(snap.endpoints, golden.endpoints, "D6 não deveria alterar endpoints");
      assert.deepEqual(snap.graph, golden.graph, "D6 não deveria alterar o grafo");
      assert.deepEqual(snap.architecture, golden.architecture, "D6 não deveria alterar a arquitetura");
    } finally {
      delete process.env.MANIFEST_MULTISTACK_HTTP_TEMPLATE;
    }
  });
});

describe("ADR-0015 G3 — MANIFEST_MULTISTACK_NODE ON ⇒ superset estrito (Onda 1 D1: rotas Express)", () => {
  it("nada do baseline some com a flag ON; só ENTRA endpoint novo", () => {
    process.env.MANIFEST_MULTISTACK_NODE = "1";
    try {
      const snap = runPipelineSlice(MINI_EASYNUP);

      // (a) todo endpoint do golden continua presente e IDÊNTICO (superset, não mutação).
      for (const g of golden.endpoints) {
        const still = snap.endpoints.find(
          (e) => e.endpoint === g.endpoint && e.httpMethod === g.httpMethod,
        );
        assert.ok(still, `endpoint do baseline sumiu com a flag ON: ${g.httpMethod} ${g.endpoint}`);
        assert.deepEqual(still, g, `endpoint do baseline mudou com a flag ON (deveria ser superset): ${g.endpoint}`);
      }

      // (b) telas, entidades, arquitetura, inconsistências e cobertura de gateway
      //     inalteradas — o balde node-backend só ADICIONA superfície de API.
      assert.deepEqual(snap.screens, golden.screens, "flag node-backend mexeu nas telas (não é superset limpo)");
      assert.deepEqual(snap.graph, golden.graph, "flag node-backend mexeu no grafo Java");
      assert.deepEqual(snap.architecture, golden.architecture, "flag node-backend mudou a detecção de arquitetura");
      assert.deepEqual(snap.inconsistencies, golden.inconsistencies, "flag node-backend introduziu inconsistência");
      assert.equal(
        snap.totals.coveredByGatewayPrefix,
        golden.totals.coveredByGatewayPrefix,
        "auto-supressão por prefixo de gateway mudou",
      );
    } finally {
      delete process.env.MANIFEST_MULTISTACK_NODE;
    }
  });

  it("C1 vira endpoint GET /webhooks/inbound/:id com a permissão do middleware (requiredRoles)", () => {
    process.env.MANIFEST_MULTISTACK_NODE = "1";
    try {
      const snap = runPipelineSlice(MINI_EASYNUP);

      const c1 = snap.endpoints.find((e) => e.endpoint === "/webhooks/inbound/:id");
      assert.ok(c1, "C1: rota Express /webhooks/inbound/:id NÃO virou endpoint com a flag ON");
      assert.equal(c1!.httpMethod, "GET", "C1: método HTTP errado (esperado GET)");
      assert.deepEqual(
        c1!.requiredRoles,
        ["webhooks.read"],
        "C1: permissão do middleware requirePermission('webhooks.read') se perdeu",
      );
      assert.equal(c1!.technicalOperation, "READ", "C1: operação técnica derivada do verbo mudou");
      // D4/D5: o handler faz db.select().from(webhookEvents) ⇒ liga à tabela Drizzle.
      assert.deepEqual(
        c1!.entitiesTouched,
        ["webhook_event"],
        "C1/C3: rota Express deixou de ligar à entidade Drizzle que o handler lê",
      );

      // Superset estrito: exatamente +1 endpoint / +1 catalog entry, o canário C1.
      assert.equal(
        snap.endpoints.length,
        golden.endpoints.length + 1,
        "esperado exatamente 1 endpoint novo (o canário C1)",
      );
      assert.equal(snap.totals.endpointEntries, golden.totals.endpointEntries + 1);
      assert.equal(snap.totals.catalogEntries, golden.totals.catalogEntries + 1);
    } finally {
      delete process.env.MANIFEST_MULTISTACK_NODE;
    }
  });
});

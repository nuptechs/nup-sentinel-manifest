// ─────────────────────────────────────────────
// Fixture "mini-easynup" — ADR-0015 Onda 0 (harness anti-regressão).
//
// Projeto sintético mínimo no formato que o Manifest cobre HOJE
// (Vue SPA + Spring WsV1 + gateway Express por prefixo). É a base do
// golden snapshot: qualquer mudança de comportamento do pipeline sobre
// este fixture quebra tests/regression/goldset-baseline.test.ts até ser
// deliberadamente re-aprovada (regenerando o golden no MESMO PR).
//
// CANÁRIOS PLANTADOS (viram prova do gate G3/superset na Onda 1):
//  1. `services/gateway/src/app.ts` tem `router.get('/inbound/:id', requirePermission(...))`
//     — HOJE invisível (só o prefixo `app.use('/webhooks')` é extraído).
//     Quando MANIFEST_MULTISTACK_NODE ligar o parser de rotas Express,
//     isso DEVE virar endpoint novo (superset) sem sumir nada do resto.
//  2. `Contracts.vue` tem um GET via useQuery({ queryKey: ['/easynup/...'] })
//     — HOJE invisível (URL vive no queryKey; padrão rest-express).
//     Quando MANIFEST_MULTISTACK_HTTP_TEMPLATE ligar, DEVE virar interação.
// ─────────────────────────────────────────────

export interface FixtureFile {
  filePath: string;
  content: string;
}

export const MINI_EASYNUP: FixtureFile[] = [
  // ── Backend Java (WsV1 por convenção de path + entidade JPA) ──
  {
    filePath:
      "src/main/java/easynup/services/web/contracts/findContracts/v1/FindContractsWsV1.java",
    content: `package easynup.services.web.contracts.findContracts.v1;

import easynup.security.HasPermission;
import easynup.security.P;

@HasPermission(P.LIST_CONTRACTS)
public class FindContractsWsV1 {
    private final FindContractsServiceV1 service;

    public FindContractsReturnV1 execute(FindContractsParamsV1 params) {
        return service.find(params);
    }
}
`,
  },
  {
    filePath:
      "src/main/java/easynup/services/web/contracts/updateContract/v1/UpdateContractWsV1.java",
    content: `package easynup.services.web.contracts.updateContract.v1;

import easynup.security.HasPermission;
import easynup.security.P;

@HasPermission(P.UPDATE_CONTRACT)
public class UpdateContractWsV1 {
    private final UpdateContractServiceV1 service;

    public UpdateContractReturnV1 execute(UpdateContractParamsV1 params) {
        return service.update(params);
    }
}
`,
  },
  {
    filePath: "src/main/java/easynup/persistence/entities/Contract.java",
    content: `package easynup.persistence.entities;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "contract")
public class Contract {

    @Id
    private Long id;

    @Column(name = "monthly_value")
    private java.math.BigDecimal monthlyValue;

    @Column(name = "supplier_document")
    private String supplierCpf;

    private String name;
}
`,
  },

  // ── Frontend Vue (SPA que fala com o WsV1 e com o gateway) ──
  {
    filePath: "frontend/src/pages/Contracts.vue",
    content: `<template>
  <div>
    <button @click="loadContracts">Carregar</button>
    <button @click="saveNote">Salvar nota</button>
    <button @click="pingWebhook">Ping webhook</button>
  </div>
</template>

<script setup lang="ts">
import { useQuery } from "@tanstack/vue-query";

// CANÁRIO 2 (Onda 1 D6): GET no padrão rest-express — URL dentro do queryKey.
// Hoje o http-service-map NÃO enxerga isto (nenhuma chamada HTTP no callsite).
const contractsQuery = useQuery({ queryKey: ["/easynup/findContracts.v1"] });

async function loadContracts() {
  const res = await fetch("/easynup/findContracts.v1", { method: "GET" });
  return res.json();
}

// Chamada /easynup/* SEM WsV1 correspondente no backend do fixture.
// Comportamento ATUAL (pós node-match, PR #44): resolve por convenção
// (mappedBackendNode sintético) e NÃO vira inconsistência — o golden
// trava exatamente isso; se a política de matching mudar, o snapshot acusa.
async function saveNote() {
  await fetch("/easynup/createContractNote.v1", { method: "POST" });
}

// Coberta pelo prefixo do gateway (app.use('/webhooks')) → auto-supressão.
async function pingWebhook() {
  await fetch("/webhooks/inbound/test", { method: "POST" });
}
</script>
`,
  },

  // ── Gateway Express (hoje: só prefixo; rotas invisíveis) ──
  {
    filePath: "services/gateway/src/app.ts",
    content: `import express from "express";
import { requirePermission } from "./middleware/auth";

const app = express();
const webhookRouter = express.Router();

// CANÁRIO 1 (Onda 1 D2/D3): rota Express com middleware de permissão.
// Hoje o Manifest NÃO a enxerga como endpoint (só extrai o prefixo do
// app.use abaixo). Com MANIFEST_MULTISTACK_NODE, deve virar endpoint
// POST/GET real com requiredRoles=["webhooks.read"] — SUPERSET (G3).
webhookRouter.get("/inbound/:id", requirePermission("webhooks.read"), (req, res) => {
  res.json({ ok: true });
});

app.use("/webhooks", webhookRouter);

export { app };
`,
  },
];

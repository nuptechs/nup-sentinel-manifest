# Gold Set — easynup (régua fixa de avaliação do Manifest)

> Régua **fixa** contra a qual qualquer versão do Manifest (e do combo grafo+agente+runtime)
> é medida. Substitui "achei que ficou bom" por número reproduzível. Cada gap aqui foi
> **medido no run ao vivo** do Manifest sobre o código real do easynup, não estimado.

## Por que existe

A excelência de um extrator de estrutura/relações não se prova por demo — prova-se medindo
**precisão e cobertura por tipo de aresta** contra um ground truth feito à mão. Este arquivo é
esse ground truth: 5 fluxos reais do easynup, rastreados com `arquivo:linha`, escolhidos para
**estressar as diferenças** entre o que análise estática por convenção resolve e o que não resolve.

## Como reproduzir a medição

1. Subir um Postgres e o servidor do Manifest (`DATABASE_URL`, `PORT=5100`, `OPENAI_API_KEY` dummy,
   `JAVA_ANALYZER_XMX=6g`).
2. `POST /api/analyze` com os arquivos-fonte do easynup (`src/main/java/**`, `frontend/src/**`,
   `services/gateway/src/**`), `options.projectName="easynup-FULL"`, `format="manifest"`.
3. Medir a resposta com os critérios abaixo. ⚠️ As chaves do shape importam: campos de entidade
   estão em **`fieldMetadata`** (não `fields`); permissão de endpoint em **`requiredRoles`**.
4. **Gate anti-regressão (ADR-0015 G1):** despeje os totais medidos num JSON plano
   (`{"totalEndpoints":…,"totalEntities":…,…,"fakeEndpoints":0}`) e rode
   `npx tsx script/check-goldset-baseline.ts <metricas.json>` — compara contra os **pisos
   congelados** em `tests/regression/baseline-easynup-full.json` (exit 1 em qualquer queda;
   fail-closed em métrica ausente). Piso só sobe (melhoria travada no mesmo PR); baixar piso =
   regressão, proibido sem ADR. Complemento contínuo que roda em TODO `npm test`/CI: o golden
   de fixture (`tests/regression/goldset-baseline.test.ts`).

## Os 5 fluxos (ground truth)

| # | Fluxo | Cadeia (resumo, arquivo:linha no easynup) | Estressa |
|---|---|---|---|
| 1 | CRUD Contrato | `useContractForm.ts:61` → proxy `/easynup/*` → `UpdateContractWsV1` → `UpdateContractServiceV1:164-169` → `Contract` → `contract` (migration 0339) | convenção (força) |
| 2 | Dispatch de regra | `RuleEngine.findExecutor:417` (`stream().filter(supports())`) → executor concreto por `getActionType()` | dispatch dinâmico (DI) |
| 3 | Glosa SLA por evento | `UpdateSlaMeasurementServiceV1:137` `publishEvent` → `@TransactionalEventListener` `SlaMeasurementApprovedListener:35` → `SlaPenaltyRecord` | evento Spring |
| 4 | Gateway não-convenção | `AiImportPanel.vue:988` `/api/contract-wizard/extract-async` → BullMQ → `extraction-core.js:177` `import()` → `risk-analyzer` (em Node) | handler Node + async |
| 5 | Lineage de coluna | `monthlyValue` (DTO) → setter `:164` → `@Column(name="monthly_value")` → coluna | granularidade de coluna |

## Baseline medido (Manifest, repo completo · 5021 arquivos · ~46s)

Totais: **1330 endpoints · 214 entidades · 3540 catalog entries · 4626 nós / 4127 arestas**.

| Capacidade | Estado medido | Veredito |
|---|---|---|
| Endpoints WsV1 + entidade (convenção) | 1330 endpoints ligados a entidade | 🟢 **força real, escala** |
| Inventário de campos por entidade | **118/118 entidades com `fieldMetadata`** (Contract: 117 campos, nome+tipo+isSensitive) | 🟢 **já funciona** |
| Cadeias de chamada (com classpath completo) | profundidade até 5 | 🟢 ok (rasura no recorte era artefato de classpath) |
| **Permissão por endpoint** | **12/696 (1.7%)** — `@HasPermission(P.X)` não lido | 🔴 gap (este PR fecha) |
| Nome da coluna no banco (`monthlyValue`→`monthly_value`) | **2119/2119 campos (100%)** via `@Column`+snake_case | 🟢 **fechado (Fase 1)** |
| Lineage **por-escrita** (endpoint→coluna específica) | entitiesTouched é nível-entidade | 🔴 gap (precisa de data-flow) |
| Dispatch (regra→executor), mapa de código | **22/23 resolvido** via getActionType (det.) + 1 órfão flagado | 🟢 **mapa fechado (Fase 3)** · runtime real = Fase 4 |
| Wiring de evento (publish→listener) | **7 listeners, 11 triggerTypes** mapeados (det.); 4 catch-all flagados | 🟢 **mapa fechado (Fase 3)** · routing dinâmico = runtime/DB |
| Endpoints falsos (`/api/audit360/{param}{param}`) | **0** (sanitizados) | 🟢 **fechado (Fase 1)** |

### Correção honesta de medição (registrada para não se repetir)

Uma medição anterior reportou **"0/118 entidades com campos"** e concluiu, errado, que o lineage de
coluna era um **limite arquitetural total**. Era **bug do script de medição**: checou a chave `fields`
em vez de `fieldMetadata`. Reverificado: o inventário de campos **já funciona** (118/118). O gap real
de coluna é **menor e específico**: falta (a) o **nome da coluna no banco** e (b) o **lineage por-escrita**.
Lição: a régua só vale se as chaves do shape forem verificadas — está cravado em "Como reproduzir".

### Separação herdada: artefato de classpath × limite de arquitetura (provado)

Rodar o **recorte** (35 arquivos) deu 49 `UnsolvedSymbol` e cadeias rasas; rodar o **repo completo**
recuperou as cadeias (profundidade 5). Logo cadeia-rasa = **artefato de classpath**, não fraqueza.
Já permissão, dispatch, evento e lineage-por-escrita **permaneceram** com tudo carregado = **arquitetural**.
Fonte externa confirma que dispatch/DI/evento são duros até para SOTA (Jasmine ASE 2022; over-aproximação
de polimorfismo no CodeQL e Joern) → esses gaps são do **agente + runtime**, não de mais estática.

## Ganho provado neste PR (Fase 1 — permissões)

`extractWsV1Roles` lê `@HasPermission(P.X)` + `@IsAuthenticated` da convenção cloudsupport
(que **não** é `@PreAuthorize`, por isso o engine Java padrão devolvia `[]`).

| Métrica | Antes | Depois |
|---|---|---|
| Endpoints com permissão | **12/696 (1.7%)** | **672/696 (96.6%)** |
| `updateContract.v1` | `[]` | `[UPDATE_CONTRACT, AUTHENTICATED]` |
| `findContract.v1` | `[]` | `[VIEW_CONTRACT, AUTHENTICATED]` |
| `updateSlaMeasurement.v1` | `[]` | `[UPDATE_SLA_MEASUREMENT, AUTHENTICATED]` |

Os ~3.4% restantes são endpoints genuinamente sem guard (público/interno) — não se inventa permissão.

## Roadmap medido contra esta régua (DoD = número moveu aqui)

- **Fase 1**: permissão 1.7%→96.6% ✅ · **nome de coluna 0→100% (2119 campos)** ✅ · **endpoints falsos 1→0** ✅ · (lineage-por-escrita pendente, precisa de data-flow → Fase 5).
- **Fase 2** (iniciada): grafo consultável — `GET /permission-governance` (endpoints sem proteção · por permissão), provado no easynup (671/695 protegidos, 24 expostos visíveis).
- **Fase 2** (cont.): `GET /entity-access` — onde a entidade é lida/escrita (118 entidades, 420 endpoints no easynup; `?entity=Contract` → 3 escrita, 2 leitura). Granularidade entidade; coluna = Fase 5.
- **Fase 2** (cont.): `GET /sensitive-exposure` — endpoints que tocam dado sensível × proteção (none/auth-only/permission). easynup: 188 endpoints sensíveis, 188 protegidos, 0 expostos (auditoria limpa).
- **Fase 3** (em curso, sem LLM até aqui): dispatch regra→executor (`GET /rule-dispatch`, 22/23 + flag órfão `CREATE_DIVERGENCE`) **e** wiring de evento (`GET /event-wiring`, 7 listeners/11 triggerTypes, guarded mapeado + catch-all flagado) resolvidos DETERMINISTICAMENTE. Achado: os gaps "duros" eram mais parseáveis que o previsto. Agente-LLM fica só pro genuinamente não-parseável (routing por motor de regras / JSONB no banco) — provável Fase 4 (runtime) em vez de LLM.
- **Fase 4**: confirmação por runtime (ADR-073) — selo "verificado".
- **Fase 5** (sob demanda): frontend type-resolved + data-flow (Joern) para lineage-por-escrita.

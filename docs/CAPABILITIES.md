# Catálogo de capacidades — NuP Sentinel Manifest

> Estado **real** do código, verificado `arquivo:linha`. Sem promessa do que não existe.
>
> Legenda de status:
> - ✅ **funciona hoje** — o código roda de ponta a ponta no fluxo normal.
> - 🟡 **construído mas depende de configuração/cadastro pra rodar de verdade** — o código existe e está ligado no pipeline, mas só produz efeito sob condição externa (env var, projeto cadastrado, JAR compilado, Sentinel no ar).
> - ⚪ **reservado / stub / parcial** — esqueleto presente, ainda não entrega valor sozinho.

O Manifest é o **módulo de análise estática de auth/schema** da plataforma NuP Sentinel.
Ele analisa um repositório (Java backend + frontend JS/TS/Vue/React/Angular),
monta um grafo de aplicação, cataloga endpoints/permissões/entidades, roda
detectores de segurança e de consistência, e **emite os achados** para o
orquestrador central (`nup-sentinel`) como `Finding v2`.

Além da análise, é também uma **plataforma de manifesto**: gera artefatos a partir do
catálogo (AGENTS.md, OpenAPI, policy-matrix, Keycloak realm, OPA/Rego, bundle NuPIdentity,
relatório de compliance HTML — §1.4), integra com Git/GitHub/GitLab incluindo webhooks e
análise de branch/PR (§6), diferencia snapshots pra detectar drift de permissão (§7),
e expõe tudo via API HTTP (§9), CLI e extensão VS Code.

---

## 1. Análise de código

| Capacidade | Status | Evidência |
|---|---|---|
| Análise sob demanda via HTTP (`POST /api/analyze`, `/api/analyze-zip`, `/api/projects/:id/analyze`) | ✅ | `server/routes.ts:183,280,518` |
| Pipeline de análise em 4 passos (grafo backend → endpoints → frontend → conexão/classificação) | ✅ | `server/pipeline/analysis-pipeline.ts:96` |
| Cache de grafo backend e de interações de frontend por projeto (TTL 30 min, invalida por hash de arquivo) | ✅ | `server/pipeline/analysis-pipeline.ts:76-83,117` |
| **Cron / agendamento de análise** | ⚪ | Não existe. Análise é sempre disparada por requisição. O único `setInterval` (`server/routes.ts:65`) só limpa uploads temporários antigos, não analisa nada. |

### 1.1 Backend Java (motor AST próprio)

| Capacidade | Status | Evidência |
|---|---|---|
| Motor Java AST próprio (JavaParser + symbol solver) rodando como processo JVM irmão | 🟡 | `server/analyzers/backend-java-client.ts:55` sobe `java -jar java-analyzer-engine-1.0.0.jar`; o JAR precisa estar compilado em `java-analyzer-engine/target/` (`backend-java-client.ts:16`). |
| Extração de Controllers / Services / Repositories / Entities + anotações de mapeamento e de segurança | ✅ | `java-analyzer-engine/.../JavaASTAnalyzer.java:30-49` (reconhece `@RestController`, `@*Mapping`, `@PreAuthorize`/`@Secured`/`@RolesAllowed`/`@DenyAll`/`@PermitAll`, `@Entity`/`@Table`/`@Document`) |
| Grafo de aplicação tipado (nós CONTROLLER/SERVICE/REPOSITORY/ENTITY) + impacto por endpoint (cadeia de chamada, entidades tocadas, operações de persistência) | ✅ | `server/analyzers/application-graph.ts:1`; impacto em `analyzeGraphEndpoints` consumido em `analysis-pipeline.ts:298` |
| Detecção de arquitetura (REST_CONTROLLER / WS_OPERATION_BASED / MVC_ACTION_BASED / EXTERNAL_API_GATEWAY) | ✅ | `server/analyzers/architecture-detector.ts:28-52` |

### 1.2 Frontend

| Capacidade | Status | Evidência |
|---|---|---|
| Extração de chamadas de API do frontend (`fetch`, `axios`, `ky`, `got`, `superagent`, `wretch`, Angular HttpClient) | ✅ | `server/analyzers/frontend/http-clients.ts:22,81-83` |
| Reconhecimento do padrão `BaseApiService` / `buildEndpoint`/`buildUrl`/`getUrl`/`getEndpoint` (classe-base que monta URL) | ✅ | `server/analyzers/frontend/http-service-map.ts:246` |
| Registro de `baseURL`/prefixo de API (variáveis e `axios.create({ baseURL })`) pra resolver URLs relativas | ✅ | `server/analyzers/frontend-analyzer.ts:71-120` |
| Resolução de cada chamada do frontend contra um endpoint do backend (`matchUrlToEndpoint` → `mappedBackendNode`) | ✅ | `server/analyzers/frontend-analyzer.ts:257-260`; matcher em `server/analyzers/frontend/utils.ts:345` (match por path, por nome de operação, fallback fuzzy) |
| Classificação da interação (HTTP / UI_ONLY / STATE_ONLY / SERVICE_BRIDGE / EXTERNAL_SERVICE) | ✅ | `server/analyzers/frontend-analyzer.ts:60,236,284,301` |
| Detecção de papéis/guards declarados no frontend (`detectedRoles`, route guards) | ✅ | `server/analyzers/frontend-analyzer.ts:64,405-406` |
| Enriquecimento de catálogo por inferência (estrutura de backend inferida quando o backend não foi analisado) | ✅ | `server/analyzers/frontend-inference-engine.ts`, chamado em `analysis-pipeline.ts:173` |
| Grafo global de chamadas do frontend (resolve cadeia fn→fn entre arquivos/imports + propaga "capacidade HTTP") | ✅ | `server/analyzers/frontend/global-call-graph.ts:1` (`buildGlobalCallGraph`/`propagateHttpCapability`), montado em `frontend-analyzer.ts:181` |
| Grafo de eventos de componente (handler → emit/chamada de serviço) | ✅ | `server/analyzers/frontend/event-graph.ts:1` (`buildComponentEventGraph`), usado em `frontend-analyzer.ts:7` |
| Grafo de fluxo de estado (store/composable → ação que dispara HTTP) | ✅ | `server/analyzers/frontend/state-flow-graph.ts:1` (`buildStateFlowGraph`), montado em `frontend-analyzer.ts:184` |
| Grafo de camadas arquiteturais do frontend | ✅ | `server/analyzers/frontend/architectural-layer-graph.ts:1` (`buildArchitecturalLayerGraph`), usado em `frontend-analyzer.ts:27` |
| Extração de rotas do frontend (Vue Router / React Router / Angular) | ✅ | `server/analyzers/frontend/route-extraction.ts:1` |
| Tabela de símbolos + resolução de HTTP por arquivo (parsers Babel/TS) | ✅ | `server/analyzers/frontend/symbol-table.ts:1`, `http-resolution.ts:1`, `parsers.ts:1`, `file-analyzers.ts:1` |
| Detecção de auth no frontend (interceptors/headers/guards) | ✅ | `server/analyzers/frontend/auth-detection.ts:1` |

> Os grafos de evento/estado/camadas/call-graph são módulos grandes e ligados (`frontend-analyzer.ts:181-184` etc.), mas o que **vira catálogo** hoje é a interação HTTP resolvida (§1.2 linha 1). Os demais grafos enriquecem a análise; o consumo direto deles pelo catálogo final é parcial.

### 1.2-bis Classificação semântica das entradas

| Capacidade | Status | Evidência |
|---|---|---|
| Classificador **determinístico** das entradas do catálogo (operação técnica / criticidade / significado, por regras) — é o que roda no pipeline | ✅ | `server/analyzers/deterministic-classifier.ts:3` (`classifyEntriesDeterministic`), chamado em `analysis-pipeline.ts:331` |
| Classificador **semântico via LLM** (OpenAI) — operação técnica, criticalityScore, suggestedMeaning, em batches de 10 | 🟡 | `server/analyzers/semantic-engine.ts:15` (`classifyEntries`). **Não roda no pipeline normal** — só é acionado sob demanda pela rota `POST /api/enrich-with-llm/:projectId` (`routes.ts:1747`); usa `openai` com `AI_INTEGRATIONS_OPENAI_API_KEY`/`_BASE_URL` (`semantic-engine.ts:4-6`) — sem essas envs, falha. Provider é **OpenAI**, não Anthropic. |

### 1.3 Catálogo & manifesto

| Capacidade | Status | Evidência |
|---|---|---|
| Geração de catálogo (entries) ligando frontend↔backend + classificação determinística | ✅ | `analysis-pipeline.ts:167-173` (graph-connector + deterministic-classifier) |
| Snapshot de manifesto por run (entidades + campos, com cópia-sombra das entidades do grafo) | ✅ | `analysis-pipeline.ts:340-409` |
| Ingestão de catálogo vindo do Codelens (`POST /api/projects/:id/codelens-extraction`) + lookups | ✅ | `server/manifest-lookup.ts:1-30` |
| Detecção de mudança por hash de arquivo (decide o que reanalisar / invalida cache incremental) | ✅ | `server/pipeline/change-detector.ts:37-48` (`computeFileHashes`/`detectChanges`), usado em `analysis-pipeline.ts:118-162` |
| Scanner de repositório (extrai/varre ZIP, classifica tipo de arquivo) | ✅ | `server/analyzers/repository-scanner.ts:23,121` |

---

## 1.4 Geradores de artefato (export do manifesto)

Toda a suíte é gerada a partir do manifesto (`generateManifest`, `manifest-generator.ts:1`) e exposta nas rotas
`POST /api/analyze`, `/api/analyze-zip` e `GET /api/manifest/:projectId?format=...` (`routes.ts:221-266,309-333,1222-1310`).
O `format` aceita: `manifest` (default), `agents-md`, `openapi`, `policy-matrix`, `keycloak-realm`, `opa-rego`, `nupidentity`, `nupidentity-runner`, `compliance-report`, `all`.

| Gerador | Status | Evidência |
|---|---|---|
| Manifesto canônico (entries + entidades/campos) | ✅ | `server/generators/manifest-generator.ts:1` (`generateManifest`) |
| `AGENTS.md` (catálogo legível por IA) | ✅ | `server/generators/agents-md-generator.ts:1` (`generateAgentsMd`) |
| OpenAPI spec (JSON) | ✅ | `server/generators/openapi-generator.ts:1` (`generateOpenAPISpec`) |
| Policy matrix (matriz endpoint × permissão) | ✅ | `server/generators/policy-matrix-generator.ts:1` (`generatePolicyMatrix`) |
| Keycloak realm export (consome findings de segurança) | ✅ | `server/generators/keycloak-realm-generator.ts:1` (`generateKeycloakRealm`) |
| OPA / Rego (bundle ou `policy.rego`) | ✅ | `server/generators/opa-rego-generator.ts:1` (`generateOpaRego`) |
| Bundle NuPIdentity + runner script | ✅ | `server/generators/nupidentity-generator.ts:238,392` (`generateNupidentityBundle`, `generateNupidentityRunnerScript`) |
| Relatório de compliance (HTML, consome manifesto + findings) | ✅ | `server/generators/compliance-report-generator.ts:1` (`generateComplianceReport`) |

---

## 2. Detectores de segurança (omission engine)

`server/security/omission-engine.ts` roda 6 detectores em cima do catálogo já persistido
(`analysis-pipeline.ts:181`). Todos ✅ no código — produzem `SecurityFinding`.

| Detector | Status | Evidência |
|---|---|---|
| `UNPROTECTED_OUTLIER` — endpoint sem proteção enquanto os pares (mesmo método+domínio) são protegidos | ✅ | `omission-engine.ts:164-234` |
| `PRIVILEGE_ESCALATION` — escrita em entidade/campo de privilégio (role/permission/isAdmin…) sem role admin | ✅ | `omission-engine.ts:236-304` |
| `SENSITIVE_DATA_EXPOSURE` — GET sem proteção que expõe campo altamente sensível (password/token/ssn…) | ✅ | `omission-engine.ts:306-350` |
| `INCONSISTENT_PROTECTION` — controller maioritariamente protegido com endpoint mutante desprotegido | ✅ | `omission-engine.ts:352-410` |
| `MISSING_PROTECTION` — endpoint de criticidade alta (≥60) sem nenhuma anotação de segurança | ✅ | `omission-engine.ts:412-438` |
| `COVERAGE_GAP` — métrica de cobertura geral + cobertura baixa por método HTTP | ✅ | `omission-engine.ts:440-494` |
| Métricas de cobertura (por método, por controller, distribuição de roles) | ✅ | `omission-engine.ts:496-551` |
| Resumo de segurança de PR (delta de proteção do PR vs repo) | ✅ | `omission-engine.ts:577` (`generatePRSecuritySummary`) |

---

## 3. Detector frontend↔backend (consistência) — **novo (PR #8)**

| Capacidade | Status | Evidência |
|---|---|---|
| Detector que aponta tela chamando endpoint que o backend **não expõe** (`mappedBackendNode == null` → provável 404 em runtime) | ✅ existe no código | `server/analyzers/frontend-backend-consistency.ts:52` (mergeado no PR #8, `fbcd7ea`) |
| Severidade por impacto: escrita (POST/PUT/PATCH/DELETE) → `high`; leitura (GET) → `medium`; dedup por `(método, url)` | ✅ | `frontend-backend-consistency.ts:71-94` |
| Guarda anti-falso-positivo: só roda quando **houve análise de backend** (`endpointImpacts > 0`); exclui EXTERNAL_SERVICE/SERVICE_BRIDGE/UI_ONLY/STATE_ONLY | ✅ | `analysis-pipeline.ts:217`; categoria filtrada em `frontend-backend-consistency.ts:63` |
| Ligado no pipeline e emitido como `type:inconsistency` ao Sentinel | ✅ | `analysis-pipeline.ts:218-235` → `emitConsistencyFindings` |
| **Rodar de verdade para o EasyNuP (ou qualquer repo real)** | 🟡 | O detector funciona, mas o end-to-end depende de (a) o repo-alvo estar **cadastrado como projeto** — hoje o seed só cria o "Customer Portal (Sample)" (`server/seed.ts:566`) — e (b) o backend Java do alvo ter sido analisado na mesma run (senão o passo é pulado: `analysis-pipeline.ts:238`). |

A classe de bug que ele pega (verificada à mão no EasyNuP): tela chama
`updateUser.v1` / `create/update/deletePermission.v1` / `create/update/delete` de
SLA Categories / Severity quando o backend só tem `find*` — descrita em
`frontend-backend-consistency.ts:14-18`.

---

## 4. Emissão para o orquestrador Sentinel

`server/security/sentinel-emitter.ts` traduz os achados em `Finding v2` e os
envia ao `nup-sentinel` (cria sessão em `/api/sessions`, ingere em `/api/findings/ingest`).

| Capacidade | Status | Evidência |
|---|---|---|
| `emitSecurityFindings` → findings `type:permission_drift` (subtypes mapeados dos 6 detectores) | ✅ código / 🟡 efeito | `sentinel-emitter.ts:146`, subtype map `:61-68` |
| `emitConsistencyFindings` → findings `type:inconsistency` (subtype `missing_backend_endpoint`) | ✅ código / 🟡 efeito | `sentinel-emitter.ts:165,180` (novo no PR #8) |
| Transporte best-effort: Sentinel fora do ar **nunca** quebra a análise (loga e engole) | ✅ | `sentinel-emitter.ts:220,308-312` |
| **Emissão de fato acontecer** | 🟡 | É **no-op** sem as três envs: `SENTINEL_URL`, `SENTINEL_API_KEY`, `SENTINEL_PROJECT_ID` (`sentinel-emitter.ts:231-233`). Opcionais: `SENTINEL_ORG_ID` (tenant), `SENTINEL_TIMEOUT_MS`. Sem elas, retorna `{ skipped: true }` e o pipeline segue normal. |

---

## 5. Persistência, frontend admin e CLI

| Capacidade | Status | Evidência |
|---|---|---|
| Backend Drizzle ORM + Postgres | ✅ | `server/db.ts`, `drizzle.config.ts` |
| Frontend admin React (Vite + Radix UI) | ✅ | `client/`, `vite.config.ts` |
| CLI (`@nuptechs/sentinel-manifest-cli`) com `analyze` / `connect` / `diff` / `manifest` | ✅ | `cli/src/commands/` |
| Seed do banco | 🟡 | `server/seed.ts` cria **apenas** o projeto "Customer Portal (Sample)" (`:566`). Para analisar o EasyNuP (ou outro repo real) é preciso cadastrar o projeto e disparar a análise. |
| Registro OIDC no NuPIdentify (deploy SaaS) | ⚪ | manifesto de cliente em `nupidentity-client-manifest.json` (registro feito fora, no deploy) |
| Extensão VS Code (`analyzeFile`/`analyzeWorkspace`/`analyzeWorkspaceFull`/`showCatalog`/`connectServer`) | ✅ | `vscode-extension/src/extension.ts:35,68,113,168,180`; analisadores local/remoto em `local-analyzer.ts`/`remote-analyzer.ts` |

---

## 6. Integração Git, webhooks e análise de branch/PR

| Capacidade | Status | Evidência |
|---|---|---|
| Provider Git abstrato + factory (GitHub / GitLab) | ✅ | `server/git/git-provider.ts:86` (`createGitProvider`); `GitHubProvider` (`github-provider.ts:13`), `GitLabProvider` (`gitlab-provider.ts:4`) |
| Conectar/desconectar repo, listar branches e PRs (`POST .../git/connect`, `GET .../git/branches`, `GET .../git/pull-requests`, `GET .../git/status`, `DELETE .../git/disconnect`) | 🟡 | `routes.ts:1421,1468,1497,1702,1722` — depende de token Git válido cadastrado no projeto |
| Analisar uma branch específica (`POST .../analyze-branch`) | 🟡 | `routes.ts:1527` — busca arquivos via provider e roda o pipeline |
| Analisar um PR (delta) (`POST .../analyze-pr`) | 🟡 | `routes.ts:1601` (`analyzePRSchema`) |
| Webhook GitHub com verificação HMAC-SHA256 (`POST /api/webhook/github`, header `x-hub-signature-256`) | 🟡 | `routes.ts:1832-1864`; HMAC só valida se `project.webhookSecret` estiver setado (`:1857`) — sem secret, **não verifica assinatura** |
| Webhook GitLab (`POST /api/webhook/gitlab`) | 🟡 | `routes.ts:1886` |
| Configurar webhook do projeto (`POST .../webhook/configure`) | ✅ | `routes.ts:1807` |

## 7. Diff de manifesto (drift entre snapshots)

| Capacidade | Status | Evidência |
|---|---|---|
| Diff entre dois snapshots de run (mudança de permissão/endpoint/entidade) | ✅ | `server/diff/manifest-diff-engine.ts:338` (`diffManifests`) |
| Rota de diff por run (`GET .../diff?runA&runB`) + diff dos 2 últimos (`GET .../diff/latest`) + listar snapshots (`GET .../snapshots`) | 🟡 | `routes.ts:1338,1370,1399` — só funciona para runs que **têm snapshot** (feature posterior ao snapshot; runs antigos retornam 404, `:1352`) |

## 8. Autenticação e API keys

| Capacidade | Status | Evidência |
|---|---|---|
| Auth OIDC (NuPIdentify) via JWT + checagem de permissão/tier | 🟡 | `server/middleware/jwt-auth.ts:64,97,107` (`verifyJWT`/`hasPermission`/`isOIDCConfigured`) — inerte se OIDC não configurado |
| API keys: criar/listar/revogar (`POST/GET/DELETE /api/keys`) com hash + prefixo | ✅ | `routes.ts:126,156,172`; `server/middleware/api-auth.ts:8,12,34` (`hashApiKey`/`generateApiKey`/`apiAuthMiddleware`) |
| Quem-sou-eu (`GET /api/auth/me`) resolvendo OIDC **ou** API key | ✅ | `routes.ts:101-125` |
| Upload em chunks (init/chunk/complete) + ZIP de projeto, com limpeza de uploads temporários antigos | ✅ | `routes.ts:543,582,642,810`; cleanup via `setInterval` (`routes.ts:65`) — **único** timer do sistema, não analisa nada |

## 9. Inventário de rotas HTTP (server/routes.ts)

Todas montadas em `server/routes.ts`. Status do efeito segue as seções acima.

| Método + rota | Linha |
|---|---|
| `GET /api/auth/me` | `:101` |
| `POST /api/keys` · `GET /api/keys` · `DELETE /api/keys/:id` | `:126,156,172` |
| `POST /api/analyze` · `POST /api/analyze-zip` | `:183,280` |
| `GET /api/docs/openapi.json` · `GET /api/docs` | `:345,350` |
| `GET /api/projects/:projectId/security-findings` | `:361` |
| `POST /api/projects/:projectId/codelens-extraction` | `:380` |
| `GET /api/projects/:projectId/lookup` | `:406` |
| `GET /api/stats` | `:435` |
| `GET /api/projects` · `GET /api/projects/:id` · `POST /api/projects` · `DELETE /api/projects/:id` | `:445,455,470,506` |
| `POST /api/projects/:id/analyze` | `:518` |
| `POST /api/uploads/init` · `/:uploadId/chunk` · `/:uploadId/complete` | `:543,582,642` |
| `POST /api/projects/upload-zip` | `:810` |
| `GET /api/analysis-runs/recent` · `GET /api/analysis-runs/:id` | `:1000,1010` |
| `GET /api/catalog-entries/:projectId` · `PATCH /api/catalog-entries/:id` · `.../export` | `:1024,1036,1057` |
| `GET /api/projects/:projectId/schema-fields` | `:1109` |
| `GET /api/manifest/:projectId` (export multi-formato) | `:1211` |
| `GET .../diff` · `.../diff/latest` · `.../snapshots` | `:1338,1370,1399` |
| `POST .../git/connect` · `GET .../git/branches` · `.../git/pull-requests` · `.../git/status` · `DELETE .../git/disconnect` | `:1421,1468,1497,1702,1722` |
| `POST .../analyze-branch` · `.../analyze-pr` | `:1527,1601` |
| `POST /api/enrich-with-llm/:projectId` | `:1747` |
| `POST /api/projects/:id/webhook/configure` | `:1807` |
| `POST /api/webhook/github` · `POST /api/webhook/gitlab` | `:1832,1886` |

---

## Resumo honesto

- A **análise estática** (grafo Java AST, frontend incl. grafos de call/evento/estado/camadas,
  catálogo, 6 detectores de segurança, detector de consistência frontend↔backend) está
  **construída e ligada no pipeline** — ✅ no nível de código. A classificação que roda no
  pipeline é a **determinística**; a classificação por LLM (OpenAI) é opt-in via rota
  `enrich-with-llm` e precisa das envs `AI_INTEGRATIONS_OPENAI_*` (🟡).
- A camada de **geração de artefato** (manifesto, AGENTS.md, OpenAPI, policy-matrix,
  Keycloak realm, OPA/Rego, bundle NuPIdentity, compliance HTML) está ✅ e exposta por
  `?format=`. A integração **Git/webhooks/branch/PR** e o **diff de snapshots** estão
  construídos (✅ código), com efeito 🟡 (dependem de token Git / webhook secret / runs com snapshot).
- O que separa "existe" de "está produzindo valor pro EasyNuP hoje" é
  **configuração/cadastro**, não código: emitter precisa das 3 envs do Sentinel;
  o motor Java precisa do JAR compilado; e o repo-alvo precisa estar **cadastrado
  como projeto** — o seed só traz o projeto Sample. Por isso esses pontos estão 🟡.
- **Não há cron**: toda análise é sob demanda via HTTP/CLI.

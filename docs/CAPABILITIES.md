# Catálogo de capacidades — NuP Sentinel Manifest

> **Verificado @ cf394d3 · 2026-08-11.** Se código e este doc divergirem, o código vence — atualize este doc no MESMO PR.
<!-- doc-verify: on -->

> Estado **real** do código, verificado `arquivo:símbolo` (ref de linha `arquivo:NNN` como auxílio). Sem promessa do que não existe.
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
| Análise sob demanda via HTTP (`POST /api/analyze`, `/api/analyze-zip`, `/api/projects/:id/analyze`) | ✅ | `server/routes.ts:242` · `server/routes.ts:358` · `server/routes.ts:719` |
| Pipeline de análise (~12 estágios imperativos; os rótulos "Step N/4" são cosméticos) — grafo backend → endpoints → frontend → conexão/classificação → persistência/finalização | ✅ | `server/pipeline/analysis-pipeline.ts:runFullAnalysis` |
| Cache de grafo backend e de interações de frontend por projeto (TTL 30 min, invalida por hash SHA-256 de arquivo) | ✅ | `server/pipeline/analysis-pipeline.ts:CACHE_TTL_MS` · `server/pipeline/analysis-pipeline.ts:graphCacheStore` · `server/pipeline/analysis-pipeline.ts:isCacheValid` |
| **Cron / agendamento de análise** | ⚪ | Não existe. Análise é sempre disparada por requisição. O único `setInterval` (`server/routes.ts:65`) só limpa uploads temporários antigos, não analisa nada. |

### 1.1 Backend Java (motor AST próprio)

| Capacidade | Status | Evidência |
|---|---|---|
| Motor Java AST próprio (JavaParser + symbol solver) rodando como processo JVM irmão | 🟡 | `server/analyzers/backend-java-client.ts:55` sobe `java -jar java-analyzer-engine-1.0.0.jar`; o JAR precisa estar compilado em `java-analyzer-engine/target/` (`server/analyzers/backend-java-client.ts:16`). |
| Extração de Controllers / Services / Repositories / Entities + anotações de mapeamento e de segurança | ✅ | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:30-49` (reconhece `@RestController`, `@*Mapping`, `@PreAuthorize`/`@Secured`/`@RolesAllowed`/`@DenyAll`/`@PermitAll`, `@Entity`/`@Table`/`@Document`) |
| Grafo de aplicação tipado (nós CONTROLLER/SERVICE/REPOSITORY/ENTITY) + impacto por endpoint (cadeia de chamada, entidades tocadas, operações de persistência) | ✅ | `server/analyzers/application-graph.ts:1`; impacto em `analyzeGraphEndpoints` consumido em `server/pipeline/analysis-pipeline.ts:298` |
| Detecção de arquitetura (REST_CONTROLLER / WS_OPERATION_BASED / MVC_ACTION_BASED / EXTERNAL_API_GATEWAY) | ✅ | `server/analyzers/architecture-detector.ts:28-52` |

### 1.2 Frontend

| Capacidade | Status | Evidência |
|---|---|---|
| Extração de chamadas de API do frontend (`fetch`, `axios`, `ky`, `got`, `superagent`, `wretch`, Angular HttpClient) | ✅ | `server/analyzers/frontend/http-clients.ts:22` |
| Reconhecimento do padrão `BaseApiService` / `buildEndpoint`/`buildUrl`/`getUrl`/`getEndpoint` (classe-base que monta URL) | ✅ | `server/analyzers/frontend/http-service-map.ts:246` |
| Registro de `baseURL`/prefixo de API (variáveis e `axios.create({ baseURL })`) pra resolver URLs relativas | ✅ | `server/analyzers/frontend-analyzer.ts:71-120` |
| Resolução de cada chamada do frontend contra um endpoint do backend (`matchUrlToEndpoint` → `mappedBackendNode`) | ✅ | `server/analyzers/frontend-analyzer.ts:257-260`; matcher em `server/analyzers/frontend/utils.ts:345` (match por path, por nome de operação, fallback fuzzy) |
| Classificação da interação (HTTP / UI_ONLY / STATE_ONLY / SERVICE_BRIDGE / EXTERNAL_SERVICE) | ✅ | `server/analyzers/frontend-analyzer.ts:60` |
| Detecção de papéis/guards declarados no frontend (`detectedRoles`, route guards) | ✅ | `server/analyzers/frontend-analyzer.ts:64` |
| Enriquecimento de catálogo por inferência (estrutura de backend inferida quando o backend não foi analisado) | ✅ | `server/analyzers/frontend-inference-engine.ts`, chamado em `server/pipeline/analysis-pipeline.ts:173` |
| Grafo global de chamadas do frontend (resolve cadeia fn→fn entre arquivos/imports + propaga "capacidade HTTP") | ✅ | `server/analyzers/frontend/global-call-graph.ts:1` (`buildGlobalCallGraph`/`propagateHttpCapability`), montado em `server/analyzers/frontend-analyzer.ts:181` |
| Grafo de eventos de componente (handler → emit/chamada de serviço) | ✅ | `server/analyzers/frontend/event-graph.ts:1` (`buildComponentEventGraph`), usado em `server/analyzers/frontend-analyzer.ts:7` |
| Grafo de fluxo de estado (store/composable → ação que dispara HTTP) | ✅ | `server/analyzers/frontend/state-flow-graph.ts:1` (`buildStateFlowGraph`), montado em `server/analyzers/frontend-analyzer.ts:184` |
| Grafo de camadas arquiteturais do frontend | ✅ | `server/analyzers/frontend/architectural-layer-graph.ts:1` (`buildArchitecturalLayerGraph`), usado em `server/analyzers/frontend-analyzer.ts:27` |
| Extração de rotas do frontend (Vue Router / React Router / Angular) | ✅ | `server/analyzers/frontend/route-extraction.ts:1` |
| Tabela de símbolos + resolução de HTTP por arquivo (parsers Babel/TS) | ✅ | `server/analyzers/frontend/symbol-table.ts:1`, `server/analyzers/frontend/http-resolution.ts:1`, `server/analyzers/frontend/parsers.ts:1`, `server/analyzers/frontend/file-analyzers.ts:1` |
| Detecção de auth no frontend (interceptors/headers/guards) | ✅ | `server/analyzers/frontend/auth-detection.ts:1` |

> Os grafos de evento/estado/camadas/call-graph são módulos grandes e ligados (`server/analyzers/frontend-analyzer.ts:181-184` etc.), mas o que **vira catálogo** hoje é a interação HTTP resolvida (§1.2 linha 1). Os demais grafos enriquecem a análise; o consumo direto deles pelo catálogo final é parcial.

### 1.2-bis Classificação semântica das entradas

| Capacidade | Status | Evidência |
|---|---|---|
| Classificador **determinístico** das entradas do catálogo (operação técnica / criticidade / significado, por regras) — é o que roda no pipeline | ✅ | `server/analyzers/deterministic-classifier.ts:3` (`classifyEntriesDeterministic`), chamado em `server/pipeline/analysis-pipeline.ts:331` |
| Classificador **semântico via LLM** (OpenAI) — operação técnica, criticalityScore, suggestedMeaning, em batches de 10 | 🟡 | `server/analyzers/semantic-engine.ts:15` (`classifyEntries`). **Não roda no pipeline normal** — só é acionado sob demanda pela rota `POST /api/enrich-with-llm/:projectId` (`server/routes.ts:1747`); usa `openai` com `AI_INTEGRATIONS_OPENAI_API_KEY`/`_BASE_URL` (`server/analyzers/semantic-engine.ts:4-6`) — sem essas envs, falha. Provider é **OpenAI**, não Anthropic. |

### 1.3 Catálogo & manifesto

| Capacidade | Status | Evidência |
|---|---|---|
| Geração de catálogo (entries) ligando frontend↔backend + classificação determinística | ✅ | `server/pipeline/analysis-pipeline.ts:167-173` (graph-connector + deterministic-classifier) |
| Snapshot de manifesto por run (entidades + campos, com cópia-sombra das entidades do grafo) | ✅ | `server/pipeline/analysis-pipeline.ts:340-409` |
| Ingestão de catálogo vindo do Codelens (`POST /api/projects/:id/codelens-extraction`) + lookups | ✅ | `server/manifest-lookup.ts:1-30` |
| Detecção de mudança por hash de arquivo (decide o que reanalisar / invalida cache incremental) | ✅ | `server/pipeline/change-detector.ts:37-48` (`computeFileHashes`/`detectChanges`), usado em `server/pipeline/analysis-pipeline.ts:118-162` |
| Scanner de repositório (extrai/varre ZIP, classifica tipo de arquivo) | ✅ | `server/analyzers/repository-scanner.ts:23` |

---

## 1.4 Geradores de artefato (export do manifesto)

Toda a suíte é gerada a partir do manifesto (`generateManifest`, `server/generators/manifest-generator.ts:1`) e exposta nas rotas
`POST /api/analyze`, `/api/analyze-zip` e `GET /api/manifest/:projectId?format=...` (`server/routes.ts:221-266`).
O `format` aceita: `manifest` (default), `agents-md`, `openapi`, `policy-matrix`, `keycloak-realm`, `opa-rego`, `nupidentity`, `nupidentity-runner`, `compliance-report`, `all`.

| Gerador | Status | Evidência |
|---|---|---|
| Manifesto canônico (entries + entidades/campos) | ✅ | `server/generators/manifest-generator.ts:1` (`generateManifest`) |
| `AGENTS.md` (catálogo legível por IA) | ✅ | `server/generators/agents-md-generator.ts:1` (`generateAgentsMd`) |
| OpenAPI spec (JSON) | ✅ | `server/generators/openapi-generator.ts:1` (`generateOpenAPISpec`) |
| Policy matrix (matriz endpoint × permissão) | ✅ | `server/generators/policy-matrix-generator.ts:1` (`generatePolicyMatrix`) |
| Keycloak realm export (consome findings de segurança) | ✅ | `server/generators/keycloak-realm-generator.ts:1` (`generateKeycloakRealm`) |
| OPA / Rego (bundle ou `policy.rego`) | ✅ | `server/generators/opa-rego-generator.ts:1` (`generateOpaRego`) |
| Bundle NuPIdentity + runner script | ✅ | `server/generators/nupidentity-generator.ts:238` (`generateNupidentityBundle`, `generateNupidentityRunnerScript`) |
| Relatório de compliance (HTML, consome manifesto + findings) | ✅ | `server/generators/compliance-report-generator.ts:1` (`generateComplianceReport`) |

---

## 2. Detectores de segurança (omission engine)

`server/security/omission-engine.ts` roda 6 detectores em cima do catálogo já persistido
(`server/pipeline/analysis-pipeline.ts:181`). Todos ✅ no código — produzem `SecurityFinding`.

| Detector | Status | Evidência |
|---|---|---|
| `UNPROTECTED_OUTLIER` — endpoint sem proteção enquanto os pares (mesmo método+domínio) são protegidos | ✅ | `server/security/omission-engine.ts:164-234` |
| `PRIVILEGE_ESCALATION` — escrita em entidade/campo de privilégio (role/permission/isAdmin…) sem role admin | ✅ | `server/security/omission-engine.ts:236-304` |
| `SENSITIVE_DATA_EXPOSURE` — GET sem proteção que expõe campo altamente sensível (password/token/ssn…) | ✅ | `server/security/omission-engine.ts:306-350` |
| `INCONSISTENT_PROTECTION` — controller maioritariamente protegido com endpoint mutante desprotegido | ✅ | `server/security/omission-engine.ts:352-410` |
| `MISSING_PROTECTION` — endpoint de criticidade alta (≥60) sem nenhuma anotação de segurança | ✅ | `server/security/omission-engine.ts:412-438` |
| `COVERAGE_GAP` — métrica de cobertura geral + cobertura baixa por método HTTP | ✅ | `server/security/omission-engine.ts:440-494` |
| Métricas de cobertura (por método, por controller, distribuição de roles) | ✅ | `server/security/omission-engine.ts:496-551` |
| Resumo de segurança de PR (delta de proteção do PR vs repo) | ✅ | `server/security/omission-engine.ts:577` (`generatePRSecuritySummary`) |

---

## 3. Detector frontend↔backend (consistência) — **novo (PR #8)**

| Capacidade | Status | Evidência |
|---|---|---|
| Detector que aponta tela chamando endpoint que o backend **não expõe** (`mappedBackendNode == null` → provável 404 em runtime) | ✅ existe no código | `server/analyzers/frontend-backend-consistency.ts:52` (mergeado no PR #8, `fbcd7ea`) |
| Severidade por impacto: escrita (POST/PUT/PATCH/DELETE) → `high`; leitura (GET) → `medium`; dedup por `(método, url)` | ✅ | `server/analyzers/frontend-backend-consistency.ts:71-94` |
| Guarda anti-falso-positivo: só roda quando **houve análise de backend** (`endpointImpacts > 0`); exclui EXTERNAL_SERVICE/SERVICE_BRIDGE/UI_ONLY/STATE_ONLY | ✅ | `server/pipeline/analysis-pipeline.ts:217`; categoria filtrada em `server/analyzers/frontend-backend-consistency.ts:63` |
| Ligado no pipeline e emitido como `type:inconsistency` ao Sentinel | ✅ | `server/pipeline/analysis-pipeline.ts:218-235` → `emitConsistencyFindings` |
| **Rodar de verdade para o EasyNuP (ou qualquer repo real)** | 🟡 | O detector funciona, mas o end-to-end depende de (a) o repo-alvo estar **cadastrado como projeto** — hoje o seed só cria o "Customer Portal (Sample)" (`server/seed.ts:566`) — e (b) o backend Java do alvo ter sido analisado na mesma run (senão o passo é pulado: `server/pipeline/analysis-pipeline.ts:238`). |

A classe de bug que ele pega (verificada à mão no EasyNuP): tela chama
`updateUser.v1` / `create/update/deletePermission.v1` / `create/update/delete` de
SLA Categories / Severity quando o backend só tem `find*` — descrita em
`server/analyzers/frontend-backend-consistency.ts:14-18`.

### 3.1 Inventário de endpoints por convenção NuPtechs — **novo**

O analisador genérico só enxerga endpoints Spring `@*Mapping`. Plataformas NuPtechs
(EasyNuP) expõem o HTTP por dois caminhos que ele não via — então `endpointImpacts`
dava **0** e o detector se auto-suprimia. Coberto em `server/analyzers/nuptechs-conventions.ts`:

| Capacidade | Status | Evidência |
|---|---|---|
| **(B) Inventário WsV1**: `.../services/web/<área>/<op>/v<N>/<Class>WsV1.java` → endpoint `/easynup/<op>.v<N>` (override por `@Ws("/abs")` explícito); injetado como nó CONTROLLER → `analyzeEndpoints` reporta e `matchUrlToEndpoint` resolve **exato** (typo/renome/removido → flagrado) | ✅ | `server/analyzers/nuptechs-conventions.ts:extractWsV1Endpoints/augmentGraphWithWsV1`; ligado em `server/pipeline/analysis-pipeline.ts:buildGraph` |
| **(A) Prefixos do gateway Node**: `app.use('<prefix>', …)` → cobertura coarse das chamadas `/api/<x>` nativas (sem catch-all `/api`, então chamada fora de todo prefixo continua flagrável). Exclui `/easynup` e `/api/v1/admin` (o WsV1 cobre) e `/api`/`/api/` (largos) | ✅ | `server/analyzers/nuptechs-conventions.ts:extractGatewayPrefixes/mapInteractionsToGatewayPrefixes`; ligado antes do detector em `analysis-pipeline.ts` |
| Precisão-primeiro (sem falso-positivo): WsV1 exato no core `/easynup/*`, gateway coarse no `/api/*` nativo; aditivo (só ativa para arquivos que casam os padrões — não afeta projetos não-NuPtechs) | ✅ | testes em `tests/analyzers/nuptechs-conventions.test.ts` (13 casos) |

---

## 4. Emissão para o orquestrador Sentinel

`server/security/sentinel-emitter.ts` traduz os achados em `Finding v2` e os
envia ao `nup-sentinel` (cria sessão em `/api/sessions`, ingere em `/api/findings/ingest`).

| Capacidade | Status | Evidência |
|---|---|---|
| `emitSecurityFindings` → findings `type:permission_drift` (subtypes mapeados dos 6 detectores) | ✅ código / 🟡 efeito | `server/security/sentinel-emitter.ts:146`, subtype map `:61-68` |
| `emitConsistencyFindings` → findings `type:inconsistency` (subtype `missing_backend_endpoint`) | ✅ código / 🟡 efeito | `server/security/sentinel-emitter.ts:165` (novo no PR #8) |
| **Críticos de grafo (ADR-070 Onda 4)** → findings `type:functional_overlap` (2+ caminhos fazem o mesmo sobre a mesma entidade; subtype `<opClass>_overlap`) e `type:lifecycle_gap` (entidade escrita sem leitura própria, ou lida sem escrita) | ✅ código / 🟡 efeito | `server/security/sentinel-emitter.ts:254` (overlap), `:295` (lifecycle) |
| Transporte best-effort: Sentinel fora do ar **nunca** quebra a análise (loga e engole) | ✅ | `server/security/sentinel-emitter.ts:220` |
| **Emissão de fato acontecer** | 🟡 | É **no-op** sem as três envs: `SENTINEL_URL`, `SENTINEL_API_KEY`, `SENTINEL_PROJECT_ID` (`server/security/sentinel-emitter.ts:231-233`). Opcionais: `SENTINEL_ORG_ID` (tenant), `SENTINEL_TIMEOUT_MS`. Sem elas, retorna `{ skipped: true }` e o pipeline segue normal. |

---

## 5. Persistência, frontend admin e CLI

| Capacidade | Status | Evidência |
|---|---|---|
| Backend Drizzle ORM + Postgres | ✅ | `server/db.ts`, `drizzle.config.ts` |
| Frontend admin React (Vite + Radix UI) | ✅ | `client/`, `vite.config.ts` |
| CLI (`@nuptechs/sentinel-manifest-cli`) com `analyze` / `connect` / `diff` / `manifest` | ✅ | `cli/src/commands/` |
| Seed do banco | 🟡 | `server/seed.ts` cria **apenas** o projeto "Customer Portal (Sample)" (`:566`). Para analisar o EasyNuP (ou outro repo real) é preciso cadastrar o projeto e disparar a análise. |
| Registro OIDC no NuPIdentify (deploy SaaS) | ⚪ | manifesto de cliente em `nupidentity-client-manifest.json` (registro feito fora, no deploy) |
| Extensão VS Code (`analyzeFile`/`analyzeWorkspace`/`analyzeWorkspaceFull`/`showCatalog`/`connectServer`) | ✅ | `vscode-extension/src/extension.ts:35`; analisadores local/remoto em `local-analyzer.ts`/`remote-analyzer.ts` |

### 5.1 Diagramas de Evidência (`/evidence`) — 8 vistas sobre os endpoints reais

Página-mãe (`client/src/pages/evidence-diagrams.tsx:EvidenceDiagramsPage`) no padrão System Map (`VizMode` union + barra segmentada + deep-link `?view=&project=`), consumindo os endpoints de evidência já existentes — **zero servidor novo**. A gramática de tiers/cores/legenda é REUSADA de `client/src/pages/system-map-evidence.tsx:EVIDENCE` (nunca redefinida). Regra: dado real ou nada (vazio ≠ falhou ≠ carregando).

| Vista | Componente | Fonte (endpoints reais) |
|---|---|---|
| Metro Map de requisições | `client/src/pages/evidence-diagrams-metro.tsx:MetroView` (layout puro `client/src/pages/evidence-metro.ts:buildMetroLayout`) | `/reasoner/sequence/catalog` + `/reasoner/sequence` |
| Sankey de autorização | `client/src/pages/evidence-diagrams-sankey.tsx:SankeyView` (modelo puro `client/src/pages/evidence-sankey.ts:buildSankeyModel`) | `/permission-governance` + `/sensitive-exposure` + `/entity-access` + catálogo |
| Grafo + Prova (recibo por aresta) | `client/src/pages/evidence-diagrams-proof.tsx:ProofView` (ego puro `client/src/pages/evidence-proof.ts:buildEgoLayout`) | `/graph` |
| Uma geometria, N lentes | `client/src/pages/evidence-diagrams-lenses.tsx:LensesView` (geometria fixa `client/src/pages/evidence-lenses.ts:buildLensGeometry`) | `/graph` + `/permission-governance` |
| Conformidade desenhado × executado | `client/src/pages/evidence-diagrams-conformance.tsx:ConformanceView` | `coverage` do `/graph` + `/reasoner/runtime-gap` + `/bimr` |
| Diff + Andon | `client/src/pages/evidence-diagrams-diff.tsx:DiffView` (diff/andon puros `client/src/pages/evidence-diff.ts:computeDiff`) | `/evidence-history` + `/evidence-health` + `/graph-drift` |
| Zoom epistêmico (herda o pior tier) | `client/src/pages/evidence-diagrams-zoom.tsx:ZoomView` (`client/src/pages/evidence-domains.ts:computeDomainEvidence`) | `/graph` + `/reasoner/domains` |
| Radar executivo | `client/src/pages/evidence-diagrams-radar.tsx:RadarView` (`client/src/pages/evidence-domains.ts:worstTier`) | `/reasoner/domains` + `/graph` + `/evidence-history` |

Rota + nav: `client/src/App.tsx` (`/evidence`) e `client/src/components/app-sidebar.tsx`. Lógica de layout/agregação é PURA e testada com fixtures (`client/src/pages/evidence-metro.test.ts`, `evidence-sankey.test.ts`, `evidence-diff.test.ts`, `evidence-domains.test.ts`, `evidence-lenses.test.ts`, `evidence-proof.test.ts`, `evidence-diagrams.test.tsx`). Co-mudança git NÃO é oferecida (ausência declarada em `server/analyzers/delivery-risk.ts:NotComputedSignal`) — a lente "Recência" usa a última observação de runtime por nó.

---

## 6. Integração Git, webhooks e análise de branch/PR

| Capacidade | Status | Evidência |
|---|---|---|
| Provider Git abstrato + factory (GitHub / GitLab) | ✅ | `server/git/git-provider.ts:86` (`createGitProvider`); `GitHubProvider` (`server/git/github-provider.ts:13`), `GitLabProvider` (`server/git/gitlab-provider.ts:4`) |
| Conectar/desconectar repo, listar branches e PRs (`POST .../git/connect`, `GET .../git/branches`, `GET .../git/pull-requests`, `GET .../git/status`, `DELETE .../git/disconnect`) | 🟡 | `server/routes.ts:1421` — depende de token Git válido cadastrado no projeto |
| Analisar uma branch específica (`POST .../analyze-branch`) | 🟡 | `server/routes.ts:1527` — busca arquivos via provider e roda o pipeline |
| Analisar um PR (delta) (`POST .../analyze-pr`) | 🟡 | `server/routes.ts:1601` (`analyzePRSchema`) |
| Webhook GitHub com verificação HMAC-SHA256 (`POST /api/webhook/github`, header `x-hub-signature-256`) | 🟡 | `server/routes.ts:1832-1864`; HMAC só valida se `project.webhookSecret` estiver setado (`:1857`) — sem secret, **não verifica assinatura** |
| Webhook GitLab (`POST /api/webhook/gitlab`) | 🟡 | `server/routes.ts:1886` |
| Configurar webhook do projeto (`POST .../webhook/configure`) | ✅ | `server/routes.ts:1807` |

## 7. Diff de manifesto (drift entre snapshots)

| Capacidade | Status | Evidência |
|---|---|---|
| Diff entre dois snapshots de run (mudança de permissão/endpoint/entidade) | ✅ | `server/diff/manifest-diff-engine.ts:338` (`diffManifests`) |
| Rota de diff por run (`GET .../diff?runA&runB`) + diff dos 2 últimos (`GET .../diff/latest`) + listar snapshots (`GET .../snapshots`) | 🟡 | `server/routes.ts:1338` — só funciona para runs que **têm snapshot** (feature posterior ao snapshot; runs antigos retornam 404, `:1352`) |

## 8. Autenticação e API keys

| Capacidade | Status | Evidência |
|---|---|---|
| Auth OIDC (NuPIdentify) via JWT + checagem de permissão/tier | 🟡 | `server/middleware/jwt-auth.ts:64` (`verifyJWT`/`hasPermission`/`isOIDCConfigured`) — inerte se OIDC não configurado |
| API keys: criar/listar/revogar (`POST/GET/DELETE /api/keys`) com hash + prefixo | ✅ | `server/routes.ts:126`; `server/middleware/api-auth.ts:8` (`hashApiKey`/`generateApiKey`/`apiAuthMiddleware`) |
| Quem-sou-eu (`GET /api/auth/me`) resolvendo OIDC **ou** API key | ✅ | `server/routes.ts:101-125` |
| Upload em chunks (init/chunk/complete) + ZIP de projeto, com limpeza de uploads temporários antigos | ✅ | `server/routes.ts:543`; cleanup via `setInterval` (`server/routes.ts:65`) — **único** timer do sistema, não analisa nada |

## 9. Inventário de rotas HTTP (server/routes.ts)

Todas montadas em `server/routes.ts`. Status do efeito segue as seções acima.

| Método + rota | Linha |
|---|---|
| `GET /api/auth/me` | `:101` |
| `POST /api/keys` · `GET /api/keys` · `DELETE /api/keys/:id` | `:126,156,172` |
| `POST /api/analyze` · `POST /api/analyze-zip` | `server/routes.ts:242` · `server/routes.ts:358` |
| `GET /api/docs/openapi.json` · `GET /api/docs` | `:345,350` |
| `GET /api/projects/:projectId/security-findings` | `:361` |
| `POST /api/projects/:projectId/codelens-extraction` | `:380` |
| `GET /api/projects/:projectId/lookup` | `:406` |
| `GET /api/stats` | `:435` |
| `GET /api/projects` · `GET /api/projects/:id` · `POST /api/projects` · `DELETE /api/projects/:id` | `:445,455,470,506` |
| `POST /api/projects/:id/analyze` | `server/routes.ts:719` |
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

## 10. Cobertura por stack & harness anti-regressão (ADR-0015)

> Governança: `nup-sentinel/docs/adr/0015-cobertura-multi-stack-manifest-paridade-qualidade.md`.
> Régua P1: **nenhuma stack vira ✅ sem goldset medido em CI** ("compila e produz output" não é suporte).
> Gates G1–G3: baseline easynup congelado (nenhum PR mergeia com métrica abaixo do piso) ·
> flags `MANIFEST_MULTISTACK_*` OFF = byte-a-byte · ON = superset estrito.

### Matriz por stack (portfólio NuPtechs, inventário 2026-07-06)

| Stack / template | Status | Situação |
|---|---|---|
| **easynup** (Vue 3 + Spring/JPA + WsV1 + gateway Express por prefixo) | ✅ | Goldset full-repo medido ([goldset-easynup.md](benchmark/goldset-easynup.md)) + golden de fixture em CI (Onda 0) |
| **rest-express** (React + wouter + Express ESM + Drizzle; ~14 repos) | ⚪ | Onda 1 (D1–D7): balde node-backend aditivo · rotas Express · middleware→`securityAnnotations` · Drizzle `pgTable` · call-chain · captura queryKey/`apiRequest` · **goldset kan + NuP-School como gate de ✅** |
| Variantes Node (`pg` cru · Fastify · `architectureType: NODE_API` · shape Node na ingestão Codelens) | ⚪ | Onda 2 (D8a–d) |
| Next.js · Python (Flask/FastAPI) | ⚪ | Onda 3 (D9) — decisão explícita: parser com goldset OU fora-de-escopo declarado (e `.py`/`.cs` saem do scanner) |
| React Native · Kotlin Android · JS arbitrário fora de convenção | fora de escopo | D10 — declarado com razão; sem promessa |

### Harness anti-regressão (Onda 0 — entregue)

| Capacidade | Status | Evidência |
|---|---|---|
| Golden do fixture mini-easynup comparado **byte-a-byte** em todo `npm test`/CI (G1-fixture) | ✅ | `tests/regression/goldset-baseline.test.ts` + `tests/regression/baseline-fixture.golden.json` (regenerar SÓ deliberadamente, no mesmo PR, com justificativa) |
| Testes de **sensibilidade** do harness (derrubar 1 endpoint ou 1 permissão ⇒ CI vermelho — 1º teste do DoD) | ✅ | `tests/regression/goldset-baseline.test.ts` §"sensibilidade do harness" |
| Flags `MANIFEST_MULTISTACK_NODE` / `MANIFEST_MULTISTACK_HTTP_TEMPLATE`, **default OFF** (G2) | ✅ | `server/config/multistack.ts` (nada as consome ainda; teste trava que setá-las não muda o snapshot) |
| Canários da Onda 1 no fixture (C1 rota Express `router.get` invisível hoje · C2 GET via `queryKey` invisível hoje) — viram prova de **superset** (G3) quando a Onda 1 ligar | ✅ | `tests/regression/mini-easynup.fixture.ts` + testes C1/C2 |
| Gate **executável** do baseline full-repo (pisos 1330 endpoints · 214 entidades · 2119 colunas · 672 permissões · teto 0 endpoints falsos; fail-closed em métrica ausente) | 🟡 | `script/check-goldset-baseline.ts` + `tests/regression/baseline-easynup-full.json` — 🟡 porque a medição full exige a receita do goldset (Postgres + JVM), fora do CI; o comparador em si é ✅ testado |

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

---

## 11. Eixos de evidência & overlay

O produto não é só um catálogo — é um **servidor de evidência**. Cada aresta do grafo carrega um **método** com confiança fixa, e o mapa distingue o que foi **provado** do que apenas **admite não ter provado**.

### 11.1 Os quatro métodos de aresta (3 de evidência + 1 de admissão)

Classificação em `server/analyzers/system-graph.ts:classifyEdgeEvidence`:

| Método | Confiança | Fonte |
|---|---|---|
| `RUNTIME_OBSERVED` | `0.95` | traços OTel/Jaeger (foi observado de fato) |
| `STATIC_PROVEN` | `0.80` | índice SCIP do build real (compiler-accurate) |
| `CONFIG_PROVEN` | `0.78` | wiring DI do Spring (provado por config, sem runtime) |
| `STATIC_UNRESOLVED` | `0.40` | heurística Java/Node — **não é prova**, é o que o mapa admite não ter provado |

`LLM_CONJECTURED` é coluna RESERVADA do censo (`server/analyzers/system-graph.ts:LLM_CONJECTURED`, hoje =0, sem produtor); o frontend já a renderiza (`client/src/pages/system-map-evidence.tsx:LLM_CONJECTURED`). Slot preparado, não capacidade viva.

### 11.2 Assimetria baked vs read-time

| | Métodos | Onde |
|---|---|---|
| **BAKED** no snapshot (gravadas na análise) | `RUNTIME_OBSERVED` + heurísticas Java/Node | pipeline |
| **OVERLAY de LEITURA** (mescladas ao servir `/graph`) | `STATIC_PROVEN` (scip) + `CONFIG_PROVEN` (config) | `server/analyzers/graph-overlays.ts:applyPersistedOverlays` (precedência **scip > config**) |

scip/config NÃO são construídas na análise — são POSTadas por fora e aplicadas na leitura.

### 11.3 Ingestão de arestas provadas (por fora)

| Endpoint | Schema | `resolution` aceito | Evidência |
|---|---|---|---|
| `POST /api/projects/:id/scip-edges` | `server/routes.ts:34` | `compiler`, `interface-impl` | `server/routes.ts:487` |
| `POST /api/projects/:id/config-edges` | `server/routes.ts:59` | `config` (store separado) | `server/routes.ts:541` |

O campo `dataAccess` (função→tabela READ/WRITE) é **DESCARTADO**: o deriver `tools/scip-typescript/scip-data-access.mjs:deriveDataAccess` o produz, mas a agregação no servidor não está ligada — nunca vira nó `table:<físico>` provado.

### 11.4 Correlator de runtime (rota × tabela)

`server/analyzers/runtime-overlay.ts:resolveRuntimeOverlayConfig` — PULL do Jaeger, atribui por ROTA × TABELA por trace-id. Só observa FRONTEIRAS (serviço→serviço, serviço→banco) — o `observedRatio` NÃO tende a 1.0 por construção (teto correto da técnica). NÃO há `session.id`/baggage/`X-Probe` neste repo (a narrativa session-baggage do ADR-073 não está implementada aqui).

Isolamento fail-closed: sem `JAEGER_QUERY_URL` ⇒ OFF; sem `runtimeOverlay.services` explícito ⇒ OFF (default `easynup-*` removido). Padrão de op interno em `server/analyzers/runtime-overlay.ts:DEFAULT_OP_RE` (configurável por alvo via `opPathPattern`). LKG runtime TTL 7 dias (`server/analyzers/runtime-overlay.ts:DEFAULT_RUNTIME_LKG_TTL_MS`).

### 11.5 Veredito tri-eixo + IA read-time governada

O veredito determinístico LOCAL (`STRONG` | `MODERATE` | `WEAK`) vive em `server/reasoner/verdict.ts:computeEvidenceVerdict` (`server/reasoner/verdict.ts:EvidenceTier`). O Tribunal de convergência multi-fonte completo e o robô de tráfego sintético vivem no repo `nup-sentinel`, não aqui.

A IA nunca decide — explica pós-fato, ancorada a id provado. TRÊS caminhos de LLM (OpenAI via Replit AI Integrations): `server/reasoner/llm.ts:ReasonerLLM` (prosa do veredito), `server/analyzers/narrative-llm.ts:resolveEdgeClaimGenerator` (narrativa), `server/analyzers/semantic-engine.ts:classifyEntries` (classificação semântica, sob demanda, fora do pipeline). O grounding é a lei: `server/reasoner/grounding.ts:groundClaims` REMOVE todo claim sem âncora provada; a prosa do LLM só passa se não contradiz o tier.

### 11.6 Armadilhas conhecidas (dívida)

- `server/analyzers/java-analyzer.ts:analyzeJavaFiles` = engine paralela obsoleta (0 imports; o pipeline usa o JAR via `server/analyzers/backend-java-client.ts:buildApplicationGraph`).
- `server/analyzers/system-graph.ts:isHeuristicResolution` casa qualquer `syntactic*` ⇒ Java resolvido sub-creditado a `0.40`.
- `server/analyzers/system-graph.ts:PRECISE_RESOLUTIONS` inclui `exact|type|import|direct` que nenhum produtor emite.

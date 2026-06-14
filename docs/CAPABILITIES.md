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

### 1.3 Catálogo & manifesto

| Capacidade | Status | Evidência |
|---|---|---|
| Geração de catálogo (entries) ligando frontend↔backend + classificação determinística | ✅ | `analysis-pipeline.ts:167-173` (graph-connector + deterministic-classifier) |
| Snapshot de manifesto por run (entidades + campos, com cópia-sombra das entidades do grafo) | ✅ | `analysis-pipeline.ts:340-409` |
| Ingestão de catálogo vindo do Codelens (`POST /api/projects/:id/codelens-extraction`) + lookups | ✅ | `server/manifest-lookup.ts:1-30` |

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

---

## Resumo honesto

- A **análise estática** (grafo Java AST, frontend, catálogo, 6 detectores de
  segurança, detector de consistência frontend↔backend) está **construída e ligada
  no pipeline** — ✅ no nível de código.
- O que separa "existe" de "está produzindo valor pro EasyNuP hoje" é
  **configuração/cadastro**, não código: emitter precisa das 3 envs do Sentinel;
  o motor Java precisa do JAR compilado; e o repo-alvo precisa estar **cadastrado
  como projeto** — o seed só traz o projeto Sample. Por isso esses pontos estão 🟡.
- **Não há cron**: toda análise é sob demanda via HTTP/CLI.

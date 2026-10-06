# NuP Sentinel Manifest — servidor de análise de evidência

> Verificado @ a889914 · 2026-10-06. Código vence o doc.
<!-- doc-verify: on -->

Módulo servidor de análise da plataforma NuP Sentinel. **Não** é um gerador de catálogo (esse enquadramento está declarado obsoleto em `replit.md:8`). É um **servidor de análise de evidência**: parseia um repositório-alvo, monta um **mapa código→execução** (grafo de aplicação, nós tipados + arestas), e sobre cada aresta carrega um **método de evidência com confiança fixa**. O diferencial é epistêmico — o mapa distingue o que foi *provado* do que apenas *admite não ter provado*, e nunca apaga por omissão o que não entende. Sobre o censo do grafo calcula um **veredito determinístico LOCAL** `STRONG` / `MODERATE` / `WEAK` (`server/reasoner/verdict.ts:computeEvidenceVerdict`).

Pacote npm: `@nuptechs/sentinel-manifest`. CLI: `@nuptechs/sentinel-manifest-cli` (bin `permacat`). Domínio SaaS: `manifest.nuptechs.com`.

O que **NÃO** vive aqui, e sim no repo [`nup-sentinel`](https://github.com/nuptechs/nup-sentinel): o robô de tráfego sintético (NÃO há gerador de tráfego neste repo); o Tribunal de convergência multi-fonte completo (aqui é só a leitura tri-eixo do lado do manifest — o próprio `server/reasoner/verdict.ts:EvidenceTier` diz isso); as ferramentas MCP. Análise é **sob demanda** (HTTP `/api/analyze*` ou CLI) — **NÃO há cron** (o único `setInterval` só limpa uploads temporários).

## Os quatro métodos de aresta (três de evidência + um de admissão)

Cada aresta carrega um método com confiança fixa (`server/analyzers/system-graph.ts:classifyEdgeEvidence`):

| Método | Confiança | Fonte | Natureza |
|---|---|---|---|
| `RUNTIME_OBSERVED` | `0.95` | traços OTel/Jaeger (foi observado de fato) | prova dinâmica |
| `STATIC_PROVEN` | `0.80` | índice SCIP do build real (compiler-accurate) | prova estática |
| `CONFIG_PROVEN` | `0.78` | wiring DI do Spring (1 bean / `@Primary`) | prova por configuração |
| `STATIC_UNRESOLVED` | `0.40` | heurística Java/Node | admissão de ignorância — **não é prova** |
| `UNKNOWN` | `0.20` | sem proveniência alguma | admissão de ignorância |
| `LLM_CONJECTURED` | — | **coluna RESERVADA do censo; hoje =0, sem produtor** | slot preparado |

`LLM_CONJECTURED` existe no tipo (`EvidenceMethod`) e no censo zerado (`server/analyzers/system-graph.ts:emptyEdgeByMethod`), e o frontend já renderia a coluna (`client/src/pages/system-map-evidence.tsx:LLM_CONJECTURED`) — mas **nenhum analisador emite aresta assim**. É slot, não capacidade viva.

### O veredito: determinístico decide, IA explica

O tier é 100% determinístico (`computeEvidenceVerdict`), ancorado no **`provenRatio`** (união runtime+static+config), não no runtime isolado — mesclar mais prova aumenta o denominador e evitaria rebaixar um veredito por adicionar evidência. A IA (`server/reasoner/verdict.ts:explainVerdict`) só **prosa** o porquê, e a prosa é **descartada** se contradiz o tier (`contradictsTier`). O "juiz" é o determinístico; a IA é escrivã.

## A assimetria que importa: baked vs read-time

- **BAKED no snapshot** (gravadas na análise): `RUNTIME_OBSERVED` e as heurísticas Java/Node.
- **OVERLAY de LEITURA** (mescladas ao servir `/graph`): `STATIC_PROVEN` (scip) e `CONFIG_PROVEN` (config), via `server/analyzers/graph-overlays.ts:applyPersistedOverlays` (precedência **scip > config**).

Ou seja: scip/config **não** são construídas na análise — são POSTadas por fora (CI do alvo) e mescladas só na leitura. Todo consumidor do grafo (`/graph`, `/bimr`, reasoner) passa por esse mesmo helper, o que evita "segunda verdade".

## Stack & os dois processos

| Camada | Tecnologia | Evidência |
|---|---|---|
| Runtime do servidor | Node 20.x + TypeScript (ESM), Express 5 | `package.json:6` · `server/index.ts` |
| Motor de análise JVM | Processo Java irmão (JavaParser 3.28.1 + symbol-solver), HTTP em `127.0.0.1:9876` | `java-analyzer-engine/pom.xml` · `server/analyzers/backend-java-client.ts` |
| Persistência | Drizzle ORM + Postgres | `shared/schema.ts` · `drizzle.config.ts` |
| Frontend admin | React 18 (Vite + Radix UI + wouter), grafo via Cytoscape/ELK | `client/` · `package.json` |
| Analisadores de frontend | Vue (SFC) · React (JSX/TSX) · Angular | `server/analyzers/frontend-analyzer.ts:analyzeFrontend` |
| LLM (opcional) | OpenAI via Replit AI Integrations | `package.json` (`openai`) |
| Deploy | Docker no Railway (2 serviços servem o mesmo repo) | `railway.toml` · `Dockerfile` |

O motor Java **não** é biblioteca — é um processo HTTP separado que o Node sobe sob demanda (`spawn("java", ["-Xmx…", "-jar", …])`, `server/analyzers/backend-java-client.ts`) e mantém vivo com health-check. Heap por `JAVA_ANALYZER_XMX` (default 2g; 512m dava OOM em repos grandes). O JAR precisa estar compilado em `java-analyzer-engine/target/` — sem ele, a análise Java não roda. O server Java escuta **só em 127.0.0.1** (`java-analyzer-engine/src/main/java/com/permacat/analyzer/AnalyzerServer.java`), isolado da rede.

## Como rodar

```sh
npm install                 # usa npm install (não npm ci — drift de bufferutil no lock)
npm run db:push             # sincroniza o schema Drizzle no Postgres (DATABASE_URL)
npm run dev                 # servidor em modo dev (tsx server/index.ts)
# produção:
npm run build && npm start  # bundle em dist/ e node dist/index.cjs
# motor Java (uma vez; sem o JAR a análise Java é pulada):
mvn -f java-analyzer-engine/pom.xml clean package
# testes e guarda anti-drift de doc:
npm test && npm run test:client && npm run doc:verify
```

O **seed** só cria o projeto "Customer Portal (Sample)" (`server/seed.ts`); analisar um repo real exige cadastrá-lo como projeto e disparar a análise (`POST /api/projects` → `POST /api/projects/:id/analyze`).

## Integrações

| Integração | Direção | Como entra | Estado |
|---|---|---|---|
| Jaeger / OTel | entrada de runtime | **PULL** da query API; allowlist por projeto | 🟡 depende de `JAEGER_QUERY_URL` + `services` |
| SCIP edges | prova estática | `POST /api/projects/:id/scip-edges` (CI do alvo) | 🟡 depende do CI do alvo |
| Config edges (Spring) | prova de wiring | `POST /api/projects/:id/config-edges` (store separado) | 🟡 depende do deriver no CI |
| Codelens | cliente que ingere catálogo | `POST /api/projects/:id/codelens-extraction` | ✅ (codelens é o produtor) |
| sentinel-emitter | saída (Finding v2) → `nup-sentinel` | cria sessão + ingere findings; best-effort | 🟡 no-op sem 3 envs `SENTINEL_*` |
| Git (GitHub/GitLab) | entrada de fonte | provider abstrato; connect/branches/PRs/analyze-branch/analyze-pr | 🟡 depende de token |
| Webhooks PR/MR | entrada (gatilho) | `POST /api/webhook/github` (HMAC), `/gitlab`, GitHub App em `/github-app` | 🟡 depende de secret/App envs |
| GitHub Action | orquestração CI | `action.yml`: `impact-pr` (laudo assinado no PR) + `index` (auto-map no push) | 🟡 depende da instância + api-key |

O runtime entra por **PULL** do Jaeger (`server/analyzers/runtime-overlay.ts:resolveRuntimeOverlayConfig`); **não** há receiver OTLP / `/v1/traces` — não existe push de traços neste repo. Isolamento **fail-closed**: sem `JAEGER_QUERY_URL` ⇒ OFF; sem `runtimeOverlay.services` explícito no projeto ⇒ OFF (**nunca** cai no default `easynup-*` de outro sistema). O runtime só observa FRONTEIRAS (serviço→serviço, serviço→banco), logo `observedRatio` **não tende a 1.0** por construção (teto correto da técnica). LKG runtime TTL 7 dias (`server/analyzers/runtime-overlay.ts:DEFAULT_RUNTIME_LKG_TTL_MS`).

## IA: só read-time, opcional, sob checagem

A IA nunca decide — explica pós-fato, ancorada a id provado. TRÊS caminhos de LLM (OpenAI via Replit AI Integrations), não "uma porta só": `server/reasoner/llm.ts:resolveReasonerLLM` (prosa do veredito), `server/analyzers/narrative-llm.ts:resolveEdgeClaimGenerator` (narrativa), `server/analyzers/semantic-engine.ts:classifyEntries` (classificação semântica, só sob demanda, fora do pipeline). O grounding é a lei: `server/reasoner/grounding.ts:groundClaims` **remove** todo claim sem âncora provada. Sem `AI_INTEGRATIONS_OPENAI_API_KEY`/`OPENAI_API_KEY` o caminho é determinístico byte-estável — o tier e a estrutura são sempre determinísticos.

## Estado, com honestidade

Veja **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** para o catálogo completo (320 funcionalidades em 25 domínios, ancoradas por símbolo, com estado prova-vs-heurística e flag item a item).

Pontos que dependem de **configuração/cadastro** (não de código) para produzir valor de verdade, e dívidas/slots conhecidos:

- **Auto-observabilidade fraca (ironia estrutural).** O produto que mede a observabilidade dos *outros* não se auto-instrumenta: expõe **apenas** `/health`/`/healthz` (liveness trivial, 200), montado antes do middleware de auth (`server/routes.ts:177`). **Não existe** `/metrics` (Prometheus/OpenMetrics) nem **instrumentação OTel do próprio manifest** — ele consome traços de terceiros, não emite os seus. A saúde do próprio pipeline é visível só indiretamente via `GET /api/projects/:id/evidence-health` (mede as fontes, não o processo) e `analysisRuns.diagnostics` (jsonb durável por run).
- **OTLP push não existe.** O eixo runtime é **PULL** do Jaeger e fica **OFF** sem `JAEGER_QUERY_URL` + `runtimeOverlay.services`. Não há receiver OTLP; session-baggage / `X-Probe` (narrativa ADR-073) **não** estão implementados neste repo — vivem no `nup-sentinel`.
- **`LLM_CONJECTURED`** é coluna reservada do censo (=0, **sem produtor**), embora o frontend já a renderize.
- **`dataAccess` (scip função→tabela) descartado.** O deriver `tools/scip-typescript/scip-data-access.mjs` o produz e há merge previsto (`server/analyzers/graph-overlays.ts:mergeDataAccessEdges`), mas a agregação no servidor **não está ligada** — nunca vira nó `table:<físico>` provado.
- **Node backend** (rotas Express / Drizzle / call-chain) está atrás da flag **`MANIFEST_MULTISTACK_NODE` (default OFF)** — `server/config/multistack.ts`. `MANIFEST_MULTISTACK_HTTP_TEMPLATE` é AUTO.
- **Emissão ao Sentinel é no-op** sem `SENTINEL_URL` + `SENTINEL_API_KEY` + `SENTINEL_PROJECT_ID` (`server/security/sentinel-emitter.ts:emitToSentinel` retorna `{skipped:true}`).
- **Motor Java** exige o JAR em `java-analyzer-engine/target/`; `java-analyzer.ts` (regex) é dívida obsoleta (0 imports no pipeline).
- **Webhook sem secret não verifica assinatura** (o HMAC só valida se `project.webhookSecret` existir — comportamento documentado, não silencioso).
- **Python (`.py`) / C# (`.cs`)** são aceitos pelo scanner mas **não têm analisador** (ingest-only).

> **Fork MORTO/legado:** existe um fork antigo em `/Users/nuptechs/Projetos NuPtechs/manifest` (HEAD `e5391a5`, enquadramento antigo "PermaCat/Code-to-Permission") — **não** é o produto vivo e não deve ser tratado como fonte de verdade.

### Deploy & flags (Railway)

Docker no Railway; `preDeployCommand = npx drizzle-kit push` sincroniza o schema antes de trocar tráfego (aditivo aplica sozinho; destrutivo falha sem TTY = fail-closed). Healthcheck em `/health`, timeout 60s (`railway.toml`).

**Pegadinha de ops:** o domínio público `manifest.nuptechs.com` é servido pelo serviço **@probe/server**, que também deploya este repo — variável setada só no serviço `nup-sentinel-manifest` **não afeta** o domínio público. Setar **nos dois**.

| Env | Função | Sem ela |
|---|---|---|
| `JAEGER_QUERY_URL` (ou `RUNTIME_OVERLAY_JAEGER_URL`) | fonte de runtime | overlay OFF |
| `JAVA_ANALYZER_XMX` | heap do motor Java (default 2g) | 2g; OOM em repos muito grandes |
| `MANIFEST_REQUIRE_AUTH` / OIDC (`OIDC_*`) | postura fail-closed da API | ver abaixo |
| `MANIFEST_TOKEN_ENCRYPTION_KEY` (64 hex) | cifra o token Git (AES-256-GCM) | token memória-only |
| `MANIFEST_REPORT_HMAC_KEY` | assina o relatório de impacto | response sem assinatura (nunca fake) |
| `SENTINEL_URL` + `SENTINEL_API_KEY` + `SENTINEL_PROJECT_ID` | emitter → Sentinel | emitter no-op (`{skipped:true}`) |
| `GITHUB_APP_ID` + `_PRIVATE_KEY` + `_WEBHOOK_SECRET` | bot de PR 1-clique | endpoint 503 |
| `AI_INTEGRATIONS_OPENAI_API_KEY` / `_BASE_URL` | LLM (prosa/narrativa/semântica) | caminhos LLM caem no template determinístico |
| `EVIDENCE_HEALTH_*_STALE_HOURS` | limiares de staleness (static 168, config 168, runtime 24, analysis 48) | defaults |

**Fail-closed da API** (`server/middleware/api-auth.ts:isAuthRequired`): auth é exigida quando OIDC está configurado **OU** `MANIFEST_REQUIRE_AUTH=true`. Quando exigida, todo `/api/*` sem credencial válida → 401 (default-deny). Quando não (caixa não-configurada), o server liga só em loopback, então o pass-through é seguro. Credencial via `Authorization: Bearer` ou `X-API-Key`; API key `pk_` (hash SHA-256) ou JWT OIDC. Webhooks têm HMAC próprio por projeto e **pulam** o middleware.

### Login do navegador (OIDC)

O dashboard usa Authorization Code + PKCE e mantém o access token somente na sessão HTTP-only do servidor. Para habilitar o acesso autenticado ao Mapa do Sistema, configure no processo que atende o domínio público:

```text
OIDC_ISSUER_URL=https://identify.nuptechs.com
OIDC_JWKS_URI=https://identify.nuptechs.com/api/oidc/jwks
OIDC_AUDIENCE=<OIDC_CLIENT_ID>
OIDC_SYSTEM_ID=nup-sentinel-manifest
OIDC_CLIENT_ID=<registered-client-id>
OIDC_CLIENT_SECRET=<registered-client-secret>
OIDC_REDIRECT_URI=https://manifest.nuptechs.com/auth/callback
SESSION_SECRET=<random-production-secret>
```

O callback precisa estar registrado no cliente OIDC; veja `nupidentity-client-manifest.json`. Se o domínio público continuar atendido por `@probe/server`, as variáveis precisam estar nesse serviço também.

### Saúde da evidência (`GET /api/projects/:id/evidence-health`)

O `coverage` do `/graph` diz **quanto** do mapa é provado. Este endpoint responde a pergunta ortogonal — **a evidência ainda está chegando?** — porque o modo de falha real é o pipeline morrer de fome em silêncio: um serviço cai, o eixo `RUNTIME_OBSERVED` vai a 0, e o `/graph` segue respondendo 200 sem alarme. Um bloco por eixo (`static`, `config`, `runtime`, `analysis`) com `status` ∈ `fresh`|`stale`|`absent`|`unknown` + um veredito `overall` (`healthy`/`degraded`/`starving`). `absent` só alarma onde alguém **declarou** que o eixo deve fluir; `unknown` (Jaeger fora, overlay OFF) nunca vira acusação. Fail-soft absoluto: uma fonte quebrada vira `unknown` naquele eixo e o relatório sai inteiro. Para integrar um repo novo, ver [`integration-kit/`](integration-kit/README.md).

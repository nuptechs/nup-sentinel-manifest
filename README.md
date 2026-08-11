# NuP Sentinel Manifest — servidor de análise de evidência

> **Verificado @ cf394d3 · 2026-08-11.** Se código e este doc divergirem, o código vence — atualize este doc no MESMO PR.
<!-- doc-verify: on -->

Módulo servidor de análise da plataforma NuP Sentinel. Este repo PARSEIA um repositório-alvo, monta um grafo de aplicação, cataloga endpoints/permissões/entidades, e PROVÊ evidência via REST `/api/*`, com um veredito tri-eixo determinístico LOCAL (`server/reasoner/verdict.ts:computeEvidenceVerdict`).

Pacote npm: `@nuptechs/sentinel-manifest`. CLI: `@nuptechs/sentinel-manifest-cli`. Domínio SaaS: `sentinel-manifest.nuptechs.com`.

O que **NÃO** vive aqui, e sim no repo [`nup-sentinel`](https://github.com/nuptechs/nup-sentinel): o robô de tráfego sintético (NÃO há gerador de tráfego neste repo); o Tribunal de convergência multi-fonte completo (aqui é só a leitura tri-eixo do lado do manifest — o próprio `server/reasoner/verdict.ts:EvidenceTier` diz isso); as ferramentas MCP. Análise é **sob demanda** (HTTP `/api/analyze*` ou CLI) — NÃO há cron.

## Os quatro métodos de aresta (três de evidência + um de admissão)

Cada aresta carrega um método com confiança fixa (`server/analyzers/system-graph.ts:classifyEdgeEvidence`):

- **RUNTIME_OBSERVED** — traços OTel/Jaeger, `0.95`.
- **STATIC_PROVEN** — índice SCIP do build real, compiler-accurate, `0.80`.
- **CONFIG_PROVEN** — wiring DI do Spring, `0.78`.
- **STATIC_UNRESOLVED** — heurística Java/Node, `0.40` — NÃO é prova, é o que o mapa **admite não ter provado**.

`LLM_CONJECTURED` é coluna RESERVADA do censo (`server/analyzers/system-graph.ts:LLM_CONJECTURED`) — hoje =0, sem produtor; o frontend já a renderiza (`client/src/pages/system-map-evidence.tsx:LLM_CONJECTURED`). Slot preparado, não capacidade viva.

## A assimetria que importa: baked vs read-time

- **BAKED no snapshot** (gravadas na análise): `RUNTIME_OBSERVED` e as heurísticas Java/Node.
- **OVERLAY de LEITURA** (mescladas ao servir `/graph`): `STATIC_PROVEN` (scip) e `CONFIG_PROVEN` (config), via `server/analyzers/graph-overlays.ts:applyPersistedOverlays` (precedência **scip > config**).

Ou seja: scip/config NÃO são construídas na análise — são POSTadas por fora e aplicadas na leitura.

## O pipeline de análise

`server/pipeline/analysis-pipeline.ts:runFullAnalysis` — ~12 estágios imperativos hardcoded, não um registro com plugins; o seam de extensão é o bloco de augments (idempotente). Os rótulos "Step 1/4"/"Step 3/4" são cosméticos. Cache por projeto, TTL 30min, invalidado por hash SHA-256 (`server/pipeline/analysis-pipeline.ts:CACHE_TTL_MS`, `server/pipeline/analysis-pipeline.ts:graphCacheStore`, `server/pipeline/analysis-pipeline.ts:isCacheValid`).

Rotas: `POST /api/analyze` (`server/routes.ts:242`), `/api/analyze-zip` (`server/routes.ts:358`), `/api/projects/:id/analyze` (`server/routes.ts:719`).

## Ingestão de arestas provadas (por fora)

`POST /api/projects/:id/scip-edges` (`server/routes.ts:487`, schema `server/routes.ts:34`: só `edges[]`, `resolution` ∈ {compiler, interface-impl}). O campo `dataAccess` (função→tabela READ/WRITE) é DESCARTADO: o deriver `tools/scip-typescript/scip-data-access.mjs:deriveDataAccess` o produz, mas a agregação no servidor NÃO está ligada — nunca vira nó `table:<físico>` provado.

`POST /api/projects/:id/config-edges` (`server/routes.ts:541`, schema `server/routes.ts:59`: `resolution` ∈ {config}, store separado).

## Correlator de runtime

`server/analyzers/runtime-overlay.ts:resolveRuntimeOverlayConfig` — PULL do Jaeger, atribui por ROTA × TABELA por trace-id. NÃO há `session.id`/baggage/`X-Probe` aqui (a narrativa session-baggage do ADR-073 não está implementada neste repo). O runtime só observa FRONTEIRAS (serviço→serviço, serviço→banco) — o `observedRatio` NÃO tende a 1.0 por construção (teto correto da técnica).

Isolamento fail-closed (`server/analyzers/runtime-overlay.ts:resolveRuntimeOverlayConfig`): sem `JAEGER_QUERY_URL` ⇒ OFF; sem `runtimeOverlay.services` explícito ⇒ OFF (default `easynup-*` removido). Padrão de op interno (`server/analyzers/runtime-overlay.ts:DEFAULT_OP_RE`) ainda easynup — outros passam o seu via `conventionProfile.runtimeOverlay.opPathPattern`. LKG runtime TTL 7 dias (`server/analyzers/runtime-overlay.ts:DEFAULT_RUNTIME_LKG_TTL_MS`).

## IA: só read-time, opcional, sob checagem

A IA nunca decide — explica pós-fato, ancorada a id provado. TRÊS caminhos de LLM (não "uma porta só"), todos OpenAI via Replit AI Integrations:

- `server/reasoner/llm.ts:ReasonerLLM` — prosa do veredito;
- `server/analyzers/narrative-llm.ts:resolveEdgeClaimGenerator` — narrativa;
- `server/analyzers/semantic-engine.ts:classifyEntries` — classificação semântica, só sob demanda, fora do pipeline.

O grounding é a lei: `server/reasoner/grounding.ts:groundClaims` REMOVE todo claim sem âncora provada. O tier é determinístico; a prosa do LLM só passa se **não** contradiz o tier.

## Configuração — por-projeto vs global

Por projeto (`conventionProfile.runtimeOverlay` JSONB): `services` (allowlist OTel, obrigatória), `gatewayService`, `opPathPattern`, `lookbackMs`, `limit`. Global hardcoded: budgets scip (moduleCap 8000/edgeBudget 30000), calibração (alpha 0.1/minSamples 30), LKG TTL 7d.

## Armadilhas conhecidas (dívida)

- `server/analyzers/java-analyzer.ts:analyzeJavaFiles` = engine paralela obsoleta (0 imports; o pipeline usa o JAR via `server/analyzers/backend-java-client.ts:buildApplicationGraph`).
- `server/analyzers/system-graph.ts:isHeuristicResolution` casa qualquer `syntactic*` ⇒ `syntactic-resolved` (Java resolvido) sub-creditado a `0.40`.
- `server/analyzers/system-graph.ts:PRECISE_RESOLUTIONS` inclui `exact|type|import|direct` que nenhum produtor emite.

---

## Status, com honestidade (o que depende de configuração)

Veja **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** para o catálogo verificado `arquivo:símbolo` com status ✅/🟡/⚪.

Pontos que dependem de configuração (não de código) para produzir valor de verdade:

- O **emitter** para o Sentinel é no-op sem `SENTINEL_URL` + `SENTINEL_API_KEY` + `SENTINEL_PROJECT_ID`.
- O **motor Java** exige o JAR compilado em `java-analyzer-engine/target/`.
- O **seed** só cria o projeto "Customer Portal (Sample)"; analisar um repo real (ex.: EasyNuP) exige cadastrá-lo como projeto e disparar a análise.
- **GitHub App (1 clique, ADR-0019 Onda 5):** com `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (PEM ou base64) + `GITHUB_APP_WEBHOOK_SECRET`, o endpoint `/api/webhook/github-app` vira o bot: instalar o App na org ⇒ todo PR recebe o laudo (auto-onboard no 1º PR: cria projeto + indexa a branch default + comenta). Registro (uma vez, admin da org): GitHub → Settings → Developer settings → GitHub Apps → New — Webhook URL `https://<instância>/api/webhook/github-app` + secret; Permissions: Contents Read, Pull requests Read&Write, Metadata Read; Events: Pull request; gerar Private key e instalar na org. Sem os 3 envs ⇒ 503, nada muda.
- **Token de git persistente (ADR-0019 Onda 4):** com `MANIFEST_TOKEN_ENCRYPTION_KEY` (64 hex), o `git/connect` persiste o token CIFRADO (AES-256-GCM) — sobrevive a restart; webhooks GitHub/GitLab viram bots de PR/MR reais (laudo + comentário upsert). Sem a chave ⇒ memória-only como antes.
- A **assinatura do relatório de impacto** (ADR-0018 Onda 5, `POST /impact-diff`) só é emitida com `MANIFEST_REPORT_HMAC_KEY` setada (HMAC-SHA256 do JSON canônico; sem a chave o response é o mesmo de antes — OFF byte-a-byte, nunca assinatura fake). Ops (verificado ao vivo 2026-07-21): `manifest.nuptechs.com` é servido pelo serviço **@probe/server** (que também deploya este repo) — variável setada só no serviço `nup-sentinel-manifest` não afeta o domínio público; setar NOS DOIS. `serviceInstanceRedeploy` pega env nova normalmente.

### Saúde da evidência (`GET /api/projects/:id/evidence-health`)

O `coverage` do `/graph` diz **quanto** do mapa é provado. Este endpoint responde
a pergunta ortogonal — **a evidência ainda está chegando?** — porque o modo de
falha real é o pipeline morrer de fome em silêncio: um serviço cai, o eixo
`RUNTIME_OBSERVED` vai a 0, e o `/graph` segue respondendo 200 sem alarme algum.

```sh
curl -s -H "x-api-key: $KEY" "$URL/api/projects/27/evidence-health" | jq .
```

Um bloco por eixo (`static`, `config`, `runtime`, `analysis`) com
`status` ∈ `fresh` | `stale` | `absent` | `unknown`, a última evidência, a idade
em horas e o limiar aplicado; mais um veredito `overall`:

| `overall` | Significado |
|---|---|
| `healthy` | tudo que foi declarado está fluindo |
| `degraded` | um eixo que fluía parou, ou o runtime foi declarado e não entrega |
| `starving` | nenhum eixo está fresco — o mapa não é alimentado por nada |

`absent` só é alarme onde alguém **declarou** que o eixo deve fluir: um projeto
Node nunca terá wiring de Spring, e degradar por `config: absent` treinaria todo
mundo a ignorar o alarme. `unknown` (Jaeger fora do ar, overlay desligado)
nunca vira acusação — não se aponta falha sem saber.

Limiares por env (horas; valor inválido cai no default):
`EVIDENCE_HEALTH_STATIC_STALE_HOURS` (168), `..._CONFIG_...` (168),
`..._RUNTIME_...` (24), `..._ANALYSIS_...` (48).

Fail-soft absoluto: uma fonte quebrada vira `unknown` **naquele eixo** e o
relatório sai inteiro. Para integrar um repo novo, ver
[`integration-kit/`](integration-kit/README.md).

### Login do navegador

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

O callback acima precisa estar registrado no cliente OIDC; veja `nupidentity-client-manifest.json`. Se o domínio público continuar atendido por `@probe/server`, as variáveis precisam estar nesse serviço também.

## Arquitetura (stack)

Drizzle ORM + Postgres backend, React (Vite + Radix UI) admin frontend, sub-engine Java (`java-analyzer-engine/`) para análise JVM. Veja `nupidentity-client-manifest.json` para o registro do cliente OIDC usado no deploy contra NuPIdentify.

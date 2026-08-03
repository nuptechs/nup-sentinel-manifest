# NuP Sentinel Manifest

> Auth/schema analyzer module of the [NuP Sentinel](https://github.com/nuptechs/nup-sentinel) platform.

This package on npm is `@nuptechs/sentinel-manifest`. The CLI is `@nuptechs/sentinel-manifest-cli`. Domain when SaaS-deployed: `sentinel-manifest.nuptechs.com`.

## What it does

- Parses repos and inventories endpoints, permissions, schema fields, role/auth decorators (Java AST engine + frontend analyzer).
- Runs 6 security-omission detectors plus a frontend↔backend consistency detector (screens calling endpoints the backend doesn't expose), plus the ADR-070 Onda 4 graph critics (redundant paths and read/write lifecycle gaps over the domain graph).
- Emits Finding v2 records (`source: 'auto_manifest'`) into the central NuP Sentinel correlator — types `permission_drift`, `inconsistency`, and the ADR-070 Onda 4 graph critics `functional_overlap` and `lifecycle_gap` (`server/security/sentinel-emitter.ts:60,209,254,295`).
- Java analyzer engine (`java-analyzer-engine/`) runs as a sibling JVM process for Java/JVM repos.

Analysis is **on-demand** (HTTP `/api/analyze*` or CLI) — there is no cron.

## Status, com honestidade

Veja **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** para o catálogo verificado `arquivo:linha` com status ✅/🟡/⚪.

Pontos que dependem de configuração (não de código) para produzir valor de verdade:

- O **emitter** para o Sentinel é no-op sem `SENTINEL_URL` + `SENTINEL_API_KEY` + `SENTINEL_PROJECT_ID`.
- O **motor Java** exige o JAR compilado em `java-analyzer-engine/target/`.
- O **seed** só cria o projeto "Customer Portal (Sample)"; analisar um repo real (ex.: EasyNuP) exige cadastrá-lo como projeto e disparar a análise.
- **GitHub App (1 clique, ADR-0019 Onda 5):** com `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (PEM ou base64) + `GITHUB_APP_WEBHOOK_SECRET`, o endpoint `/api/webhook/github-app` vira o bot: instalar o App na org ⇒ todo PR recebe o laudo (auto-onboard no 1º PR: cria projeto + indexa a branch default + comenta). Registro (uma vez, admin da org): GitHub → Settings → Developer settings → GitHub Apps → New — Webhook URL `https://<instância>/api/webhook/github-app` + secret; Permissions: Contents Read, Pull requests Read&Write, Metadata Read; Events: Pull request; gerar Private key e instalar na org. Sem os 3 envs ⇒ 503, nada muda.
- **Token de git persistente (ADR-0019 Onda 4):** com `MANIFEST_TOKEN_ENCRYPTION_KEY` (64 hex), o `git/connect` persiste o token CIFRADO (AES-256-GCM) — sobrevive a restart; webhooks GitHub/GitLab viram bots de PR/MR reais (laudo + comentário upsert). Sem a chave ⇒ memória-only como antes.
- A **assinatura do relatório de impacto** (ADR-0018 Onda 5, `POST /impact-diff`) só é emitida com `MANIFEST_REPORT_HMAC_KEY` setada (HMAC-SHA256 do JSON canônico; sem a chave o response é o mesmo de antes — OFF byte-a-byte, nunca assinatura fake). Ops (verificado ao vivo 2026-07-21): `manifest.nuptechs.com` é servido pelo serviço **@probe/server** (que também deploya este repo) — variável setada só no serviço `nup-sentinel-manifest` não afeta o domínio público; setar NOS DOIS. `serviceInstanceRedeploy` pega env nova normalmente.

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

## Architecture

Drizzle ORM + Postgres backend, React (Vite + Radix UI) admin frontend, sub-engine Java for JVM analysis.

See `nupidentity-client-manifest.json` for the OIDC client registration manifest used at deploy time against NuPIdentify.

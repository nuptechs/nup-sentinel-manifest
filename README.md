# NuP Sentinel Manifest

> Auth/schema analyzer module of the [NuP Sentinel](https://github.com/nuptechs/nup-sentinel) platform.

This package on npm is `@nuptechs/sentinel-manifest`. The CLI is `@nuptechs/sentinel-manifest-cli`. Domain when SaaS-deployed: `sentinel-manifest.nuptechs.com`.

## What it does

- Parses repos and inventories endpoints, permissions, schema fields, role/auth decorators (Java AST engine + frontend analyzer).
- Runs 6 security-omission detectors plus a frontend↔backend consistency detector (screens calling endpoints the backend doesn't expose).
- Emits Finding v2 records (`source: 'auto_manifest'`, types `permission_drift` and `inconsistency`) into the central NuP Sentinel correlator.
- Java analyzer engine (`java-analyzer-engine/`) runs as a sibling JVM process for Java/JVM repos.

Analysis is **on-demand** (HTTP `/api/analyze*` or CLI) — there is no cron.

## Status, com honestidade

Veja **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** para o catálogo verificado `arquivo:linha` com status ✅/🟡/⚪.

Pontos que dependem de configuração (não de código) para produzir valor de verdade:

- O **emitter** para o Sentinel é no-op sem `SENTINEL_URL` + `SENTINEL_API_KEY` + `SENTINEL_PROJECT_ID`.
- O **motor Java** exige o JAR compilado em `java-analyzer-engine/target/`.
- O **seed** só cria o projeto "Customer Portal (Sample)"; analisar um repo real (ex.: EasyNuP) exige cadastrá-lo como projeto e disparar a análise.
- A **assinatura do relatório de impacto** (ADR-0018 Onda 5, `POST /impact-diff`) só é emitida com `MANIFEST_REPORT_HMAC_KEY` setada (HMAC-SHA256 do JSON canônico; sem a chave o response é o mesmo de antes — OFF byte-a-byte, nunca assinatura fake). Ops (verificado ao vivo 2026-07-21): `manifest.nuptechs.com` é servido pelo serviço **@probe/server** (que também deploya este repo) — variável setada só no serviço `nup-sentinel-manifest` não afeta o domínio público; setar NOS DOIS. `serviceInstanceRedeploy` pega env nova normalmente.

## Architecture

Drizzle ORM + Postgres backend, React (Vite + Radix UI) admin frontend, sub-engine Java for JVM analysis.

See `nupidentity-client-manifest.json` for the OIDC client registration manifest used at deploy time against NuPIdentify.

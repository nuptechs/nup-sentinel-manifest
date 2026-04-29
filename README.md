# NuP Sentinel Manifest

> Auth/schema analyzer module of the [NuP Sentinel](https://github.com/nuptechs/nup-sentinel) platform.

This package on npm is `@nuptechs/sentinel-manifest`. The CLI is `@nuptechs/sentinel-manifest-cli`. Domain when SaaS-deployed: `sentinel-manifest.nuptechs.com`.

## What it does

- Parses repos and inventories endpoints, permissions, schema fields, role/auth decorators.
- Emits Finding v2 records (with `source: 'auto_manifest'`) into the central NuP Sentinel correlator.
- Java analyzer engine (`java-analyzer-engine/`) runs as a sibling JVM process for Java/JVM repos.

## Architecture

Drizzle ORM + Postgres backend, React (Vite + Radix UI) admin frontend, sub-engine Java for JVM analysis.

See `nupidentity-client-manifest.json` for the OIDC client registration manifest used at deploy time against NuPIdentify.

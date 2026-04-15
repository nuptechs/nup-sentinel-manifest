# Manifest (PermaCat) — AI Agent Guidelines

## Overview

Static code analyzer and permission catalog generator. Scans Vue/React/Angular frontends + Spring Boot backends to produce security artifacts: permission manifests, OpenAPI specs, policy matrices, Keycloak configs, OPA Rego rules, and compliance reports. Includes a CLI tool and VSCode extension.

System ID: `manifest` — all OIDC permissions prefixed with `manifest:`.

## Tech Stack (Firmly Decided)

| Component | Technology |
|-----------|-----------|
| Web Server | Express + TypeScript (ESM) |
| Frontend | React 19 + Vite 6 + TailwindCSS 4 + Radix UI |
| CLI | Commander.js (ts-node) |
| Java Analyzer | Maven + JavaParser 3.26 + Spring reflection |
| VSCode Extension | VS Code API + esbuild |
| Database | PostgreSQL 16 + Drizzle ORM |
| Auth | NuPIdentity (OIDC/PKCE) + API Keys |
| Deploy | Docker (multi-stage: Node 20 + JRE 17) |

## Project Structure

```
server/
  routes.ts              ← All API endpoints
  analyzers/             ← Code scanning engines (frontend + semantic)
  generators/            ← Output formatters (manifest, OpenAPI, Keycloak, OPA, etc.)
  pipeline/              ← Analysis orchestration
  middleware/             ← JWT auth (OIDC) + API key validation
  storage.ts             ← File system abstraction
client/src/              ← React SPA (projects, results, catalog viewer)
shared/
  schema.ts              ← Drizzle tables + Zod validators
cli/src/commands/        ← init, analyze, export, connect, push
java-analyzer-engine/    ← Maven JAR — Spring Boot AST parsing
vscode-extension/src/    ← Local + remote analyzer, catalog tree view
```

## Dual Auth Model

1. **OIDC/JWT (interactive users)** — NuPIdentity, JWKS auto-discovery, permission normalization (strips `manifest:` prefix)
2. **API Keys (CI/CD, webhooks)** — format `pk_<hex>` (64 chars), SHA256-hashed in DB, project-scoped, last-used tracking

## Analysis Pipeline (core data flow)

1. Upload `.zip` or connect GitHub/GitLab repo
2. Repository scanner extracts `.java`, `.tsx`, `.vue`, `.ts` files
3. **Java Analyzer Engine** (subprocess) parses Spring Boot → endpoints + permissions
4. **Frontend Analyzer** extracts HTTP calls (fetch, axios, $http)
5. **Semantic Engine** correlates frontend calls ↔ backend endpoints
6. **Architecture Detector** validates layering (controller → service → repo)
7. **Generators** produce outputs (manifest, OpenAPI, policies, etc.)
8. Results stored in DB (`analysisRuns`, `sourceFiles`)

## Output Generators

| Format | Use Case |
|--------|----------|
| Manifest JSON | Import to NuPIdentity/IAM |
| OpenAPI YAML | API contract for clients |
| Policy Matrix CSV | Permission spreadsheet |
| Keycloak Realm JSON | Deploy to Keycloak directly |
| OPA Rego | Policy rules for OPA |
| Compliance HTML | Audit trail (GDPR, SOC2) |
| Agents MD | Human-readable docs |

## Database Schema

Key tables: `users`, `projects` (status: pending/processing/completed/failed, git integration), `sourceFiles` (path, content, hash), `analysisRuns` (totals, timing, errors).

## API Endpoints

```
POST   /api/analyze              # Headless analysis (send files, get catalog)
POST   /api/analyze-zip          # Upload ZIP, analyze
POST   /api/projects             # Create project
GET    /api/projects/:id         # Project details
POST   /api/projects/:id/analyze # Trigger analysis
GET    /api/analysis/:runId      # Status & results
POST   /api/projects/:id/connect-git  # GitHub/GitLab webhook
POST   /api/webhook/github       # Push event handler
POST   /api/webhook/gitlab       # Push event handler
POST   /api/apikeys/generate     # Create API key for CI/CD
```

## Build & Test

```bash
npm run dev          # Server (5000) + Client (5173)
npm run build        # Production build
npm run check        # TypeScript check
npm run db:push      # Push schema to DB
```

## Key Conventions

- Java analyzer runs as a subprocess — communicate via HTTP, not in-process
- Chunked upload for large repos (60MB chunks, auto-expire after 1h)
- Webhook secret validation on all GitHub/GitLab events
- All Zod validators co-located with Drizzle schema in `shared/schema.ts`

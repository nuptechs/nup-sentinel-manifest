# PermaCat - Code-to-Permission Catalog Generator

## Overview
PermaCat is an enterprise-grade static code intelligence tool designed to analyze frontend (Vue/React/Angular) and Spring Boot backend source code. Its primary purpose is to automatically generate a Technical Action Catalog for Identity and Access Management (IAM) systems. This tool aims to streamline the process of understanding and managing permissions by providing a comprehensive overview of technical operations derived directly from the codebase. The project envisions creating a comprehensive, editable catalog that bridges the gap between code implementation and IAM requirements, facilitating better security and compliance.

## User Preferences
I want iterative development. I expect you to ask clarifying questions about the implementation details and decisions. I prefer detailed explanations for complex parts of the code.

## System Architecture
The application features a frontend built with React, TypeScript, Shadcn UI, and TailwindCSS. The backend is powered by Express, TypeScript, Drizzle ORM, and PostgreSQL. A standalone JVM service, utilizing the JavaParser AST library, handles Spring Boot code analysis. Frontend analysis is performed using the TypeScript compiler API (React/JS/TS), `@vue/compiler-sfc` (Vue SFCs), and `@angular/compiler` (Angular templates). A Semantic Engine, powered by OpenAI LLM (via Replit AI Integrations), is used for classifying technical operations and assigning criticality scores.

Key features include ZIP repository upload for automatic scanning, individual file uploads, AST-based parsing of frontend interaction points and Java backend components (controllers, services, repositories, entities), and building a graph connecting frontend interactions to backend endpoints with full method tracing. The system supports backend-only catalog generation, an editable catalog with human classification support, and first-class manifest output generation.

A **Manifest Generation System** produces four pipeline-ready output formats from catalog entries: MANIFEST.json, AGENTS.md, OpenAPI 3.0.3 Spec, and Policy Matrix (including Keycloak, Okta, and AWS IAM policies).

The Java Backend Analyzer uses JavaParser with JavaSymbolSolver for semantic AST analysis. The Frontend Analyzer, built in Node.js, uses framework-specific AST parsers to resolve handlers, trace HTTP calls, and identify HTTP client identifiers, employing a multi-pass architecture for robust cross-file HTTP service resolution and an eight-tier HTTP resolution system. The system constructs an in-memory Application Graph model, facilitating detailed traversal and impact analysis.

The enriched catalog model captures extensive metadata for each entry, including `resolutionPath`, `architectureType`, `interactionCategory`, `confidence`, `requiredRoles` (from Spring Security annotations), `securityAnnotations`, `entityFieldsMetadata` (JPA entity field enrichment including validation and sensitivity), `sensitiveFieldsAccessed`, `frontendRoute`, and `routeGuards`. Spring Security annotations are extracted, including SpEL expression parsing. JPA entity fields are enriched, and frontend router definitions (Vue Router, React Router, Angular Router) are parsed.

An **Analysis Pipeline** encapsulates the full analysis workflow: graph construction, architecture detection, endpoint analysis, frontend interaction scanning, graph connection, deterministic classification, persistence, and finalization. It includes **Hybrid Incremental Analysis** with in-memory caching per project based on file content SHA-256 hashes, allowing reuse of frontend or backend analysis results if only one part of the codebase changes.

A **Manifest Diff Engine** compares two analysis snapshots to produce structured diffs covering endpoints, screens, roles, entities, and security impact, storing analysis snapshots in the `analysis_snapshots` table.

A **Git Integration System** provides first-class support for GitHub and GitLab repositories through an abstraction layer, enabling connection, branch listing, pull request analysis, and triggering analysis on connected projects via webhooks. PR analysis involves dual-branch analysis and manifest diff generation for security reports.

A **Platform Integration System** enables external system access via API Key Authentication (with project-scoped access and last-used tracking), Headless Analysis Endpoints for single-call or ZIP uploads, comprehensive OpenAPI Documentation, and Webhook Integration for GitHub and GitLab to auto-trigger analysis on configured projects.

A **System Explorer** page provides a visual map of the analyzed system, grouping catalog entries by screen, with clickable interaction blocks that display a detailed trace panel showing the full resolution path from Frontend Interaction to Entities Touched, including all relevant metadata.

## External Dependencies
- PostgreSQL
- OpenAI LLM (via Replit AI Integrations)
- Java JDK 17
- Maven
- Node.js 20
- `JavaParser` library with `JavaSymbolSolver`
- `@vue/compiler-sfc`
- `@angular/compiler`
- `adm-zip`
- `multer`
- `commander` (CLI tool)
- `chalk` (CLI output formatting)
- `cli-table3` (CLI table formatting)
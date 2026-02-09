# PermaCat - Code-to-Permission Catalog Generator

## Overview
PermaCat is an enterprise-grade static code intelligence tool designed to analyze frontend (Vue/React/Angular) and Spring Boot backend source code. Its primary purpose is to automatically generate a Technical Action Catalog for Identity and Access Management (IAM) systems. This tool aims to streamline the process of understanding and managing permissions by providing a comprehensive overview of technical operations derived directly from the codebase.

## User Preferences
I want iterative development. I expect you to ask clarifying questions about the implementation details and decisions. I prefer detailed explanations for complex parts of the code.

## System Architecture
The application features a frontend built with React, TypeScript, Shadcn UI, and TailwindCSS. The backend is powered by Express, TypeScript, Drizzle ORM, and PostgreSQL. A standalone JVM service, utilizing the JavaParser AST library, handles Spring Boot code analysis. Frontend analysis is performed using the TypeScript compiler API (React/JS/TS), `@vue/compiler-sfc` (Vue SFCs), and `@angular/compiler` (Angular templates). A Semantic Engine, powered by OpenAI LLM (via Replit AI Integrations), is used for classifying technical operations and assigning criticality scores.

Key features include ZIP repository upload for automatic scanning, individual file uploads, AST-based parsing of frontend interaction points and Java backend components (controllers, services, repositories, entities), and building a graph connecting frontend interactions to backend endpoints with full method tracing. The system supports backend-only catalog generation, an editable catalog with human classification support, and JSON export.

The Java Backend Analyzer uses JavaParser with JavaSymbolSolver for semantic AST analysis, resolving method calls, and tracing repository-to-entity relationships via generics. It runs as an HTTP service, auto-started by the Node.js client. The Frontend Analyzer, built in Node.js, uses framework-specific AST parsers to resolve handlers, trace HTTP calls, and identify HTTP client identifiers. It implements a two-pass architecture for cross-file HTTP service resolution, handling imported functions and local variable URL tracing.

The system constructs an in-memory Application Graph model to represent the backend, with `GraphNode` and `GraphEdge` objects, allowing for detailed traversal and impact analysis per controller endpoint. The data flow involves storing uploaded source files, analyzing them with both Java and Node.js engines, reconstructing the Application Graph, generating `EndpointImpact` objects, and then converting `FrontendInteractions` into catalog entries. A deterministic classifier assigns `technicalOperation`, `criticalityScore`, and `suggestedMeaning` based on predefined rules, with an optional LLM enrichment step for refinement. The system also includes a robust repository scanner for ZIP file processing, handling large files efficiently by ignoring irrelevant directories and supporting chunked uploads to bypass size limitations.

## Frontend Analyzer Details

### Cross-File HTTP Service Resolution (Two-Pass Architecture)
- **Pass 1 — HttpServiceMap**: Pre-scan ALL source files to build a global map of exported functions/methods that contain HTTP calls
  - `HttpServiceMap`: `Map<filePath, Map<exportName, HttpServiceEntry>>` where entry = `{url, method, functionName}`
  - Scans function declarations, arrow functions, class methods for HTTP call expressions
  - Tracks class inheritance: `extends` clauses merge parent HTTP methods into child classes
  - Handles default exports, named exports, and class method exports with multiple key prefixes (`className.method`, `default.method`, `exportName.method`)
- **Pass 2 — Import Resolution**: When single-file `traceHttpCalls` returns no results, resolves via cross-file imports
  - `resolveImportedServiceMap(fileImports, httpServiceMap)` maps import specifiers to service entries
  - Supports `@/` alias resolution (maps to `src/` directory) and relative path resolution
  - `resolveBindingsViaNodes(bindings, resolvedImports)` performs transitive call graph traversal: traces handler → imported function → HTTP call
  - Depth-limited to 5 levels to prevent cycles
- **Local Variable URL Tracing**: `resolveUrlFromExpression` recursively resolves identifiers in template literals, binary expressions, and call expressions
  - Template expressions: resolves each span identifier via `varMap` before substituting `{param}`
  - `buildEndpoint()` / `buildUrl()` pattern: extracts string arguments → `{base}/operation`
  - BaseApiService pattern: `buildEndpoint('create', true)` → `{base}/create`, enabling 100% match rate to WS operation controllers
- **Architecture detection** (`architecture-detector.ts`): Classifies backend as REST_CONTROLLER (standard `/api/` paths) or WS_OPERATION_BASED (WebSocket-like controllers using className matching); affects URL-to-controller matching strategy
- **Validated on large production codebase** (easynup): URL extraction 6.3x improvement (146→922), controller matching 4.4x improvement (146→640), {base} URLs 100% matched (306/306)

### Global Function Call Graph (Three-Tier Resolution)
- **Purpose**: Third-tier fallback for HTTP resolution when local tracing and cross-file service map both fail. Handles deeply nested call chains where handler → composable → service → HTTP call spans multiple intermediate functions.
- **Architecture**: `GlobalCallGraph = Map<qualifiedKey, GlobalCallGraphNode>` where key = `filePath::functionName`
- **Node structure**: `{ filePath, functionName, httpCalls (direct), callees (Set<qualifiedKey>), callers (Set<qualifiedKey>), propagatedHttpCalls (HttpCall[]) }`
- **Build phase** (`buildGlobalCallGraph`):
  1. Scan all source files, extract function/method declarations with qualified keys
  2. For each function body, detect direct HTTP calls (fetch, axios, etc.) and call sites to other functions
  3. Resolve cross-file edges: parse imports via `parseImportBindingsInternal`, create callee edges like `targetPath::default.methodName`
  4. Seed HTTP leaves from both direct calls and HttpServiceMap entries
- **Propagation phase** (`propagateHttpCapability`): BFS from HTTP leaf functions backward through reverse call graph edges
  - Merges propagated HTTP calls into callers
  - Handles cycles via visited set tracking
  - Result: every function that transitively leads to an HTTP call gets the resolved URLs
- **Lookup** (`lookupGlobalCallGraph`): Given handler name + file path, tries qualified key lookup, then import-resolved lookup
- **Integration**: Built after HttpServiceMap in `analyzeFrontend`, passed to Vue/React/Angular file analyzers via `resolveBindingsViaNodes`
- **Resolution order**: (1) `ScriptSymbolTable.traceHttpCalls` → (2) `resolveExternalCallsToHttpCalls` → (3) `lookupGlobalCallGraph`

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

# PermaCat - Code-to-Permission Catalog Generator

## Overview
PermaCat is an enterprise-grade static code intelligence tool designed to analyze frontend (Vue/React/Angular) and Spring Boot backend source code. Its primary purpose is to automatically generate a Technical Action Catalog for Identity and Access Management (IAM) systems. This tool aims to streamline the process of understanding and managing permissions by providing a comprehensive overview of technical operations derived directly from the codebase. The project envisions creating a comprehensive, editable catalog that bridges the gap between code implementation and IAM requirements, facilitating better security and compliance.

## User Preferences
I want iterative development. I expect you to ask clarifying questions about the implementation details and decisions. I prefer detailed explanations for complex parts of the code.

## System Architecture
The application features a frontend built with React, TypeScript, Shadcn UI, and TailwindCSS. The backend is powered by Express, TypeScript, Drizzle ORM, and PostgreSQL. A standalone JVM service, utilizing the JavaParser AST library, handles Spring Boot code analysis. Frontend analysis is performed using the TypeScript compiler API (React/JS/TS), `@vue/compiler-sfc` (Vue SFCs), and `@angular/compiler` (Angular templates). A Semantic Engine, powered by OpenAI LLM (via Replit AI Integrations), is used for classifying technical operations and assigning criticality scores.

Key features include ZIP repository upload for automatic scanning, individual file uploads, AST-based parsing of frontend interaction points and Java backend components (controllers, services, repositories, entities), and building a graph connecting frontend interactions to backend endpoints with full method tracing. The system supports backend-only catalog generation, an editable catalog with human classification support, and JSON export.

The Java Backend Analyzer uses JavaParser with JavaSymbolSolver for semantic AST analysis. The Frontend Analyzer, built in Node.js, uses framework-specific AST parsers to resolve handlers, trace HTTP calls, and identify HTTP client identifiers. It implements a multi-pass architecture for robust cross-file HTTP service resolution, local variable URL tracing, and global function call graph analysis. Advanced resolution mechanisms include a Component Event Graph for propagating HTTP resolution through component event boundaries, a State Flow Graph for tracing HTTP calls through state management systems (Pinia, Vuex, Redux, Angular services), and an Architectural Layer Graph for symbol-first architectural traversal (handler → resolved symbol → owning file → architectural climb via imports to repositories).

### Six-Tier HTTP Resolution System (resolveHandlerHttpCalls)
1. **Local HTTP Calls**: Direct HTTP calls in handler via ScriptSymbolTable.traceHttpCalls
2. **External Calls**: Imported functions resolved via importBindings + HttpServiceMap
3. **Global Call Graph**: Cross-file function call propagation with HTTP call inheritance
4. **Event Graph**: Parent component event handlers traced for HTTP calls
5. **State Flow Graph**: State write→read chains connecting handlers to HTTP-calling functions
6. **Architectural Layer Graph**: Symbol-first approach — handler's called symbols → resolve via importBindings to target file → classify role (facade/usecase/repository) → climb import chain following role constraints → collect repository HTTP calls. Key rule: architectural traversal ONLY after concrete symbol target is known.

### Architectural Layer Graph (Sixth-Tier Resolution) — ACTIVE (symbol-first)
- **Correct algorithm**: handler → external calls filtered by handler scope (relevantFunctions) → resolve each imported name to sourcePath via importBindings → one specific target file → climb from there following role constraints
- **Previous failed attempt**: Used file-level imports (ALL imports) → 7x over-resolution. Fixed by switching to symbol-first approach.
- **Data structures**: `ArchitecturalLayerGraph { roleByFile, importsByFile, repositoryHttpCalls }`
- **Role classification** (`classifyFileRole`): .vue→component, HTTP calls in serviceMap→repository, @Component/defineComponent/JSX→component, @Injectable/@Service→facade, class declarations→usecase, else→unknown
- **Validated on easynup**: 2444 total entries, 1017 with endpoints, 685 with controllers, 317 {base} URLs (near-zero false positives, +3 genuine new resolutions vs baseline)

### Enriched Catalog Model
Each catalog entry now carries full resolution metadata directly from the analyzer (no inference/heuristics):
- **resolutionPath** (jsonb): Ordered array of `{ tier, file, function, detail }` steps showing exactly how the endpoint was discovered
- **resolutionStrategy** (text): Which tier(s) resolved the call (e.g., "local", "serviceMap", "eventGraph+serviceMap", "architecturalLayerGraph")
- **architectureType** (text): "REST_CONTROLLER" or "WS_OPERATION_BASED"
- **interactionCategory** (text): "HTTP", "UI_ONLY", or "STATE_ONLY" — entries with null endpoint are UI_ONLY, not errors
- **confidence** (real, 0–1): Based on resolution tier depth (local=1.0, serviceMap=0.95, globalCallGraph=0.85, eventGraph=0.80, stateFlowGraph=0.65, architecturalLayerGraph=0.55)

Resolution metadata is attached via `__resolution` property on `HttpCall[]` arrays inside `resolveHandlerHttpCalls`, read in `resolveBindingsViaNodes`, stored in `FrontendInteraction`, and persisted to the catalog by graph-connector. The analyzer functions themselves are unchanged — only the data propagation was added.

The system constructs an in-memory Application Graph model, representing backend components and their interactions, enabling detailed traversal and impact analysis. Data flow involves source file analysis by both Java and Node.js engines, graph reconstruction, and conversion into catalog entries. A deterministic classifier assigns `technicalOperation`, `criticalityScore`, and `suggestedMeaning`, with optional LLM enrichment. A robust repository scanner handles large ZIP files efficiently. Database inserts for catalog entries are batched to prevent performance issues with large result sets.

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
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
- **Resolution order**: (1) `ScriptSymbolTable.traceHttpCalls` → (2) `resolveExternalCallsToHttpCalls` → (3) `lookupGlobalCallGraph` → (4) `lookupEventGraph` → (5) `lookupStateFlowGraph`

### Component Event Graph (Fourth-Tier Resolution)
- **Purpose**: Propagates HTTP resolution through component event boundaries ($emit in Vue, callback props in React, @Output in Angular). When a child component handler emits an event that is listened to by a parent handler which resolves to HTTP, the child handler inherits that HTTP mapping.
- **Data structures**:
  - `ComponentEventGraph`: `{ emitters, listeners, componentRegistry }`
  - `emitters`: `Map<filePath, ComponentEmitEntry[]>` where entry = `{ eventName, emitterFunction }`
  - `listeners`: `Map<parentFilePath, EventListenerEntry[]>` where entry = `{ childTag, childFilePath, eventName, parentHandler }`
  - `componentRegistry`: `Map<tagName, filePath>` mapping PascalCase + kebab-case tag names to file paths
- **Component Registry** (`buildComponentRegistry`):
  - Registers all source files by filename-derived PascalCase, kebab-case, and base name
  - Scans import declarations in Vue/React/Angular files to map imported component names to resolved file paths
  - Uses `normalizeModulePath` (now supports `.vue` extensions) for cross-file resolution
- **Emit detection** per framework:
  - Vue: `this.$emit('event')`, `emit('event')` (Composition API), `context.emit('event')` — tracked with enclosing function name
  - React: `props.onEventName()` or destructured `onEventName()` callback invocations
  - Angular: `@Output() eventName = new EventEmitter()` + `this.eventName.emit()` patterns
- **Listener detection** in parent templates:
  - Vue: `<ChildComponent @eventName="parentHandler">` — detects custom component tags via `isCustomComponentTag`
  - React: `<ChildComponent onEventName={parentHandler}>` — capitalized JSX tags with `on*` props
  - Angular: `<child-component (eventName)="parentHandler()">` — custom elements with outputs
- **Event name normalization** (`normalizeEventName`): strips `on` prefix, removes dashes/underscores, lowercases for cross-framework matching
- **Resolution** (`lookupEventGraph`): finds emitted events for handler → scans all parent listeners for matching events → resolves parent handler via full 3-tier pipeline (local → cross-file → global call graph)
- **Integration**: Built as pre-pass in `analyzeFrontend` alongside serviceMap and globalCallGraph, passed through to `resolveBindingsViaNodes` → `resolveHandlerHttpCalls`
- **Validated on easynup**: endpoints 972→1014 (+42), controller matches 657→683 (+26), {base} URLs 306→317 (+11)

### State Flow Graph (Fifth-Tier Resolution)
- **Purpose**: Resolves HTTP calls through state management boundaries. When a handler writes to a state container (Pinia/Vuex store, Redux slice, Angular service, composable) and a separate function reads that state field and makes an HTTP call, the handler inherits the HTTP mapping.
- **Data structures**:
  - `StateFlowGraph`: `{ writers, readers, containerFiles }`
  - `writers`: `Map<qualifiedField, StateFieldWrite[]>` where entry = `{ containerFile, containerName, fieldName, writerFunction, qualifiedField }`
  - `readers`: `Map<qualifiedField, StateFieldRead[]>` where entry = `{ containerFile, containerName, fieldName, readerFunction, httpCalls }`
  - `containerFiles`: `Set<string>` of detected state container file paths
  - Qualified field format: `${containerFilePath}::${containerName}.${fieldName}`
- **Container detection** (`detectStateContainers`):
  - Pinia: `defineStore('name', ...)` — extracts store name and state fields from setup function or options object
  - Vuex: `createStore({...})` — extracts state fields from state option
  - Redux: `createSlice({name, initialState, reducers})` — extracts fields from initialState, writers from reducer functions
  - Angular: `@Injectable()` class declarations — extracts class properties as state fields
  - Composables: Functions returning objects with `ref()`, `reactive()`, or `useState()` calls — extracts reactive variable names
- **Write detection** (`detectStateWrites`): Scans all source files for:
  - Vuex mutations/actions: `commit('mutationName')`, `dispatch('actionName')`
  - Pinia direct assignment: `store.field = value`, `store.$patch({field: value})`
  - Redux dispatch: `dispatch(actionCreator())` 
  - Angular service assignment: `this.service.field = value`
  - Generic setter calls: `setFieldName(value)` patterns matching container fields
- **Read detection** (`detectStateReads`): Scans functions that contain HTTP calls for:
  - Direct property access: `store.field`, `this.service.field`
  - Computed/getter patterns: functions referencing state fields
  - Watch/effect patterns: `watch(() => store.field, ...)`, `useEffect` with state dependencies
- **Lookup** (`lookupStateFlowGraph`): Given handler name + file path, checks if handler calls any state-writing function → finds readers of same state fields with HTTP calls → returns those HTTP calls
- **Integration**: Built as pre-pass in `analyzeFrontend` alongside serviceMap, globalCallGraph, and eventGraph, passed through to `resolveBindingsViaNodes` → `resolveHandlerHttpCalls`
- **Validated on easynup**: no change in metrics (1014 endpoints, 683 controllers, 317 {base} URLs) as expected for WS operation-based architecture that doesn't use state management patterns for HTTP triggering

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

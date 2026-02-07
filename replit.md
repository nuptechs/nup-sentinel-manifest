# PermaCat - Code-to-Permission Catalog Generator

## Overview
Enterprise-grade static code intelligence tool that analyzes frontend (Vue/React/Angular) and Spring Boot backend source code to automatically generate a Technical Action Catalog for IAM (Identity and Access Management) systems.

## Architecture
- **Frontend**: React + TypeScript + Shadcn UI + TailwindCSS
- **Backend**: Express + TypeScript + Drizzle ORM + PostgreSQL
- **Java Analysis Engine**: Standalone JVM service using JavaParser AST library for Spring Boot code analysis
- **Frontend Analysis Engine**: TypeScript compiler API (React/JS/TS), @vue/compiler-sfc (Vue SFCs), @angular/compiler (Angular templates)
- **Semantic Engine**: OpenAI LLM (via Replit AI Integrations) for classifying technical operations and criticality scores

## Key Features
1. Upload project source files (Vue/React/Angular frontend + Java Spring Boot backend)
2. Analyze frontend for interaction points (buttons, forms, HTTP calls, navigation) using real AST parsers
3. Parse Java controllers, services, repositories, and entities using JavaParser (JVM-based AST)
4. Build a graph connecting frontend interactions to backend endpoints with full method tracing
5. LLM-powered semantic classification of technical operations and criticality scores
6. Editable catalog with human classification support
7. JSON export of the full catalog

## Project Structure
```
java-analyzer-engine/           - Standalone Java service (JavaParser + Symbol Solver)
  pom.xml                       - Maven build with JavaParser, Gson dependencies
  src/main/java/com/permacat/
    analyzer/
      AnalyzerServer.java       - HTTP server (port 9876) with /analyze and /health endpoints
      JavaASTAnalyzer.java      - JavaParser-based AST analyzer for Spring Boot code
    model/
      GraphNodeDTO.java         - Node DTO matching ApplicationGraph format
      GraphEdgeDTO.java         - Edge DTO matching ApplicationGraph format
      AnalysisResult.java       - Response model (nodes + edges)

client/src/
  App.tsx                       - Main app with sidebar layout
  pages/
    dashboard.tsx               - Overview stats and recent activity
    upload.tsx                  - Project file upload (paste or file upload)
    catalog.tsx                 - Catalog viewer with filters, search, detail dialog
  components/
    app-sidebar.tsx             - Navigation sidebar
    theme-toggle.tsx            - Dark/light mode toggle
  lib/
    theme-provider.tsx          - Theme context provider

server/
  index.ts                      - Express server entry point
  routes.ts                     - API endpoints (uses async buildApplicationGraphAsync)
  storage.ts                    - Database storage layer (IStorage interface)
  db.ts                         - Database connection
  seed.ts                       - Sample project seed data
  analyzers/
    application-graph.ts        - ApplicationGraph model (GraphNode, GraphEdge, analyzeEndpoints)
    backend-java-client.ts      - Node.js client that spawns/communicates with Java engine
    frontend-analyzer.ts        - AST-based frontend analyzer (Vue/React/Angular)
    graph-connector.ts          - Converts FrontendInteractions to catalog entries
    semantic-engine.ts          - LLM classification of operations

shared/
  schema.ts                     - Drizzle ORM schema (projects, source_files, analysis_runs, catalog_entries)
```

## Analyzer Architecture

### Java Backend Analyzer (JVM-based) — PURE SYMBOL RESOLUTION
- Uses **JavaParser** library with **JavaSymbolSolver** for semantic AST analysis
- **CombinedTypeSolver**: ReflectionTypeSolver (JDK types) + JavaParserTypeSolver (project source types)
- Writes source files to temp directory for JavaParserTypeSolver filesystem access
- **SymbolMap**: Maps `ResolvedReferenceTypeDeclaration` → `ClassInfo` (qualified-name-keyed internally for proper identity across resolve() calls)
- `cls.resolve()` binds each `ClassOrInterfaceDeclaration` to its resolved symbol during class scanning phase
- `callExpr.resolve()` resolves method calls; `resolved.declaringType()` used as primary key into SymbolMap to find target ClassInfo
- **Scope type fallback**: when `declaringType()` resolves to a framework class (e.g., JpaRepository), falls back to `callExpr.getScope().calculateResolvedType()` to find the actual field type (e.g., UserRepository) in SymbolMap — enables service→repository edges for inherited methods
- **MethodCallInfo** stores both `resolvedDeclaringType` (declaring class) and `resolvedScopeType` (callee field type) for two-level lookup
- **No heuristic fallback**: if `callExpr.resolve()` fails, the edge is silently skipped (no processHeuristicCall, no resolveTargetType, no isInjectableType)
- **Repository→Entity via generics**: extracts entity type from `JpaRepository<Entity, ID>` generic type parameters using `typeArgs.get(0).resolve()` through symbol solver — no naming convention (`UserRepository→User` removed)
- **ClassInfo** stores `ResolvedReferenceTypeDeclaration resolvedSymbol` and `resolvedEntitySymbol` for repositories
- **ReflectionTypeSolver(false)**: includes full classpath (Spring framework JARs) for resolving inherited framework methods
- Runs as a standalone HTTP service on port 9876 (auto-started by Node.js client)
- Detects: @RestController, @Service, @Repository, @Entity annotations via AST
- Returns JSON matching ApplicationGraph node/edge format with WRITES_ENTITY/READS_ENTITY edges from repository→entity resolution

### Frontend Analyzer (Node.js-based) — PURE NODE REFERENCE RESOLUTION
- **ScriptSymbolTable**: `nodeMap: Map<ts.Node, SymbolDeclaration>` (node-keyed), `nameIndex: Map<string, ts.Node>` (thin name→node index for initial template binding)
- **SymbolDeclaration**: `calledNodes: ts.Node[]` (node references, not string names)
- **Handler resolution**: `resolveHandlerNode(name) → ts.Node` resolves template handler name to AST node ONCE; all subsequent tracing uses node references
- **Call chain tracing**: `traceHttpCalls(node: ts.Node)` follows `calledNodes: ts.Node[]` graph — no string-based trace
- **ImportedHttpClients**: Indexes import declarations to identify HTTP client identifiers (axios, @angular/common/http, api/service imports); CallExpression callee objects verified against imported identifiers instead of pattern-matching against string lists
- **React/JSX/TSX**: TypeScript compiler API (ts.createSourceFile) for full AST parsing
- **Vue SFCs**: @vue/compiler-sfc for SFC parsing + template AST walking, TypeScript compiler API for script blocks
- **Angular**: @angular/compiler (parseTemplate) for template AST, TypeScript compiler API for component files
- **URL matching**: Segment-by-segment URL scoring against ApplicationGraph controller nodes

## Application Graph Model
The backend is represented as a navigable in-memory graph:
- **GraphNode** (id, type: CONTROLLER|SERVICE|REPOSITORY|ENTITY, className, methodName, metadata)
- **GraphEdge** (fromNode, toNode, relationType: CALLS|WRITES_ENTITY|READS_ENTITY, metadata)
- **ApplicationGraph** class with addNode/addEdge, getNodesByType, reachableFrom(nodeId), toJSON
- **buildApplicationGraphAsync(files)** calls Java engine then reconstructs graph from JSON
- **analyzeGraphEndpoints(graph)** traverses the graph per controller endpoint to produce EndpointImpact
- **EndpointImpact** contains endpoint, involvedNodes, entitiesTouched, callDepth, fullCallChain, persistenceOperations

## Data Flow
1. User uploads source files → stored in `source_files` table
2. Analysis triggered → Java files sent to JVM engine, frontend files analyzed in Node.js
3. Java engine parses all Java files via JavaParser AST → returns nodes + edges JSON
4. Node.js client reconstructs ApplicationGraph from JSON response
5. analyzeGraphEndpoints() traverses the graph per controller endpoint to produce EndpointImpact
6. analyzeFrontend() uses framework-specific AST parsers to extract UI elements with event handlers, trace handler functions to HTTP calls, and match URLs to controller nodes in ApplicationGraph
7. Graph connector converts FrontendInteractions (with mapped GraphNodes) into catalog entries, traversing ApplicationGraph for full call chains
8. Semantic engine classifies operations via LLM
9. Catalog entries stored in database
10. UI displays with filtering, search, editing, and JSON export

## API Endpoints
- GET /api/stats - Dashboard statistics
- GET /api/projects - List all projects
- POST /api/projects - Create project with source files
- POST /api/projects/:id/analyze - Run analysis pipeline
- GET /api/catalog-entries/:projectId - Get catalog entries
- PATCH /api/catalog-entries/:id - Update human classification
- GET /api/catalog-entries/:projectId/export - Export catalog as JSON
- GET /api/analysis-runs/recent - Recent analysis runs

## System Dependencies
- Java JDK 17 (for JavaParser-based analyzer engine)
- Maven (for building the Java analyzer JAR)
- Node.js 20 (for Express server and frontend analyzers)

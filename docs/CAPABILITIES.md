# Catálogo de capacidades — NuP Sentinel Manifest

> Verificado @ a889914 · 2026-10-06. Código vence o doc.
<!-- doc-verify: on -->

Estado **real** do código, ancorado por `arquivo:símbolo` (ref de linha `arquivo:NNN` só como auxílio humano — linha é frágil; o contrato forte é o símbolo). Sem promessa do que não existe. 320 funcionalidades em 25 domínios.

Convenção de estado:

- ✅ **vivo** — roda de ponta a ponta no fluxo normal, determinístico.
- 🟡 **depende de config/cadastro/token** — código ligado, só produz efeito sob condição externa (env, projeto cadastrado, JAR, token Git, Sentinel no ar, chave LLM/HMAC).
- 🟦 **flag OFF por default** — atrás de `MANIFEST_MULTISTACK_*` (G2: OFF = byte-a-byte).
- ⚪ **slot sem produtor / stub / dívida** — esqueleto presente, não entrega valor sozinho hoje.

Marcação de natureza: **(prova)** = compiler-accurate / AST real / regra determinística; **(heur.)** = regex / nome / score honestamente rotulado; **(LLM opt.)** = LLM só explica pós-fato, veredito/estrutura determinísticos, fallback template sem chave.

---

## 1. API HTTP — Inventário de rotas (`server/routes.ts`)

88 rotas montadas em `server/routes.ts`. Método + caminho · o que faz · linha · estado.

| Rota | O que faz | Linha | Estado |
|---|---|---|---|
| `GET /health` · `/healthz` | Liveness | `:177` | ✅ |
| `GET /ready` | Readiness | `:180` | ✅ |
| `GET /api/auth/me` | Quem-sou-eu (resolve OIDC **ou** API key) | `:189` | ✅ |
| `POST /api/keys` | Cria API key (hash + prefixo) | `:214` | ✅ |
| `GET /api/keys` | Lista API keys | `:244` | ✅ |
| `DELETE /api/keys/:id` | Revoga API key | `:260` | ✅ |
| `POST /api/analyze` | Analisa `fileData[]` + gera artefatos por `?format=` | `:271` | ✅ |
| `POST /api/analyze-zip` | Analisa ZIP base64 | `:387` | ✅ |
| `GET /api/docs/openapi.json` | OpenAPI do próprio servidor | `:452` | ✅ |
| `GET /api/docs` | Swagger UI | `:457` | ✅ |
| `GET .../security-findings` | Lista findings de segurança do projeto | `:468` | ✅ |
| `POST .../codelens-extraction` | Ingestão de catálogo vindo do Codelens | `:487` | 🟡 (produtor externo) |
| `POST .../scip-edges` | Ingestão overlay SCIP (STATIC_PROVEN) | `:516` | 🟡 (produtor externo) |
| `POST .../config-edges` | Ingestão overlay config/DI Spring (CONFIG_PROVEN) | `:573` | 🟡 (produtor externo) |
| `GET .../lookup` | Lookup no manifesto | `:626` | ✅ |
| `GET /api/stats` | Estatísticas globais | `:655` | ✅ |
| `GET /api/projects` | Lista projetos | `:678` | ✅ |
| `GET /api/projects/:id` | Detalhe do projeto | `:688` | ✅ |
| `POST /api/projects` | Cria projeto | `:703` | ✅ |
| `DELETE /api/projects/:id` | Remove projeto | `:739` | ✅ |
| `POST /api/projects/:id/analyze` | Analisa projeto já cadastrado | `:751` | ✅ |
| `POST /api/uploads/init` | Inicia upload em chunks | `:776` | ✅ |
| `POST /api/uploads/:id/chunk` | Envia chunk | `:815` | ✅ |
| `POST /api/uploads/:id/complete` | Finaliza upload | `:875` | ✅ |
| `POST /api/projects/upload-zip` | Upload de ZIP de projeto | `:1043` | ✅ |
| `GET /api/analysis-runs/recent` | Runs recentes | `:1233` | ✅ |
| `GET /api/analysis-runs/:id` | Detalhe de run | `:1243` | ✅ |
| `GET /api/catalog-entries/:projectId` | Lista entries do catálogo | `:1257` | ✅ |
| `PATCH /api/catalog-entries/:id` | Edita entry (curadoria) | `:1269` | ✅ |
| `GET .../catalog-entries/:projectId/export` | Exporta entries | `:1290` | ✅ |
| `GET .../schema-fields` | Campos de entidade (schema) | `:1342` | ✅ |
| `GET /api/manifest/:projectId` | Export multi-formato (`?format=`) | `:1444` | ✅ |
| `GET .../diff` | Diff entre dois runs | `:1571` | 🟡 (só runs com snapshot) |
| `GET .../diff/latest` | Diff dos 2 últimos snapshots | `:1603` | 🟡 |
| `GET .../snapshots` | Lista snapshots | `:1632` | 🟡 |
| `GET .../impact` | Impacto por símbolo | `:1655` | ✅ |
| `GET .../narrative` | Narrativa do subgrafo | `:1687` | ✅ / 🟡 (LLM opt.) |
| `GET .../reasoner/dead-code` | Triagem de código morto | `:1765` | ✅ / 🟡 (LLM opt.) |
| `GET .../reasoner/domains` | Domínios emergentes (comunidades) | `:1804` | ✅ / 🟡 (LLM opt.) |
| `GET .../reasoner/runtime-gap` | Entrypoints nunca exercitados | `:1833` | ✅ / 🟡 (LLM opt.) |
| `GET .../reasoner/verdict` | Veredito tri-eixo (STRONG/MODERATE/WEAK) | `:1857` | ✅ |
| `GET .../reasoner/mechanism` | Mecanismo/fluxo provado a partir de entry | `:1914` | ✅ / 🟡 (LLM opt.) |
| `GET .../reasoner/sequence/catalog` | Catálogo de entrypoints p/ sequência | `:1986` | ✅ |
| `GET .../reasoner/sequence` | Diagrama de sequência (Mermaid) | `:2016` | ✅ |
| `GET .../reasoner/uml` | UML (default) | `:2105` | ✅ |
| `GET .../reasoner/uml/:type` | UML por tipo (class/component/package/deploy/usecase/activity/state) | `:2121` | ✅ |
| `GET .../reasoner/c4` | C4 (default) | `:2206` | ✅ |
| `GET .../reasoner/c4/:view` | C4 por vista (context/container/component/landscape) | `:2211` | ✅ |
| `GET .../graph-drift` | Drift estrutural do grafo (SCCs/ciclos) | `:2254` | ✅ |
| `GET .../facts` | Fact sheet do projeto | `:2282` | ✅ |
| `POST .../facts/check` | Checagem de fatos | `:2295` | ✅ |
| `GET .../dsm` | Design Structure Matrix | `:2315` | ✅ |
| `GET .../evidence-health` | Saúde da evidência por eixo | `:2336` | ✅ |
| `GET .../evidence-history` | Histórico de evidência | `:2365` | ✅ |
| `GET .../graph` | Grafo do sistema + overlays scip/config | `:2387` | ✅ |
| `GET .../bimr` | Backend Inventory × Manifest Reality | `:2452` | ✅ |
| `GET .../adr-links` | Links ADR↔código | `:2494` | ✅ |
| `GET .../ontology` | Lê ontologia de negócio do projeto | `:2536` | ✅ |
| `PUT .../ontology` | Grava ontologia de negócio | `:2549` | ✅ |
| `GET .../convention-profile` | Lê perfil de convenção | `:2581` | ✅ |
| `PUT .../convention-profile` | Grava perfil de convenção | `:2599` | ✅ |
| `POST .../convention-profile/mine` | Minera convenções do código | `:2671` | ✅ |
| `POST .../convention-profile/hypothesize` | Gera hipóteses de regra (LLM) | `:2740` | 🟡 (LLM opt.) |
| `POST .../reindex-zip` | Re-indexa ZIP de fonte | `:2846` | ✅ |
| `POST .../impact-diff` | Relatório de impacto de um diff (assinável) | `:2906` | ✅ / 🟡 (assinatura HMAC opt.) |
| `GET .../overlap` | Sobreposição funcional | `:3065` | ✅ |
| `GET .../completeness` | Lacunas de completude | `:3090` | ✅ |
| `GET .../permission-governance` | Governança de permissão | `:3116` | ✅ |
| `GET .../entity-access` | Acesso a entidades | `:3148` | ✅ |
| `GET .../sensitive-exposure` | Exposição de dados sensíveis (LGPD) | `:3179` | ✅ |
| `GET .../rule-dispatch` | Despacho de regras | `:3210` | ✅ |
| `GET .../event-wiring` | Fiação produtor↔consumidor de eventos | `:3238` | ✅ |
| `GET .../assessment` | Avaliação do sistema | `:3270` | ✅ |
| `GET .../regression` | Diff de regressão | `:3295` | ✅ |
| `GET .../domain-coverage` | Cobertura de domínio (ontologia) | `:3324` | ✅ |
| `GET .../market-coverage` | Cobertura de capacidades de mercado | `:3350` | ✅ |
| `POST .../git/connect` | Conecta repo Git | `:3394` | 🟡 (token) |
| `GET .../git/branches` | Lista branches | `:3453` | 🟡 |
| `GET .../git/pull-requests` | Lista PRs/MRs | `:3482` | 🟡 |
| `POST .../analyze-branch` | Analisa branch | `:3512` | 🟡 |
| `POST .../analyze-pr` | Analisa PR (delta) | `:3586` | 🟡 |
| `GET .../git/status` | Status da conexão Git | `:3687` | 🟡 |
| `DELETE .../git/disconnect` | Desconecta repo | `:3707` | 🟡 |
| `POST /api/enrich-with-llm/:projectId` | Classificação semântica via LLM | `:3732` | 🟡 (OpenAI) |
| `POST .../webhook/configure` | Configura webhook do projeto | `:3792` | ✅ |
| `POST /api/webhook/github` | Webhook GitHub (PR → laudo+comentário) | `:3817` | 🟡 |
| `POST /api/webhook/github-app` | Webhook GitHub App (auto-onboard no 1º PR) | `:3920` | 🟡 |
| `POST /api/webhook/gitlab` | Webhook GitLab (MR → laudo+nota) | `:4024` | 🟡 |

**Contador domínio 1: 88 rotas.**

---

## 2. Pipeline de análise (`server/pipeline/`)

Orquestrador `runFullAnalysis` em `server/pipeline/analysis-pipeline.ts` — ~12 estágios imperativos hardcoded (os rótulos "Step N/4" são cosméticos). Cache por projeto (TTL 30 min, invalida por hash SHA-256). O seam de extensão é o bloco de augments (idempotente — `addNode`/`addEdge` dedupam); fail-soft é regra na espinha (overlay/augment que estoura é logado e engolido).

| Estágio / capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Carimbo do commit analisado | Normaliza e grava `gitSha` do run (SHA inválido é ignorado, nunca aproximado) | `server/pipeline/analysis-pipeline.ts:136` | ✅ |
| Diagnóstico durável do run | Persiste `analysis_runs.diagnostics` (sobrevive ao SSE; vale no caminho de falha) | `server/pipeline/analysis-pipeline.ts:129` | ✅ |
| Cache de grafo backend (Step 1/4) | Reusa grafo Java se nenhum `.java` mudou (hash) | `server/pipeline/analysis-pipeline.ts:157` | ✅ |
| Build do grafo de aplicação | Sobe motor Java (JAR) + frontend; detecta arquitetura | `server/pipeline/analysis-pipeline.ts:buildGraph` | ✅ / 🟡 (JAR) |
| Convention profile (seam aditiva) | Aplica perfil de convenção antes de endpoints/cache | `server/pipeline/analysis-pipeline.ts:applyConventionProfile` | 🟡 flag `MANIFEST_CONVENTION_PROFILER` |
| Inventário WsV1 + prefixos gateway | Augment por convenção NuPtechs (`/easynup/*.vN`, `app.use('/prefix')`) | `server/pipeline/analysis-pipeline.ts:augmentGraphWithWsV1` | ✅ |
| Análise de endpoints (Step 2/4) | Impacto por endpoint (cadeia, entidades, persistência) | `server/pipeline/analysis-pipeline.ts:565` | ✅ |
| Cache/análise de frontend (Step 3/4) | Interações de frontend (reuso por hash) | `server/pipeline/analysis-pipeline.ts:193` | ✅ |
| Augment API-layer / composable / full-stack | Arestas tela→backend adicionais | `server/pipeline/analysis-pipeline.ts:237` | ✅ / 🟦 (parte atrás de `MANIFEST_MULTISTACK_*`) |
| Runtime overlay (costura) | Mescla observações OTel/Jaeger + LKG do snapshot anterior | `server/pipeline/analysis-pipeline.ts:264` | 🟡 (Jaeger) |
| Classificação determinística (Step 4/4) | Classifica entries (operação/criticidade/significado) | `server/pipeline/analysis-pipeline.ts:626` | ✅ |
| Enriquecimento por inferência | Infere estrutura backend quando não analisado | `server/pipeline/analysis-pipeline.ts:321` | ✅ (heur.) |
| Omissão de segurança (6 detectores) | Roda engine de segurança + métricas | `server/pipeline/analysis-pipeline.ts:329` | ✅ |
| Emissão ao Sentinel | Emite permission_drift / inconsistency / críticos de grafo | `server/pipeline/analysis-pipeline.ts:355` | 🟡 (envs Sentinel) |
| Consistência frontend↔backend | Só roda se houve cobertura de backend | `server/pipeline/analysis-pipeline.ts:387` | ✅ |
| Snapshot de manifesto por run | Grava entidades + campos (cópia-sombra) | `server/pipeline/analysis-pipeline.ts:340` | ✅ |
| Cache por projeto (TTL 30 min) | `graphCacheStore`/`frontendCacheStore`, invalida por hash | `server/pipeline/analysis-pipeline.ts:clearProjectCache` | ✅ |
| Detecção de mudança | `computeFileHashes`/`detectChanges` (SHA-256) | `server/pipeline/change-detector.ts:detectChanges` | ✅ |
| Guarda de concorrência | Máx análises simultâneas (`MANIFEST_MAX_CONCURRENT_ANALYSES`, default 2) | `server/middleware/analysis-guard.ts:15` | ✅ |
| **Cron / agendamento** | Não existe — análise sempre sob demanda (único `setInterval` só limpa uploads) | §1 (sem símbolo: ausência) | ⚪ |

**Contador domínio 2: 20.**

---

## 3. Análise estática — Backend Java / Spring (`java-analyzer-engine/` + `server/analyzers/backend-java-client.ts`)

Há **dois** analisadores Java: (a) motor AST real (JavaParser + SymbolSolver, Java 21/Maven) em `java-analyzer-engine/` — caminho de produção via HTTP; (b) reimplementação regex legada em `server/analyzers/java-analyzer.ts` (0 imports no pipeline — dívida).

### 3.1 Motor AST real (produção) — `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java`

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Parse AST + symbol solving | JavaParser `CombinedTypeSolver`, nível BLEEDING_EDGE | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:configureParserWithSymbolSolver` | ✅ (prova) |
| Estereótipos Spring | Reconhece `@RestController`/`@Controller`/`@Service`/`@Component`/`@Repository`/`@Entity`/`@Table`/`@Document` | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:extractClassInfo` | ✅ (prova) |
| Extração de endpoints HTTP | `@RequestMapping`/`@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`; verbo+path | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:resolveHttpMethod` | ✅ (prova) |
| Base-path herdado de superclasse | Controllers que herdam `@RequestMapping` de base abstrata | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:resolveSuperclassBasePaths` | ✅ (prova) |
| Anotações de segurança + roles SpEL | `@PreAuthorize`/`@Secured`/`@RolesAllowed`/`@DenyAll`/`@PermitAll`; `hasRole/hasAuthority/hasAnyRole/hasAnyAuthority` | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:extractSecurityAnnotation` | ✅ (prova) |
| Segurança programática (in-body) | `hasRole/checkPermission/isAuthenticated`, `SecurityContextHolder`, `isUserInRole` | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:detectProgrammaticSecurity` | ✅ (heur., wired) |
| Campos JPA + sensíveis + validação | `@Id`/`@EmbeddedId`; `@NotNull/@Size/@Email/@Pattern`; nomes sensíveis (password/token/cpf/ssn/salary…) + `@JsonIgnore`/WRITE_ONLY | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:extractEntityFields` | ✅ (heur. por nome) |
| Nome físico de tabela | `@Table(name=...)` literal | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:extractTableNameFromAnnotation` | ✅ (prova) |
| Repository→entity por genéricos | `JpaRepository<E,Id>` resolvido por solver + fallback sintático | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:resolveRepositoryEntitiesViaGenerics` | ✅ (prova) |
| Associações JPA (ASSOCIATES) | `@OneToMany/@ManyToOne/@OneToOne/@ManyToMany/@Embedded/@ElementCollection` | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:collectEntityAssociations` | ✅ (prova) |
| JPQL `@Query` + `em.createQuery` | Entidades lidas/escritas por JPQL (read vs write) | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:collectJpqlLiterals` | ✅ (prova) |
| Call-graph CALLS + op de persistência | Chamadas resolvidas por solver (+fallback); classifica save/delete/read | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:detectPersistenceOp` | ✅ (prova) |
| Mutação de entidade (`setXxx`) | `WRITES_ENTITY` state_change | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:detectEntityMutations` | ✅ (prova) |
| Meta-annotation closure | `@DomainService` meta-anotado com `@Service` → tratado como Service (BFS) | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:applyMetaAnnotationClosure` | ✅ (prova) |
| Interface→impl fan-out (CHA) | Arestas CALLS `resolution:"interface-impl"` | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:resolveCalleeNodeId` | ✅ (prova) |
| Entrypoints / gatilhos de background | `@Scheduled/@EventListener/@KafkaListener/@RabbitListener/@SqsListener/@JmsListener/@PostConstruct`; `CommandLineRunner`/`ApplicationRunner` | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:861` | ✅ (prova) |
| Herança EXTENDS/IMPLEMENTS | Minta nós INTERFACE/SUPERTYPE de projeto (pula framework) | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:resolveOrMintSupertypeNode` | ✅ (prova) |
| Proveniência de resolução | Tag por aresta `syntactic-resolved/syntactic-declared/interface-impl` | `java-analyzer-engine/src/main/java/com/permacat/analyzer/JavaASTAnalyzer.java:1527` | ✅ (honestidade) |
| Servidor HTTP do motor | `/analyze` POST + `/health` em 127.0.0.1:9876 | `java-analyzer-engine/src/main/java/com/permacat/analyzer/AnalyzerServer.java:33` | ✅ |
| CLI extractor (dump estrutural) | Classes/campos/métodos/enums/anotações, solver OFF | `java-analyzer-engine/src/main/java/com/permacat/analyzer/CliExtractor.java:55` | ✅ |
| Cliente Node→Java (spawn/warmup/retry) | Sobe `java -Xmx -jar`, timeout 25 min, heap `JAVA_ANALYZER_XMX` | `server/analyzers/backend-java-client.ts:buildApplicationGraph` | 🟡 (JAR compilado) |

### 3.2 Analisador Java regex legado (dívida) — `server/analyzers/java-analyzer.ts`

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Analisador regex paralelo | `analyzeJavaFiles`/`buildApplicationGraph` por regex — **0 imports no pipeline**; NÃO detecta `@PreAuthorize`/`@Secured` nem associações JPA | `server/analyzers/java-analyzer.ts:analyzeJavaFiles` | ⚪ obsoleto |

**Contador domínio 3: 22 (21 motor AST + 1 dívida regex).**

---

## 4. Análise estática — Frontend (Vue / React / Angular) (`server/analyzers/frontend/` + top-level)

Orquestrador `analyzeFrontend` em `server/analyzers/frontend-analyzer.ts`. Frameworks detectados em `detectFileType` (`server/analyzers/frontend/utils.ts:detectFileType`): `vue | react | angular | javascript | html` (sem Svelte).

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Parse Vue SFC | `@vue/compiler-sfc`; script + template AST | `server/analyzers/frontend/parsers.ts:parseVueTemplateAST` | ✅ (prova) |
| Parse Angular | `@angular/compiler`; template AST + `@Component` | `server/analyzers/frontend/parsers.ts:parseAngularTemplateAST` | ✅ (prova) |
| Parse React JSX/TSX | `parseJSXTemplate`; ScriptKind TSX/JSX | `server/analyzers/frontend/parsers.ts:parseJSXTemplate` | ✅ (prova) |
| Parse TS/JS | TypeScript compiler API (.ts/.tsx/.jsx/.js) | `server/analyzers/frontend/parsers.ts:1` | ✅ (prova) |
| Classificação de elemento UI | button/link/form/menu/input/icon (element-ui/antd/vuetify/material) | `server/analyzers/frontend/parsers.ts:classifyElement` | ✅ (heur.) |
| Identificação de HTTP clients | `axios`, `@angular/common/http`, `ky`, `got`, `superagent`, `request`, `wretch`, `fetch` | `server/analyzers/frontend/http-clients.ts:22` | ✅ |
| Registro de baseURL/prefixo | Variáveis + `axios.create({baseURL})` p/ resolver URLs relativas | `server/analyzers/frontend-analyzer.ts:71` | ✅ |
| Mapa de serviço HTTP | Resolve métodos/instâncias exportados → chamadas HTTP; padrão `BaseApiService`/`buildUrl` | `server/analyzers/frontend/http-service-map.ts:buildHttpServiceMap` | ✅ |
| Resolução UI-action→backend (19 tiers) | Escada de confiança (local 1.0 → fuzzy 0.45); `matchUrlToEndpoint` | `server/analyzers/frontend/http-resolution.ts:resolveHandlerHttpCalls` | ✅ (prova+heur.) |
| Classificação de interação | HTTP / UI_ONLY / STATE_ONLY / SERVICE_BRIDGE / EXTERNAL_SERVICE | `server/analyzers/frontend-analyzer.ts:60` | ✅ |
| Extração de rotas SPA | Vue Router / React Router / Angular / `wouter`; detecta guards | `server/analyzers/frontend/route-extraction.ts:buildRouteMap` | ✅ (heur.) |
| Grafo global de chamadas | Resolve fn→fn entre arquivos/imports + propaga "capacidade HTTP" | `server/analyzers/frontend/global-call-graph.ts:buildGlobalCallGraph` | ✅ |
| Grafo de fluxo de estado | pinia/vuex/redux/composables/useState/useReducer/signal | `server/analyzers/frontend/state-flow-graph.ts:buildStateFlowGraph` | ✅ |
| Grafo de eventos de componente | `$emit`/`@Output`/eventos custom entre componentes | `server/analyzers/frontend/event-graph.ts:buildComponentEventGraph` | ✅ |
| Grafo de camadas arquiteturais | Roles component/facade/usecase/repository | `server/analyzers/frontend/architectural-layer-graph.ts:buildArchitecturalLayerGraph` | ✅ (heur.) |
| Detecção de auth no frontend | hooks/HOC/headers (Bearer/X-API-Key)/localStorage/roles/guards in-handler | `server/analyzers/frontend/auth-detection.ts:detectFileAuthPatterns` | ✅ (heur.) |
| Tabela de símbolos por script | Resolve binding/origem/HTTP-awareness (base dos tiers) | `server/analyzers/frontend/symbol-table.ts:ScriptSymbolTable` | ✅ |
| Drivers por framework | `analyzeVueFile`/`analyzeReactFile`/`analyzeAngularFile` | `server/analyzers/frontend/file-analyzers.ts:analyzeReactFile` | ✅ |
| Enriquecimento por inferência | Infere controller/entidades/roles pela URL quando backend ausente | `server/analyzers/frontend-inference-engine.ts:enrichCatalogEntriesWithInference` | ✅ (heur.) |
| Captura rest-express (queryKey/apiRequest) | `useQuery({queryKey})` + `apiRequest(method,url)` | `server/analyzers/frontend/rest-express-template.ts:detectRestExpressTemplate` | 🟦 AUTO (`MANIFEST_MULTISTACK_HTTP_TEMPLATE`) |

> Nota: os grafos de evento/estado/camadas enriquecem a análise; o que **vira catálogo** hoje é a interação HTTP resolvida.

**Contador domínio 4: 20.**

---

## 5. Análise estática — Node backend (`server/analyzers/node-backend/`)

Todos atrás da flag `MANIFEST_MULTISTACK_NODE` (default OFF; ADR-0015). Determinísticos.

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Rotas Express | Superfície de API (`get/post/put/patch/delete/options/head/all`); `app.use('/prefix')`; roles via `requirePermission()`; proxies `/easynup/*.vN` | `server/analyzers/node-backend/express-routes.ts:extractJavaProxies` | 🟦 OFF |
| Entidades Drizzle | `pgTable`/`sqliteTable`/`mysqlTable`/`pgView`; colunas + primaryKey | `server/analyzers/node-backend/drizzle-schema.ts:extractDrizzleEntities` | 🟦 OFF |
| Call-chain Node (AST) | Handler→Drizzle touch multi-hop; resolve alias/barrels/DI; caps 2000 arquivos/50k nós | `server/analyzers/node-backend/call-chain.ts:buildBackendCallChain` | 🟦 OFF |

**Contador domínio 5: 3.**

---

## 6. Scanner & detecção de arquitetura/linguagem

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Scanner de repositório (ZIP) | Extrai/varre ZIP, filtro de extensão, zip-slip guard, raiz comum | `server/analyzers/repository-scanner.ts:extractAndScanZip` | ✅ |
| Extensões suportadas | `.java .ts .tsx .js .jsx .vue .py .cs` (+ tsconfig) | `server/analyzers/repository-scanner.ts:6` | ✅ |
| Linguagens só-ingestão (sem analisador) | `.py` (Python) e `.cs` (C#) entram no scanner mas não têm módulo de análise | `server/analyzers/repository-scanner.ts:getFileType` | ⚪ slot |
| Detector de arquitetura | REST_CONTROLLER / WS_OPERATION_BASED / MVC_ACTION_BASED / EXTERNAL_API_GATEWAY (score+confiança) | `server/analyzers/architecture-detector.ts:detectArchitecture` | ✅ (heur.) |

**Contador domínio 6: 4.**

---

## 7. Grafo tri-eixo & cobertura (`server/analyzers/system-graph.ts`, `graph-overlays.ts`, `graph-drift.ts`, `graph-connector.ts`, `application-graph.ts`, `dsm.ts`)

Os quatro métodos de aresta (3 de evidência + 1 de admissão) classificados em `classifyEdgeEvidence` (`server/analyzers/system-graph.ts:classifyEdgeEvidence`):

| Método | Confiança | Fonte |
|---|---|---|
| `RUNTIME_OBSERVED` | 0.95 | traços OTel/Jaeger |
| `STATIC_PROVEN` | 0.80 | índice SCIP do build (compiler-accurate) |
| `CONFIG_PROVEN` | 0.78 | wiring DI do Spring |
| `STATIC_UNRESOLVED` | 0.40 | heurística Java/Node (admite não ter provado) |
| `LLM_CONJECTURED` | — | **coluna reservada, hoje =0, sem produtor** (frontend já renderiza) |

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Classificação de evidência por aresta | Método + confiança por aresta | `server/analyzers/system-graph.ts:classifyEdgeEvidence` | ✅ |
| Censo de cobertura (byMethod/total) | Conta arestas por método; `coverage.edges.byMethod` | `server/analyzers/system-graph.ts:computeRawCensus` | ✅ |
| Shape do grafo (class/method) | `shapeSystemGraph` — forma canônica consumida por `/graph` e reasoner | `server/analyzers/system-graph.ts:shapeSystemGraph` | ✅ |
| Overlay de leitura (scip/config) | Mescla STATIC_PROVEN (scip) + CONFIG_PROVEN (config) ao servir `/graph`; precedência scip > config | `server/analyzers/graph-overlays.ts:applyPersistedOverlays` | ✅ |
| Grafo de aplicação | Nós CONTROLLER/SERVICE/REPOSITORY/ENTITY + impacto por endpoint | `server/analyzers/application-graph.ts:isMalformedEndpointPath` | ✅ |
| Grafo→catálogo | Converte impactos de endpoint em catalog entries | `server/analyzers/graph-connector.ts:endpointImpactsToCatalogEntries` | ✅ |
| Drift estrutural entre snapshots | Churn de nós, arestas added/dead, novos ciclos de serviço, delta de acoplamento | `server/analyzers/graph-drift.ts:computeGraphDrift` | ✅ |
| DSM (Design Structure Matrix) | Matriz de dependência do grafo | `server/analyzers/dsm.ts:computeDsm` | ✅ |
| Resoluções precisas (dívida) | Set inclui `exact|type|import|direct` que nenhum produtor emite; `syntactic*`→0.40 sub-creditado | `server/analyzers/system-graph.ts:PRECISE_RESOLUTIONS` | ⚪ dívida |

**Contador domínio 7: 9 capacidades + 5 métodos de aresta = 14.**

---

## 8. Ingestão de evidência (por fora do pipeline)

Arestas provadas não são construídas na análise — são **POSTadas por produtores externos** (CI do repo-alvo) e aplicadas na leitura.

| Canal | O que faz | Evidência | Estado |
|---|---|---|---|
| Codelens | Ingesta catálogo extraído pelo Codelens + lookups | `server/manifest-lookup.ts:ingestCodelensExtraction` | 🟡 (produtor externo) |
| SCIP edges | Agrega arestas call-graph compiler-accurate símbolo→símbolo em STATIC_PROVEN | `server/analyzers/scip-aggregate.ts:aggregateScipEdges` | 🟡 (CI scip-typescript/scip-java) |
| Config edges | Agrega wiring DI do Spring (interface→impl provável-única) em CONFIG_PROVEN | `server/analyzers/config-aggregate.ts:aggregateConfigEdges` | 🟡 (produtor externo) |
| Data-access (função→tabela) | Produtor existe (`tools/scip-typescript/scip-data-access.mjs`), mas agregação no servidor **NÃO ligada** — `dataAccess` descartado; nunca vira nó `table:<físico>` provado | `server/analyzers/data-access-aggregate.ts:mergeDataAccessEdges` | ⚪ slot sem consumo |
| Resolvers do integration-kit | `derive-config-edges.mjs` (CONFIG_PROVEN genérico) + workflows scip-java/scip-typescript + guias OTel | `integration-kit/templates/derive-config-edges.mjs:1` | 🟡 (templates) |
| OTLP / push de traços | **Não existe receiver OTLP/`/v1/traces`** — runtime é PULL do Jaeger, não push; slot conceitual não preenchido | §9 (ausência declarada) | ⚪ sem slot |

Nota: scip `mergeScipEdges` (`server/analyzers/scip-aggregate.ts:mergeScipEdges`, caps módulo 8000 / aresta 30000); config `typeFqnOfConfigEndpoint` (`server/analyzers/config-aggregate.ts:typeFqnOfConfigEndpoint`); codelens materializa 5 tabelas (cap `MAX_ITEMS_PER_KIND=10000`).

**Contador domínio 8: 6.**

---

## 9. Runtime overlay — correlator OTel/Jaeger (`server/analyzers/runtime-overlay.ts`)

PULL do Jaeger; atribui por ROTA × TABELA por trace-id; só observa FRONTEIRAS (serviço→serviço, serviço→banco), logo `observedRatio` não tende a 1.0 por construção.

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Config fail-closed | Sem `JAEGER_QUERY_URL` ⇒ OFF; sem `runtimeOverlay.services` explícito ⇒ OFF (nunca cai em default de outro sistema) | `server/analyzers/runtime-overlay.ts:resolveRuntimeOverlayConfig` | 🟡 |
| Aplicar overlay de runtime | Marca nós/arestas `RUNTIME_OBSERVED` | `server/analyzers/runtime-overlay.ts:applyRuntimeOverlay` | 🟡 |
| Pares de runtime (rota×tabela) | Extrai pares de trace; tabelas de SQL/db-span | `server/analyzers/runtime-overlay.ts:extractRuntimePairs` | 🟡 |
| Observações em tabelas | Aplica hits de tabela observados | `server/analyzers/runtime-overlay.ts:applyRuntimeTableObservations` | 🟡 |
| LKG (Last-Known-Good) | Carrega runtime do snapshot anterior; TTL 7 dias; decai por TTL | `server/analyzers/runtime-overlay.ts:carryForwardRuntime` | 🟡 |
| Fetch de traços | Busca traços recentes do Jaeger (com report) | `server/analyzers/runtime-overlay.ts:fetchRecentTracesWithReport` | 🟡 |
| Padrão de op configurável | `DEFAULT_OP_RE` (easynup) sobrescrito por `opPathPattern` do perfil | `server/analyzers/runtime-overlay.ts:DEFAULT_OP_RE` | 🟡 |
| Session-baggage / X-Probe | **Não implementado neste repo** (narrativa ADR-073 vive no `nup-sentinel`) | §9 (ausência declarada) | ⚪ ausente |

**Contador domínio 9: 8.**

---

## 10. Evidência — saúde / drift / histórico

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Saúde da evidência | Por eixo (static/config/runtime/analysis): fresh/stale/absent/unknown + veredito overall (healthy/degraded/starving) | `server/analyzers/evidence-health.ts:buildEvidenceHealth` | ✅ |
| Limiares por env | `EVIDENCE_HEALTH_*_STALE_HOURS` (static/config 168, runtime 24, analysis 48) | `server/analyzers/evidence-health.ts:resolveThresholds` | ✅ |
| Saúde por eixo (edge/analysis/runtime) | Frescor por tipo de evidência | `server/analyzers/evidence-health.ts:edgeAxisHealth` | ✅ / 🟡 (Jaeger) |
| Drift analisado × deployado | Sonda SHA deployado (health URL) e compara com o analisado | `server/analyzers/evidence-drift.ts:probeDeployedSha` | 🟡 (health URL) |
| SHA de diagnóstico | Extrai git SHA do run | `server/analyzers/evidence-drift.ts:gitShaFromDiagnostics` | ✅ |
| Histórico de evidência | Resume evidência por run (série temporal) | `server/analyzers/evidence-history.ts:summarizeRunEvidence` | ✅ |

**Contador domínio 10: 6.**

---

## 11. Impacto funcional

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Impacto por símbolo | Alcance a jusante de um símbolo no manifesto | `server/analyzers/impact-analyzer.ts:computeImpact` | ✅ |
| Impacto funcional (ontologia) | Ancora mudança a conceitos de domínio; tokeniza | `server/analyzers/functional-impact.ts:computeFunctionalImpact` | ✅ |
| Confiança de impacto | Pontua nós afetados + blind spots | `server/analyzers/impact-confidence.ts:computeImpactConfidence` | ✅ |
| BIMR (Backend Inventory × Manifest Reality) | Prova-de-valor do eixo runtime: tabelas mintadas / tabelas observadas; filtra infraestrutura | `server/analyzers/blind-impact.ts:computeBimr` | ✅ (só com oráculo runtime) |
| Serviço de impacto por diff | Monta relatório de impacto a partir de um diff unificado (base p/ PR bot) | `server/impact-service.ts:buildImpactForDiff` | ✅ |
| Assinatura HMAC do relatório | HMAC-SHA256 do JSON canônico (`/impact-diff`), só com `MANIFEST_REPORT_HMAC_KEY` | `server/impact-service.ts:signReport` | 🟡 |
| Símbolos alterados / diff | Parse de diff unificado em arquivos/símbolos | `server/analyzers/changed-symbols.ts:parseUnifiedDiff` | ✅ |
| Classificação de breaking changes | Classifica mudanças que quebram contrato | `server/analyzers/breaking-changes.ts:classifyBreakingChanges` | ✅ |
| Risco de entrega / churn | Métrica de churn do diff (co-mudança git NÃO oferecida — ausência declarada) | `server/analyzers/delivery-risk.ts:computeChurn` | ✅ |
| SARIF | Converte relatório em SARIF (code scanning) | `server/analyzers/sarif-report.ts:toSarif` | ✅ |
| Assinatura de relatório (canônico) | Stringify canônico p/ assinatura/hash | `server/analyzers/report-signature.ts:canonicalStringify` | ✅ |
| Consumidores cross-repo | Config de consumidores externos via env | `server/analyzers/cross-repo-consumers.ts:consumersConfigFromEnv` | 🟡 (env) |

**Contador domínio 11: 12.**

---

## 12. Calibração

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Confiabilidade por método | Calibra confiança por método de aresta (alpha 0.1, minSamples 30) | `server/analyzers/calibration.ts:calibrateMethodReliability` | ✅ |
| Overlay de calibração | Aplica calibração ao grafo (RUNTIME_OBSERVED tratado) | `server/analyzers/calibration-overlay.ts:buildCalibrationOverlay` | ✅ |
| Wiring de calibração no `/graph` | `buildGraphCalibration` + gates de comparabilidade/aplicabilidade; pesos fixos da própria aresta | `server/analyzers/graph-calibration.ts:buildGraphCalibration` | ✅ (abstém p/ fixo sem oráculo) |

**Contador domínio 12: 3.**

---

## 13. Detectores de segurança (`server/security/omission-engine.ts`)

6 detectores orquestrados por `SecurityOmissionEngine.analyze()`; entrypoint `analyzeSecurityOmissions`. Todos ✅ determinísticos (sem flag).

| Detector | O que faz | Evidência | Natureza |
|---|---|---|---|
| `UNPROTECTED_OUTLIER` | Endpoint sem proteção enquanto pares (mesmo método+domínio) protegidos (≥2 pares, taxa ≥0.5) | `server/security/omission-engine.ts:164` | heur. (comparação de pares) |
| `PRIVILEGE_ESCALATION` | Escrita (POST/PUT/PATCH) em campo/entidade de privilégio sem role admin | `server/security/omission-engine.ts:236` | regra+heur. |
| `SENSITIVE_DATA_EXPOSURE` | GET sem proteção expondo campo altamente sensível (password/token/ssn…) | `server/security/omission-engine.ts:306` | regra/regex |
| `INCONSISTENT_PROTECTION` | Controller majoritariamente protegido com endpoint mutante desprotegido | `server/security/omission-engine.ts:352` | heur. intra-controller |
| `MISSING_PROTECTION` | Endpoint criticidade ≥60 sem nenhuma anotação de segurança | `server/security/omission-engine.ts:412` | regra/threshold |
| `COVERAGE_GAP` | Resumo de cobertura (info) + gap por método HTTP (<50%, ≥2 endpoints) | `server/security/omission-engine.ts:440` | agregado/métrica |

| Capacidade correlata | O que faz | Evidência | Estado |
|---|---|---|---|
| Métricas de cobertura | Por método, por controller, distribuição de roles | `server/security/omission-engine.ts:computeCoverageMetrics` | ✅ |
| Resumo de segurança de PR | Delta de proteção do PR vs repo | `server/security/omission-engine.ts:generatePRSecuritySummary` | ✅ |
| Exposição sensível (LGPD) | Classifica endpoint em none/auth-only/permission; relatório PT-BR | `server/analyzers/sensitive-exposure.ts:detectSensitiveExposure` | ✅ (heur.) |
| Consistência frontend↔backend | Tela chama endpoint inexistente (`mappedBackendNode==null`) → `missing_backend_endpoint` (write=high/read=medium); só com cobertura de backend | `server/analyzers/frontend-backend-consistency.ts:detectFrontendBackendInconsistencies` | ✅ (prova) |

**Contador domínio 13: 6 detectores + 4 correlatos = 10.**

---

## 14. Governança de permissão, acesso a entidades, regras & eventos

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Governança de permissão | Relatório de governança de permissão a partir do manifesto | `server/analyzers/permission-governance.ts:detectPermissionGovernance` | ✅ |
| Acesso a entidades | Mapa de quem lê/escreve cada entidade | `server/analyzers/entity-access.ts:detectEntityAccess` | ✅ |
| Despacho de regras | Enum de tipos de ação de regra a partir do código | `server/analyzers/rule-dispatch.ts:parseRuleActionTypeEnum` | ✅ |
| Fiação de eventos | Produtor↔consumidor de eventos (emit/listen) | `server/analyzers/event-wiring.ts:resolveEventWiring` | ✅ |

**Contador domínio 14: 4.**

---

## 15. Analisadores de domínio / mercado / convenção / ontologia / ADR / avaliação

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Cobertura de domínio | Confronta manifesto com ontologia de domínio | `server/analyzers/domain-coverage.ts:checkDomainCoverage` | ✅ |
| Cobertura de mercado | Confronta com capacidades de mercado (setor público) | `server/analyzers/market-coverage.ts:checkMarketCoverage` | ✅ |
| Capacidades de mercado (dados) | Catálogo de capacidades setor público | `server/analyzers/market-capabilities.ts:PUBLIC_SECTOR_CAPABILITIES` | ✅ (dados) |
| Ontologia de domínio (dados) | Conceitos de contratação pública | `server/analyzers/domain-ontology.ts:PUBLIC_PROCUREMENT_ONTOLOGY` | ✅ (dados) |
| Mineração de convenção | Minera sufixos de camada / âncoras de rota | `server/analyzers/convention-miner.ts:mineConventionProfile` | ✅ |
| Perfil de convenção | Modo do profiler via env | `server/analyzers/convention-profile.ts:profilerMode` | 🟦 (`MANIFEST_CONVENTION_PROFILER`) |
| Gerador de hipóteses | Amostra arquivos p/ propor regras (LLM) | `server/analyzers/hypothesis-generator.ts:pickSampleFiles` | 🟡 (LLM) |
| Recuperação de ADR | Regex de símbolo forte p/ ligar ADR↔código | `server/analyzers/adr-retrieval.ts:strongSymbolRegex` | ✅ |
| Links tácitos de ADR | Extrai citações `arquivo:linha` de ADRs | `server/analyzers/adr-tacit-links.ts:extractLineCitations` | ✅ |
| Sobreposição funcional | 2+ caminhos fazendo o mesmo sobre a mesma entidade | `server/analyzers/overlap-detector.ts:classifyVerb` | ✅ |
| Lacunas de completude | Endpoints/entidades incompletos | `server/analyzers/completeness-detector.ts:detectCompletenessGaps` | ✅ |
| Avaliação do sistema | Sumário avaliativo do sistema | `server/analyzers/system-assessment.ts:buildSystemAssessment` | ✅ |
| Diff de regressão | Compara run anterior × atual | `server/analyzers/regression-diff.ts:buildRegressionDiff` | ✅ |
| Fact sheet | Folha de fatos do projeto | `server/analyzers/fact-sheet.ts:buildFactSheet` | ✅ |
| Narrativa + grounding gate | Narrativa do subgrafo com porta de grounding | `server/analyzers/narrative.ts:applyGroundingGate` | ✅ / 🟡 (LLM opt.) |
| Projeções de narrativa (persona) | Visão por perspectiva/persona | `server/analyzers/narrative-projections.ts:projectPerspective` | ✅ |
| Narrativa LLM (gerador de claim) | Gera claim por aresta (só com chave) | `server/analyzers/narrative-llm.ts:resolveEdgeClaimGenerator` | 🟡 (OpenAI) |
| Classificação semântica (LLM) | Operação/criticidade/significado em batches de 10 (fora do pipeline) | `server/analyzers/semantic-engine.ts:classifyEntries` | 🟡 (OpenAI) |
| Classificação determinística | Classifica entries no pipeline (sem LLM) | `server/analyzers/deterministic-classifier.ts:classifyEntriesDeterministic` | ✅ |
| Augment full-stack / profile / canonical | Arestas tela→gateway→backend; templates de rota; modelo canônico de role | `server/analyzers/full-stack-augment.ts:urlMatchesRoute` | ✅ / 🟦 (parte flag) |

**Contador domínio 15: 20.**

---

## 16. Geradores de artefato (`server/generators/`)

Todos **determinísticos** (nenhum usa LLM); tomam `ManifestData`. Expostos por `?format=` em `/api/analyze`, `/api/analyze-zip`, `GET /api/manifest/:projectId` (formatos: `manifest`, `agents-md`, `openapi`, `policy-matrix`, `keycloak-realm`, `opa-rego`, `nupidentity`, `nupidentity-runner`, `compliance-report`, `all`).

| Gerador | Saída | Evidência | Estado |
|---|---|---|---|
| Manifesto canônico | `ManifestData` (MANIFEST.json, schema v1) | `server/generators/manifest-generator.ts:generateManifest` | ✅ |
| AGENTS.md | Markdown legível por IA | `server/generators/agents-md-generator.ts:generateAgentsMd` | ✅ |
| OpenAPI | Spec OpenAPI 3.0.3 (JSON) + `x-manifest`/`x-sensitive` | `server/generators/openapi-generator.ts:generateOpenAPISpec` | ✅ (`fullCallChain:[]` hardcoded) |
| OPA / Rego | `{policy (Rego), bundle}` + regras deny sensível/crítico | `server/generators/opa-rego-generator.ts:generateOpaRego` | ✅ |
| Keycloak realm | JSON de import/export (roles, client, authz) | `server/generators/keycloak-realm-generator.ts:generateKeycloakRealm` | ✅ (param `securityFindings` não consumido) |
| Policy matrix | Matriz universal → Keycloak + Okta + AWS IAM | `server/generators/policy-matrix-generator.ts:generatePolicyMatrix` | ✅ |
| Bundle NuPIdentity + runner | 4 JSONs RBAC+ABAC (systems/profiles/profile-functions/abac) + script runner | `server/generators/nupidentity-generator.ts:generateNupidentityBundle` | ✅ (guard→ABAC heur., `unmappedGuards`) |
| Compliance report | HTML SOC2/LGPD (inventário + matriz + findings + checklist) | `server/generators/compliance-report-generator.ts:generateComplianceReport` | ✅ |

**Contador domínio 16: 8.**

---

## 17. Reasoner / veredito / grounding (`server/reasoner/`)

Veredito tri-eixo **determinístico LOCAL**. IA só explica pós-fato, ancorada a id provado; grounding remove claim sem âncora; LLM opcional (sem chave ⇒ caminho determinístico byte-estável).

| Capacidade | O que faz / produz | Evidência | Estado |
|---|---|---|---|
| Gateway LLM governado | Único ponto de LLM; `null` sem chave (modo determinístico) | `server/reasoner/llm.ts:resolveReasonerLLM` | 🟡 (OpenAI) |
| Grounding gate | Filtra claims contra âncoras provadas; ledger (proposed/kept/rejected) | `server/reasoner/grounding.ts:groundClaims` | ✅ (a lei) |
| Veredito de evidência | `STRONG`/`MODERATE`/`WEAK` + ratios + razões | `server/reasoner/verdict.ts:computeEvidenceVerdict` | ✅ (tier det.; prosa LLM opt.) |
| Mecanismo / fluxo | Passos PROVADOS de um entry (BFS FLOW), ordem runtime, branches | `server/reasoner/mechanism.ts:traceMechanism` | ✅ / 🟡 (naming LLM opt.) |
| Portas de mecanismo | `RuntimeOrderPort` + null port (ordem determinística) | `server/reasoner/mechanism-ports.ts:33` | ✅ |
| Código morto | Candidatos isolated/runtime-refuted/no-proven-caller + confiança <1 | `server/reasoner/dead-code.ts:triageDeadCode` | ✅ (heur.) / 🟡 (phrasing LLM) |
| Runtime gap | Entrypoints nunca exercitados por tráfego, priorizados | `server/reasoner/runtime-gap.ts:findRuntimeGap` | ✅ / 🟡 (hints LLM) |
| Domínios emergentes | Comunidades (label-propagation) + seams + hubs | `server/reasoner/domains.ts:detectDomains` | ✅ / 🟡 (naming LLM) |
| Loader do grafo | Grafo shaped + overlays scip/config mesclados (canônico p/ `/reasoner/*`) | `server/reasoner/graph-load.ts:loadReasonerGraph` | ✅ |
| C4 model + render | `C4Model` → Structurizr DSL + Mermaid C4 (context/container/component/landscape) | `server/reasoner/c4/c4-model.ts:buildC4Model` | ✅ |
| Sequência model + render | `MechanismReport` → `SequenceModel` → Mermaid `sequenceDiagram` | `server/reasoner/sequence/sequence-model.ts:mechanismToSequence` | ✅ |
| UML suite | class/component/package/deployment/usecase/activity/state → Mermaid | `server/reasoner/uml/uml-render.ts:umlToMermaid` | ✅ |
| Adapter entry-catalog | Enumera entrypoints (rotas + batch/scheduled) do grafo | `server/reasoner/adapters/entry-catalog.adapter.ts:graphEntryCatalog` | ✅ |
| Adapter runtime-order (Jaeger) | Ordem real de execução por rota via OTel | `server/reasoner/adapters/runtime-order.adapter.ts:jaegerRuntimeOrderPort` | 🟡 (jaegerUrl, fail-soft) |

**Contador domínio 17: 14.**

---

## 18. Emissão ao orquestrador Sentinel (`server/security/sentinel-emitter.ts`)

Traduz achados em `Finding v2` e envia ao `nup-sentinel` (cria sessão + ingere). **No-op** sem `SENTINEL_URL` + `SENTINEL_API_KEY` + `SENTINEL_PROJECT_ID`.

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Emissão de findings de segurança | `type:permission_drift` (subtypes dos 6 detectores) | `server/security/sentinel-emitter.ts:emitSecurityFindings` | 🟡 |
| Emissão de inconsistência | `type:inconsistency` (`missing_backend_endpoint`) | `server/security/sentinel-emitter.ts:emitConsistencyFindings` | 🟡 |
| Emissão de overlap | `type:functional_overlap` (só escritas) | `server/security/sentinel-emitter.ts:emitOverlapFindings` | 🟡 |
| Emissão de completude | `type:lifecycle_gap` (só high) | `server/security/sentinel-emitter.ts:emitCompletenessFindings` | 🟡 |
| Transporte (cria sessão + ingere) | `POST /api/sessions` → `POST /api/findings/ingest`; best-effort, Sentinel offline não quebra análise | `server/security/sentinel-emitter.ts:emitToSentinel` | ✅ |
| Gate das 3 envs | Sem envs ⇒ `{skipped:true}`; `SENTINEL_API_KEY` pode vir `chave:orgId` (tenant-scoped) | `server/security/sentinel-emitter.ts:parseSentinelKey` | 🟡 |
| Omission engine (fonte) | Produz os `SecurityFinding` consumidos | `server/security/omission-engine.ts:76` | ✅ |

**Contador domínio 18: 7.**

---

## 19. Git / PR / Webhooks (`server/git/`)

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Provider abstrato + factory | GitHub / GitLab; parse SSH+HTTPS; filtro source | `server/git/git-provider.ts:createGitProvider` | ✅ |
| GitHub provider | REST bearer; branches/tree/files×20/content; `fetchPRDiff`; `fetchPRDiffLight` (só arquivos mudados) | `server/git/github-provider.ts:fetchPRDiffLight` | 🟡 (token) |
| GitLab provider | `PRIVATE-TOKEN`; auto-detecta self-hosted; MRs como PRs; sem light diff | `server/git/gitlab-provider.ts:GitLabProvider` | 🟡 (token) |
| GitHub App (auth) | App JWT RS256 (9min), installation token (1h), verificação de assinatura, ações relevantes | `server/git/github-app.ts:verifyWebhookSignature` | 🟡 (3 envs do App) |
| Comentário de PR idempotente | Upsert de 1 comentário (marker compartilhado) GitHub issues + GitLab notes | `server/git/pr-comment.ts:upsertGithubPrComment` | 🟡 |
| Diff unificado de PR | Monta unified diff de base/head p/ o motor de impacto | `server/git/pr-unified-diff.ts:buildUnifiedDiffFromPR` | ✅ |
| Normalizador de SHA | Só 40-hex aceito (short SHA rejeitado p/ não falsear drift) | `server/git/sha.ts:normalizeGitSha` | ✅ |
| Token vault (AES-256-GCM) | Cifra token Git em repouso (fail-closed sem `MANIFEST_TOKEN_ENCRYPTION_KEY`) | `server/git/token-vault.ts:encryptToken` | 🟡 (chave 64-hex) |
| Webhook GitHub | `pull_request` (opened/synchronize), HMAC-SHA256 por secret, light diff → laudo + comentário | `server/routes.ts:3817` | 🟡 |
| Webhook GitHub App | Fail-closed 503 sem App; auto-onboard no 1º PR (cria projeto + indexa branch + comenta) | `server/routes.ts:3920` | 🟡 |
| Webhook GitLab | `merge_request` (open/update), valida `x-gitlab-token`, diff → laudo + nota MR | `server/routes.ts:4024` | 🟡 |
| Configurar webhook | Seta `webhookSecret`/`webhookEnabled` do projeto | `server/routes.ts:3792` | ✅ |

**Contador domínio 19: 12.**

---

## 20. Diff de manifesto (drift entre snapshots) (`server/diff/`)

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Diff entre snapshots | Mudança de permissão/endpoint/entidade entre 2 runs | `server/diff/manifest-diff-engine.ts:diffManifests` | ✅ |
| Rotas de diff/snapshots | `/diff`, `/diff/latest`, `/snapshots` (runs sem snapshot → 404) | `server/routes.ts:1571` | 🟡 |

**Contador domínio 20: 2.**

---

## 21. Autenticação, API keys & uploads (`server/middleware/`, `server/auth/`)

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Auth OIDC (NuPIdentify) | Authorization Code + PKCE; token só na sessão HTTP-only; checa permissão/tier | `server/middleware/api-auth.ts:isOIDCConfigured` | 🟡 (envs OIDC) |
| Gate de auth | Exige auth se OIDC configurado OU `MANIFEST_REQUIRE_AUTH=true`; bootstrap key | `server/middleware/api-auth.ts:isAuthRequired` | ✅ |
| API keys | Cria/lista/revoga com hash + prefixo | `server/middleware/api-auth.ts:hashApiKey` | ✅ |
| Whoami | Resolve OIDC **ou** API key | `server/routes.ts:189` | ✅ |
| Upload em chunks + ZIP | init/chunk/complete + upload-zip; limpeza de temporários (único `setInterval`) | `server/routes.ts:776` | ✅ |
| Guarda de concorrência | Máx análises simultâneas | `server/middleware/analysis-guard.ts:15` | ✅ |

**Contador domínio 21: 6.**

---

## 22. CLI — `@nuptechs/sentinel-manifest-cli` (`cli/`)

v0.2.0; bin `permacat` → `./dist/index.js`; publica no GitHub Packages.

| Comando | O que faz | Evidência | Estado |
|---|---|---|---|
| `analyze <path>` | Varre dir/ZIP; `--local` scan regex in-process, senão upload ao servidor; exit 1 se endpoint crítico desprotegido | `cli/src/commands/analyze.ts:createAnalyzeCommand` | ✅ |
| `diff <projectId> [runA] [runB]` | Compara 2 snapshots (ou latest); added/removed/modified + impacto | `cli/src/commands/diff.ts:createDiffCommand` | ✅ |
| `manifest <projectId>` | Baixa manifesto em formato `manifest/agents-md/openapi/policy-matrix/all` | `cli/src/commands/manifest.ts:createManifestCommand` | ✅ |
| `connect <repoUrl>` | Conecta repo Git (`--provider github|gitlab`); lista branches | `cli/src/commands/connect.ts:createConnectCommand` | ✅ |
| `impact-pr` | Bot CI-nativo: `git diff` local → `/impact-diff` (md/json/sarif); upsert comentário GitHub; `--fail-on-alert` | `cli/src/commands/impact-pr.ts:createImpactPrCommand` | ✅ |
| `index` | Auto-map em push: zipa fonte filtrada → `/reindex-zip` | `cli/src/commands/index-map.ts:createIndexCommand` | ✅ |

**Contador domínio 22: 6 comandos.**

---

## 23. Extensão VS Code — `nup-manifest-vscode` (`vscode-extension/`)

Publisher `nuptechs`, v0.1.0, engine ≥1.85, esbuild; handlers reais em `vscode-extension/src/extension.ts`.

| Comando / feature | O que faz | Evidência | Estado |
|---|---|---|---|
| `analyzeFile` | Analisa arquivo ativo (regex local) | `vscode-extension/src/extension.ts:34` | ✅ |
| `analyzeWorkspace` | Scan local (≤500 `.vue/.tsx/.jsx/.ts/.js`) | `vscode-extension/src/extension.ts:67` | ✅ |
| `analyzeWorkspaceFull` | Upload ≤1000 arquivos ao servidor (`RemoteAnalyzer`) | `vscode-extension/src/extension.ts:112` | ✅ |
| `showCatalog` | Abre webview do catálogo | `vscode-extension/src/extension.ts:167` | ✅ |
| `connectServer` | Pede serverUrl + apiKey (config global) | `vscode-extension/src/extension.ts:179` | ✅ |
| `clearResults` | Limpa resultados | `vscode-extension/src/extension.ts:209` | ✅ |
| Tree view "Catalog" | Container activitybar + árvore | `vscode-extension/src/extension.ts:17` | ✅ |
| Status bar + decorations | `$(shield) Manifest` (idle/analyzing/…) + decorações inline | `vscode-extension/src/extension.ts:227` | ✅ |
| Config | `serverUrl` + `apiKey` | `vscode-extension/package.json:1` | ✅ |

**Contador domínio 23: 9.**

---

## 24. Integration kit & GitHub Action

| Capacidade | O que faz | Evidência | Estado |
|---|---|---|---|
| Guia de onboarding | 3 eixos (STATIC/CONFIG/RUNTIME), registro, verificação | `integration-kit/README.md:1` | ✅ (doc) |
| Resolver CONFIG_PROVEN genérico | `derive-config-edges.mjs` — interface→impl provável-única → `/config-edges` | `integration-kit/templates/derive-config-edges.mjs:1` | ✅ (template) |
| Workflow scip-java | Feed STATIC_PROVEN (scip-java) + CONFIG_PROVEN (Maven/Gradle+Spring) | `integration-kit/templates/scip-java-index.yml:1` | ✅ (template) |
| Workflow scip-typescript | Feed STATIC_PROVEN (TS/Node; sem CONFIG_PROVEN) | `integration-kit/templates/scip-typescript-index.yml:1` | ✅ (template) |
| Guias OTel (Java/Node) | RUNTIME_OBSERVED via agente/SDK | `integration-kit/templates/otel-node.md:1` | ✅ (doc) |
| GitHub Action composite | "Impacto de Entrega" — detecta PR vs push; roda CLI `impact-pr`/`index`; upload SARIF | `action.yml:1` | ✅ |

**Contador domínio 24: 6.**

---

## 25. Capacidades por linguagem / stack (ADR-0015)

Régua: nenhuma stack vira ✅ sem goldset medido em CI.

| Stack / template | O que faz | Evidência | Estado |
|---|---|---|---|
| **easynup** (Vue 3 + Spring/JPA + WsV1 + gateway Express) | Goldset full-repo + golden de fixture em CI | `tests/regression/goldset-baseline.test.ts:1` | ✅ |
| **rest-express** (React + wouter + Express + Drizzle) | Balde node-backend aditivo (Onda 1) | `server/analyzers/node-backend/express-routes.ts:1` | 🟦 flag (goldset pendente) |
| Variantes Node (pg cru / Fastify / NODE_API) | Onda 2 | ADR-0015 (governança no `nup-sentinel`) | ⚪ |
| Next.js · Python (Flask/FastAPI) | Onda 3 — decisão pendente | ADR-0015 | ⚪ |
| React Native · Kotlin Android · JS fora de convenção | Declarado fora de escopo | ADR-0015 | ⚪ |
| Python (.py) / C# (.cs) | Aceitos pelo scanner, sem analisador dedicado | `server/analyzers/repository-scanner.ts:6` | ⚪ ingest-only |
| Harness anti-regressão (G1/G2/G3) | Golden byte-a-byte + sensibilidade + canários Onda 1 | `tests/regression/mini-easynup.fixture.ts:1` | ✅ |
| Flags multistack | `MANIFEST_MULTISTACK_NODE` (OFF) · `MANIFEST_MULTISTACK_HTTP_TEMPLATE` (AUTO) | `server/config/multistack.ts:readMultistackFlags` | ✅ |

**Contador domínio 25: 8.**

---

## Totais

| Domínio | Itens |
|---|---|
| 1. API HTTP (rotas) | 88 |
| 2. Pipeline de análise | 20 |
| 3. Backend Java/Spring | 22 |
| 4. Frontend (Vue/React/Angular) | 20 |
| 5. Node backend (flag OFF) | 3 |
| 6. Scanner & arquitetura | 4 |
| 7. Grafo tri-eixo & cobertura | 14 (9 + 5 métodos) |
| 8. Ingestão de evidência | 6 |
| 9. Runtime overlay | 8 |
| 10. Evidência (health/drift/history) | 6 |
| 11. Impacto funcional | 12 |
| 12. Calibração | 3 |
| 13. Detectores de segurança | 10 (6 + 4) |
| 14. Governança/entidades/regras/eventos | 4 |
| 15. Domínio/mercado/convenção/ADR/avaliação | 20 |
| 16. Geradores de artefato | 8 |
| 17. Reasoner/veredito/grounding | 14 |
| 18. Emissão ao Sentinel | 7 |
| 19. Git/PR/webhooks | 12 |
| 20. Diff de manifesto | 2 |
| 21. Auth/API keys/uploads | 6 |
| 22. CLI | 6 |
| 23. VS Code | 9 |
| 24. Integration kit & Action | 6 |
| 25. Capacidades por stack | 8 |
| **TOTAL** | **320** |

---

## Caveats de comprovação (heurística vs prova, slots, flags)

| Item | Natureza / estado |
|---|---|
| Motor Java AST (JavaParser+SymbolSolver) | **prova** compiler-accurate; exige JAR em `java-analyzer-engine/target/` (🟡) |
| `server/analyzers/java-analyzer.ts` (regex) | dívida: 0 imports no pipeline; não vê `@PreAuthorize`/associações JPA (⚪) |
| Campos sensíveis / segurança programática Java | **heur.** por nome/método (honestamente rotulado) |
| 6 detectores de segurança | determinísticos; 4 por **heurística de pares/threshold**, 2 por **regra/regex** |
| `LLM_CONJECTURED` | coluna reservada, hoje =0, **sem produtor** (frontend já renderiza) — slot preparado |
| `dataAccess` (scip função→tabela) | produtor existe, **agregação no servidor NÃO ligada** — slot sem consumo |
| Session-baggage / X-Probe runtime | **não implementado** neste repo (vive no `nup-sentinel`) |
| scip/config edges | overlays de **leitura**, POSTados por produtor externo (CI do alvo); sem POST, `/graph` byte-a-byte |
| Toda emissão ao Sentinel | **no-op** sem `SENTINEL_URL`+`SENTINEL_API_KEY`+`SENTINEL_PROJECT_ID` |
| Todo LLM (reasoner/narrativa/semântica) | **opcional**; sem `AI_INTEGRATIONS_OPENAI_API_KEY`/`OPENAI_API_KEY` ⇒ caminho determinístico; grounding remove claim sem âncora; veredito/estrutura sempre determinísticos |
| Geradores de artefato | 100% determinísticos; `openapi.fullCallChain:[]` hardcoded; `keycloak` param `securityFindings` não consumido; `nupidentity` guard→ABAC heur. com `unmappedGuards` |
| Assinatura HMAC de relatório / token vault | só com chave (`MANIFEST_REPORT_HMAC_KEY` / `MANIFEST_TOKEN_ENCRYPTION_KEY`); sem chave, OFF honesto (nunca assinatura fake) |
| Node backend (domínio 5) | 🟦 atrás de `MANIFEST_MULTISTACK_NODE` (OFF); rest-express-template 🟦 AUTO |
| Webhook GitHub sem secret | **não verifica assinatura** (HMAC só valida com `webhookSecret`) |
| Diff/snapshots | só runs que têm snapshot (runs antigos → 404) |
| Python/C# | aceitos pelo scanner, **sem analisador** (ingest-only) |
| Cron/agendamento | **não existe** — análise sempre sob demanda |
| Cobertura de runtime | `observedRatio` não tende a 1.0 por construção (só fronteiras) — teto correto da técnica, não falha |

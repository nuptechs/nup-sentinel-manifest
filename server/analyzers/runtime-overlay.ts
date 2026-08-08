// ─────────────────────────────────────────────
// Runtime overlay — a COSTURA runtime↔estático (ADR-0026 / ADR-073).
//
// O grafo estático não resolve os ~56% de rotas Node-nativas com DISPATCH
// DINÂMICO (o handler computa a op) — elas param na ROTA, sem alcançar a
// entidade. A VERDADE de o que essas rotas tocam existe nos traços OTel/Jaeger
// do próprio parque (VERIFICADO ao vivo 2026-08-02: `GET /api/internal/
// workflowAgentTask/findPending` → tabela `workflow_callback_token`, cross-
// service, `db.sql.table` direto, parent/child por traceparent).
//
// Este módulo lê esses traços e mescla no grafo persistido ARESTAS OBSERVADAS
// (`RUNTIME_OBSERVED`) rota→entidade (+ rota→endpoint Java quando o proxy
// aparece no traço), com proveniência honesta (`observed: true`, `source:
// 'jaeger'`, contagem + traceIds de amostra + últimoVisto). O atlas as trata
// como OBSERVADAS — nunca como chamada de código estática.
//
// PRECISÃO acima da prática (o adapter do sentinel ACHATA os spans e regex-eia
// SQL): aqui usamos o atributo `db.sql.table` DIRETO do span JDBC e o
// `http.route`/`url.path` concreto — sem parse de SQL, sem heurística.
//
// GATED + FAIL-SOFT: sem `JAEGER_QUERY_URL` (ou erro de rede), não faz nada →
// grafo byte-a-byte ao de hoje. Telemetria nunca quebra a análise.
// ─────────────────────────────────────────────
import { ApplicationGraph, GraphNode, GraphEdge } from "./application-graph";
import { toSnakeCase } from "./nuptechs-conventions";
import { urlMatchesRoute } from "./full-stack-augment";

// ─── Modelo de traço Jaeger (native query API) ───
export interface JaegerTag { key: string; value: unknown }
export interface JaegerRef { refType?: string; traceID?: string; spanID?: string }
export interface JaegerSpan {
  spanID?: string;
  operationName?: string;
  processID?: string;
  startTime?: number; // micros
  tags?: JaegerTag[];
  references?: JaegerRef[];
}
export interface JaegerTrace {
  traceID?: string;
  spans?: JaegerSpan[];
  processes?: Record<string, { serviceName?: string }>;
}

/** Par observado agregado por rota do gateway. */
export interface RuntimePair {
  method: string;
  path: string;                       // url.path concreto (ex. /api/x/123)
  count: number;                      // nº de traços que exercitaram a rota
  tables: Map<string, string>;        // tabela(snake) → operação predominante
  javaEndpoints: Set<string>;         // http.route Java (/easynup/op.v1) no traço
  pageRoutes: Set<string>;            // page.route (tela de origem) — RUM
  traceIds: string[];                 // amostra (≤5) de evidência
  lastSeenMs: number;                 // maior startTime observado (ms)
}

export interface RuntimeOverlayResult {
  tracesConsidered: number;
  routesObserved: number;
  routesMatched: number;   // casaram com ROTA estática do grafo
  routesMinted: number;    // observadas mas AUSENTES do grafo estático (miss)
  entityEdges: number;     // arestas RUNTIME_OBSERVED rota→entidade
  wsv1Edges: number;       // arestas RUNTIME_OBSERVED rota→endpoint Java
  serviceEntityEdges: number; // arestas RUNTIME_OBSERVED serviço→entidade (same-trace, 1-endpoint)
  tablesResolved: number;  // tabela casou com ENTITY existente
  tablesMinted: number;    // tabela sem ENTITY → mintou table:<n>
  hotNodes: number;        // nós marcados runtimeHot
}

const NOISE_RE = /\/(healthz?|metrics|actuator|favicon|robots\.txt)(\/|$|\?)/i;
// Padrão de op do endpoint interno (rota→wsv1). DEFAULT = convenção easynup
// (/easynup/op.vN); QUALQUER alvo passa o seu via opts.opPathPattern — o overlay
// não é mais cravado num sistema (ADR mapeador universal, Fase 0).
const DEFAULT_OP_RE = /\/easynup\/[A-Za-z][A-Za-z0-9]*\.v\d+/;

// Extração de TABELA agnóstica a stack (semconv OTel, verificado 1.43.0):
// cascata db.collection.name (novo Stable) → db.sql.table (antigo) → parse do
// SQL (db.query.text novo / db.statement antigo). A auto-instrumentação de
// Node(pg)/Java-antigo NEM SEMPRE emite o nome da tabela como atributo — só o
// texto do SQL — então o parser é o que torna o mapeamento UNIVERSAL.
// Captura o identificador inteiro após FROM/JOIN/INTO/UPDATE — incl. schema
// pontilhado e aspas/colchetes por segmento (`"public"."service_order"`,
// `` `contract` ``, `[dbo].[Order]`). O cleanup tira aspas e reduz a schema.tabela→tabela.
const SQL_TABLE_RE = /\b(?:from|join|into|update)\s+([`"[\]\w.$]+)/gi;
/** Extrai nomes de tabela de um SQL (sanitizado, literais→?). Puro. */
export function tablesFromSql(sql: string): string[] {
  const out = new Set<string>();
  if (!sql || typeof sql !== "string") return [];
  let m: RegExpExecArray | null;
  SQL_TABLE_RE.lastIndex = 0;
  while ((m = SQL_TABLE_RE.exec(sql)) !== null) {
    let t = m[1].replace(/[`"[\]]/g, "");        // tira aspas/colchetes
    t = t.split(".").pop() || t;                  // schema.tabela → tabela
    if (t && !/^(select|where|set|values|on|as)$/i.test(t)) out.add(t.toLowerCase());
  }
  return Array.from(out);
}
/** Tabelas tocadas por um span de banco (cascata novo→antigo→SQL). Puro. */
export function tablesFromDbSpan(tg: Record<string, string>): string[] {
  if (tg["db.collection.name"]) return [tg["db.collection.name"]];  // semconv Stable atual
  if (tg["db.sql.table"]) return [tg["db.sql.table"]];               // convenção antiga (renomeada)
  const sql = tg["db.query.text"] || tg["db.statement"];             // fallback universal
  return sql ? tablesFromSql(sql) : [];
}
/** Verbo da operação de banco (novo db.operation.name → antigo db.operation). */
function dbOpOf(tg: Record<string, string>): string {
  return (tg["db.operation.name"] || tg["db.operation"] || "").toUpperCase();
}

/**
 * Normaliza o nome de uma tabela vinda do span: tira o SCHEMA/db (`railway.
 * audit_log` → `audit_log`), aspas/colchetes, e reduz a snake_case minúsculo.
 * O `db.name`/schema é ruído — só o nome da tabela importa para casar a entidade.
 */
export function normalizeTableName(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  const bare = raw.replace(/[`"[\]]/g, "").split(".").pop() || raw;
  return toSnakeCase(bare).toLowerCase();
}

function tagsOf(sp: JaegerSpan): Record<string, string> {
  const o: Record<string, string> = {};
  for (const t of sp?.tags || []) o[t.key] = String(t.value ?? "");
  return o;
}
function stripQuery(p: string): string {
  return (p || "").split("?")[0];
}

/**
 * Extrai, de traços Jaeger crus, os pares observados por ROTA do gateway.
 * PURO — recebe os traços já buscados (testável sem rede).
 *
 * Um traço = uma requisição: a rota-raiz do gateway + TODAS as tabelas
 * (`db.sql.table`) tocadas na mesma trace-id. Robusto a RUM (span de frontend
 * como raiz): a rota é o span do serviço-gateway sem pai IN-TRACE.
 */
export function extractRuntimePairs(
  traces: JaegerTrace[],
  opts: { gatewayServices?: string[]; opPathPattern?: RegExp } = {},
): RuntimePair[] {
  const gwSvcs = new Set(opts.gatewayServices && opts.gatewayServices.length ? opts.gatewayServices : ["easynup-gateway"]);
  const opRe = opts.opPathPattern || DEFAULT_OP_RE; // configurável por alvo (não mais cravado)
  const byRoute = new Map<string, RuntimePair>();

  for (const t of traces || []) {
    const spans = Array.isArray(t?.spans) ? t.spans : [];
    if (!spans.length) continue;
    const procs = t.processes || {};
    const svcOf = (sp: JaegerSpan) => procs[sp?.processID || ""]?.serviceName || "";
    const inTrace = new Set(spans.map((s) => s.spanID).filter(Boolean) as string[]);
    const hasParentInTrace = (sp: JaegerSpan) =>
      (sp.references || []).some((r) => r.refType === "CHILD_OF" && r.spanID && inTrace.has(r.spanID));

    // rota-raiz do gateway: span do serviço-gateway com url.path/http.target e
    // sem pai in-trace (a entrada). Fallback: qualquer span de gateway com path.
    const gwSpans = spans.filter((s) => {
      const tg = tagsOf(s);
      return gwSvcs.has(svcOf(s)) && (tg["url.path"] || tg["http.target"] || tg["http.route"]);
    });
    if (!gwSpans.length) continue;
    const root = gwSpans.find((s) => !hasParentInTrace(s)) || gwSpans[0];
    const rtg = tagsOf(root);
    let path = stripQuery(rtg["url.path"] || rtg["http.target"] || rtg["http.route"] || "");
    if (!path || NOISE_RE.test(path)) continue;
    const method = String(rtg["http.request.method"] || rtg["http.method"] || "GET").toUpperCase();

    // ROTA MAIS ESPECÍFICA do traço (fix do colapso-no-mount, 2026-08-08): o
    // express seta http.route no PONTO DE MONTAGEM (ex. `/easynup`), então TODAS
    // as rotas proxied colapsavam numa única chave `GET /easynup` (routePairs=1
    // com 40 rotas distintas no hub). O span FILHO (Spring) carrega a rota real
    // (`/easynup/findX.v1`). Preferimos o caminho MAIS LONGO do traço que
    // ESTENDE o do root (prefixo estrito) — nunca troca por rota não relacionada.
    if (path) {
      let best = path;
      for (const s of spans) {
        const cand = stripQuery(tagsOf(s)["http.route"] || "");
        if (
          cand.length > best.length &&
          cand.startsWith(path.endsWith("/") ? path : `${path}/`) &&
          !NOISE_RE.test(cand)
        ) {
          best = cand;
        }
      }
      path = best;
    }

    // agrega tudo do traço
    const tables: Array<{ table: string; op: string }> = [];
    const javaEndpoints = new Set<string>();
    const pageRoutes = new Set<string>();
    let lastSeenMs = 0;
    for (const s of spans) {
      const tg = tagsOf(s);
      const op = dbOpOf(tg);
      for (const tbl of tablesFromDbSpan(tg)) tables.push({ table: normalizeTableName(tbl), op });
      const hr = tg["http.route"] || "";
      const opMatch = hr.match(opRe);
      if (opMatch) javaEndpoints.add(opMatch[0]);
      if (tg["page.route"]) pageRoutes.add(tg["page.route"]);
      if (typeof s.startTime === "number") lastSeenMs = Math.max(lastSeenMs, Math.round(s.startTime / 1000));
    }

    const key = `${method} ${path}`;
    let pair = byRoute.get(key);
    if (!pair) {
      pair = { method, path, count: 0, tables: new Map(), javaEndpoints: new Set(), pageRoutes: new Set(), traceIds: [], lastSeenMs: 0 };
      byRoute.set(key, pair);
    }
    pair.count++;
    for (const { table, op } of tables) if (table) pair.tables.set(table, op || pair.tables.get(table) || "");
    for (const e of Array.from(javaEndpoints)) pair.javaEndpoints.add(e);
    for (const p of Array.from(pageRoutes)) pair.pageRoutes.add(p);
    if (pair.traceIds.length < 5 && t.traceID) pair.traceIds.push(t.traceID);
    pair.lastSeenMs = Math.max(pair.lastSeenMs, lastSeenMs);
  }

  return Array.from(byRoute.values());
}

/**
 * Mescla os pares observados no grafo como arestas `RUNTIME_OBSERVED`.
 * PURO (muta o grafo, sem rede). Reusa `urlMatchesRoute` + `toSnakeCase`.
 */
export function applyRuntimeOverlay(
  graph: ApplicationGraph,
  pairs: RuntimePair[],
): RuntimeOverlayResult {
  const res: RuntimeOverlayResult = {
    tracesConsidered: 0, routesObserved: pairs.length, routesMatched: 0, routesMinted: 0,
    entityEdges: 0, wsv1Edges: 0, serviceEntityEdges: 0, tablesResolved: 0, tablesMinted: 0, hotNodes: 0,
  };
  res.tracesConsidered = pairs.reduce((a, p) => a + p.count, 0);

  // índices de merge (mesmas convenções do full-stack-augment)
  const entityByTable = new Map<string, string>();
  for (const n of graph.getNodesByType("ENTITY")) entityByTable.set(toSnakeCase(n.className), n.id);
  const wsv1ByPath = new Map<string, string>();
  const routeNodes: { id: string; method: string; path: string }[] = [];
  // Grafo PROFUNDO (scip/SCOPE): os WsV1 são nós `SERVICE:<fqn>` com id
  // `...<pacote>.<op>.v<N>.<Op>ServiceV1` — a convenção `wsv1:<path>` não existe
  // lá (por isso routeJavaEdges ficava 0 estrutural no projeto 27). Indexa por
  // `<op>.v<N>` derivado do PRÓPRIO id (determinístico, sem heurística de nome).
  const serviceByOpVersion = new Map<string, string>();
  const OP_SEG_RE = /\.([a-z][A-Za-z0-9]*)\.(v\d+)\./;
  for (const n of graph.getAllNodes()) {
    const md = (n.metadata || {}) as Record<string, unknown>;
    if (n.id.startsWith("wsv1:") && typeof md.fullPath === "string") wsv1ByPath.set(md.fullPath, n.id);
    if (n.type === "ROUTE") routeNodes.push({ id: n.id, method: String(md.httpMethod || ""), path: String(md.fullPath || "") });
    if (n.type === "SERVICE") {
      const m = n.id.match(OP_SEG_RE);
      if (m && !serviceByOpVersion.has(`${m[1]}.${m[2]}`)) serviceByOpVersion.set(`${m[1]}.${m[2]}`, n.id);
    }
  }

  const hot = new Set<string>();
  const markHot = (id: string, count: number, lastSeenMs: number) => {
    const n = graph.getNode(id);
    if (!n) return;
    const md = (n.metadata || {}) as Record<string, unknown>;
    (n as { metadata?: Record<string, unknown> }).metadata = md;
    md.runtimeHot = true;
    md.runtimeCount = (Number(md.runtimeCount) || 0) + count;
    if (lastSeenMs) md.runtimeLastSeenMs = Math.max(Number(md.runtimeLastSeenMs) || 0, lastSeenMs);
    hot.add(id);
  };
  const edgeSeen = new Set<string>();
  const addObserved = (from: string, to: string, meta: Record<string, unknown>) => {
    if (from === to) return false;
    const k = `${from}->${to}`;
    if (edgeSeen.has(k)) return false;
    // dedup contra aresta observada já existente (idempotente entre runs)
    if (graph.getOutgoingEdges(from).some((e) => e.toNode === to && e.relationType === "RUNTIME_OBSERVED")) {
      edgeSeen.add(k);
      return false;
    }
    edgeSeen.add(k);
    graph.addEdge(new GraphEdge(from, to, "RUNTIME_OBSERVED", { observed: true, source: "jaeger", ...meta }));
    return true;
  };

  for (const p of pairs) {
    // 1) resolve/minta o nó de ROTA
    let routeId: string | null = null;
    for (const r of routeNodes) {
      if (r.method && r.method !== p.method) continue;
      if (urlMatchesRoute(p.path, { path: r.path } as unknown as Parameters<typeof urlMatchesRoute>[1])) { routeId = r.id; break; }
    }
    if (routeId) {
      res.routesMatched++;
    } else {
      routeId = `route:runtime:${p.method}:${p.path}`;
      if (!graph.getNode(routeId)) {
        graph.addNode(new GraphNode(routeId, "ROUTE", p.path, null, null, {
          httpMethod: p.method, fullPath: p.path, runtimeOnly: true, observed: true, synthetic: true,
        }));
        routeNodes.push({ id: routeId, method: p.method, path: p.path });
      }
      res.routesMinted++;
    }
    markHot(routeId, p.count, p.lastSeenMs);

    const meta = {
      count: p.count,
      traceIds: p.traceIds.slice(0, 5),
      lastSeenMs: p.lastSeenMs || undefined,
      pageRoutes: p.pageRoutes.size ? Array.from(p.pageRoutes).slice(0, 3) : undefined,
    };

    // 2) rota → entidade (a costura: alcança o DADO que o estático não pega)
    for (const [table, op] of Array.from(p.tables)) {
      let target = entityByTable.get(table);
      if (target) {
        res.tablesResolved++;
      } else {
        target = `table:${table}`;
        if (!graph.getNode(target)) {
          graph.addNode(new GraphNode(target, "ENTITY", table, null, null, { runtimeOnly: true, observed: true, synthetic: true }));
          entityByTable.set(table, target);
        }
        res.tablesMinted++;
      }
      if (addObserved(routeId, target, { ...meta, operation: op || undefined })) res.entityEdges++;
      markHot(target, p.count, p.lastSeenMs);
    }

    // 3) rota → endpoint Java (quando o proxy aparece no traço)
    // Resolve na convenção rasa (`wsv1:<path>`) E na profunda (`SERVICE:<fqn>`
    // via `<op>.v<N>` do path `/easynup/<op>.v<N>`).
    const javaTargets: string[] = [];
    for (const ep of Array.from(p.javaEndpoints)) {
      let target = wsv1ByPath.get(ep) || null;
      if (!target) {
        const m = ep.match(/\/([a-z][A-Za-z0-9]*)\.(v\d+)(?:\/|$)/);
        if (m) target = serviceByOpVersion.get(`${m[1]}.${m[2]}`) || null;
      }
      if (!target) continue;
      javaTargets.push(target);
      if (addObserved(routeId, target, { ...meta, endpoint: ep })) res.wsv1Edges++;
      markHot(target, p.count, p.lastSeenMs);
    }

    // 4) serviço → entidade OBSERVADO same-trace (a base dos pares COMPARÁVEIS
    // da calibração: SERVICE tem arestas estáticas — uma aresta observada com a
    // MESMA origem torna o oráculo comparável ao mapa). CONSERVADOR: só quando o
    // traço tem EXATAMENTE 1 endpoint Java — com 2+, atribuir tabela a serviço
    // seria chute (anti-falso-positivo declarado).
    if (javaTargets.length === 1) {
      const svcNode = javaTargets[0];
      for (const [table, op] of Array.from(p.tables)) {
        const target = entityByTable.get(table) || `table:${table}`;
        if (!graph.getNode(target)) continue; // entidade já mintada no passo 2
        if (addObserved(svcNode, target, { ...meta, operation: op || undefined, viaTrace: true })) {
          res.serviceEntityEdges++;
        }
      }
    }
  }

  res.hotNodes = hot.size;
  return res;
}

// ─────────────────────────────────────────────
// Mapeamento DIRETO tabela→ENTITY (independente de rota) — o caso do TRAÇO
// FRAGMENTO.
//
// Achado ao vivo (2026-08-07): no hub, os traços `easynup-backend` são
// FRAGMENTOS — carregam spans de DB com `db.sql.table` mas NÃO o span de rota
// HTTP (o Gateway, que emite o span-raiz com `http.route`/`url.path`, roda deploy
// antigo e exporta pro collector morto). Logo `extractRuntimePairs` (que precisa
// do par rota→tabela) acha 0 pares e o `RUNTIME_OBSERVED` fica 0 mesmo com o hub
// cheio de spans de DB.
//
// Correção: se um span de runtime TOCA a tabela `T`, a ENTIDADE correspondente
// foi PROVADAMENTE acessada em runtime — evidência de 1ª classe do que o mapa
// quer ("isto executou de fato"), SEM depender da rota. Marca o nó ENTITY como
// `runtimeHot` (→ `coverage.nodes.observed` + `evidence.method=RUNTIME_OBSERVED`)
// e emite uma aresta `RUNTIME_OBSERVED` de uma fonte de runtime sintética e
// TRANSPARENTE (`runtime:db:<serviço>`, `dbFragment:true`) → a entidade, para o
// censo de arestas (`coverage.byMethod.RUNTIME_OBSERVED`) também acender. A fonte
// diz honestamente "acesso a DB observado, rota indisponível (traço fragmentado)".
// Continua valendo o par rota→tabela quando o traço COMPLETO existir.
// ─────────────────────────────────────────────

/** Tabela tocada em runtime, agregada por nome (snake, schema-stripped). */
export interface RuntimeTableHit {
  table: string;                 // nome normalizado (audit_log, sla_indicator)
  count: number;                 // nº de spans de DB que a tocaram
  ops: Set<string>;              // verbos observados (SELECT/INSERT/…)
  services: Set<string>;         // serviços OTel cujos spans a tocaram
  traceIds: string[];            // amostra (≤5)
  lastSeenMs: number;
}

export interface RuntimeTableObservationResult {
  tablesObserved: number;   // tabelas distintas tocadas em runtime
  entitiesResolved: number; // tabela casou uma ENTITY existente
  tablesMinted: number;     // tabela sem ENTITY → mintou table:<n>
  nodesMarked: number;      // nós de entidade marcados runtimeHot
  edges: number;            // arestas RUNTIME_OBSERVED fonte→entidade emitidas
}

/**
 * Extrai, de traços crus, o conjunto de TABELAS tocadas por spans de DB —
 * INDEPENDENTE de rota (funciona no traço fragmento que só tem span de DB). PURO.
 * Agrega por nome de tabela normalizado. `opts.dbServices` opcional restringe os
 * serviços considerados (default: qualquer serviço).
 */
export function extractRuntimeTableHits(
  traces: JaegerTrace[],
  opts: { dbServices?: string[] } = {},
): RuntimeTableHit[] {
  const allow = opts.dbServices && opts.dbServices.length ? new Set(opts.dbServices) : null;
  const byTable = new Map<string, RuntimeTableHit>();
  for (const t of traces || []) {
    const spans = Array.isArray(t?.spans) ? t.spans : [];
    if (!spans.length) continue;
    const procs = t.processes || {};
    for (const s of spans) {
      const svc = procs[s?.processID || ""]?.serviceName || "";
      if (allow && !allow.has(svc)) continue;
      const tg = tagsOf(s);
      const op = dbOpOf(tg);
      const seen = new Set<string>();
      for (const raw of tablesFromDbSpan(tg)) {
        const table = normalizeTableName(raw);
        if (!table || seen.has(table)) continue;
        seen.add(table);
        let hit = byTable.get(table);
        if (!hit) {
          hit = { table, count: 0, ops: new Set(), services: new Set(), traceIds: [], lastSeenMs: 0 };
          byTable.set(table, hit);
        }
        hit.count++;
        if (op) hit.ops.add(op);
        if (svc) hit.services.add(svc);
        if (hit.traceIds.length < 5 && t.traceID && !hit.traceIds.includes(t.traceID)) hit.traceIds.push(t.traceID);
        if (typeof s.startTime === "number") hit.lastSeenMs = Math.max(hit.lastSeenMs, Math.round(s.startTime / 1000));
      }
    }
  }
  return Array.from(byTable.values());
}

/**
 * Mescla os hits de tabela como observação de runtime da ENTIDADE. PURO (muta o
 * grafo, sem rede). Reusa `toSnakeCase(className)` — a MESMA convenção do índice
 * de entidade do `applyRuntimeOverlay` — então `sla_indicator`→`SlaIndicator`,
 * `audit_log`→`AuditLog`, `snap_point_category`→`SnapPointCategory` casam.
 */
export function applyRuntimeTableObservations(
  graph: ApplicationGraph,
  hits: RuntimeTableHit[],
): RuntimeTableObservationResult {
  const res: RuntimeTableObservationResult = {
    tablesObserved: hits.length, entitiesResolved: 0, tablesMinted: 0, nodesMarked: 0, edges: 0,
  };
  // índice tabela(snake) → id de nó ENTITY (mesma convenção do overlay de rota).
  const entityByTable = new Map<string, string>();
  for (const n of graph.getNodesByType("ENTITY")) {
    const cn = n.className || n.id.split(":").pop() || "";
    const key = toSnakeCase(cn);
    if (key && !entityByTable.has(key)) entityByTable.set(key, n.id);
  }

  const markHot = (id: string, count: number, lastSeenMs: number) => {
    const n = graph.getNode(id);
    if (!n) return;
    const md = (n.metadata || {}) as Record<string, unknown>;
    (n as { metadata?: Record<string, unknown> }).metadata = md;
    md.runtimeHot = true;
    md.runtimeCount = (Number(md.runtimeCount) || 0) + count;
    if (lastSeenMs) md.runtimeLastSeenMs = Math.max(Number(md.runtimeLastSeenMs) || 0, lastSeenMs);
  };
  const edgeSeen = new Set<string>();
  const addObserved = (from: string, to: string, meta: Record<string, unknown>) => {
    if (from === to) return false;
    const k = `${from}->${to}`;
    if (edgeSeen.has(k)) return false;
    if (graph.getOutgoingEdges(from).some((e) => e.toNode === to && e.relationType === "RUNTIME_OBSERVED")) {
      edgeSeen.add(k);
      return false;
    }
    edgeSeen.add(k);
    graph.addEdge(new GraphEdge(from, to, "RUNTIME_OBSERVED", { observed: true, source: "jaeger", ...meta }));
    return true;
  };

  for (const h of hits) {
    let target = entityByTable.get(h.table);
    if (target) {
      res.entitiesResolved++;
    } else {
      target = `table:${h.table}`;
      if (!graph.getNode(target)) {
        graph.addNode(new GraphNode(target, "ENTITY", h.table, null, null, { runtimeOnly: true, observed: true, synthetic: true }));
        entityByTable.set(h.table, target);
      }
      res.tablesMinted++;
    }
    markHot(target, h.count, h.lastSeenMs);
    res.nodesMarked++;

    // Fonte de runtime sintética e TRANSPARENTE (rota indisponível no fragmento).
    const svc = Array.from(h.services)[0] || "runtime";
    const src = `runtime:db:${svc}`;
    if (!graph.getNode(src)) {
      graph.addNode(new GraphNode(src, "ROUTE", `db@${svc}`, null, null, {
        runtimeOnly: true, observed: true, synthetic: true, dbFragment: true, service: svc,
      }));
    }
    markHot(src, h.count, h.lastSeenMs);
    const op = Array.from(h.ops)[0] || undefined;
    if (addObserved(src, target, { count: h.count, operation: op, dbFragment: true, traceIds: h.traceIds.slice(0, 5), lastSeenMs: h.lastSeenMs || undefined })) {
      res.edges++;
    }
  }
  return res;
}

// ─── Leitor Jaeger (rede; gated + fail-soft + time-boxed) ───
export interface FetchTracesOpts {
  baseUrl: string;
  apiKey?: string | null;
  services?: string[];
  lookbackMs?: number;
  limit?: number;
  nowMs?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  logger?: { warn?: (...a: unknown[]) => void };
}

/**
 * Relatório POR SERVIÇO do fetch de traços — a matéria-prima do diagnóstico
 * durável (`analysis_runs.diagnostics`). Sem isto, "0 traço" era indistinguível
 * de "Jaeger 502/fora do ar" (incidente 2026-08-08: o hub Badger devolve 502
 * transiente em janela grande e o overlay virava 0 aresta EM SILÊNCIO).
 */
export interface TraceFetchServiceReport {
  service: string;
  /** HTTP status da última tentativa (0 = erro de rede/abort). */
  httpStatus: number;
  /** mensagem de erro de rede, quando houve. */
  error?: string;
  /** nº de traços retornados pela tentativa que valeu. */
  traces: number;
  /** true quando a 1ª tentativa falhou e o retry (janela reduzida) foi usado. */
  retried: boolean;
  /** lookback efetivamente usado na tentativa que valeu (ms). */
  lookbackMsUsed: number;
}

async function fetchServiceOnce(
  fetchFn: typeof fetch,
  url: string,
  apiKey: string | null | undefined,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; error?: string; data: JaegerTrace[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      headers: apiKey ? { "x-api-key": apiKey } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, data: [] };
    const json = (await res.json()) as { data?: JaegerTrace[] };
    return { ok: true, status: res.status, data: Array.isArray(json?.data) ? json.data : [] };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error)?.message || String(err), data: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca traços recentes da Jaeger native query API por serviço, dedupa por
 * traceID, e devolve TAMBÉM o relatório por serviço. NUNCA lança (fail-soft).
 * Resiliência: se a 1ª tentativa de um serviço falha (HTTP ≠2xx ou rede), faz
 * UM retry com a janela reduzida à metade — o modo de falha real do hub
 * (Badger 502 sob janela grande) responde bem a janela menor; mais que 1 retry
 * viraria martelo em backend doente.
 */
export async function fetchRecentTracesWithReport(
  opts: FetchTracesOpts,
): Promise<{ traces: JaegerTrace[]; report: TraceFetchServiceReport[] }> {
  const base = opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, "") : "";
  if (!base) return { traces: [], report: [] };
  const services = opts.services && opts.services.length ? opts.services : ["easynup-gateway", "easynup-backend"];
  const now = opts.nowMs ?? Date.now();
  const lookbackMs = opts.lookbackMs ?? 86400000;
  const limit = opts.limit ?? 400;
  const fetchFn = opts.fetchFn || fetch;
  const log = opts.logger || console;
  const timeoutMs = opts.timeoutMs ?? 20000;

  const urlFor = (service: string, lb: number) => {
    const endMicros = now * 1000;
    const startMicros = endMicros - lb * 1000;
    return `${base}/api/traces?service=${encodeURIComponent(service)}&start=${startMicros}&end=${endMicros}&limit=${limit}`;
  };

  const byTrace = new Map<string, JaegerTrace>();
  const report: TraceFetchServiceReport[] = [];
  for (const service of services) {
    let attempt = await fetchServiceOnce(fetchFn, urlFor(service, lookbackMs), opts.apiKey, timeoutMs);
    let retried = false;
    let lookbackUsed = lookbackMs;
    if (!attempt.ok) {
      log.warn?.(
        `[runtime-overlay] jaeger ${service} falhou (HTTP ${attempt.status}${attempt.error ? ` ${attempt.error}` : ""}) — retry com janela ${Math.round(lookbackMs / 2 / 60000)}min`,
      );
      retried = true;
      lookbackUsed = Math.max(60000, Math.floor(lookbackMs / 2));
      attempt = await fetchServiceOnce(fetchFn, urlFor(service, lookbackUsed), opts.apiKey, timeoutMs);
    }
    if (!attempt.ok) {
      log.warn?.(`[runtime-overlay] jaeger ${service} HTTP ${attempt.status}${attempt.error ? ` ${attempt.error}` : ""}`);
    }
    for (const t of attempt.data) {
      if (t?.traceID && !byTrace.has(t.traceID)) byTrace.set(t.traceID, t);
    }
    report.push({
      service,
      httpStatus: attempt.status,
      ...(attempt.error ? { error: attempt.error } : {}),
      traces: attempt.data.length,
      retried,
      lookbackMsUsed: lookbackUsed,
    });
  }
  return { traces: Array.from(byTrace.values()), report };
}

/** Retrocompat: mesma busca, só os traços (consumidores antigos + testes). */
export async function fetchRecentTraces(opts: FetchTracesOpts): Promise<JaegerTrace[]> {
  return (await fetchRecentTracesWithReport(opts)).traces;
}

// ─── Orquestrador da costura (o que o pipeline invoca) ───
export interface RuntimeOverlaySummary {
  traces: number;
  dbSpanHits: number;      // total de spans de DB (soma dos counts por tabela)
  routePairs: number;      // rotas observadas com par rota→tabela (traço completo)
  routeEntityEdges: number;
  routeJavaEdges: number;
  serviceEntityEdges: number;  // serviço→entidade same-trace (base dos pares comparáveis)
  tablesObserved: number;
  entitiesResolved: number;
  tablesMinted: number;
  entityNodesMarked: number;
  tableEntityEdges: number;
  /** fetch por serviço (HTTP status/retry/traços) — vai pro diagnóstico durável. */
  fetchReport: TraceFetchServiceReport[];
}

export interface RunRuntimeOverlayDeps {
  /** sink de log SEMPRE chamado (nunca no-op silencioso). */
  onLog?: (msg: string) => void;
  /** injeção para teste; default = fetch global via fetchRecentTraces. */
  fetchFn?: typeof fetch;
  nowMs?: number;
}

/**
 * Orquestra a costura runtime↔estático sobre um grafo: busca traços, aplica o par
 * rota→tabela (traço COMPLETO) E o mapeamento direto tabela→ENTITY (traço
 * FRAGMENTO), e LOGA HONESTAMENTE cada etapa (config, nº de traços, nº de spans de
 * DB, nº de arestas por caminho). Fail-soft: erro de rede → 0, nunca lança. É o
 * ponto único que o `analysis-pipeline` chama — o teste exercita esse mesmo caminho.
 */
export async function runRuntimeOverlay(
  graph: ApplicationGraph,
  cfg: ResolvedRuntimeOverlayConfig,
  deps: RunRuntimeOverlayDeps = {},
): Promise<RuntimeOverlaySummary> {
  const log = (m: string) => deps.onLog?.(m);
  log(`Runtime overlay ON — jaeger=${cfg.jaegerUrl} serviços=[${cfg.services.join(",")}] raízes=[${cfg.gatewayServices.join(",")}]`);

  const { traces, report: fetchReport } = await fetchRecentTracesWithReport({
    baseUrl: cfg.jaegerUrl,
    apiKey: cfg.apiKey,
    services: cfg.services,
    lookbackMs: cfg.lookbackMs,
    limit: cfg.limit,
    nowMs: deps.nowMs,
    fetchFn: deps.fetchFn,
  });
  for (const r of fetchReport) {
    log(
      `Runtime overlay fetch: ${r.service} HTTP ${r.httpStatus} traços=${r.traces}${r.retried ? ` (retry, janela ${Math.round(r.lookbackMsUsed / 60000)}min)` : ""}${r.error ? ` erro=${r.error}` : ""}`,
    );
  }

  // (1) par rota→tabela — traço COMPLETO (root HTTP + spans de DB).
  const pairs = extractRuntimePairs(traces, { gatewayServices: cfg.gatewayServices, opPathPattern: cfg.opPathPattern });
  const ov = applyRuntimeOverlay(graph, pairs);

  // (2) tabela→ENTITY direto — traço FRAGMENTO (só span de DB, sem rota).
  const hits = extractRuntimeTableHits(traces, { dbServices: cfg.services });
  const tobs = applyRuntimeTableObservations(graph, hits);
  const dbSpanHits = hits.reduce((a, h) => a + h.count, 0);

  log(
    `Runtime overlay: traços=${traces.length} spans-DB=${dbSpanHits} · ROTA: pares=${pairs.length} arestas=${ov.entityEdges}entidade+${ov.wsv1Edges}java · TABELA→ENTIDADE: tabelas=${tobs.tablesObserved} (${tobs.entitiesResolved}✓/${tobs.tablesMinted}mint) nós=${tobs.nodesMarked} arestas=${tobs.edges}`,
  );
  if (traces.length > 0 && ov.routesObserved === 0 && tobs.tablesObserved === 0) {
    log(`Runtime overlay: ${traces.length} traços mas 0 rota E 0 tabela — spans sem url.path/http.route NEM db.sql.table/db.statement. Confira a instrumentação/serviços OTel [${cfg.services.join(",")}].`);
  } else if (tobs.tablesObserved > 0 && ov.routesObserved === 0) {
    log(`Runtime overlay: traços FRAGMENTO (spans de DB sem span de rota) — a entidade foi marcada RUNTIME_OBSERVED direto pela tabela (rota indisponível; Gateway não exporta pro hub).`);
  }

  return {
    traces: traces.length,
    dbSpanHits,
    routePairs: pairs.length,
    routeEntityEdges: ov.entityEdges,
    routeJavaEdges: ov.wsv1Edges,
    serviceEntityEdges: ov.serviceEntityEdges,
    tablesObserved: tobs.tablesObserved,
    entitiesResolved: tobs.entitiesResolved,
    tablesMinted: tobs.tablesMinted,
    entityNodesMarked: tobs.nodesMarked,
    tableEntityEdges: tobs.edges,
    fetchReport,
  };
}

// ─── ADR-0028 P1.1 — resolução de config POR PROJETO (pura, testável) ───
//
// PROBLEMA que isto resolve (diagnóstico do `observedRatio:0` do NuPIdentify):
// a costura runtime↔estático já flui ponta-a-ponta (overlay → `appGraph` →
// snapshot `systemGraph` → `/graph`/`shapeSystemGraph` → `RUNTIME_OBSERVED` +
// `coverage.observedRatio`). Mas o allowlist de SERVIÇO Jaeger vinha de um env
// GLOBAL do processo (`RUNTIME_OVERLAY_SERVICES`, default `easynup-*`). Uma
// única instância do Manifest analisa VÁRIOS projetos — com um env global ela
// NUNCA acende os traços de um 2º projeto (NuPIdentify): o allowlist easynup
// não casa NENHUM span daquele serviço, `extractRuntimePairs` volta [], zero
// aresta observada, `observedRatio` fica 0.
//
// A config passa a ser resolvida POR PROJETO, em cascata:
//   conventionProfile.runtimeOverlay (por projeto, JSONB — SEM migration)
//     > env do processo (RUNTIME_OVERLAY_*/JAEGER_QUERY_*)
//       > default easynup.
// OPT-IN / ADITIVO: sem override de projeto e sem env → `null` (desligado,
// byte-a-byte ao gated de hoje). `gatewayService` = span-raiz do traço (o
// serviço que recebe a requisição); num serviço único (NuPIdentify) é o próprio.
//
// CONSTRAINT honesto (SOTA): OTel só observa FRONTEIRAS instrumentadas
// (serviço→serviço, →DB). O overlay carimba as arestas de fronteira (rota→
// entidade, rota→endpoint), NÃO o call-graph interno método-a-método. Logo
// `observedRatio` mede "fração de arestas de fronteira observadas" e por
// construção NÃO tende a 1.0 — é o teto correto, não uma falha.

/** Override por projeto (lido de `conventionProfile.runtimeOverlay`). Todos opcionais. */
export interface RuntimeOverlayProjectConfig {
  jaegerUrl?: string | null;
  apiKey?: string | null;
  /** allowlist de serviços OTel; CSV ou array. services[0] = serviço de fronteira/raiz. */
  services?: string | string[];
  /** serviço que recebe a requisição (span-raiz). Default = services[0]. */
  gatewayService?: string;
  lookbackMs?: number;
  limit?: number;
  /** regex (string) do endpoint interno (rota→endpoint). Inválida → default. */
  opPathPattern?: string;
}

/** Config normalizada e pronta pra usar; `null` = overlay desligado (gated). */
export interface ResolvedRuntimeOverlayConfig {
  jaegerUrl: string;
  apiKey: string | null;
  services: string[];
  /** serviço de fronteira "canônico" (services[0] ou o explícito). Mantido p/ retrocompat. */
  gatewayService: string;
  /**
   * TODOS os serviços que podem ser a RAIZ de um traço (span de entrada). Um
   * traço rooteia no serviço que RECEBE a requisição — no easynup pode ser o
   * gateway Node (`easynup-gateway`) OU o backend Java (`easynup-backend`) quando
   * o tráfego bate direto no Java (robô nup-sentinel, cron, chamada interna). Se
   * só o `gatewayService` fosse aceito como raiz, os traços rooteados no BACKEND
   * — justamente os que carregam os spans de DB (`db.sql.table`) — seriam
   * descartados e o overlay produziria 0 aresta RUNTIME_OBSERVED mesmo com o hub
   * cheio de traços. Inclui o `gatewayService` + toda a allowlist `services`.
   */
  gatewayServices: string[];
  lookbackMs: number;
  limit: number;
  opPathPattern?: RegExp;
}

const DEFAULT_OVERLAY_SERVICES = ["easynup-gateway", "easynup-backend"];

function csvToList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
function firstNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}
/** Compila a regex de op (string do operador); inválida → default seguro, nunca lança. */
function compileOpPattern(raw?: string): RegExp | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  try { return new RegExp(raw); } catch { return DEFAULT_OP_RE; }
}

/**
 * Resolve a config do overlay para UM projeto. PURA (só lê o bag do projeto +
 * um mapa de env). Retorna `null` quando não há URL do Jaeger em nenhuma camada
 * (overlay desligado = comportamento gated atual, byte-a-byte).
 */
export function resolveRuntimeOverlayConfig(
  perProject: RuntimeOverlayProjectConfig | null | undefined,
  env: Record<string, string | undefined> = {},
): ResolvedRuntimeOverlayConfig | null {
  const pp = perProject || {};
  const jaegerUrl = firstStr(pp.jaegerUrl, env.RUNTIME_OVERLAY_JAEGER_URL, env.JAEGER_QUERY_URL);
  if (!jaegerUrl) return null; // gated: sem Jaeger, nada a fazer

  const services =
    (pp.services !== undefined ? csvToList(pp.services) : []).length
      ? csvToList(pp.services)
      : csvToList(env.RUNTIME_OVERLAY_SERVICES).length
        ? csvToList(env.RUNTIME_OVERLAY_SERVICES)
        : [...DEFAULT_OVERLAY_SERVICES];

  const gatewayService = firstStr(pp.gatewayService) || services[0];
  // Raízes de traço aceitas = o serviço de fronteira explícito + TODA a allowlist
  // buscada, dedup preservando a ordem (o de fronteira primeiro). Assim um traço
  // rooteado no backend (que carrega os spans de DB) é minerado, não descartado.
  const gatewayServices = Array.from(new Set([gatewayService, ...services].filter(Boolean)));

  return {
    jaegerUrl,
    apiKey: firstStr(pp.apiKey, env.JAEGER_QUERY_API_KEY) || null,
    services,
    gatewayService,
    gatewayServices,
    lookbackMs: firstNum(pp.lookbackMs, env.RUNTIME_OVERLAY_LOOKBACK_MS) ?? 86400000,
    limit: firstNum(pp.limit, env.RUNTIME_OVERLAY_LIMIT) ?? 400,
    opPathPattern: compileOpPattern(pp.opPathPattern),
  };
}

/** Lê o bag `runtimeOverlay` do `conventionProfile` de um projeto (defensivo, nunca lança). */
export function projectOverlayConfig(project: unknown): RuntimeOverlayProjectConfig | null {
  const cp = (project as { conventionProfile?: unknown } | null)?.conventionProfile;
  if (!cp || typeof cp !== "object") return null;
  const ro = (cp as Record<string, unknown>).runtimeOverlay;
  return ro && typeof ro === "object" ? (ro as RuntimeOverlayProjectConfig) : null;
}

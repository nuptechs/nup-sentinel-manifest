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
    const path = stripQuery(rtg["url.path"] || rtg["http.target"] || rtg["http.route"] || "");
    if (!path || NOISE_RE.test(path)) continue;
    const method = String(rtg["http.request.method"] || rtg["http.method"] || "GET").toUpperCase();

    // agrega tudo do traço
    const tables: Array<{ table: string; op: string }> = [];
    const javaEndpoints = new Set<string>();
    const pageRoutes = new Set<string>();
    let lastSeenMs = 0;
    for (const s of spans) {
      const tg = tagsOf(s);
      const op = dbOpOf(tg);
      for (const tbl of tablesFromDbSpan(tg)) tables.push({ table: toSnakeCase(tbl), op });
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
    entityEdges: 0, wsv1Edges: 0, tablesResolved: 0, tablesMinted: 0, hotNodes: 0,
  };
  res.tracesConsidered = pairs.reduce((a, p) => a + p.count, 0);

  // índices de merge (mesmas convenções do full-stack-augment)
  const entityByTable = new Map<string, string>();
  for (const n of graph.getNodesByType("ENTITY")) entityByTable.set(toSnakeCase(n.className), n.id);
  const wsv1ByPath = new Map<string, string>();
  const routeNodes: { id: string; method: string; path: string }[] = [];
  for (const n of graph.getAllNodes()) {
    const md = (n.metadata || {}) as Record<string, unknown>;
    if (n.id.startsWith("wsv1:") && typeof md.fullPath === "string") wsv1ByPath.set(md.fullPath, n.id);
    if (n.type === "ROUTE") routeNodes.push({ id: n.id, method: String(md.httpMethod || ""), path: String(md.fullPath || "") });
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
    for (const ep of Array.from(p.javaEndpoints)) {
      const target = wsv1ByPath.get(ep);
      if (!target) continue;
      if (addObserved(routeId, target, { ...meta, endpoint: ep })) res.wsv1Edges++;
      markHot(target, p.count, p.lastSeenMs);
    }
  }

  res.hotNodes = hot.size;
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
 * Busca traços recentes da Jaeger native query API por serviço, dedupa por
 * traceID. NUNCA lança (fail-soft: erro/rede → []). Time-boxed por serviço.
 */
export async function fetchRecentTraces(opts: FetchTracesOpts): Promise<JaegerTrace[]> {
  const base = opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, "") : "";
  if (!base) return [];
  const services = opts.services && opts.services.length ? opts.services : ["easynup-gateway", "easynup-backend"];
  const now = opts.nowMs ?? Date.now();
  const lookbackMs = opts.lookbackMs ?? 86400000;
  const limit = opts.limit ?? 400;
  const endMicros = now * 1000;
  const startMicros = endMicros - lookbackMs * 1000;
  const fetchFn = opts.fetchFn || fetch;
  const log = opts.logger || console;

  const byTrace = new Map<string, JaegerTrace>();
  for (const service of services) {
    const url = `${base}/api/traces?service=${encodeURIComponent(service)}&start=${startMicros}&end=${endMicros}&limit=${limit}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
    try {
      const res = await fetchFn(url, {
        headers: opts.apiKey ? { "x-api-key": opts.apiKey } : {},
        signal: ctrl.signal,
      });
      if (!res.ok) { log.warn?.(`[runtime-overlay] jaeger ${service} HTTP ${res.status}`); continue; }
      const json = (await res.json()) as { data?: JaegerTrace[] };
      for (const t of Array.isArray(json?.data) ? json.data : []) {
        if (t?.traceID && !byTrace.has(t.traceID)) byTrace.set(t.traceID, t);
      }
    } catch (err) {
      log.warn?.(`[runtime-overlay] jaeger ${service} erro:`, (err as Error)?.message || err);
    } finally {
      clearTimeout(timer);
    }
  }
  return Array.from(byTrace.values());
}

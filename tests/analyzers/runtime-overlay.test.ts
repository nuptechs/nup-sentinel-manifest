import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractRuntimePairs,
  applyRuntimeOverlay,
  fetchRecentTraces,
  fetchRecentTracesWithReport,
  type JaegerTrace,
} from "../../server/analyzers/runtime-overlay";
import { ApplicationGraph, GraphNode } from "../../server/analyzers/application-graph";

// ── helpers de traço Jaeger (shape verificado ao vivo 2026-08-02) ──
const tag = (key: string, value: unknown) => ({ key, value });
function trace(traceID: string, spans: Array<{ svc: string; op?: string; parent?: string; id?: string; tags?: Record<string, unknown>; startTime?: number }>): JaegerTrace {
  const processes: Record<string, { serviceName: string }> = {};
  const jspans = spans.map((s, i) => {
    const pid = `p_${s.svc}`;
    processes[pid] = { serviceName: s.svc };
    return {
      spanID: s.id || `s${i}`,
      operationName: s.op || "",
      processID: pid,
      startTime: s.startTime,
      references: s.parent ? [{ refType: "CHILD_OF", traceID, spanID: s.parent }] : [],
      tags: Object.entries(s.tags || {}).map(([k, v]) => tag(k, v)),
    };
  });
  return { traceID, spans: jspans, processes };
}

describe("ADR-0026 costura — extractRuntimePairs (traço → par rota/tabela)", () => {
  it("rota Node-nativa + db.sql.table → par rota→tabela (o caso dos 56%)", () => {
    // espelha o traço REAL: GET /api/internal/workflowAgentTask/findPending → workflow_callback_token
    const t = trace("t1", [
      { svc: "easynup-gateway", id: "gw", tags: { "url.path": "/api/internal/workflowAgentTask/findPending?x=1", "http.request.method": "GET" } },
      { svc: "easynup-backend", id: "bk", parent: "gw", tags: { "http.route": "/api/internal/workflowAgentTask/findPending" } },
      { svc: "easynup-backend", id: "jd", parent: "bk", tags: { "db.sql.table": "workflow_callback_token", "db.operation": "SELECT" } },
    ]);
    const pairs = extractRuntimePairs([t]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].method, "GET");
    assert.equal(pairs[0].path, "/api/internal/workflowAgentTask/findPending"); // query removida
    assert.ok(pairs[0].tables.has("workflow_callback_token"));
    assert.equal(pairs[0].tables.get("workflow_callback_token"), "SELECT");
    assert.deepEqual(pairs[0].traceIds, ["t1"]);
  });

  it("captura endpoint Java (/easynup/op.v1) + page.route (RUM) quando presentes", () => {
    const t = trace("t2", [
      { svc: "easynup-gateway", id: "gw", tags: { "url.path": "/easynup/findContract.v1", "http.request.method": "POST", "page.route": "/contratos" } },
      { svc: "easynup-backend", id: "bk", parent: "gw", tags: { "http.route": "/easynup/findContract.v1" } },
      { svc: "easynup-backend", id: "jd", parent: "bk", tags: { "db.sql.table": "contract", "db.operation": "SELECT" } },
    ]);
    const [p] = extractRuntimePairs([t]);
    assert.ok(p.javaEndpoints.has("/easynup/findContract.v1"));
    assert.ok(p.pageRoutes.has("/contratos"));
    assert.ok(p.tables.has("contract"));
  });

  it("pula ruído (health/metrics/actuator) — não polui o mapa", () => {
    const t = trace("t3", [{ svc: "easynup-gateway", id: "gw", tags: { "url.path": "/actuator/health", "http.request.method": "GET" } }]);
    assert.equal(extractRuntimePairs([t]).length, 0);
  });

  it("agrega múltiplos traços da MESMA rota (count + união de tabelas + amostra ≤5)", () => {
    const mk = (id: string, tbl: string) => trace(id, [
      { svc: "easynup-gateway", id: "gw", tags: { "url.path": "/api/x", "http.request.method": "GET" } },
      { svc: "easynup-backend", id: "jd", parent: "gw", tags: { "db.sql.table": tbl } },
    ]);
    const pairs = extractRuntimePairs([mk("a", "foo"), mk("b", "bar"), mk("c", "foo")]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].count, 3);
    assert.deepEqual([...pairs[0].tables.keys()].sort(), ["bar", "foo"]);
    assert.equal(pairs[0].traceIds.length, 3);
  });

  it("robusto a RUM: raiz é o span do GATEWAY sem pai in-trace (não o frontend)", () => {
    const t = trace("t4", [
      { svc: "easynup-frontend", id: "fe", tags: { "url.path": "/spa", "http.request.method": "GET" } },
      { svc: "easynup-gateway", id: "gw", parent: "fe", tags: { "url.path": "/api/real", "http.request.method": "POST" } },
      { svc: "easynup-backend", id: "jd", parent: "gw", tags: { "db.sql.table": "vendor" } },
    ]);
    const [p] = extractRuntimePairs([t]);
    assert.equal(p.path, "/api/real"); // a rota do gateway, não /spa do frontend
    assert.equal(p.method, "POST");
  });
});

describe("ADR-0026 costura — applyRuntimeOverlay (merge no grafo)", () => {
  function graphWith(entities: Array<[string, string]>, routes: Array<[string, string]> = []) {
    const g = new ApplicationGraph();
    for (const [id, className] of entities) g.addNode(new GraphNode(id, "ENTITY", className, null, null, {}));
    for (const [method, path] of routes) g.addNode(new GraphNode(`route:${method}:${path}`, "ROUTE", path, null, null, { httpMethod: method, fullPath: path }));
    return g;
  }
  const pair = (over: Partial<import("../../server/analyzers/runtime-overlay").RuntimePair> & { method: string; path: string }) =>
    ({ count: 1, tables: new Map(), javaEndpoints: new Set(), pageRoutes: new Set(), traceIds: ["t"], lastSeenMs: 0, ...over });

  it("casa rota estática (:param) + resolve tabela→ENTITY existente → aresta RUNTIME_OBSERVED", () => {
    const g = graphWith([["entity:WorkflowCallbackToken", "WorkflowCallbackToken"]], [["GET", "/api/x/:id"]]);
    const r = applyRuntimeOverlay(g, [pair({ method: "GET", path: "/api/x/42", tables: new Map([["workflow_callback_token", "SELECT"]]) })]);
    assert.equal(r.routesMatched, 1);
    assert.equal(r.routesMinted, 0);
    assert.equal(r.tablesResolved, 1);
    assert.equal(r.entityEdges, 1);
    const e = g.getAllEdges().find((x) => x.fromNode === "route:GET:/api/x/:id" && x.toNode === "entity:WorkflowCallbackToken");
    assert.ok(e, "aresta rota→entidade criada");
    assert.equal(e!.relationType, "RUNTIME_OBSERVED");
    assert.equal(e!.metadata.observed, true);
    assert.equal(e!.metadata.source, "jaeger");
    // nós marcados hot
    assert.equal((g.getNode("route:GET:/api/x/:id")!.metadata as Record<string, unknown>).runtimeHot, true);
    assert.equal((g.getNode("entity:WorkflowCallbackToken")!.metadata as Record<string, unknown>).runtimeHot, true);
  });

  it("rota observada AUSENTE do estático → minta route:runtime (miss honesto), tabela sem ENTITY → minta table:<n>", () => {
    const g = graphWith([]); // sem rotas nem entidades
    const r = applyRuntimeOverlay(g, [pair({ method: "GET", path: "/api/orphan", tables: new Map([["some_table", ""]]) })]);
    assert.equal(r.routesMatched, 0);
    assert.equal(r.routesMinted, 1);
    assert.equal(r.tablesMinted, 1);
    assert.equal(r.entityEdges, 1);
    const rn = g.getNode("route:runtime:GET:/api/orphan");
    assert.ok(rn, "rota runtime-only mintada");
    assert.equal((rn!.metadata as Record<string, unknown>).runtimeOnly, true);
    assert.ok(g.getNode("table:some_table"), "tabela runtime-only mintada");
  });

  it("liga rota→endpoint Java (wsv1) quando o proxy aparece no traço", () => {
    const g = graphWith([], [["POST", "/api/contracts"]]);
    g.addNode(new GraphNode("wsv1:POST:/easynup/findContract.v1", "CONTROLLER", "FindContractWsV1", "execute", null, { fullPath: "/easynup/findContract.v1" }));
    const r = applyRuntimeOverlay(g, [pair({ method: "POST", path: "/api/contracts", javaEndpoints: new Set(["/easynup/findContract.v1"]) })]);
    assert.equal(r.wsv1Edges, 1);
    const e = g.getAllEdges().find((x) => x.toNode === "wsv1:POST:/easynup/findContract.v1" && x.relationType === "RUNTIME_OBSERVED");
    assert.ok(e, "aresta rota→wsv1 observada");
  });

  it("IDEMPOTENTE: aplicar 2× não duplica arestas nem infla count fantasma de aresta", () => {
    const g = graphWith([["entity:Contract", "Contract"]], [["GET", "/api/c"]]);
    const p = () => [pair({ method: "GET", path: "/api/c", tables: new Map([["contract", "SELECT"]]) })];
    applyRuntimeOverlay(g, p());
    const after1 = g.getAllEdges().filter((e) => e.relationType === "RUNTIME_OBSERVED").length;
    const r2 = applyRuntimeOverlay(g, p());
    const after2 = g.getAllEdges().filter((e) => e.relationType === "RUNTIME_OBSERVED").length;
    assert.equal(after1, 1);
    assert.equal(after2, 1); // não duplicou
    assert.equal(r2.entityEdges, 0); // 2ª passada não conta a aresta já existente
  });
});

describe("ADR-0026 costura — fetchRecentTraces (gated + fail-soft)", () => {
  it("sem baseUrl → [] (byte-a-byte, sem tocar rede)", async () => {
    let called = false;
    const res = await fetchRecentTraces({ baseUrl: "", fetchFn: (async () => { called = true; return {} as Response; }) as typeof fetch });
    assert.deepEqual(res, []);
    assert.equal(called, false);
  });

  it("erro de rede em um serviço → NÃO lança, segue nos outros, dedupa por traceID", async () => {
    const t = trace("dup", [{ svc: "easynup-gateway", id: "gw", tags: { "url.path": "/api/x", "http.request.method": "GET" } }]);
    const fake = (async (url: string) => {
      if (String(url).includes("easynup-gateway")) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({ data: [t, t] }) } as unknown as Response; // mesmo traceID 2×
    }) as unknown as typeof fetch;
    const res = await fetchRecentTraces({ baseUrl: "http://jaeger", services: ["easynup-gateway", "easynup-backend"], fetchFn: fake, logger: { warn: () => {} } });
    assert.equal(res.length, 1); // dedup por traceID; gateway falhou fail-soft
    assert.equal(res[0].traceID, "dup");
  });

  it("HTTP não-ok → ignora o serviço sem lançar", async () => {
    const fake = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as typeof fetch;
    const res = await fetchRecentTraces({ baseUrl: "http://jaeger", services: ["easynup-gateway"], fetchFn: fake, logger: { warn: () => {} } });
    assert.deepEqual(res, []);
  });
});

describe("rota específica + matching SERVICE profundo + serviço→entidade (fix do colapso-no-mount, 2026-08-08)", () => {
  const deepGraph = () => {
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("ENTITY:easynup.persistence.entities.Contract", "ENTITY", "Contract", null, null, {}));
    g.addNode(new GraphNode("ENTITY:easynup.persistence.entities.SlaIndicator", "ENTITY", "SlaIndicator", null, null, {}));
    g.addNode(new GraphNode(
      "SERVICE:easynup.services.web.contracts.findContract.v1.FindContractServiceV1",
      "SERVICE", "FindContractServiceV1", null, null, {},
    ));
    g.addNode(new GraphNode(
      "SERVICE:easynup.services.web.slaIndicators.findSlaIndicators.v1.FindSlaIndicatorsServiceV1",
      "SERVICE", "FindSlaIndicatorsServiceV1", null, null, {},
    ));
    return g;
  };
  const proxiedTrace = (id: string, op: string, table: string) => trace(id, [
    // express seta http.route no MOUNT — o bug real: 40 rotas colapsavam em "GET /easynup"
    { svc: "easynup-gateway", id: "gw", tags: { "http.route": "/easynup", "http.request.method": "GET" } },
    { svc: "easynup-backend", id: "bk", parent: "gw", tags: { "http.route": `/easynup/${op}` } },
    { svc: "easynup-backend", id: "db", parent: "bk", tags: { "db.sql.table": table, "db.operation": "SELECT" } },
  ]);

  it("2 rotas proxied sob o MESMO mount → 2 pares com o path ESPECÍFICO do filho (não 1 par /easynup)", () => {
    const pairs = extractRuntimePairs(
      [proxiedTrace("t1", "findContract.v1", "contract"), proxiedTrace("t2", "findSlaIndicators.v1", "sla_indicator")],
      { gatewayServices: ["easynup-gateway", "easynup-backend"] },
    );
    assert.equal(pairs.length, 2);
    const paths = pairs.map((p) => p.path).sort();
    assert.deepEqual(paths, ["/easynup/findContract.v1", "/easynup/findSlaIndicators.v1"]);
  });

  it("rota mais específica NUNCA troca por rota não-relacionada (só prefixo estrito do root)", () => {
    const t = trace("t3", [
      { svc: "easynup-gateway", id: "gw", tags: { "http.route": "/api/x", "http.request.method": "GET" } },
      { svc: "easynup-backend", id: "bk", parent: "gw", tags: { "http.route": "/easynup/outraCoisa.v1" } },
    ]);
    const pairs = extractRuntimePairs([t], { gatewayServices: ["easynup-gateway", "easynup-backend"] });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].path, "/api/x"); // /easynup/... NÃO estende /api/x — mantém o root
  });

  it("javaEndpoint casa nó SERVICE profundo (sem wsv1:) → aresta rota→SERVICE + SERVICE→ENTIDADE same-trace", () => {
    const g = deepGraph();
    const pairs = extractRuntimePairs([proxiedTrace("t4", "findContract.v1", "contract")], {
      gatewayServices: ["easynup-gateway", "easynup-backend"],
    });
    const res = applyRuntimeOverlay(g, pairs);
    assert.equal(res.wsv1Edges, 1); // rota→SERVICE profundo
    assert.equal(res.serviceEntityEdges, 1); // SERVICE→Contract (base dos pares comparáveis)
    const svcOut = g.getOutgoingEdges("SERVICE:easynup.services.web.contracts.findContract.v1.FindContractServiceV1");
    assert.ok(svcOut.some((e) => e.toNode === "ENTITY:easynup.persistence.entities.Contract" && e.relationType === "RUNTIME_OBSERVED"));
  });

  it("2+ endpoints Java no MESMO traço → NÃO atribui serviço→entidade (conservador anti-chute)", () => {
    const g = deepGraph();
    const t = trace("t5", [
      { svc: "easynup-gateway", id: "gw", tags: { "http.route": "/easynup", "http.request.method": "GET" } },
      { svc: "easynup-backend", id: "b1", parent: "gw", tags: { "http.route": "/easynup/findContract.v1" } },
      { svc: "easynup-backend", id: "b2", parent: "gw", tags: { "http.route": "/easynup/findSlaIndicators.v1" } },
      { svc: "easynup-backend", id: "db", parent: "b1", tags: { "db.sql.table": "contract" } },
    ]);
    const res = applyRuntimeOverlay(g, extractRuntimePairs([t], { gatewayServices: ["easynup-gateway", "easynup-backend"] }));
    assert.equal(res.wsv1Edges, 2); // as duas rota→SERVICE valem
    assert.equal(res.serviceEntityEdges, 0); // atribuição de tabela seria chute — não emite
  });

  it("convenção rasa wsv1:<path> segue funcionando (retrocompat)", () => {
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("wsv1:/easynup/findContract.v1", "SERVICE", "FindContractWsV1", null, null, { fullPath: "/easynup/findContract.v1" }));
    const pairs = extractRuntimePairs([proxiedTrace("t6", "findContract.v1", "contract")], {
      gatewayServices: ["easynup-gateway", "easynup-backend"],
    });
    const res = applyRuntimeOverlay(g, pairs);
    assert.equal(res.wsv1Edges, 1);
  });
});

describe("diagnóstico durável — fetchRecentTracesWithReport (retry janela-reduzida + report por serviço)", () => {
  it("502 na 1ª tentativa → retry com lookback pela METADE e report {retried:true, httpStatus:200}", async () => {
    // o modo de falha REAL do hub (Badger 502 sob janela de 24h; janela menor responde)
    const t = trace("ok1", [{ svc: "easynup-backend", id: "bk", tags: { "db.sql.table": "audit_log" } }]);
    const urls: string[] = [];
    let calls = 0;
    const fake = (async (url: string) => {
      urls.push(String(url));
      calls++;
      if (calls === 1) return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ data: [t] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const nowMs = 1_754_600_000_000;
    const { traces, report } = await fetchRecentTracesWithReport({
      baseUrl: "http://jaeger", services: ["easynup-backend"], lookbackMs: 86400000, nowMs,
      fetchFn: fake, logger: { warn: () => {} },
    });
    assert.equal(traces.length, 1);
    assert.equal(report.length, 1);
    assert.equal(report[0].service, "easynup-backend");
    assert.equal(report[0].retried, true);
    assert.equal(report[0].httpStatus, 200);
    assert.equal(report[0].traces, 1);
    assert.equal(report[0].lookbackMsUsed, 43200000); // metade de 24h
    // a URL do retry cobre EXATAMENTE a janela reduzida (endMicros - 12h em micros)
    const endMicros = nowMs * 1000;
    assert.ok(urls[1].includes(`start=${endMicros - 43200000 * 1000}`));
  });

  it("falha nas 2 tentativas → traces=[] e report com o status final (fail-soft, sem lançar)", async () => {
    const fake = (async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch;
    const { traces, report } = await fetchRecentTracesWithReport({
      baseUrl: "http://jaeger", services: ["easynup-backend"], fetchFn: fake, logger: { warn: () => {} },
    });
    assert.deepEqual(traces, []);
    assert.equal(report[0].httpStatus, 0);
    assert.equal(report[0].retried, true);
    assert.equal(report[0].error, "fetch failed");
  });

  it("sucesso direto → retried:false e janela cheia", async () => {
    const fake = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as unknown as Response) as typeof fetch;
    const { report } = await fetchRecentTracesWithReport({
      baseUrl: "http://jaeger", services: ["easynup-gateway"], lookbackMs: 86400000, fetchFn: fake, logger: { warn: () => {} },
    });
    assert.equal(report[0].retried, false);
    assert.equal(report[0].lookbackMsUsed, 86400000);
  });

  it("runRuntimeOverlay: summary carrega o fetchReport (vai pro analysis_runs.diagnostics)", async () => {
    const { runRuntimeOverlay } = await import("../../server/analyzers/runtime-overlay");
    const g = new ApplicationGraph();
    g.addNode(new GraphNode("ENTITY:easynup.persistence.entities.AuditLog", "ENTITY", "AuditLog", null, null, {}));
    const t = trace("frag", [{ svc: "easynup-backend", id: "bk", tags: { "db.sql.table": "audit_log", "db.operation": "SELECT" } }]);
    const fake = (async () => ({ ok: true, status: 200, json: async () => ({ data: [t] }) }) as unknown as Response) as typeof fetch;
    const summary = await runRuntimeOverlay(g, {
      jaegerUrl: "http://jaeger", apiKey: null,
      services: ["easynup-backend"], gatewayService: "easynup-backend", gatewayServices: ["easynup-backend"],
      lookbackMs: 3600000, limit: 100,
    }, { fetchFn: fake });
    assert.equal(summary.fetchReport.length, 1);
    assert.equal(summary.fetchReport[0].httpStatus, 200);
    assert.equal(summary.tableEntityEdges, 1); // fragmento ancorou audit_log→AuditLog
  });
});

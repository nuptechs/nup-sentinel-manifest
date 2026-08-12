import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractRuntimePairs, type JaegerTrace } from "../../server/analyzers/runtime-overlay";
import {
  extractRuntimeOrder,
  extractRuntimeOrderForRoute,
} from "../../server/reasoner/adapters/runtime-order.adapter";

// ── Fix do BLEED cross-service ──
// Cenário REAL que motivou o fix (provado ao vivo em 2026-08-12): o request de
// `POST /api/authorize/scope` do identify carrega, no MESMO trace-id distribuído,
// os spans JDBC do easynup (que consulta contract/project/service_order ao redor
// de chamar o PDP). O correlator agregava "todas as tabelas do traço" → as
// tabelas do easynup eram atribuídas à rota do identify (nós sintéticos
// `table:contract` com runtimeHot=true e sourceFile=None no grafo do proj 38).
// A cura: allowlist de observação (`services` da config por-projeto) — a MESMA
// semântica fail-closed que o caminho fragmento (`dbServices`) já tinha.

const tag = (key: string, value: unknown) => ({ key, value });
function trace(
  traceID: string,
  spans: Array<{ svc: string; id?: string; parent?: string; start?: number; tags?: Record<string, unknown> }>,
): JaegerTrace {
  const processes: Record<string, { serviceName: string }> = {};
  const jspans = spans.map((s, i) => {
    const pid = `p_${s.svc}`;
    processes[pid] = { serviceName: s.svc };
    return {
      spanID: s.id || `s${i}`,
      operationName: "",
      processID: pid,
      startTime: s.start ?? i * 1000,
      references: s.parent ? [{ refType: "CHILD_OF", traceID, spanID: s.parent }] : [],
      tags: Object.entries(s.tags || {}).map(([k, v]) => tag(k, v)),
    };
  });
  return { traceID, spans: jspans, processes } as JaegerTrace;
}

/** O traço do incidente: identify atende a rota; easynup contribui spans JDBC alheios. */
function authorizeTraceWithForeignSpans(): JaegerTrace {
  return trace("t-authz-1", [
    { svc: "nupidentity", id: "http", start: 0, tags: { "url.path": "/api/authorize/scope", "http.request.method": "POST" } },
    { svc: "nupidentity", id: "jdbc1", parent: "http", start: 1000, tags: { "db.sql.table": "abac_policies", "db.operation": "SELECT" } },
    { svc: "nupidentity", id: "jdbc2", parent: "http", start: 2000, tags: { "db.sql.table": "relationship_tuples", "db.operation": "SELECT" } },
    // spans do OUTRO sistema no mesmo traço distribuído (a origem do bleed):
    { svc: "easynup-backend", id: "fjdbc1", start: 3000, tags: { "db.sql.table": "contract", "db.operation": "SELECT" } },
    { svc: "easynup-backend", id: "fjdbc2", start: 4000, tags: { "db.sql.table": "service_order", "db.operation": "SELECT" } },
  ]);
}

describe("fix do bleed — extractRuntimePairs com allowlist de observação", () => {
  it("com services do projeto, tabela de serviço ALHEIO não é atribuída à rota (o incidente real)", () => {
    const pairs = extractRuntimePairs([authorizeTraceWithForeignSpans()], {
      gatewayServices: ["nupidentity"],
      services: ["nupidentity"],
    });
    assert.equal(pairs.length, 1);
    const tables = Array.from(pairs[0].tables.keys()).sort();
    assert.deepEqual(tables, ["abac_policies", "relationship_tuples"]); // easynup NÃO vaza
  });

  it("sem services (legado/single-tenant), o comportamento anterior é preservado — e documenta o bleed", () => {
    const pairs = extractRuntimePairs([authorizeTraceWithForeignSpans()], {
      gatewayServices: ["nupidentity"],
    });
    const tables = Array.from(pairs[0].tables.keys()).sort();
    assert.ok(tables.includes("contract")); // sem allowlist, o traço inteiro conta (compat)
  });

  it("a allowlist é a UNIÃO services ∪ gatewayServices — a raiz nunca se auto-exclui", () => {
    // services aponta só o backend; a raiz (gateway) ainda contribui o próprio JDBC.
    const t = trace("t-u-1", [
      { svc: "gw", id: "http", tags: { "url.path": "/api/x", "http.request.method": "GET" } },
      { svc: "gw", id: "j1", parent: "http", tags: { "db.sql.table": "session" } },
      { svc: "backend", id: "j2", parent: "http", tags: { "db.sql.table": "user" } },
      { svc: "intruso", id: "j3", tags: { "db.sql.table": "contract" } },
    ]);
    const pairs = extractRuntimePairs([t], { gatewayServices: ["gw"], services: ["backend"] });
    const tables = Array.from(pairs[0].tables.keys()).sort();
    assert.deepEqual(tables, ["session", "user"]); // gw ∪ backend entram; intruso não
  });
});

describe("fix do bleed — ordem de execução (mecanismo) com allowlist", () => {
  it("extractRuntimeOrder ignora spans JDBC de serviço alheio", () => {
    const ops = extractRuntimeOrder([authorizeTraceWithForeignSpans()], { services: ["nupidentity"] });
    const tables = ops.map((o) => o.table);
    assert.deepEqual(tables, ["abac_policies", "relationship_tuples"]);
    assert.deepEqual(ops.map((o) => o.rank), [0, 1]); // ordem real preservada
  });

  it("extractRuntimeOrderForRoute propaga a allowlist até a ordem", () => {
    const ops = extractRuntimeOrderForRoute([authorizeTraceWithForeignSpans()], "/api/authorize/scope", {
      gatewayServices: ["nupidentity"],
      services: ["nupidentity"],
    });
    assert.deepEqual(ops.map((o) => o.table), ["abac_policies", "relationship_tuples"]);
  });

  it("sem allowlist, compat: a ordem inclui o traço inteiro (comportamento anterior)", () => {
    const ops = extractRuntimeOrder([authorizeTraceWithForeignSpans()]);
    assert.ok(ops.map((o) => o.table).includes("contract"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tablesFromSql,
  tablesFromDbSpan,
  extractRuntimePairs,
  type JaegerTrace,
} from "../../server/analyzers/runtime-overlay";

// ── helper de traço (shape Jaeger nativo) ──
function trace(traceID: string, spans: Array<{ svc: string; id?: string; parent?: string; tags?: Record<string, unknown> }>): JaegerTrace {
  const processes: Record<string, { serviceName: string }> = {};
  const jspans = spans.map((s, i) => {
    const pid = `p_${s.svc}`;
    processes[pid] = { serviceName: s.svc };
    return {
      spanID: s.id || `s${i}`,
      processID: pid,
      references: s.parent ? [{ refType: "CHILD_OF", traceID, spanID: s.parent }] : [],
      tags: Object.entries(s.tags || {}).map(([k, v]) => ({ key: k, value: v })),
    };
  });
  return { traceID, spans: jspans, processes };
}

describe("ADR mapeador universal — tablesFromSql (parse agnóstico de tabela)", () => {
  it("extrai FROM / JOIN / INTO / UPDATE e tira schema + aspas", () => {
    assert.deepEqual(tablesFromSql("SELECT * FROM contract WHERE id = ?"), ["contract"]);
    assert.deepEqual(tablesFromSql('SELECT * FROM "public"."service_order" so JOIN vendor v ON v.id = ?'), ["service_order", "vendor"]);
    assert.deepEqual(tablesFromSql("INSERT INTO railway.audit_log (a,b) VALUES (?,?)"), ["audit_log"]);
    assert.deepEqual(tablesFromSql("UPDATE `contract` SET x = ? WHERE id = ?"), ["contract"]);
    assert.deepEqual(tablesFromSql("DELETE FROM company WHERE id = ?"), ["company"]);
  });
  it("não confunde palavra-chave nem quebra em SQL vazio/estranho", () => {
    assert.deepEqual(tablesFromSql(""), []);
    assert.deepEqual(tablesFromSql("BEGIN"), []);
    assert.deepEqual(tablesFromSql(null as unknown as string), []);
  });
});

describe("ADR mapeador universal — tablesFromDbSpan (cascata novo→antigo→SQL)", () => {
  it("prefere db.collection.name (semconv Stable atual)", () => {
    assert.deepEqual(tablesFromDbSpan({ "db.collection.name": "contract", "db.query.text": "SELECT * FROM outra" }), ["contract"]);
  });
  it("cai em db.sql.table (convenção antiga)", () => {
    assert.deepEqual(tablesFromDbSpan({ "db.sql.table": "service_order" }), ["service_order"]);
  });
  it("FALLBACK universal: parseia db.query.text quando NÃO há atributo de tabela (caso Node/pg)", () => {
    assert.deepEqual(tablesFromDbSpan({ "db.query.text": "SELECT * FROM vendor WHERE id = ?" }), ["vendor"]);
  });
  it("cai em db.statement (nome antigo do texto)", () => {
    assert.deepEqual(tablesFromDbSpan({ "db.statement": "INSERT INTO invoice (x) VALUES (?)" }), ["invoice"]);
  });
  it("sem nada de banco → []", () => {
    assert.deepEqual(tablesFromDbSpan({ "http.route": "/x" }), []);
  });
});

describe("ADR mapeador universal — extractRuntimePairs em sistema NÃO-easynup", () => {
  it("mapeia rota→tabela num alvo genérico (serviço/op diferentes + só db.query.text, sem db.sql.table)", () => {
    // Sistema fictício "shop": gateway 'shop-edge', endpoints internos /rpc/<op>,
    // e a instrumentação NÃO emite db.sql.table — só db.query.text (caso Node/pg).
    const t = trace("t1", [
      { svc: "shop-edge", id: "gw", tags: { "url.path": "/api/orders", "http.request.method": "GET" } },
      { svc: "shop-core", id: "bk", parent: "gw", tags: { "http.route": "/rpc/listOrders" } },
      { svc: "shop-core", id: "db", parent: "bk", tags: { "db.system.name": "postgresql", "db.query.text": "SELECT * FROM orders o JOIN customer c ON c.id = ?", "db.operation.name": "SELECT" } },
    ]);
    const pairs = extractRuntimePairs([t], { gatewayServices: ["shop-edge"], opPathPattern: /\/rpc\/[A-Za-z]\w*/ });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].path, "/api/orders");
    // as DUAS tabelas do SQL viraram alvo (orders + customer) — sem depender de atributo de tabela
    assert.ok(pairs[0].tables.has("orders"), "orders mapeada do SQL");
    assert.ok(pairs[0].tables.has("customer"), "customer (JOIN) mapeada do SQL");
    // o op interno foi capturado pelo pattern do alvo (não o /easynup/ default)
    assert.ok(pairs[0].javaEndpoints.has("/rpc/listOrders"));
  });

  it("REGRESSÃO: alvo easynup (db.sql.table + /easynup/op.v1 default) segue funcionando byte-a-byte", () => {
    const t = trace("t2", [
      { svc: "easynup-gateway", id: "gw", tags: { "url.path": "/api/x", "http.request.method": "GET" } },
      { svc: "easynup-backend", id: "bk", parent: "gw", tags: { "http.route": "/easynup/findContracts.v1" } },
      { svc: "easynup-backend", id: "db", parent: "bk", tags: { "db.sql.table": "contract", "db.operation": "SELECT" } },
    ]);
    const [p] = extractRuntimePairs([t]); // sem opts → defaults easynup
    assert.ok(p.tables.has("contract"));
    assert.ok(p.javaEndpoints.has("/easynup/findContracts.v1"));
  });
});

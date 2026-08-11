// ─────────────────────────────────────────────
// reasoner/runtime-order — a ORDEM REAL de execução do OTel (o que nem o agente
// nem o grafo colapsado têm). Extração pura dos spans + reordenação dos passos.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractRuntimeOrder } from "../../server/reasoner/adapters/runtime-order.adapter.ts";
import { applyRuntimeOrder } from "../../server/reasoner/mechanism.ts";
import type { JaegerTrace } from "../../server/analyzers/runtime-overlay.ts";

function span(spanID: string, startTime: number, stmt: string): any {
  return { spanID, startTime, operationName: "db.query", tags: [{ key: "db.statement", value: stmt }] };
}

describe("extractRuntimeOrder — ordem real por startTime", () => {
  it("ordena as tabelas pela ordem REAL de execução dos spans (não por nome)", () => {
    const trace: JaegerTrace = {
      traceID: "t1",
      spans: [
        span("b", 3000, "SELECT * FROM systems WHERE id=$1"),
        span("a", 1000, "SELECT * FROM users WHERE id=$1"),
        span("c", 5000, "INSERT INTO authorization_decisions (x) VALUES ($1)"),
      ],
    };
    const ops = extractRuntimeOrder([trace]);
    assert.deepEqual(ops.map((o) => o.table), ["users", "systems", "authorization_decisions"]);
    assert.equal(ops[0].op, "read");
    assert.equal(ops[2].op, "write");
    assert.deepEqual(ops.map((o) => o.rank), [0, 1, 2]);
  });
  it("escolhe o traço com MAIS spans DB (a requisição mais completa)", () => {
    const thin: JaegerTrace = { traceID: "aaa", spans: [span("x", 1, "SELECT 1 FROM users")] };
    const full: JaegerTrace = { traceID: "zzz", spans: [span("p", 2, "SELECT FROM users"), span("q", 3, "INSERT INTO systems VALUES(1)")] };
    const ops = extractRuntimeOrder([thin, full]);
    assert.equal(ops.length, 2, "usa o traço completo, não o fino");
  });
  it("dedup: 1ª ocorrência de cada tabela vence; sem span DB → vazio", () => {
    const t: JaegerTrace = { traceID: "t", spans: [span("a", 1, "SELECT FROM users"), span("b", 2, "UPDATE users SET x=1")] };
    assert.equal(extractRuntimeOrder([t]).length, 1);
    assert.deepEqual(extractRuntimeOrder([{ traceID: "e", spans: [{ spanID: "x", operationName: "http" } as any] }]), []);
  });
  it("nunca lança com entrada malformada", () => {
    assert.doesNotThrow(() => extractRuntimeOrder(null as any));
    assert.doesNotThrow(() => extractRuntimeOrder([{} as any]));
  });
});

describe("applyRuntimeOrder — reordena os passos pela execução real", () => {
  const steps = [
    { toLabel: "authorization_decisions", relationType: "WRITES_ENTITY", order: 1 },
    { toLabel: "users", relationType: "READS_ENTITY", order: 2 },
    { toLabel: "Logger", relationType: "CALLS", order: 3 },
    { toLabel: "systems", relationType: "READS_ENTITY", order: 4 },
  ];
  it("os passos de dado ganham a ORDEM REAL; o CALLS (sem span) segue por alcance", () => {
    const ops = [
      { table: "users", op: "read" as const, rank: 0 },
      { table: "systems", op: "read" as const, rank: 1 },
      { table: "authorization_decisions", op: "write" as const, rank: 2 },
    ];
    const { steps: out, orderedCount } = applyRuntimeOrder(steps, ops);
    assert.equal(orderedCount, 3);
    // ordem real: users, systems, authorization_decisions; Logger (CALLS) por último
    assert.deepEqual(out.map((s) => s.toLabel), ["users", "systems", "authorization_decisions", "Logger"]);
    assert.equal(out[0].runtimeRank, 0);
    assert.equal(out[3].runtimeRank, undefined);
    assert.deepEqual(out.map((s) => s.order), [1, 2, 3, 4]);
  });
  it("sem ops → passos intactos (fail-soft, ordem por alcance)", () => {
    const { steps: out, orderedCount } = applyRuntimeOrder(steps, []);
    assert.equal(orderedCount, 0);
    assert.deepEqual(out.map((s) => s.order), [1, 2, 3, 4]);
  });
});

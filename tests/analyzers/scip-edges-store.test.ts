import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mergeScipEdgesStore,
  bucketsOf,
  SOURCE_RE,
  DEFAULT_SOURCE,
} from "../../server/analyzers/scip-edges-store";

const javaEdge = (n: string) => ({ from: `scip-java j ${n}`, to: `scip-java j ${n}2`, kind: "CALLS", resolution: "compiler" as const, fromFile: `src/main/java/${n}.java`, toFile: `src/main/java/${n}2.java` });
const tsEdge = (n: string) => ({ from: `scip-typescript t ${n}`, to: `scip-typescript t ${n}2`, kind: "CALLS", resolution: "compiler" as const, fromFile: `frontend/src/${n}.ts`, toFile: `frontend/src/${n}2.ts` });

describe("scip-edges-store — multi-fonte", () => {
  it("fonte inválida cai p/ default", () => {
    assert.equal(SOURCE_RE.test("typescript"), true);
    assert.equal(SOURCE_RE.test("JAVA"), false);
    assert.equal(SOURCE_RE.test("../evil"), false);
    const s = mergeScipEdgesStore(null, { edges: [tsEdge("a")] }, "BAD!", "2026-01-01T00:00:00.000Z");
    assert.deepEqual(Object.keys(s._bySource), [DEFAULT_SOURCE]);
  });

  it("primeiro POST cria o balde e o top-level flat", () => {
    const s = mergeScipEdgesStore(null, { edges: [tsEdge("a"), tsEdge("b")], imports: [{ from: "frontend/src/a.ts", to: "frontend/src/b.ts" }] }, "typescript", "2026-01-02T00:00:00.000Z");
    assert.equal(s._bySource.typescript.edges!.length, 2);
    assert.equal(s.edges.length, 2);
    assert.equal(s.imports.length, 1);
    assert.equal(s.counts.total, 2);
    assert.deepEqual(s.counts.bySource, { typescript: 2 });
    assert.equal(s.ingestedAt, "2026-01-02T00:00:00.000Z");
  });

  it("CRÍTICO: TS não apaga Java e vice-versa (coexistência no projeto 27)", () => {
    // Java posta na rota flat (fonte default).
    let store: unknown = mergeScipEdgesStore(null, { edges: [javaEdge("Foo"), javaEdge("Bar")] }, DEFAULT_SOURCE, "2026-01-03T00:00:00.000Z");
    // TS posta na rota por-fonte.
    store = mergeScipEdgesStore(store, { edges: [tsEdge("x")] }, "typescript", "2026-01-04T00:00:00.000Z");
    const s = store as ReturnType<typeof mergeScipEdgesStore>;
    assert.equal(s._bySource.default.edges!.length, 2, "Java preservado");
    assert.equal(s._bySource.typescript.edges!.length, 1, "TS adicionado");
    assert.equal(s.edges.length, 3, "união = Java + TS");
    assert.deepEqual(s.counts.bySource, { default: 2, typescript: 1 });

    // Re-POST do Java (flat) substitui SÓ o balde default; TS intacto.
    const s2 = mergeScipEdgesStore(s, { edges: [javaEdge("Foo"), javaEdge("Bar"), javaEdge("Baz")] }, DEFAULT_SOURCE, "2026-01-05T00:00:00.000Z");
    assert.equal(s2._bySource.default.edges!.length, 3, "Java re-postado");
    assert.equal(s2._bySource.typescript.edges!.length, 1, "TS ainda intacto");
    assert.equal(s2.edges.length, 4);
    assert.equal(s2.ingestedAt, "2026-01-05T00:00:00.000Z", "frescor = mais recente");
  });

  it("re-POST da MESMA fonte substitui o balde (idempotente, sem duplicar)", () => {
    let store: unknown = mergeScipEdgesStore(null, { edges: [tsEdge("a"), tsEdge("b"), tsEdge("c")] }, "typescript", "2026-01-06T00:00:00.000Z");
    store = mergeScipEdgesStore(store, { edges: [tsEdge("a")] }, "typescript", "2026-01-07T00:00:00.000Z");
    const s = store as ReturnType<typeof mergeScipEdgesStore>;
    assert.equal(s.edges.length, 1, "substituiu, não somou");
  });

  it("migra store LEGADO flat (sem _bySource) p/ o balde default", () => {
    const legacy = { tool: "scip-typescript", schema: "adr-0031.p2", edges: [javaEdge("Old")], imports: [{ from: "a", to: "b" }], ingestedAt: "2025-12-01T00:00:00.000Z" };
    const buckets = bucketsOf(legacy);
    assert.deepEqual(Object.keys(buckets), [DEFAULT_SOURCE]);
    assert.equal(buckets.default.edges!.length, 1);
    // Um POST de TS depois do legado preserva o legado em default.
    const s = mergeScipEdgesStore(legacy, { edges: [tsEdge("new")] }, "typescript", "2026-01-08T00:00:00.000Z");
    assert.equal(s._bySource.default.edges!.length, 1, "legado migrado p/ default");
    assert.equal(s._bySource.typescript.edges!.length, 1);
    assert.equal(s.edges.length, 2);
  });

  it("null / malformado → store vazio coerente", () => {
    assert.deepEqual(bucketsOf(null), {});
    assert.deepEqual(bucketsOf({ junk: 1 }), {});
    const s = mergeScipEdgesStore(undefined, { edges: [] }, "typescript", "2026-01-09T00:00:00.000Z");
    assert.equal(s.edges.length, 0);
    assert.equal(s.counts.total, 0);
  });
});

// ─────────────────────────────────────────────
// reasoner/graph-load — o loader ÚNICO que faz o Reasoner ler o MESMO mapa que o
// /graph (overlays PROVADOS mesclados). Fecha o gap: o reasoner raciocinava sobre
// o snapshot cru, subestimando a cobertura provada e inventando "sem chamador".
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadReasonerGraph } from "../../server/reasoner/graph-load.ts";

// Grafo cru mínimo: um módulo TS e uma tabela, SEM aresta CALLS entre funções.
// O overlay scip vai PROVAR uma chamada foo→bar dentro do módulo.
function rawGraph() {
  return {
    nodes: [
      // o índice de arquivo lê `metadata.sourceFile` (é de lá que o merge casa símbolo→nó)
      { id: "node:src/a.ts", type: "SERVICE", className: "a.ts", metadata: { sourceFile: "src/a.ts" } },
      { id: "node:src/b.ts", type: "SERVICE", className: "b.ts", metadata: { sourceFile: "src/b.ts" } },
      { id: "table:widgets", type: "ENTITY", className: "widgets" },
    ],
    edges: [
      { fromNode: "node:src/a.ts", toNode: "table:widgets", relationType: "READS_ENTITY" },
    ],
  };
}

// payload scip no formato do deriver: símbolo→símbolo com resolution 'compiler'.
// Usa os campos fromFile/toFile (agnóstico à linguagem) para casar os nós-módulo.
function scipPayload() {
  return {
    tool: "scip-typescript",
    edges: [
      {
        // símbolo SCIP válido: `<scheme> <manager> <package> <version> <descriptors>` (≥5 partes)
        from: "scip-typescript npm myrepo v1 `src/a.ts`/foo().",
        to: "scip-typescript npm myrepo v1 `src/b.ts`/bar().",
        kind: "CALLS",
        resolution: "compiler",
        fromFile: "src/a.ts",
        toFile: "src/b.ts",
      },
    ],
  };
}

const snapWith = (graph: unknown) => [{ manifestJson: { systemGraph: graph }, analysisRunId: 7 }];

describe("reasoner/graph-load — mescla os overlays provados antes de moldar", () => {
  it("SEM overlay: molda o grafo cru (byte-a-byte, fail-soft)", async () => {
    const r = await loadReasonerGraph(1, {
      getSnapshots: async () => snapWith(rawGraph()) as never,
      getProject: async () => ({ scipEdges: null, configEdges: null }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.analysisRunId, 7);
    // nenhuma aresta CALLS provada (o grafo cru não tinha)
    const proven = r.shaped.edges.filter((e) => (e.evidence?.method ?? (e as any).method) === "STATIC_PROVEN");
    assert.equal(proven.length, 0);
  });

  it("COM overlay scip: a chamada foo→bar entra como STATIC_PROVEN (o reasoner passa a vê-la)", async () => {
    const r = await loadReasonerGraph(1, {
      getSnapshots: async () => snapWith(rawGraph()) as never,
      getProject: async () => ({ scipEdges: scipPayload(), configEdges: null }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const proven = r.shaped.edges.filter((e) => (e.evidence?.method ?? (e as any).method) === "STATIC_PROVEN");
    assert.ok(proven.length >= 1, "a aresta CALLS provada pelo compilador foi mesclada");
    assert.ok(r.overlays.scipStats, "estatística do merge scip presente");
  });

  it("FAIL-SOFT: getProject lança → serve o grafo cru, não derruba", async () => {
    const r = await loadReasonerGraph(1, {
      getSnapshots: async () => snapWith(rawGraph()) as never,
      getProject: async () => { throw new Error("db down"); },
      logger: { error: () => {} },
    });
    assert.equal(r.ok, true); // sobreviveu
  });

  it("404 quando não há snapshot", async () => {
    const r = await loadReasonerGraph(1, { getSnapshots: async () => [], getProject: async () => null });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 404);
  });

  it("404 GRAPH_NOT_IN_SNAPSHOT quando o snapshot precede o system graph", async () => {
    const r = await loadReasonerGraph(1, {
      getSnapshots: async () => [{ manifestJson: {}, analysisRunId: 1 }] as never,
      getProject: async () => null,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.body.code, "GRAPH_NOT_IN_SNAPSHOT");
  });
});

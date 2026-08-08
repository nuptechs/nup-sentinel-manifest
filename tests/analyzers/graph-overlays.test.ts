import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPersistedOverlays } from "../../server/analyzers/graph-overlays";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// ─────────────────────────────────────────────────────────────────────────
// A extração do bloco de merge que vivia inline no handler do /graph. O que
// estes testes protegem: o contrato que o /graph tinha (gated, fail-soft,
// ordem scip→config) continua valendo, agora compartilhado com o /bimr.
// ─────────────────────────────────────────────────────────────────────────

const silent = { error: () => {} };

const graph: RawSystemGraph = {
  nodes: [
    { id: "SERVICE:app.Svc", type: "SERVICE", className: "Svc", metadata: { sourceFile: "src/main/java/app/Svc.java" } },
    { id: "REPOSITORY:app.Repo", type: "REPOSITORY", className: "Repo", metadata: { sourceFile: "src/main/java/app/Repo.java" } },
  ],
  edges: [],
};

describe("applyPersistedOverlays — gated", () => {
  it("projeto sem overlays: grafo byte-a-byte e nenhuma estatística", async () => {
    const r = await applyPersistedOverlays(graph, null, silent);
    assert.equal(r.graph, graph, "mesma referência — nada foi clonado nem tocado");
    assert.equal(r.scipStats, undefined);
    assert.equal(r.configStats, undefined);
  });

  it("payload vazio não dispara merge", async () => {
    const r = await applyPersistedOverlays(graph, { scipEdges: { edges: [] }, configEdges: { edges: [] } }, silent);
    assert.equal(r.graph, graph);
    assert.equal(r.scipStats, undefined);
    assert.equal(r.configStats, undefined);
  });

  it("payload malformado (edges não-array) é ignorado sem lançar", async () => {
    const r = await applyPersistedOverlays(graph, { scipEdges: { edges: "nope" }, configEdges: 42 } as never, silent);
    assert.equal(r.graph, graph);
  });
});

describe("applyPersistedOverlays — merge de config vira CONFIG_PROVEN no censo", () => {
  it("aresta de DI provada entra classificada", async () => {
    const r = await applyPersistedOverlays(
      graph,
      {
        configEdges: {
          edges: [
            {
              from: "app.Svc",
              to: "app.Repo",
              fromFqn: "app.Svc",
              toFqn: "app.Repo",
              kind: "di",
              resolution: "config",
              reason: "único bean concreto",
            },
          ],
        },
      },
      silent,
    );
    assert.ok(r.configStats, "estatística do merge presente");
    const shaped = shapeSystemGraph(r.graph, "class");
    assert.ok(
      shaped.coverage.edges.byMethod.CONFIG_PROVEN >= 1,
      `esperava ≥1 CONFIG_PROVEN, veio ${JSON.stringify(shaped.coverage.edges.byMethod)}`,
    );
  });
});

describe("applyPersistedOverlays — fail-soft", () => {
  it("erro no merge de scip NÃO impede o merge de config nem derruba", async () => {
    const errors: unknown[] = [];
    // `edges` com item que faz o agregador explodir ao ler propriedades
    const bombs = { get edges() { throw new Error("boom"); } };
    const r = await applyPersistedOverlays(
      graph,
      {
        scipEdges: bombs as never,
        configEdges: {
          edges: [{ from: "app.Svc", to: "app.Repo", fromFqn: "app.Svc", toFqn: "app.Repo", kind: "di", resolution: "config" }],
        },
      },
      { error: (...a) => errors.push(a) },
    );
    assert.equal(errors.length, 1, "o erro foi REPORTADO, não engolido");
    assert.equal(r.scipStats, undefined);
    assert.ok(r.configStats, "o config seguiu mesmo com o scip quebrado");
  });
});

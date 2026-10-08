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

// OBS-D01 — o produtor dataAccess (função→tabela física) LIGADO ponta-a-ponta
// pela porta de leitura. O merge já existe (data-access-aggregate); o que faltava
// era a PROVA de que o overlay compartilhado o aciona a partir de
// `scipEdges.dataAccess` — o caminho que /graph, /bimr e o reasoner usam.
describe("applyPersistedOverlays — data-access liga função→tabela física (OBS-D01)", () => {
  const fnSym = "scip-typescript npm . . `server/services/contract.service.ts`/ContractService#create().";
  const tableSym = "scip-typescript npm . . `shared/schema/contract.ts`/contract.";
  const withModule: RawSystemGraph = {
    nodes: [
      { id: "node:server/services/contract.service.ts", type: "MODULE", className: "contract.service", metadata: { sourceFile: "server/services/contract.service.ts" } },
    ],
    edges: [],
  };

  it("materializa table:<físico> e expõe dataAccessStats pela porta de leitura", async () => {
    const r = await applyPersistedOverlays(
      withModule,
      {
        scipEdges: {
          dataAccess: [
            { from: fnSym, to: tableSym, access: "write", fromFile: "server/services/contract.service.ts", toFile: "shared/schema/contract.ts" },
          ],
        },
      } as never,
      silent,
    );
    assert.ok(r.dataAccessStats, "estatística do merge data-access presente");
    assert.equal((r.dataAccessStats as any).edgesAdded, 1);
    assert.equal((r.dataAccessStats as any).tableNodesMinted, 1);
    // o nó de tabela FÍSICA foi materializado no grafo servido
    assert.ok(r.graph.nodes.some((n) => n.id === "table:contract"), "table:contract materializada");
    // e vira STATIC_PROVEN no censo epistêmico (resolution:compiler)
    const shaped = shapeSystemGraph(r.graph);
    assert.ok(
      (shaped.coverage.edges.byMethod.STATIC_PROVEN || 0) >= 1,
      `esperava ≥1 STATIC_PROVEN, veio ${JSON.stringify(shaped.coverage.edges.byMethod)}`,
    );
  });

  it("dataAccess ausente → nenhuma estatística (byte-a-byte)", async () => {
    const r = await applyPersistedOverlays(withModule, { scipEdges: { edges: [] } } as never, silent);
    assert.equal(r.dataAccessStats, undefined);
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

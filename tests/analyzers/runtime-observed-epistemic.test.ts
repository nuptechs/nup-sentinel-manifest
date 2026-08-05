import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractRuntimePairs,
  applyRuntimeOverlay,
  type JaegerTrace,
} from "../../server/analyzers/runtime-overlay";
import { ApplicationGraph, GraphNode } from "../../server/analyzers/application-graph";
import { shapeSystemGraph } from "../../server/analyzers/system-graph";

// ── ADR-0028 P1.1 — a PROVA de ponta a ponta ──
// Arestas observadas em traço → `observed:true` no grafo → sobrevivem à
// serialização do snapshot (`toJSON`) → viram `evidence.method=RUNTIME_OBSERVED`
// e `coverage.observedRatio>0` no `shapeSystemGraph` (o que o `/graph` serve e o
// ledger de recall P0.2b lê). É o caminho inteiro que estava com observedRatio=0.

const tag = (key: string, value: unknown) => ({ key, value });
function trace(traceID: string, spans: Array<{ svc: string; id?: string; parent?: string; tags?: Record<string, unknown> }>): JaegerTrace {
  const processes: Record<string, { serviceName: string }> = {};
  const jspans = spans.map((s, i) => {
    const pid = `p_${s.svc}`;
    processes[pid] = { serviceName: s.svc };
    return {
      spanID: s.id || `s${i}`,
      operationName: "",
      processID: pid,
      references: s.parent ? [{ refType: "CHILD_OF", traceID, spanID: s.parent }] : [],
      tags: Object.entries(s.tags || {}).map(([k, v]) => tag(k, v)),
    };
  });
  return { traceID, spans: jspans, processes };
}

/** Grafo ESTÁTICO mínimo: 1 rota + 1 entidade, ligadas por uma aresta estática. */
function staticGraph() {
  const g = new ApplicationGraph();
  g.addNode(new GraphNode("route:GET:/api/users/:id", "ROUTE", "/api/users/:id", null, null, {
    httpMethod: "GET", fullPath: "/api/users/:id",
  }));
  g.addNode(new GraphNode("entity:User", "ENTITY", "User", null, null, {}));
  return g;
}

describe("ADR-0028 P1.1 — observedRatio flui do traço ao grafo servido", () => {
  it("serviço NÃO-easynup (NuPIdentify) acende observedRatio>0 quando o gateway service casa", () => {
    // Um traço do PRÓPRIO NuPIdentify: http de entrada + JDBC no MESMO serviço.
    const t = trace("t-id-1", [
      { svc: "nupidentify", id: "http", tags: { "url.path": "/api/users/7?x=1", "http.request.method": "GET" } },
      { svc: "nupidentify", id: "jdbc", parent: "http", tags: { "db.sql.table": "user", "db.operation": "SELECT" } },
    ]);

    // extração mira o serviço do PROJETO (o que a config por-projeto resolve).
    const pairs = extractRuntimePairs([t], { gatewayServices: ["nupidentify"] });
    assert.equal(pairs.length, 1);

    const g = staticGraph();
    const ov = applyRuntimeOverlay(g, pairs);
    assert.equal(ov.routesMatched, 1);       // casou a rota estática :id
    assert.equal(ov.entityEdges, 1);         // rota→entidade OBSERVADA
    assert.equal(ov.tablesResolved, 1);      // tabela `user` → ENTITY `User`

    // Serialização do snapshot (idêntica ao pipeline: appGraph.toJSON()).
    const serialized = g.toJSON();
    // A aresta observada e o nó hot sobrevivem ao JSON:
    const obsEdge = serialized.edges.find((e) => e.relationType === "RUNTIME_OBSERVED");
    assert.ok(obsEdge, "aresta RUNTIME_OBSERVED deve estar no snapshot");
    assert.equal((obsEdge!.metadata as Record<string, unknown>).observed, true);

    // O que o /graph serve: shapeSystemGraph deriva o censo epistêmico.
    const shaped = shapeSystemGraph(serialized, "method");
    assert.ok(shaped.coverage.edges.observedRatio > 0, "observedRatio DEVE ser > 0");
    assert.equal(shaped.coverage.edges.byMethod.RUNTIME_OBSERVED, 1);
    assert.ok(shaped.coverage.nodes.observed >= 1, "≥1 nó observado (runtimeHot)");
    // a própria aresta shaped carrega a evidência mais forte:
    const shapedObs = shaped.edges.find((e) => e.relationType === "RUNTIME_OBSERVED");
    assert.equal(shapedObs!.evidence.method, "RUNTIME_OBSERVED");
    assert.equal(shapedObs!.evidence.confidence, 0.95);
  });

  it("sem overlay aplicado → observedRatio=0 (byte-a-byte; a costura é o que acende)", () => {
    const shaped = shapeSystemGraph(staticGraph().toJSON(), "method");
    assert.equal(shaped.coverage.edges.byMethod.RUNTIME_OBSERVED, 0);
    assert.equal(shaped.coverage.edges.observedRatio, 0);
  });
});

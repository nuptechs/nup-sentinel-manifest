import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  joinCrossServiceBySymbol,
  qualifyNodeId,
  type ServiceGraph,
  type CrossServiceSymbolEdge,
} from "../../server/analyzers/cross-service-symbol-junction";
import type { RawSystemNode } from "../../server/analyzers/system-graph";

// OBS-D04 — junção cross-service por SÍMBOLO, não por string. Inerte: nenhum
// produtor POSTa pares cross-service; os testes travam o contrato (resolve cada
// ponta no grafo do SEU serviço e emite aresta STATIC_PROVEN qualificada).

const gateway: ServiceGraph = {
  service: "easynup",
  nodes: [{ id: "node:client/api/users.ts", type: "SERVICE", className: "users", metadata: { sourceFile: "client/api/users.ts" } } as RawSystemNode],
};
const identify: ServiceGraph = {
  service: "identify",
  nodes: [{ id: "wsv1:/users/:id", type: "CONTROLLER", className: "UserController", metadata: { sourceFile: "server/user-controller.ts" } } as RawSystemNode],
};

// símbolos SCIP (scheme + ≥5 partes); o arquivo chega por `fromFile`/`toFile` (F1).
const pair = (res: "compiler" | "interface-impl" = "compiler"): CrossServiceSymbolEdge => ({
  fromService: "easynup",
  from: "scip-typescript npm easynup 1.0.0 client/api/`users.ts`/getUser().",
  fromFile: "client/api/users.ts",
  toService: "identify",
  to: "scip-java maven identify 1.0.0 server/UserController#get(+1).",
  toFile: "server/user-controller.ts",
  resolution: res,
});

describe("cross-service-symbol-junction — elo por símbolo", () => {
  it("resolve cada ponta e emite aresta cross-service qualificada por serviço", () => {
    const { edges, stats } = joinCrossServiceBySymbol([gateway, identify], [pair()]);
    assert.equal(stats.aggregated, 1);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].fromNode, qualifyNodeId("easynup", "node:client/api/users.ts"));
    assert.equal(edges[0].toNode, qualifyNodeId("identify", "wsv1:/users/:id"));
    assert.equal(edges[0].crossService, true);
    assert.equal(edges[0].resolution, "compiler");
  });

  it("compiler prevalece sobre interface-impl no mesmo par (dedup)", () => {
    const { edges, stats } = joinCrossServiceBySymbol([gateway, identify], [pair("interface-impl"), pair("compiler")]);
    assert.equal(stats.aggregated, 1);
    assert.equal(edges[0].resolution, "compiler");
  });

  it("símbolo que não resolve a nó → descartado e contado (honesto)", () => {
    const p = pair();
    p.toFile = "server/does-not-exist.ts"; // nenhum nó do identify tem esse arquivo
    const { edges, stats } = joinCrossServiceBySymbol([gateway, identify], [p]);
    assert.equal(edges.length, 0);
    assert.equal(stats.unresolvedEndpoint, 1);
  });

  it("serviço desconhecido e par intra-serviço são recusados", () => {
    const unknown = { ...pair(), toService: "ghost" };
    const intra = { ...pair(), toService: "easynup", toFile: "client/api/users.ts" };
    const { stats } = joinCrossServiceBySymbol([gateway, identify], [unknown, intra]);
    assert.equal(stats.unknownService, 1);
    assert.equal(stats.intraServiceDropped, 1);
    assert.equal(stats.aggregated, 0);
  });

  it("sem serviços ou sem pares → vazio (inerte)", () => {
    assert.equal(joinCrossServiceBySymbol([], [pair()]).edges.length, 0);
    assert.equal(joinCrossServiceBySymbol([gateway, identify], []).edges.length, 0);
  });
});

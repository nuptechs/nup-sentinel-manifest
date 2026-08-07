import { describe, it, expect } from "vitest";
import {
  buildRankedNodes,
  topBlastRadius,
  blindSpots,
  runtimeHotpaths,
  insightsSummary,
  nodeLabel,
  type InsightGraph,
} from "./system-map-insights";

// Grafo-fixture pequeno e explícito. As arestas carregam o eixo de evidência
// (contrato P0.1). Desenhado para contagens INEQUÍVOCAS: uma aresta contribui
// seu método para os DOIS extremos, então cada nó-folha tem 1 método distinto,
// e só o hub A (3 arestas de métodos distintos) é corroborado.
function graph(): InsightGraph {
  return {
    nodes: [
      // hub A: 3 saídas de métodos distintos → corroborado por 3, todo provado, hot
      { id: "TYPE:app.OrderService", type: "SERVICE", className: "OrderService", inDegree: 5, outDegree: 3, sourceFile: "app/OrderService.java", runtimeHot: true, runtimeCount: 42 },
      { id: "TYPE:app.OrderRepo", type: "REPOSITORY", className: "OrderRepo", inDegree: 2, outDegree: 0, sourceFile: "app/OrderRepo.java" },
      { id: "TYPE:app.Mailer", type: "SERVICE", className: "Mailer", inDegree: 1, outDegree: 0, sourceFile: "app/Mailer.java" },
      { id: "TYPE:app.Wiring", type: "SERVICE", className: "Wiring", inDegree: 1, outDegree: 0, sourceFile: "app/Wiring.java" },
      // par cego: única aresta entre eles é STATIC_UNRESOLVED
      { id: "TYPE:app.GhostA", type: "SERVICE", className: "GhostA", inDegree: 0, outDegree: 1, sourceFile: "app/GhostA.java" },
      { id: "TYPE:app.GhostB", type: "SERVICE", className: "GhostB", inDegree: 1, outDegree: 0, sourceFile: "app/GhostB.java" },
      // órfão: 0 arestas
      { id: "TYPE:app.Orphan", type: "COMPONENT", className: "Orphan", inDegree: 0, outDegree: 0 },
    ],
    edges: [
      { fromNode: "TYPE:app.OrderService", toNode: "TYPE:app.OrderRepo", relationType: "CALLS", evidence: { method: "RUNTIME_OBSERVED", confidence: 0.95 } },
      { fromNode: "TYPE:app.OrderService", toNode: "TYPE:app.Mailer", relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.8 } },
      { fromNode: "TYPE:app.OrderService", toNode: "TYPE:app.Wiring", relationType: "CALLS", evidence: { method: "CONFIG_PROVEN", confidence: 0.78 } },
      { fromNode: "TYPE:app.GhostA", toNode: "TYPE:app.GhostB", relationType: "CALLS", evidence: { method: "STATIC_UNRESOLVED", confidence: 0.4 } },
    ],
  };
}

describe("buildRankedNodes — proveniência agregada por nó", () => {
  it("colhe métodos distintos, corroboração, tier provado e alcance no hub", () => {
    const ranked = buildRankedNodes(graph());
    const svc = ranked.find((r) => r.id === "TYPE:app.OrderService")!;
    expect(svc.degree).toBe(8); // in 5 + out 3
    // 3 arestas incidentes, 3 métodos distintos → corroborado por 3
    expect(svc.corroboratedBy).toBe(3);
    expect(svc.methods).toEqual(["RUNTIME_OBSERVED", "STATIC_PROVEN", "CONFIG_PROVEN"]); // ordenado do + forte
    expect(svc.strongest).toBe("RUNTIME_OBSERVED");
    expect(svc.proven).toBe(true);
    expect(svc.runtimeHot).toBe(true);
    expect(svc.blindEdges).toBe(0);
  });

  it("nó-folha tem 1 método; CONFIG_PROVEN conta como provado (não vira UNKNOWN)", () => {
    const wiring = buildRankedNodes(graph()).find((r) => r.id === "TYPE:app.Wiring")!;
    expect(wiring.corroboratedBy).toBe(1);
    expect(wiring.methods).toEqual(["CONFIG_PROVEN"]);
    expect(wiring.proven).toBe(true); // o bug corrigido: config-proven é tier provado
    expect(wiring.blindEdges).toBe(0);
  });

  it("órfão (0 arestas) não inventa método nem corroboração", () => {
    const orphan = buildRankedNodes(graph()).find((r) => r.id === "TYPE:app.Orphan")!;
    expect(orphan.incidentEdges).toBe(0);
    expect(orphan.corroboratedBy).toBe(0);
    expect(orphan.methods).toEqual([]);
    expect(orphan.proven).toBe(false);
  });
});

describe("topBlastRadius — maior alcance, opcionalmente só corroborado", () => {
  it("ordena por alcance desc; órfão (grau 0) fica de fora", () => {
    const top = topBlastRadius(graph(), 20);
    expect(top[0].id).toBe("TYPE:app.OrderService"); // grau 8, o maior
    expect(top.find((r) => r.id === "TYPE:app.Orphan")).toBeUndefined();
  });

  it("onlyCorroborated exige ≥2 fontes de evidência — só o hub", () => {
    const top = topBlastRadius(graph(), 20, true);
    expect(top.map((r) => r.id)).toEqual(["TYPE:app.OrderService"]);
  });

  it("respeita o limite", () => {
    expect(topBlastRadius(graph(), 2)).toHaveLength(2);
  });
});

describe("blindSpots — nós onde só há evidência cega", () => {
  it("lista GhostA/GhostB (só STATIC_UNRESOLVED); nunca o hub nem os provados", () => {
    const blind = blindSpots(graph()).map((r) => r.id);
    expect(blind).toContain("TYPE:app.GhostA");
    expect(blind).toContain("TYPE:app.GhostB");
    expect(blind).not.toContain("TYPE:app.OrderService");
    expect(blind).not.toContain("TYPE:app.Wiring"); // config-proven → não é cego
    expect(blind).not.toContain("TYPE:app.Orphan"); // 0 arestas → não é "cego", é vazio
  });
});

describe("runtimeHotpaths — o que foi visto rodar", () => {
  it("lista só nós runtimeHot, ordenando por nº de traços", () => {
    const hot = runtimeHotpaths(graph());
    expect(hot.map((r) => r.id)).toEqual(["TYPE:app.OrderService"]);
    expect(hot[0].runtimeCount).toBe(42);
  });
});

describe("insightsSummary — manchete honesta", () => {
  it("conta corroborados, cegos, hot e detecta o eixo de evidência", () => {
    const s = insightsSummary(graph());
    expect(s.nodes).toBe(7);
    expect(s.edges).toBe(4);
    expect(s.corroborated).toBe(1); // só OrderService tem ≥2 métodos
    expect(s.blind).toBe(2); // GhostA + GhostB
    expect(s.hot).toBe(1);
    expect(s.hasEvidence).toBe(true);
  });

  it("degrada sem eixo de evidência: hasEvidence false, corroboração some (nada inventado)", () => {
    const g: InsightGraph = {
      nodes: [{ id: "A", type: "SERVICE", inDegree: 1, outDegree: 1 }],
      edges: [{ fromNode: "A", toNode: "A" }], // sem `evidence`
    };
    const s = insightsSummary(g);
    expect(s.hasEvidence).toBe(false);
    expect(s.corroborated).toBe(0);
    // aresta sem evidência → método UNKNOWN → conta como cego
    expect(s.blind).toBe(1);
  });
});

describe("nodeLabel — nome curto legível", () => {
  it("usa className, senão o fim do id", () => {
    expect(nodeLabel({ id: "TYPE:pkg.Foo", type: "SERVICE", inDegree: 0, outDegree: 0 })).toBe("Foo");
    expect(nodeLabel({ id: "TYPE:pkg.Foo", type: "SERVICE", className: "Foo", inDegree: 0, outDegree: 0 })).toBe("Foo");
    expect(nodeLabel({ id: "just-an-id", type: "X", inDegree: 0, outDegree: 0 })).toBe("just-an-id");
  });
});

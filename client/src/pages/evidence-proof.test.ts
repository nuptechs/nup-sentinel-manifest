import { describe, it, expect } from "vitest";
import {
  EGO_NEIGHBOR_CAP,
  EGO_VIEW,
  buildEgoLayout,
  defaultCenterId,
  edgeReceipt,
  proofLabel,
  searchNode,
  type ProofGraph,
  type ProofNode,
} from "./evidence-proof";

// ── Fixture literal mínima (shape do /graph verificado no SPEC) ───────
function graph(): ProofGraph {
  return {
    nodes: [
      { id: "SERVICE:app.Hub", type: "SERVICE", className: "Hub", inDegree: 9, outDegree: 3, sourceFile: "app/Hub.java" },
      { id: "REPOSITORY:app.Repo", type: "REPOSITORY", className: "Repo", inDegree: 4, outDegree: 0, sourceFile: "app/Repo.java", runtimeHot: true, runtimeCount: 42, runtimeLastSeenMs: 1754500000000 },
      { id: "SERVICE:app.Ghost", type: "SERVICE", className: "Ghost", inDegree: 1, outDegree: 0, sourceFile: "app/Ghost.java" },
      { id: "CONTROLLER:app.Api", type: "CONTROLLER", methodName: "listContracts", inDegree: 0, outDegree: 2 },
      // não-vizinho do Hub (só conecta ao Repo)
      { id: "SERVICE:app.Longe", type: "SERVICE", className: "Longe", inDegree: 1, outDegree: 1 },
    ],
    edges: [
      { fromNode: "SERVICE:app.Hub", toNode: "REPOSITORY:app.Repo", relationType: "CALLS", count: 42, observed: true, evidence: { method: "RUNTIME_OBSERVED", confidence: 0.95 } },
      { fromNode: "SERVICE:app.Hub", toNode: "SERVICE:app.Ghost", relationType: "CALLS", resolution: "convention-name", synthetic: true, evidence: { method: "STATIC_UNRESOLVED", confidence: 0.4 } },
      { fromNode: "CONTROLLER:app.Api", toNode: "SERVICE:app.Hub", relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.8 } },
      // aresta entre dois vizinhos — 1-hop estrito: NÃO entra no ego do Hub
      { fromNode: "SERVICE:app.Longe", toNode: "REPOSITORY:app.Repo", relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.8 } },
      // self-loop: descartado
      { fromNode: "SERVICE:app.Hub", toNode: "SERVICE:app.Hub", relationType: "CALLS" },
    ],
  };
}

describe("defaultCenterId — ponto de entrada com fan-out, não o sink de infra", () => {
  it("escolhe um bom centro (entry com fan-out) em vez do sink mais dependido", () => {
    expect(defaultCenterId(graph().nodes)).toBe("SERVICE:app.Hub");
  });

  it("NÃO centra num hub de infra (muito inDegree, ~zero outDegree) — o defeito do logger.ts", () => {
    const nodes: ProofNode[] = [
      // logger: dependidíssimo, mas não chama ninguém e não é entry → péssimo centro
      { id: "UTIL:logger", type: "UTIL", methodName: "log", inDegree: 103, outDegree: 0 },
      // controller modesto, mas é um ponto de entrada que fana pra fora
      { id: "CONTROLLER:app.Api", type: "CONTROLLER", className: "Api", inDegree: 2, outDegree: 5 },
    ];
    expect(defaultCenterId(nodes)).toBe("CONTROLLER:app.Api");
  });

  it("empate desempata por id (determinístico); vazio → null", () => {
    const tie: ProofNode[] = [
      { id: "b", type: "SERVICE", inDegree: 3, outDegree: 0 },
      { id: "a", type: "SERVICE", inDegree: 3, outDegree: 0 },
    ];
    expect(defaultCenterId(tie)).toBe("a");
    expect(defaultCenterId([])).toBeNull();
  });
});

describe("searchNode — substring em className/methodName/id", () => {
  const nodes = graph().nodes;

  it("acha por className, case-insensitive", () => {
    expect(searchNode(nodes, "GHOST")?.id).toBe("SERVICE:app.Ghost");
  });

  it("acha por methodName e por id", () => {
    expect(searchNode(nodes, "listContr")?.id).toBe("CONTROLLER:app.Api");
    expect(searchNode(nodes, "repository:app")?.id).toBe("REPOSITORY:app.Repo");
  });

  it("query vazia ou sem match → null (nunca chuta)", () => {
    expect(searchNode(nodes, "   ")).toBeNull();
    expect(searchNode(nodes, "nao-existe")).toBeNull();
  });
});

describe("buildEgoLayout — ego-network 1-hop radial", () => {
  it("só arestas INCIDENTES ao centro entram; self-loop sai", () => {
    const layout = buildEgoLayout(graph(), "SERVICE:app.Hub")!;
    expect(layout.edges).toHaveLength(3); // Repo, Ghost, Api — sem Longe→Repo, sem self-loop
    expect(layout.edges.every((e) => e.edge.fromNode === "SERVICE:app.Hub" || e.edge.toNode === "SERVICE:app.Hub")).toBe(true);
    expect(layout.neighbors.map((n) => n.node.id)).not.toContain("SERVICE:app.Longe");
  });

  it("direção preservada: aresta de entrada aponta PARA o centro", () => {
    const layout = buildEgoLayout(graph(), "SERVICE:app.Hub")!;
    const inbound = layout.edges.find((e) => e.edge.fromNode === "CONTROLLER:app.Api")!;
    expect(inbound.outbound).toBe(false);
    expect(inbound.x2).toBe(EGO_VIEW.cx);
    expect(inbound.y2).toBe(EGO_VIEW.cy);
  });

  it("cap de vizinhos anunciado (shown/total) e mantém os de maior grau", () => {
    const g: ProofGraph = { nodes: [{ id: "hub", type: "SERVICE", inDegree: 99, outDegree: 30, className: "Hub" }], edges: [] };
    for (let i = 0; i < 30; i++) {
      g.nodes.push({ id: `n${String(i).padStart(2, "0")}`, type: "SERVICE", inDegree: i, outDegree: 0 });
      g.edges.push({ fromNode: "hub", toNode: `n${String(i).padStart(2, "0")}`, relationType: "CALLS" });
    }
    const layout = buildEgoLayout(g, "hub")!;
    expect(layout.shown).toBe(EGO_NEIGHBOR_CAP);
    expect(layout.totalNeighbors).toBe(30);
    // os 24 mantidos são os de maior grau: n06..n29 (graus 6..29)
    expect(layout.neighbors.map((n) => n.node.id)).not.toContain("n05");
    expect(layout.neighbors.map((n) => n.node.id)).toContain("n29");
    // arestas para vizinhos truncados saem junto
    expect(layout.edges).toHaveLength(EGO_NEIGHBOR_CAP);
  });

  it("determinístico: duas chamadas produzem o MESMO layout", () => {
    expect(buildEgoLayout(graph(), "SERVICE:app.Hub")).toEqual(buildEgoLayout(graph(), "SERVICE:app.Hub"));
  });

  it("vizinhos ficam no anel (raio fixo em volta do centro)", () => {
    const layout = buildEgoLayout(graph(), "SERVICE:app.Hub")!;
    for (const n of layout.neighbors) {
      const d = Math.hypot(n.x - EGO_VIEW.cx, n.y - EGO_VIEW.cy);
      expect(Math.abs(d - EGO_VIEW.radius)).toBeLessThan(0.5);
    }
  });

  it("centro inexistente → null (nunca inventa um ego)", () => {
    expect(buildEgoLayout(graph(), "nao-existe")).toBeNull();
  });
});

describe("edgeReceipt — o recibo com os campos que o shape REALMENTE traz", () => {
  const g = graph();

  it("aresta observada: método, confiança, contagem, observed e fontes das pontas", () => {
    const r = edgeReceipt(g.edges[0], g.nodes);
    expect(r.method).toBe("RUNTIME_OBSERVED");
    expect(r.confidence).toBe(0.95);
    expect(r.relationType).toBe("CALLS");
    expect(r.count).toBe(42);
    expect(r.observed).toBe(true);
    expect(r.from.label).toBe("Hub");
    expect(r.from.sourceFile).toBe("app/Hub.java");
    expect(r.to.sourceFile).toBe("app/Repo.java");
    // recência é POR NÓ — vem da ponta, nunca da aresta
    expect(r.to.runtimeLastSeenMs).toBe(1754500000000);
    expect(r.from.runtimeLastSeenMs).toBeUndefined();
    expect(r.unresolvedWarning).toBe(false);
  });

  it("STATIC_UNRESOLVED liga o aviso de heurística e expõe a resolution", () => {
    const r = edgeReceipt(g.edges[1], g.nodes);
    expect(r.method).toBe("STATIC_UNRESOLVED");
    expect(r.unresolvedWarning).toBe(true);
    expect(r.resolution).toBe("convention-name");
    expect(r.synthetic).toBe(true);
    expect(r.count).toBeNull(); // sem contagem ≠ ×0
  });

  it("sem eixo de evidência → UNKNOWN com confiança canônica 0.2 (nunca crasha)", () => {
    const r = edgeReceipt({ fromNode: "x", toNode: "y", relationType: "CALLS" }, []);
    expect(r.method).toBe("UNKNOWN");
    expect(r.confidence).toBe(0.2);
    expect(r.from.label).toBe("x");
  });
});

describe("proofLabel — rótulo derivado (o shape não traz label)", () => {
  it("className → methodName → fim do id", () => {
    expect(proofLabel({ id: "a", type: "SERVICE", className: "Hub", inDegree: 0, outDegree: 0 })).toBe("Hub");
    expect(proofLabel({ id: "a", type: "SERVICE", methodName: "run", inDegree: 0, outDegree: 0 })).toBe("run");
    expect(proofLabel({ id: "SERVICE:app.X", type: "SERVICE", inDegree: 0, outDegree: 0 })).toBe("app.X");
  });
});

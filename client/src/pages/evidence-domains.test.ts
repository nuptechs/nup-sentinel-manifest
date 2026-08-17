import { describe, it, expect } from "vitest";
import {
  computeDomainEvidence,
  computeSeamEvidence,
  tierCensus,
  worstTier,
  type DomainsReport,
  type EdgeLite,
} from "./evidence-domains";

describe("worstTier", () => {
  it("herda o PIOR tier (fail-honest, nunca média)", () => {
    expect(worstTier(["RUNTIME_OBSERVED", "STATIC_UNRESOLVED", "STATIC_PROVEN"])).toBe("STATIC_UNRESOLVED");
  });
  it("vazio → UNKNOWN", () => {
    expect(worstTier([])).toBe("UNKNOWN");
  });
});

const report: DomainsReport = {
  domains: [
    { id: "D1", name: "Financeiro", size: 5, nodeIds: ["a", "b"] },
    { id: "D2", name: "Auditoria", size: 3, nodeIds: ["c"] },
    { id: "D3", name: "Órfão", size: 2, nodeIds: ["z"] },
  ],
  seams: [{ from: "D1", to: "D2", edges: 2 }],
  hubs: ["UTIL:Logger"],
};

function edge(from: string, to: string, method: string): EdgeLite {
  return { fromNode: from, toNode: to, evidence: { method } };
}

describe("computeDomainEvidence", () => {
  it("um domínio 'verde' com 1 elo heurístico herda o pior tier desse elo", () => {
    const edges: EdgeLite[] = [
      edge("a", "b", "STATIC_PROVEN"), // interno provado
      edge("a", "c", "STATIC_UNRESOLVED"), // incidente heurístico
    ];
    const dev = computeDomainEvidence(report, edges);
    const d1 = dev.find((d) => d.id === "D1")!;
    expect(d1.worstTier).toBe("STATIC_UNRESOLVED"); // o elo fraco denuncia
    expect(d1.provenShare).toBeGreaterThan(0);
    expect(d1.provenShare).toBeLessThan(1);
  });

  it("domínio sem nenhuma aresta = CEGO (provenShare -1, nunca fabricado)", () => {
    const dev = computeDomainEvidence(report, [edge("a", "b", "STATIC_PROVEN")]);
    const orfao = dev.find((d) => d.id === "D3")!;
    expect(orfao.provenShare).toBe(-1);
    expect(orfao.worstTier).toBe("UNKNOWN");
  });

  it("share provado = proven/total dos elos incidentes", () => {
    const edges: EdgeLite[] = [
      edge("a", "b", "STATIC_PROVEN"),
      edge("a", "b", "RUNTIME_OBSERVED"),
      edge("a", "c", "STATIC_UNRESOLVED"),
    ];
    const d1 = computeDomainEvidence(report, edges).find((d) => d.id === "D1")!;
    // D1 toca 3 elos, 2 provados
    expect(d1.edgeCount).toBe(3);
    expect(d1.provenShare).toBeCloseTo(2 / 3, 3);
  });
});

describe("computeSeamEvidence", () => {
  it("seam entre domínios herda o pior tier do feixe cruzado", () => {
    const edges: EdgeLite[] = [
      edge("a", "c", "STATIC_PROVEN"),
      edge("b", "c", "STATIC_UNRESOLVED"),
    ];
    const seams = computeSeamEvidence(report, edges);
    const s = seams.find((x) => x.from === "D1" && x.to === "D2")!;
    expect(s.worstTier).toBe("STATIC_UNRESOLVED");
  });
});

describe("tierCensus", () => {
  it("conta arestas por método", () => {
    const c = tierCensus([edge("a", "b", "STATIC_PROVEN"), edge("a", "b", "STATIC_PROVEN"), edge("x", "y", "RUNTIME_OBSERVED")]);
    expect(c.STATIC_PROVEN).toBe(2);
    expect(c.RUNTIME_OBSERVED).toBe(1);
    expect(c.UNKNOWN).toBe(0);
  });
});

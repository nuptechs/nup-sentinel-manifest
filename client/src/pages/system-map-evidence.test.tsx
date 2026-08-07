import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  coverageSummary,
  coverageBadgeText,
  evidenceMethodOf,
  evidenceConfidenceOf,
  confidenceOfMethod,
  normalizeEvidenceMethod,
  strongestEvidence,
  hasEvidenceData,
  EvidenceLegend,
  CoverageBadge,
  EVIDENCE_ORDER,
  PROVEN_TIER,
  type GraphCoverage,
} from "./system-map-evidence";

afterEach(cleanup);

// ── Degradação graciosa: sem evidence/coverage, NADA crasha ───────────
describe("degradação graciosa (contrato P0.1 ausente)", () => {
  it("coverageSummary → null quando coverage é undefined/null", () => {
    expect(coverageSummary(undefined)).toBeNull();
    expect(coverageSummary(null)).toBeNull();
  });

  it("coverageSummary → null quando não há bloco edges ou total <= 0", () => {
    expect(coverageSummary({ nodes: { observed: 0, total: 0 } } as unknown as GraphCoverage)).toBeNull();
    expect(
      coverageSummary({ edges: { byMethod: {}, total: 0, observedRatio: 0 }, nodes: { observed: 0, total: 0 } }),
    ).toBeNull();
  });

  it("evidenceMethodOf → UNKNOWN para aresta sem evidence, null ou método lixo", () => {
    expect(evidenceMethodOf(undefined)).toBe("UNKNOWN");
    expect(evidenceMethodOf(null)).toBe("UNKNOWN");
    expect(evidenceMethodOf({})).toBe("UNKNOWN");
    expect(evidenceMethodOf({ evidence: null })).toBe("UNKNOWN");
    expect(evidenceMethodOf({ evidence: { method: "BOGUS_ENUM_NOVO" } })).toBe("UNKNOWN");
    expect(normalizeEvidenceMethod(42)).toBe("UNKNOWN");
  });

  it("evidenceMethodOf → método válido quando presente (ignora o resto do objeto)", () => {
    const edge = { evidence: { method: "STATIC_PROVEN", confidence: 0.9 } } as { evidence: { method: unknown } };
    expect(evidenceMethodOf(edge)).toBe("STATIC_PROVEN");
  });

  it("hasEvidenceData: false sem eixo de evidência, true quando ao menos 1 aresta o traz (incl. UNKNOWN explícito)", () => {
    expect(hasEvidenceData(undefined)).toBe(false);
    expect(hasEvidenceData([])).toBe(false);
    expect(hasEvidenceData([{}, { observed: true }] as Array<{ evidence?: unknown }>)).toBe(false);
    expect(hasEvidenceData([{}, { evidence: { method: "UNKNOWN", confidence: 0 } }])).toBe(true);
  });

  it("strongestEvidence escolhe o método mais forte; vazio → UNKNOWN", () => {
    expect(strongestEvidence([])).toBe("UNKNOWN");
    expect(strongestEvidence(["UNKNOWN", "STATIC_UNRESOLVED", "RUNTIME_OBSERVED", "STATIC_PROVEN"])).toBe(
      "RUNTIME_OBSERVED",
    );
    expect(strongestEvidence(["UNKNOWN", "LLM_CONJECTURED"])).toBe("LLM_CONJECTURED");
  });

  it("CoverageBadge não renderiza nada sem coverage (degradação graciosa)", () => {
    const { container } = render(<CoverageBadge coverage={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("coverage-badge")).toBeNull();
  });
});

// ── Legenda dos 6 métodos ─────────────────────────────────────────────
describe("EvidenceLegend", () => {
  it("renderiza os 6 métodos com rótulo pt-BR (inclui CONFIG_PROVEN)", () => {
    render(<EvidenceLegend />);
    expect(screen.getByText("Observado em runtime")).toBeInTheDocument();
    expect(screen.getByText("Provado (estático)")).toBeInTheDocument();
    expect(screen.getByText("Provado por config (DI/rota)")).toBeInTheDocument();
    expect(screen.getByText("Não-resolvido")).toBeInTheDocument();
    expect(screen.getByText("Conjecturado (IA)")).toBeInTheDocument();
    expect(screen.getByText("Desconhecido")).toBeInTheDocument();
    // um item por método
    expect(EVIDENCE_ORDER).toHaveLength(6);
    for (const m of EVIDENCE_ORDER) {
      expect(screen.getByTestId(`evidence-legend-item-${m}`)).toBeInTheDocument();
    }
  });
});

// ── CONFIG_PROVEN: o método que faltava (bug: caía em UNKNOWN) ─────────
describe("CONFIG_PROVEN — taxonomia completa (ADR-0035)", () => {
  it("normalizeEvidenceMethod reconhece CONFIG_PROVEN (antes virava UNKNOWN)", () => {
    expect(normalizeEvidenceMethod("CONFIG_PROVEN")).toBe("CONFIG_PROVEN");
    expect(evidenceMethodOf({ evidence: { method: "CONFIG_PROVEN" } })).toBe("CONFIG_PROVEN");
  });

  it("CONFIG_PROVEN está no tier PROVADO e ranqueia acima de não-resolvido/conjectura", () => {
    expect(PROVEN_TIER.has("CONFIG_PROVEN")).toBe(true);
    // ao colapsar arestas, config-proven vence o não-resolvido e a conjectura
    expect(strongestEvidence(["STATIC_UNRESOLVED", "CONFIG_PROVEN"])).toBe("CONFIG_PROVEN");
    expect(strongestEvidence(["LLM_CONJECTURED", "CONFIG_PROVEN"])).toBe("CONFIG_PROVEN");
    // mas cede ao checker de compilador e ao runtime
    expect(strongestEvidence(["CONFIG_PROVEN", "STATIC_PROVEN"])).toBe("STATIC_PROVEN");
    expect(strongestEvidence(["CONFIG_PROVEN", "RUNTIME_OBSERVED"])).toBe("RUNTIME_OBSERVED");
  });

  it("coverageSummary conta CONFIG_PROVEN no total PROVADO (não só observado)", () => {
    const s = coverageSummary({
      edges: {
        byMethod: { RUNTIME_OBSERVED: 10, STATIC_PROVEN: 20, CONFIG_PROVEN: 15, STATIC_UNRESOLVED: 5, UNKNOWN: 50 },
        total: 100,
        observedRatio: 0.1,
      },
      nodes: { observed: 10, total: 100 },
    })!;
    expect(s.observed).toBe(10); // só runtime
    expect(s.proven).toBe(45); // runtime + estático + config
    expect(s.provenPct).toBe(45);
    expect(s.ratioPct).toBe(10);
  });
});

// ── Confiança por aresta (encoding de opacidade ∝ confiança) ──────────
describe("evidenceConfidenceOf / confidenceOfMethod", () => {
  it("usa a confiança crua quando presente e finita", () => {
    expect(evidenceConfidenceOf({ evidence: { method: "STATIC_PROVEN", confidence: 0.73 } })).toBe(0.73);
  });

  it("cai na confiança canônica do método quando a crua está ausente/inválida", () => {
    expect(evidenceConfidenceOf({ evidence: { method: "CONFIG_PROVEN" } })).toBe(0.78);
    expect(evidenceConfidenceOf({ evidence: { method: "RUNTIME_OBSERVED", confidence: NaN } })).toBe(0.95);
    expect(evidenceConfidenceOf(undefined)).toBe(0.2); // sem evidência → UNKNOWN
  });

  it("clampa valores fora de 0..1", () => {
    expect(evidenceConfidenceOf({ evidence: { method: "STATIC_PROVEN", confidence: 1.4 } })).toBe(1);
    expect(evidenceConfidenceOf({ evidence: { method: "STATIC_PROVEN", confidence: -0.3 } })).toBe(0);
  });

  it("confidenceOfMethod é monotônica com o rank (mais forte = mais confiante)", () => {
    expect(confidenceOfMethod("RUNTIME_OBSERVED")).toBeGreaterThan(confidenceOfMethod("STATIC_PROVEN"));
    expect(confidenceOfMethod("STATIC_PROVEN")).toBeGreaterThan(confidenceOfMethod("CONFIG_PROVEN"));
    expect(confidenceOfMethod("CONFIG_PROVEN")).toBeGreaterThan(confidenceOfMethod("STATIC_UNRESOLVED"));
    expect(confidenceOfMethod("STATIC_UNRESOLVED")).toBeGreaterThan(confidenceOfMethod("UNKNOWN"));
  });
});

// ── Badge de cobertura com dados (a revelação honesta do furo) ─────────
describe("CoverageBadge com dados", () => {
  it("mostra a % de cobertura e as arestas nunca observadas", () => {
    const coverage: GraphCoverage = {
      edges: {
        byMethod: { RUNTIME_OBSERVED: 42, STATIC_PROVEN: 40, STATIC_UNRESOLVED: 18 },
        total: 100,
        observedRatio: 0.42,
      },
      nodes: { observed: 30, total: 80 },
    };
    render(<CoverageBadge coverage={coverage} />);
    expect(screen.getByTestId("coverage-badge")).toHaveTextContent("cobertura 42%, 58 arestas nunca observadas");
  });

  it("plural correto quando só 1 aresta nunca foi observada", () => {
    const s = coverageSummary({
      edges: { byMethod: { RUNTIME_OBSERVED: 9 }, total: 10, observedRatio: 0.9 },
      nodes: { observed: 5, total: 5 },
    })!;
    expect(coverageBadgeText(s)).toBe("cobertura 90%, 1 aresta nunca observada");
  });

  it("deriva observedRatio de byMethod/total quando o campo vem ausente", () => {
    const s = coverageSummary({
      edges: { byMethod: { RUNTIME_OBSERVED: 1 }, total: 4 } as GraphCoverage["edges"],
      nodes: { observed: 1, total: 4 },
    })!;
    expect(s.ratioPct).toBe(25);
    expect(s.unobserved).toBe(3);
  });
});

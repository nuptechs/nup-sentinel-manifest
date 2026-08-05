import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  coverageSummary,
  coverageBadgeText,
  evidenceMethodOf,
  normalizeEvidenceMethod,
  strongestEvidence,
  hasEvidenceData,
  EvidenceLegend,
  CoverageBadge,
  EVIDENCE_ORDER,
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

// ── Legenda dos 5 métodos ─────────────────────────────────────────────
describe("EvidenceLegend", () => {
  it("renderiza os 5 métodos com rótulo pt-BR", () => {
    render(<EvidenceLegend />);
    expect(screen.getByText("Observado em runtime")).toBeInTheDocument();
    expect(screen.getByText("Provado (estático)")).toBeInTheDocument();
    expect(screen.getByText("Não-resolvido")).toBeInTheDocument();
    expect(screen.getByText("Conjecturado (IA)")).toBeInTheDocument();
    expect(screen.getByText("Desconhecido")).toBeInTheDocument();
    // um item por método
    expect(EVIDENCE_ORDER).toHaveLength(5);
    for (const m of EVIDENCE_ORDER) {
      expect(screen.getByTestId(`evidence-legend-item-${m}`)).toBeInTheDocument();
    }
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

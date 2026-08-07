import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { breakdownData, EpistemicBreakdown, RankedNodeCard } from "./system-map-proofs";
import type { GraphCoverage } from "./system-map-evidence";
import type { RankedNode } from "./system-map-insights";

afterEach(cleanup);

const coverage: GraphCoverage = {
  edges: {
    byMethod: { RUNTIME_OBSERVED: 10, STATIC_PROVEN: 30, CONFIG_PROVEN: 20, STATIC_UNRESOLVED: 15, UNKNOWN: 25 },
    total: 100,
    observedRatio: 0.1,
  },
  nodes: { observed: 12, total: 60 },
};

// ── peça 3: repartição (pura) ─────────────────────────────────────────
describe("breakdownData", () => {
  it("ordena forte→fraco, só buckets não-vazios, com % correta", () => {
    const d = breakdownData(coverage)!;
    expect(d.map((x) => x.method)).toEqual([
      "RUNTIME_OBSERVED",
      "STATIC_PROVEN",
      "CONFIG_PROVEN",
      "STATIC_UNRESOLVED",
      "UNKNOWN",
    ]); // LLM_CONJECTURED tem 0 → omitido
    const config = d.find((x) => x.method === "CONFIG_PROVEN")!;
    expect(config.count).toBe(20);
    expect(config.pct).toBe(20);
    expect(config.label).toContain("config"); // rótulo pt-BR do método
  });

  it("degrada: null sem censo / total 0", () => {
    expect(breakdownData(undefined)).toBeNull();
    expect(breakdownData(null)).toBeNull();
    expect(
      breakdownData({ edges: { byMethod: {}, total: 0, observedRatio: 0 }, nodes: { observed: 0, total: 0 } }),
    ).toBeNull();
  });
});

// ── peça 3: card do donut ─────────────────────────────────────────────
describe("EpistemicBreakdown", () => {
  it("mostra % provado (runtime+estático+config) e a legenda com contagens", () => {
    render(
      <TooltipProvider>
        <EpistemicBreakdown coverage={coverage} />
      </TooltipProvider>,
    );
    // provado = 10+30+20 = 60 de 100 → 60%
    expect(screen.getByTestId("breakdown-proven-pct")).toHaveTextContent("60%");
    expect(screen.getByTestId("breakdown-row-CONFIG_PROVEN")).toHaveTextContent("20");
    expect(screen.getByTestId("breakdown-row-UNKNOWN")).toBeInTheDocument();
  });

  it("degrada graciosamente: sem coverage não renderiza nada", () => {
    const { container } = render(<EpistemicBreakdown coverage={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ── peça 2: o card cita a TESTEMUNHA ──────────────────────────────────
const node: RankedNode = {
  id: "TYPE:app.OrderService",
  label: "OrderService",
  type: "SERVICE",
  sourceFile: "app/OrderService.java",
  inDegree: 5,
  outDegree: 3,
  degree: 8,
  methods: ["RUNTIME_OBSERVED", "CONFIG_PROVEN"],
  strongest: "RUNTIME_OBSERVED",
  strongestConfidence: 0.95,
  corroboratedBy: 2,
  proven: true,
  runtimeHot: true,
  runtimeCount: 42,
  sensitive: false,
  incidentEdges: 3,
  blindEdges: 0,
};

describe("RankedNodeCard — cada afirmação cita a testemunha", () => {
  it("mostra alcance, arquivo-fonte, métodos e corroboração", () => {
    render(<RankedNodeCard node={node} />);
    expect(screen.getByTestId("insight-node-TYPE:app.OrderService")).toBeInTheDocument();
    expect(screen.getByText("OrderService")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument(); // alcance
    expect(screen.getByText("app/OrderService.java")).toBeInTheDocument(); // testemunha: arquivo
    // testemunhas de método (inclui CONFIG_PROVEN — antes caía em UNKNOWN)
    expect(screen.getByTestId("witness-RUNTIME_OBSERVED")).toBeInTheDocument();
    expect(screen.getByTestId("witness-CONFIG_PROVEN")).toBeInTheDocument();
    expect(screen.getByTestId("corroboration-TYPE:app.OrderService")).toHaveTextContent("2 fontes");
    // confiança do elo mais forte
    expect(screen.getByText(/confiança 95%/)).toBeInTheDocument();
    // runtimeHot
    expect(screen.getByText(/rodou ×42/)).toBeInTheDocument();
  });

  it("não mostra corroboração quando há só 1 fonte", () => {
    render(<RankedNodeCard node={{ ...node, id: "X", methods: ["CONFIG_PROVEN"], corroboratedBy: 1, strongest: "CONFIG_PROVEN", runtimeHot: false }} />);
    expect(screen.queryByTestId("corroboration-X")).toBeNull();
  });
});

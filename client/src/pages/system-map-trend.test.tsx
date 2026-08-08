// ─────────────────────────────────────────────
// O que estes testes protegem: a série temporal não pode MENTIR sobre evolução.
//
// Três mentiras possíveis, todas com teste dedicado:
//   • plotar run sem censo como ZERO — inventaria um vale/subida que nunca houve
//     (o histórico só começou a ser gravado num deploy; run anterior é "não
//     sabemos", não "não havia prova");
//   • chamar 1 ponto de tendência — um delta de 0% leria como "não melhorou",
//     que é uma afirmação, e falsa;
//   • tratar falha de consulta como "nenhuma evolução" — carregando ≠ vazio ≠
//     falhou, a regra do resto do mapa.
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  EvidenceTrendPanel,
  trendHeadline,
  trendSeries,
  type EvidenceHistoryPayload,
  type EvidenceHistoryPointDTO,
} from "./system-map-trend";

afterEach(cleanup);

// Números do projeto 27 — o run mais novo é sempre o ÚLTIMO ponto.
function point(runId: number, over: Partial<EvidenceHistoryPointDTO> = {}): EvidenceHistoryPointDTO {
  return {
    runId,
    completedAt: `2026-08-0${runId}T01:00:00.000Z`,
    coverage: {
      edges: {
        total: 4000,
        byMethod: { RUNTIME_OBSERVED: 700, STATIC_PROVEN: 3000, CONFIG_PROVEN: 20, UNKNOWN: 280 },
        observedRatio: 0.175,
      },
      nodes: { observed: 100, total: 900 },
    },
    bimr: { measurable: true, observed: 40, resolved: 31, minted: 9, mintedRatio: 0.225, mintedRatioExcludingInfrastructure: 0.2 },
    calibration: { calibrated: true, comparablePairs: 50 },
    ...over,
  };
}

/** run melhor: mais provado (3900/4000 = 97%) e menos ponto cego (10%). */
const melhor = (runId: number) =>
  point(runId, {
    coverage: {
      edges: { total: 4000, byMethod: { RUNTIME_OBSERVED: 743, STATIC_PROVEN: 3085, CONFIG_PROVEN: 22, UNKNOWN: 150 }, observedRatio: 0.185 },
      nodes: { observed: 120, total: 900 },
    },
    bimr: { measurable: true, observed: 40, resolved: 36, minted: 4, mintedRatio: 0.1, mintedRatioExcludingInfrastructure: 0.1 },
  });

const payload = (points: EvidenceHistoryPointDTO[]): EvidenceHistoryPayload => ({
  projectId: 27,
  count: points.length,
  limit: 90,
  recordedFrom: points[0]?.completedAt ?? null,
  points,
});

// ── série (pura) ──────────────────────────────────────────────────────
describe("trendSeries", () => {
  it("mapeia cada run medido para um ponto do gráfico", () => {
    const s = trendSeries(payload([point(1), melhor(2)]))!;
    expect(s).toHaveLength(2);
    expect(s[0].runId).toBe(1);
    expect(s[0].STATIC_PROVEN).toBe(3000);
    expect(s[1].STATIC_PROVEN).toBe(3085);
    expect(s[0].provenPct).toBe(93); // (700+3000+20)/4000
    expect(s[1].provenPct).toBe(96); // (743+3085+22)/4000
    expect(s[0].label).toBe("01/08");
  });

  it("run SEM censo é omitido — jamais plotado como zero", () => {
    const antigo = point(1, { coverage: null });
    const s = trendSeries(payload([antigo, point(2)]))!;
    expect(s).toHaveLength(1);
    expect(s.map((p) => p.runId)).toEqual([2]);
    expect(s.some((p) => p.total === 0)).toBe(false);
  });

  it("BIMR não-mensurável vira null, não 0% de ponto cego", () => {
    const semTrafego = point(2, { bimr: { measurable: false, observed: 0, resolved: 0, minted: 0, mintedRatio: 0, mintedRatioExcludingInfrastructure: 0 } });
    const s = trendSeries(payload([point(1), semTrafego]))!;
    expect(s[0].bimrPct).toBe(20);
    expect(s[1].bimrPct).toBeNull();
  });

  it("degrada: sem payload / sem pontos / nenhum ponto medido → null", () => {
    expect(trendSeries(undefined)).toBeNull();
    expect(trendSeries(payload([]))).toBeNull();
    expect(trendSeries(payload([point(1, { coverage: null })]))).toBeNull();
  });
});

// ── manchete (pura) ───────────────────────────────────────────────────
describe("trendHeadline", () => {
  it("mede o delta em pontos percentuais entre o 1º e o último medido", () => {
    const h = trendHeadline(payload([point(1), melhor(2)]));
    expect(h.state).toBe("measured");
    expect(h.deltaPp).toBe(3); // 93% → 96%
    expect(h.direction).toBe("up");
    expect(h.headline).toContain("mais confirmado");
    expect(h.sub).toContain("93% → 96%");
  });

  it("regressão é reportada como regressão", () => {
    const h = trendHeadline(payload([melhor(1), point(2)]));
    expect(h.deltaPp).toBe(-3);
    expect(h.direction).toBe("down");
    expect(h.headline).toContain("menos confirmado");
  });

  it("UM ponto não é tendência — vira 'warming', nunca delta 0", () => {
    const h = trendHeadline(payload([point(1)]));
    expect(h.state).toBe("warming");
    expect(h.deltaPp).toBeUndefined();
    expect(h.headline).toMatch(/começa a acumular/i);
  });

  it("sem nenhum run medido → unavailable (não é 'sem evolução')", () => {
    const h = trendHeadline(payload([point(1, { coverage: null })]));
    expect(h.state).toBe("unavailable");
    expect(h.unmeasured).toBe(1);
  });

  it("conta os runs que ficaram de fora (sem censo e falhos)", () => {
    const falho = point(3, { coverage: null, failed: true });
    const h = trendHeadline(payload([point(1, { coverage: null }), point(2), melhor(4), falho]));
    expect(h.unmeasured).toBe(2); // o pré-registro + o falho
    expect(h.failed).toBe(1);
  });
});

// ── estados do painel: carregando ≠ vazio ≠ falhou ────────────────────
describe("EvidenceTrendPanel — estados distintos", () => {
  it("carregando mostra esqueleto, não número", () => {
    render(<EvidenceTrendPanel isLoading />);
    expect(screen.getByTestId("trend-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("trend-delta")).toBeNull();
  });

  it("erro é ERRO — jamais 'o mapa não evoluiu'", () => {
    render(<EvidenceTrendPanel isError error={new Error("500: boom")} onRetry={() => {}} />);
    expect(screen.getByTestId("trend-error")).toBeInTheDocument();
    expect(screen.getByText(/não sabemos/i)).toBeInTheDocument();
    expect(screen.getByTestId("trend-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("trend-delta")).toBeNull();
  });

  it("sem histórico é NEUTRO (não erro, não zero)", () => {
    render(<EvidenceTrendPanel data={payload([])} />);
    expect(screen.getByTestId("trend-state-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("trend-error")).toBeNull();
    expect(screen.queryByTestId("trend-delta")).toBeNull();
  });

  it("1 run medido → 'histórico começa a acumular', sem gráfico de tendência", () => {
    render(<EvidenceTrendPanel data={payload([point(1)])} />);
    expect(screen.getByTestId("trend-state-warming")).toBeInTheDocument();
    expect(screen.queryByTestId("trend-coverage-chart")).toBeNull();
  });
});

// ── conteúdo medido ───────────────────────────────────────────────────
describe("EvidenceTrendPanel — série medida", () => {
  it("mostra o delta, a legenda por método e a variação de cada um", () => {
    render(<EvidenceTrendPanel data={payload([point(1), melhor(2)])} />);
    expect(screen.getByTestId("trend-state-measured")).toBeInTheDocument();
    expect(screen.getByTestId("trend-delta")).toHaveTextContent("+3 pp");
    // legenda em DOM comum (fora do ResponsiveContainer, que não renderiza em jsdom)
    expect(screen.getByTestId("trend-legend-STATIC_PROVEN")).toHaveTextContent("3.085");
    expect(screen.getByTestId("trend-legend-STATIC_PROVEN")).toHaveTextContent("+85");
    expect(screen.getByTestId("trend-legend-RUNTIME_OBSERVED")).toHaveTextContent("+43");
    expect(screen.getByTestId("trend-last-total")).toHaveTextContent("4.000");
  });

  it("o ponto cego encolhendo aparece com as duas pontas", () => {
    render(<EvidenceTrendPanel data={payload([point(1), melhor(2)])} />);
    expect(screen.getByTestId("trend-bimr-delta")).toHaveTextContent("20% → 10%");
    expect(screen.getByTestId("trend-bimr-delta")).toHaveTextContent("-10 pp");
  });

  it("sem BIMR mensurável diz NÃO-MEDIDO, não 0%", () => {
    const semTrafego = (id: number) =>
      point(id, { bimr: { measurable: false, observed: 0, resolved: 0, minted: 0, mintedRatio: 0, mintedRatioExcludingInfrastructure: 0 } });
    render(<EvidenceTrendPanel data={payload([semTrafego(1), semTrafego(2)])} />);
    expect(screen.getByTestId("trend-bimr-unavailable")).toBeInTheDocument();
    expect(screen.getByText(/não é 0%/i)).toBeInTheDocument();
    expect(screen.queryByTestId("trend-bimr-chart")).toBeNull();
  });

  it("avisa quantos runs ficaram fora da linha (o histórico começou depois)", () => {
    render(<EvidenceTrendPanel data={payload([point(1, { coverage: null }), point(2), melhor(3)])} />);
    expect(screen.getByTestId("trend-unmeasured")).toHaveTextContent("1 run(s) sem censo");
  });

  it("degrada com payload de servidor antigo (sem points) sem quebrar", () => {
    render(<EvidenceTrendPanel data={{ projectId: 27 } as EvidenceHistoryPayload} />);
    expect(screen.getByTestId("trend-state-unavailable")).toBeInTheDocument();
  });
});

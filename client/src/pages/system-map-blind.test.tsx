// ─────────────────────────────────────────────
// system-map-blind — a vitrine do BIMR + as faixas calibradas.
//
// O que estes testes protegem (na ordem do que dói se quebrar):
//  1. os TRÊS estados são distintos: carregando ≠ vazio/neutro ≠ falhou. Um
//     "0 pontos cegos" quando a query morreu seria a pior mentira possível.
//  2. "sem tráfego" NÃO vira 0% — vira "não medido", com essa palavra.
//  3. a abstenção da calibração aparece com o MOTIVO, não como tabela vazia.
//  4. infra é marcada e a 2ª taxa aparece — o número não é inflado em silêncio.
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  bimrHeadline,
  calibrationRows,
  BlindSpotPanel,
  CalibrationBands,
  type BimrPayload,
} from "./system-map-blind";
import type { GraphCalibration } from "./system-map-evidence";

afterEach(cleanup);

// Forma verificada no run 102 do projeto 27 (7 mintadas de 23 observadas).
const measured: BimrPayload = {
  available: true,
  measurable: true,
  tablesObservedRuntime: 23,
  tablesResolvedStatic: 16,
  tablesMintedRuntimeOnly: 7,
  mintedRatio: 0.3043,
  mintedRatioExcludingInfrastructure: 0.2381,
  observedExcludingInfrastructure: 21,
  minted: [
    { id: "table:legacy_ledger", table: "legacy_ledger", runtimeCount: 12, likelyInfrastructure: false },
    { id: "table:databasechangelog", table: "databasechangelog", runtimeCount: 3, likelyInfrastructure: true },
  ],
  entitiesHotWithoutStaticInbound: { count: 2, nodes: [{ id: "ENTITY:a.Orfa", label: "Orfa" }, { id: "ENTITY:a.Solta", label: "Solta" }] },
  caveats: ["O denominador é a JANELA observada."],
};

// ── helpers puros ─────────────────────────────────────────────────────
describe("bimrHeadline", () => {
  it("medido: manchete em português de gente, com os dois números", () => {
    const h = bimrHeadline(measured);
    expect(h.state).toBe("measured");
    expect(h.pct).toBe(30);
    expect(h.headline).toContain("7 de 23");
    expect(h.sub).toContain("30%");
  });

  it("sem análise: estado NEUTRO — nunca 'zero pontos cegos'", () => {
    const h = bimrHeadline({ available: false, reason: "Nenhuma análise executada ainda." });
    expect(h.state).toBe("unavailable");
    expect(h.headline).not.toMatch(/0%/);
    expect(h.sub).toContain("Nenhuma análise");
  });

  it("payload ausente/nulo degrada para o estado neutro", () => {
    expect(bimrHeadline(undefined).state).toBe("unavailable");
    expect(bimrHeadline(null).state).toBe("unavailable");
  });

  it("análise sem tráfego: diz NÃO-MEDIDO com todas as letras (não 0%)", () => {
    const h = bimrHeadline({ available: true, measurable: false, tablesObservedRuntime: 0 });
    expect(h.state).toBe("not-measurable");
    expect(h.sub).toMatch(/não[- ]medido/i);
  });

  it("zero mintadas é uma boa notícia explícita, não um vazio", () => {
    const h = bimrHeadline({ available: true, measurable: true, tablesObservedRuntime: 12, tablesMintedRuntimeOnly: 0, mintedRatio: 0 });
    expect(h.state).toBe("measured");
    expect(h.headline).toContain("existem no código");
  });
});

describe("calibrationRows", () => {
  const cal: GraphCalibration = {
    calibrated: true,
    confidenceLevelPct: 90,
    byMethod: {
      STATIC_UNRESOLVED: { reliability: 0.3, lower: 0.23, upper: 0.38, width: 0.15, n: 100, confirmed: 30, calibrated: true },
      CONFIG_PROVEN: { reliability: 0.9, lower: 0.8, upper: 0.96, width: 0.16, n: 40, confirmed: 36, calibrated: true },
      STATIC_PROVEN: { reliability: 0.5, lower: 0, upper: 1, width: 1, n: 4, confirmed: 2, calibrated: false, abstainReason: "amostra rala" },
    },
    effectiveConfidenceByMethod: {
      STATIC_UNRESOLVED: { confidence: 0.3, source: "calibrated", fixed: 0.4 },
      CONFIG_PROVEN: { confidence: 0.9, source: "calibrated", fixed: 0.78 },
    },
  };

  it("só publica método CALIBRADO, ordenado por confiabilidade", () => {
    const rows = calibrationRows(cal);
    expect(rows.map((r) => r.method)).toEqual(["CONFIG_PROVEN", "STATIC_UNRESOLVED"]);
    expect(rows.find((r) => r.method === "STATIC_PROVEN")).toBeUndefined(); // abstido
  });

  it("traduz taxa/intervalo/peso-de-projeto em % legível", () => {
    const r = calibrationRows(cal).find((x) => x.method === "STATIC_UNRESOLVED")!;
    expect(r.reliabilityPct).toBe(30);
    expect(r.lowerPct).toBe(23);
    expect(r.upperPct).toBe(38);
    expect(r.marginPct).toBe(8); // maior lado (38−30)
    expect(r.fixedPct).toBe(40); // o "antes"
  });

  it("abstenção global → nenhuma linha (a UI mostra o motivo, não tabela vazia)", () => {
    expect(calibrationRows({ calibrated: false, reason: "sem oráculo" })).toEqual([]);
    expect(calibrationRows(null)).toEqual([]);
    expect(calibrationRows(undefined)).toEqual([]);
  });
});

// ── estados do painel: carregando ≠ vazio ≠ falhou ────────────────────
describe("BlindSpotPanel — estados distintos", () => {
  it("carregando mostra esqueleto, não número", () => {
    render(<BlindSpotPanel isLoading />);
    expect(screen.getByTestId("blind-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("blind-pct")).toBeNull();
  });

  it("erro é ERRO — jamais 'nenhum ponto cego'", () => {
    render(<BlindSpotPanel isError error={new Error("500: boom")} onRetry={() => {}} />);
    expect(screen.getByTestId("blind-error")).toBeInTheDocument();
    expect(screen.getByText(/não sabemos/i)).toBeInTheDocument();
    expect(screen.getByTestId("blind-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("blind-pct")).toBeNull();
  });

  it("available:false é NEUTRO (não erro, não zero)", () => {
    render(<BlindSpotPanel data={{ available: false, reason: "Nenhuma análise executada ainda." }} />);
    expect(screen.getByTestId("blind-state-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("blind-error")).toBeNull();
    expect(screen.queryByTestId("blind-pct")).toBeNull();
  });
});

describe("BlindSpotPanel — a manchete de valor", () => {
  it("mostra a taxa, os números e NOMEIA as tabelas invisíveis", () => {
    render(<BlindSpotPanel data={measured} />);
    expect(screen.getByTestId("blind-pct")).toHaveTextContent("30%");
    expect(screen.getByTestId("blind-headline")).toHaveTextContent("7 de 23");
    expect(screen.getByTestId("minted-legacy_ledger")).toBeInTheDocument();
    expect(screen.getByTestId("minted-databasechangelog")).toBeInTheDocument();
  });

  it("marca infra e mostra a 2ª taxa (número não é inflado em silêncio)", () => {
    render(<BlindSpotPanel data={measured} />);
    expect(screen.getByTestId("minted-databasechangelog")).toHaveTextContent("infra");
    expect(screen.getByTestId("blind-ex-infra")).toHaveTextContent("24%");
  });

  it("mostra o 2º sinal (entidade quente sem ninguém apontando)", () => {
    render(<BlindSpotPanel data={measured} />);
    expect(screen.getByTestId("blind-orphans")).toHaveTextContent("2 entidade(s)");
    expect(screen.getByText("Orfa")).toBeInTheDocument();
  });

  it("expõe os caveats — o que o número NÃO diz", () => {
    render(<BlindSpotPanel data={measured} />);
    expect(screen.getByTestId("blind-caveats")).toHaveTextContent("JANELA observada");
  });

  it("sem mintadas: nenhuma lista vazia pendurada", () => {
    render(<BlindSpotPanel data={{ available: true, measurable: true, tablesObservedRuntime: 5, tablesMintedRuntimeOnly: 0, mintedRatio: 0, minted: [] }} />);
    expect(screen.queryByTestId("blind-minted-list")).toBeNull();
    expect(screen.queryByTestId("blind-orphans")).toBeNull();
  });
});

// ── faixas calibradas ─────────────────────────────────────────────────
describe("CalibrationBands", () => {
  it("calibrado: mostra x% ±y e o intervalo com o NÍVEL declarado", () => {
    render(
      <CalibrationBands
        calibration={{
          calibrated: true,
          confidenceLevelPct: 90,
          byMethod: { STATIC_PROVEN: { reliability: 0.8, lower: 0.72, upper: 0.86, width: 0.14, n: 200, confirmed: 160, calibrated: true } },
          effectiveConfidenceByMethod: { STATIC_PROVEN: { confidence: 0.8, source: "calibrated", fixed: 0.8 } },
        }}
      />,
    );
    const row = screen.getByTestId("calibration-row-STATIC_PROVEN");
    // ± é o lado MAIOR do intervalo (assimétrico em Clopper–Pearson): max(86−80, 80−72)=8.
    // Arredondar para o lado menor esconderia incerteza — o oposto do objetivo.
    expect(row).toHaveTextContent("80% ±8");
    expect(row).toHaveTextContent("IC 90%: 72–86%");
  });

  it("abstém COM MOTIVO — e diz que o número exibido é peso de projeto", () => {
    render(
      <CalibrationBands
        calibration={{
          calibrated: false,
          reason: "oráculo de runtime incomparável com o mapa estático (traço fragmentado)",
        }}
      />,
    );
    const box = screen.getByTestId("calibration-abstained");
    expect(box).toHaveTextContent("incomparável");
    expect(box).toHaveTextContent(/peso de projeto/i);
    expect(screen.queryByTestId("calibration-row-STATIC_PROVEN")).toBeNull();
  });

  it("completude só aparece quando APLICÁVEL (o bug dos 34 milhões não vaza)", () => {
    const base: GraphCalibration = {
      calibrated: false,
      reason: "x",
      completeness: { observed: 9601, estimatedTotal: 34573201, missShare: 0.9997 },
    };
    const { rerender } = render(<CalibrationBands calibration={{ ...base, completenessApplicable: false }} />);
    expect(screen.queryByTestId("completeness-note")).toBeNull();
    rerender(<CalibrationBands calibration={{ ...base, completenessApplicable: true }} />);
    expect(screen.getByTestId("completeness-note")).toBeInTheDocument();
  });

  it("servidor antigo (sem a seção) não renderiza nada — degradação graciosa", () => {
    const { container } = render(<CalibrationBands calibration={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

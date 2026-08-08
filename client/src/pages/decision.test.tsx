// ─────────────────────────────────────────────
// O que estes testes protegem na Visão de Decisão:
//
//   • a página inteira é uma COMPOSIÇÃO de quatro fontes independentes — se
//     uma cai, as outras três continuam respondendo (senão a "superfície única"
//     vira ponto único de falha, que é pior do que as três telas de antes);
//   • saúde ruim tem que CONTAMINAR a leitura — starving muda o banner E avisa
//     que o resto está sob suspeita, no topo e no rodapé;
//   • zero fabricado é proibido em todas as seções: sem censo ≠ 0% de prova;
//     sem tráfego ≠ 0% de ponto cego; sem aresta observada ≠ nada executa;
//   • todo número fecha com sua procedência (endpoint + run).
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import {
  DecisionView,
  BlindHeadlineCard,
  CensusCard,
  HotPathsCard,
  TrendCard,
  type DecisionGraphPayload,
  type QueryLike,
} from "./decision";
import type { EvidenceHealthPayload } from "./decision-health";
import type { BimrPayload } from "./system-map-blind";
import type { EvidenceHistoryPayload } from "./system-map-trend";

afterEach(cleanup);

const ok = <T,>(data: T): QueryLike<T> => ({ data, isLoading: false, isError: false, error: null });
const failed = <T,>(msg = "500: boom"): QueryLike<T> => ({ isLoading: false, isError: true, error: new Error(msg) });
const loading = <T,>(): QueryLike<T> => ({ isLoading: true, isError: false, error: null });

// ── Fixtures: números reais do projeto 27 (easynup) ───────────────────
const health: EvidenceHealthPayload = {
  projectId: 27,
  generatedAt: "2026-08-08T14:20:00.000Z",
  static: { status: "fresh", stale: false, ageHours: 3 },
  config: { status: "fresh", stale: false, ageHours: 5 },
  runtime: { status: "fresh", stale: false, ageHours: 0.5 },
  analysis: { status: "fresh", stale: false, ageHours: 2, lastRunId: 102 },
  overall: "healthy",
};

const graph: DecisionGraphPayload = {
  projectId: 27,
  analysisRunId: 102,
  nodes: [
    { id: "ROUTE:/api/contracts", type: "ROUTE", className: "GET /api/contracts", inDegree: 0, outDegree: 2, runtimeHot: true },
    { id: "SERVICE:app.ContractService", type: "SERVICE", className: "ContractService", inDegree: 2, outDegree: 3, runtimeHot: true },
    { id: "ENTITY:app.Contract", type: "ENTITY", className: "Contract", inDegree: 5, outDegree: 0, runtimeHot: true },
  ],
  edges: [
    { fromNode: "ROUTE:/api/contracts", toNode: "SERVICE:app.ContractService", relationType: "RUNTIME_OBSERVED", count: 118, evidence: { method: "RUNTIME_OBSERVED", confidence: 0.95 } },
    { fromNode: "SERVICE:app.ContractService", toNode: "ENTITY:app.Contract", relationType: "READS_ENTITY", count: 42, evidence: { method: "RUNTIME_OBSERVED", confidence: 0.95 } },
    { fromNode: "SERVICE:app.ContractService", toNode: "ENTITY:app.Contract", relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.8 } },
  ],
  coverage: {
    edges: {
      byMethod: { RUNTIME_OBSERVED: 743, STATIC_PROVEN: 3085, CONFIG_PROVEN: 22, UNKNOWN: 150 },
      total: 4000,
      observedRatio: 0.185,
    },
    nodes: { observed: 120, total: 900 },
  },
};

const bimr: BimrPayload = {
  projectId: 27,
  analysisRunId: 102,
  available: true,
  measurable: true,
  tablesObservedRuntime: 40,
  tablesResolvedStatic: 36,
  tablesMintedRuntimeOnly: 4,
  mintedRatio: 0.105,
  mintedRatioExcludingInfrastructure: 0.105,
  minted: [{ id: "t1", table: "contract_audit", runtimeCount: 12, likelyInfrastructure: false }],
};

const historyPoint = (runId: number, staticProven: number, unknown: number) => ({
  runId,
  completedAt: `2026-08-0${runId}T01:00:00.000Z`,
  coverage: {
    edges: {
      total: 4000,
      byMethod: { RUNTIME_OBSERVED: 700 + runId, STATIC_PROVEN: staticProven, CONFIG_PROVEN: 22, UNKNOWN: unknown },
      observedRatio: 0.175,
    },
    nodes: { observed: 100, total: 900 },
  },
  bimr: { measurable: true, observed: 40, resolved: 36, minted: 4, mintedRatio: 0.1, mintedRatioExcludingInfrastructure: 0.1 },
});

const history: EvidenceHistoryPayload = {
  projectId: 27,
  count: 2,
  points: [historyPoint(1, 3000, 278), historyPoint(8, 3085, 185)],
};

const allGood = () => (
  <DecisionView health={ok(health)} graph={ok(graph)} bimr={ok(bimr)} history={ok(history)} projectId={27} />
);

// ── 1. Tudo saudável: as quatro respostas em uma tela ─────────────────
describe("DecisionView — tudo saudável", () => {
  it("responde as quatro perguntas e o slot do Tribunal fica declarado", () => {
    render(allGood());

    // saúde: verde, sem contaminar o resto
    expect(screen.getByTestId("health-banner-healthy")).toBeInTheDocument();
    expect(screen.queryByTestId("health-suspect-warning")).toBeNull();

    // ponto cego
    expect(screen.getByTestId("decision-blind-pct")).toHaveTextContent("11%"); // 0.105 → 11%
    expect(screen.getByTestId("decision-blind-headline")).toHaveTextContent(/4 de 40 tabelas/);

    // censo: provado = 743+3085+22 = 3850 de 4000 → 96%
    expect(screen.getByTestId("decision-census-proven-pct")).toHaveTextContent("96%");
    expect(screen.getByTestId("decision-census-row-STATIC_PROVEN")).toHaveTextContent("3.085");

    // tendência: 93% → 95% = +2 pp (proven 3723 → 3815 de 4000)
    expect(screen.getByTestId("decision-trend-delta")).toHaveTextContent("+2 pp");

    // arestas quentes, ordenadas por nº de traços
    expect(screen.getByTestId("decision-hotpath-0")).toHaveTextContent("×118");
    expect(screen.getByTestId("decision-hotpath-1")).toHaveTextContent("×42");
    expect(screen.queryByTestId("decision-hotpath-2")).toBeNull(); // a estática não entra

    // Tribunal: declarado, não fingido
    expect(screen.getByTestId("decision-tribunal-pending")).toHaveTextContent(/integração pendente/);
    expect(screen.getByTestId("decision-tribunal-contract")).toBeInTheDocument();
  });

  it("todo número fecha com sua procedência (endpoint + run)", () => {
    render(allGood());
    expect(screen.getByTestId("decision-blind-source")).toHaveTextContent("fonte: /bimr · run #102");
    expect(screen.getByTestId("decision-census-source")).toHaveTextContent("fonte: /graph · run #102");
    expect(screen.getByTestId("decision-hotpaths-source")).toHaveTextContent("fonte: /graph · run #102");
    expect(screen.getByTestId("decision-trend-source")).toHaveTextContent("fonte: /evidence-history · 2 run(s) medido(s)");
    expect(screen.getByTestId("health-source")).toHaveTextContent("fonte: /evidence-health");
  });

  it("o link do ponto cego leva à lista, na vista Provas do projeto certo", () => {
    render(allGood());
    expect(screen.getByTestId("decision-blind-link")).toHaveAttribute("href", "/system-map?view=proofs&project=27");
  });
});

// ── 2. Saúde ruim contamina a leitura ─────────────────────────────────
describe("DecisionView — saúde ruim", () => {
  it("starving muda o banner E avisa que o resto está suspeito", () => {
    render(
      <DecisionView
        health={ok({ ...health, overall: "starving" as const })}
        graph={ok(graph)}
        bimr={ok(bimr)}
        history={ok(history)}
      />,
    );
    expect(screen.getByTestId("health-banner-starving")).toBeInTheDocument();
    expect(screen.getByTestId("health-suspect-warning")).toHaveTextContent(/último retrato/);
    // ...e os números seguem visíveis (não são apagados — são qualificados)
    expect(screen.getByTestId("decision-census-proven-pct")).toHaveTextContent("96%");
  });

  it("saúde que FALHOU não vira saúde boa — vira 'não sabemos', com suspeita", () => {
    render(
      <DecisionView health={failed<EvidenceHealthPayload>()} graph={ok(graph)} bimr={ok(bimr)} history={ok(history)} />,
    );
    expect(screen.getByTestId("health-banner-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("health-suspect-warning")).toBeInTheDocument();
    expect(screen.queryByTestId("health-banner-healthy")).toBeNull();
  });
});

// ── 3. Degradação ISOLADA: um card cai, a página segue ────────────────
describe("DecisionView — degradação isolada", () => {
  it("BIMR falho não derruba censo, tendência nem arestas quentes", () => {
    render(
      <DecisionView health={ok(health)} graph={ok(graph)} bimr={failed<BimrPayload>("503: bimr fora")} history={ok(history)} />,
    );
    expect(screen.getByTestId("decision-blind-error")).toHaveTextContent("503: bimr fora");
    // a falha diz o que NÃO significa
    expect(screen.getByTestId("decision-blind-error")).toHaveTextContent(/não.*quer dizer que não há pontos cegos/i);
    expect(screen.queryByTestId("decision-blind-pct")).toBeNull();

    // vizinhos intactos
    expect(screen.getByTestId("decision-census-proven-pct")).toHaveTextContent("96%");
    expect(screen.getByTestId("decision-trend-delta")).toHaveTextContent("+2 pp");
    expect(screen.getByTestId("decision-hotpath-0")).toBeInTheDocument();
  });

  it("/graph falho derruba SÓ os dois cards que dependem dele", () => {
    render(
      <DecisionView health={ok(health)} graph={failed<DecisionGraphPayload>()} bimr={ok(bimr)} history={ok(history)} />,
    );
    expect(screen.getByTestId("decision-census-error")).toBeInTheDocument();
    expect(screen.getByTestId("decision-hotpaths-error")).toBeInTheDocument();
    expect(screen.getByTestId("decision-blind-pct")).toHaveTextContent("11%");
    expect(screen.getByTestId("decision-trend-delta")).toHaveTextContent("+2 pp");
  });

  it("carregando ≠ vazio ≠ falhou, por seção", () => {
    render(
      <DecisionView health={ok(health)} graph={loading<DecisionGraphPayload>()} bimr={ok(bimr)} history={ok(history)} />,
    );
    expect(screen.getByTestId("decision-census-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("decision-census-empty")).toBeNull();
    expect(screen.queryByTestId("decision-census-error")).toBeNull();
  });
});

// ── 4. Zero fabricado é proibido ──────────────────────────────────────
describe("zero fabricado — cada seção admite o que não sabe", () => {
  it("sem censo: 'ausência de censo', jamais 0% de prova", () => {
    render(<CensusCard query={ok({ ...graph, coverage: null })} />);
    expect(screen.getByTestId("decision-census-empty")).toHaveTextContent(/não é 0% de prova/i);
    expect(screen.queryByTestId("decision-census-proven-pct")).toBeNull();
  });

  it("sem tabela invisível, o link para a lista SOME (não manda para tela vazia)", () => {
    render(<BlindHeadlineCard query={ok({ ...bimr, tablesMintedRuntimeOnly: 0, minted: [] })} projectId={27} />);
    expect(screen.queryByTestId("decision-blind-link")).toBeNull();
    expect(screen.getByTestId("decision-blind-headline")).toHaveTextContent(/Todas as 40 tabelas/);
  });

  it("BIMR sem tráfego: 'não medido', sem número grande de ponto cego", () => {
    render(
      <BlindHeadlineCard
        query={ok({ available: true, measurable: false, tablesObservedRuntime: 0 } as BimrPayload)}
      />,
    );
    expect(screen.queryByTestId("decision-blind-pct")).toBeNull();
    expect(screen.getByTestId("decision-blind-sub")).toHaveTextContent(/não-medido/);
    expect(screen.queryByTestId("decision-blind-link")).toBeNull();
  });

  it("com eixo de prova mas sem aresta observada: 'zero de observação', não zero de execução", () => {
    const semRuntime: DecisionGraphPayload = {
      ...graph,
      edges: [{ fromNode: "a", toNode: "b", relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.8 } }],
    };
    render(<HotPathsCard query={ok(semRuntime)} />);
    expect(screen.getByTestId("decision-hotpaths-empty")).toHaveTextContent(/zero de observação/);
  });

  it("sem eixo de proveniência: diz que não dá para saber (texto diferente do acima)", () => {
    const semEvidencia: DecisionGraphPayload = {
      ...graph,
      edges: [{ fromNode: "a", toNode: "b", relationType: "CALLS" }],
    };
    render(<HotPathsCard query={ok(semEvidencia)} />);
    const el = screen.getByTestId("decision-hotpaths-empty");
    expect(el).toHaveTextContent(/não traz o eixo de proveniência/);
    expect(el).not.toHaveTextContent(/zero de observação/);
  });

  it("um só run medido não vira tendência de 0 pp", () => {
    render(<TrendCard query={ok({ projectId: 27, count: 1, points: [historyPoint(1, 3000, 278)] })} />);
    expect(screen.queryByTestId("decision-trend-delta")).toBeNull();
    expect(screen.getByTestId("decision-trend-headline")).toHaveTextContent(/começa a acumular/);
  });

  it("aresta observada sem contagem mostra 'sem contagem', não ×0", () => {
    const semContagem: DecisionGraphPayload = {
      ...graph,
      edges: [{ fromNode: "a", toNode: "b", relationType: "RUNTIME_OBSERVED", evidence: { method: "RUNTIME_OBSERVED", confidence: 0.95 } }],
    };
    render(<HotPathsCard query={ok(semContagem)} />);
    const row = within(screen.getByTestId("decision-hotpath-0"));
    expect(row.getByText("sem contagem")).toBeInTheDocument();
  });
});

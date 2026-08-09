// ─────────────────────────────────────────────────────────────────────────
// O que estes testes protegem: a HONESTIDADE e a ORDEM da série temporal.
//
// A série existe para responder "o mapa está mais confirmado que há 30 dias?".
// Duas classes de bug a matariam em silêncio, e ambas têm teste dedicado aqui:
//
//   • FABRICAR MEDIDA — run antigo (anterior ao registro do resumo) virar um
//     zero no gráfico. Zero é uma afirmação ("não havia prova"); ausência de
//     medida é outra ("não sabemos"). Confundir as duas inventa uma subida que
//     nunca houve.
//   • ERRAR O RECORTE/ORDEM — cortar os N mais ANTIGOS em vez dos N mais
//     RECENTES (gráfico congelado no passado), ou servir fora de ordem
//     cronológica (linha do tempo embaralhada). Os dois passam despercebidos
//     numa inspeção visual de payload; aqui falham.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HISTORY_POINTS,
  MAX_HISTORY_POINTS,
  buildEvidenceHistory,
  evidenceFromDiagnostics,
  historyPoint,
  overlayFromDiagnostics,
  resolveLimit,
  summarizeRunEvidence,
  type AnalysisRunLike,
} from "../../server/analyzers/evidence-history";

// ── fixtures ──────────────────────────────────────────────────────────
// Números do projeto 27 (run 104) para o resumo ficar reconhecível.
const coverage = {
  edges: {
    total: 3850,
    byMethod: { RUNTIME_OBSERVED: 743, STATIC_PROVEN: 3085, CONFIG_PROVEN: 22, STATIC_UNRESOLVED: 0 },
    observedRatio: 0.193,
  },
  nodes: { observed: 120, total: 900 },
};

const bimr = {
  measurable: true,
  tablesObservedRuntime: 40,
  tablesResolvedStatic: 31,
  tablesMintedRuntimeOnly: 9,
  mintedRatio: 0.225,
  mintedRatioExcludingInfrastructure: 0.1,
  observedExcludingInfrastructure: 36,
  minted: [{ id: "table:databasechangelog", table: "databasechangelog" }],
  resolved: [{ id: "e1" }],
  entitiesHotWithoutStaticInbound: { count: 2, nodes: [] },
  caveats: ["janela de 1h"],
};

const calibration = {
  calibrated: true,
  hasRuntimeGroundTruth: true,
  runtimeOracleSize: 90,
  oracleComparablePairs: 57,
  confirmableStaticByMethod: { STATIC_PROVEN: 800 },
  byMethod: {},
  effectiveConfidenceByMethod: {},
  completeness: {},
  completenessApplicable: false,
  methodOverlapShare: 0.12,
  confidenceLevelPct: 95,
  completenessLevelPct: 95,
};

const overlay = {
  status: "ran",
  jaegerUrl: "http://jaeger:16686",
  services: ["easynup-gateway"],
  lookbackMs: 3600000,
  traces: 512,
  dbSpanHits: 4000,
  routePairs: 61,
  routeEntityEdges: 40,
  routeJavaEdges: 12,
  serviceEntityEdges: 57,
  tablesObserved: 40,
  entitiesResolved: 31,
  tablesMinted: 9,
  entityNodesMarked: 31,
  tableEntityEdges: 88,
  fetchReport: [{ service: "easynup-gateway", status: 200 }],
};

/** diagnóstico como o pipeline o grava (resumo + overlay). */
function diagnostics(extra: Record<string, unknown> = {}) {
  return { files: 900, overlay, evidence: summarizeRunEvidence({ coverage, bimr, calibration }), ...extra };
}

function run(id: number, over: Partial<AnalysisRunLike> = {}): AnalysisRunLike {
  return {
    id,
    status: "completed",
    startedAt: new Date(Date.UTC(2026, 7, id)),
    completedAt: new Date(Date.UTC(2026, 7, id, 1)),
    diagnostics: diagnostics(),
    ...over,
  };
}

const deps = (runs: AnalysisRunLike[], project: unknown = { id: 27 }) => ({
  getProject: async () => project,
  getAnalysisRuns: async () => runs,
});

// ── compressão do resumo ──────────────────────────────────────────────
describe("evidence-history — summarizeRunEvidence", () => {
  it("comprime censo + BIMR + calibração no formato durável", () => {
    const s = summarizeRunEvidence({ coverage, bimr, calibration })!;
    assert.equal(s.v, 1);
    assert.equal(s.coverage.edges.total, 3850);
    assert.equal(s.coverage.edges.byMethod.RUNTIME_OBSERVED, 743);
    assert.equal(s.coverage.nodes.observed, 120);
    assert.equal(s.bimr!.observed, 40);
    assert.equal(s.bimr!.minted, 9);
    assert.equal(s.calibration!.comparablePairs, 57);
  });

  it("NÃO carrega as listas grandes — o resumo é gravado a cada run", () => {
    const s = summarizeRunEvidence({ coverage, bimr, calibration })!;
    // se `minted[]`/`resolved[]`/`completeness` vazarem, cada run engorda o
    // diagnostics com o grafo inteiro e a tabela vira um depósito.
    assert.deepEqual(Object.keys(s.bimr!).sort(), [
      "measurable",
      "minted",
      "mintedRatio",
      "mintedRatioExcludingInfrastructure",
      "observed",
      "resolved",
    ]);
    assert.equal(typeof s.bimr!.minted, "number", "minted é CONTAGEM, não a lista");
    assert.equal(typeof s.bimr!.resolved, "number", "resolved é CONTAGEM, não a lista");
    assert.deepEqual(Object.keys(s.calibration!).sort(), ["calibrated", "comparablePairs"]);
  });

  it("sem censo de arestas → null (não fabrica ponto)", () => {
    assert.equal(summarizeRunEvidence({ coverage: null }), null);
    assert.equal(summarizeRunEvidence({ coverage: {} }), null);
    assert.equal(summarizeRunEvidence({ coverage: { edges: {} } }), null);
  });

  it("BIMR/calibração ausentes viram null — nunca zero", () => {
    const s = summarizeRunEvidence({ coverage })!;
    assert.equal(s.bimr, null, "sem BIMR é 'não medido', não '0 pontos cegos'");
    assert.equal(s.calibration, null);
  });

  it("entrada corrompida não lança e descarta o lixo", () => {
    const s = summarizeRunEvidence({
      coverage: { edges: { total: 10, byMethod: { A: 3, B: "muitas", C: null } }, nodes: null },
    })!;
    assert.deepEqual(s.coverage.edges.byMethod, { A: 3 });
    assert.equal(s.coverage.nodes.total, 0);
  });

  it("preserva o motivo da abstenção da calibração", () => {
    const s = summarizeRunEvidence({
      coverage,
      calibration: { calibrated: false, reason: "sem oráculo comparável", oracleComparablePairs: 0 },
    })!;
    assert.equal(s.calibration!.calibrated, false);
    assert.equal(s.calibration!.reason, "sem oráculo comparável");
  });
});

// ── leitura do diagnóstico ────────────────────────────────────────────
describe("evidence-history — leitura do diagnóstico durável", () => {
  it("extrai os contadores do overlay sem vazar infra (jaegerUrl/fetchReport)", () => {
    const o = overlayFromDiagnostics(diagnostics())!;
    assert.equal(o.traces, 512);
    assert.equal(o.routePairs, 61);
    assert.equal(o.serviceEntityEdges, 57);
    assert.equal(o.tableEntityEdges, 88);
    assert.equal(o.tablesObserved, 40);
    assert.equal(o.entitiesResolved, 31);
    assert.deepEqual(
      Object.keys(o).sort(),
      ["entitiesResolved", "routePairs", "serviceEntityEdges", "status", "tableEntityEdges", "tablesObserved", "traces"],
      "endereço do Jaeger e relatório de fetch não são dado de gráfico",
    );
  });

  it("overlay OFF é preservado como off — não vira 'rodou e viu zero'", () => {
    const o = overlayFromDiagnostics({ overlay: { status: "off", reason: "sem jaegerUrl" } })!;
    assert.equal(o.status, "off");
    assert.equal(o.traces, null, "gate desligado é AUSÊNCIA de medida, não medida zero");
  });

  it("diagnóstico ausente/sem overlay → null", () => {
    assert.equal(overlayFromDiagnostics(undefined), null);
    assert.equal(overlayFromDiagnostics({ files: 3 }), null);
    assert.equal(evidenceFromDiagnostics({ files: 3 }), null);
  });
});

// ── um run vira um ponto ──────────────────────────────────────────────
describe("evidence-history — historyPoint", () => {
  it("run completo vira ponto medido", () => {
    const p = historyPoint(run(4));
    assert.equal(p.runId, 4);
    assert.equal(p.coverage!.edges.byMethod.STATIC_PROVEN, 3085);
    assert.equal(p.failed, undefined);
    assert.equal(p.completedAt, "2026-08-04T01:00:00.000Z");
  });

  it("run FALHO entra na série marcado — a falha é parte da história", () => {
    const p = historyPoint(run(5, { status: "failed", diagnostics: { failure: { message: "fetch failed" } } }));
    assert.equal(p.failed, true);
    assert.equal(p.coverage, null);
  });

  it("run ANTERIOR ao registro → coverage null, jamais zero", () => {
    const p = historyPoint(run(6, { diagnostics: { files: 900, overlay } }));
    assert.equal(p.coverage, null, "sem resumo gravado o ponto é 'não sabemos'");
    assert.equal(p.bimr, null);
    assert.ok(p.overlay, "o overlay antigo, esse sim, existe e é aproveitado");
  });

  it("diagnóstico corrompido não derruba o ponto", () => {
    const p = historyPoint(run(7, { diagnostics: { evidence: "isto era pra ser um objeto" } }));
    assert.equal(p.coverage, null);
    assert.equal(p.runId, 7);
  });

  // O ponto carrega QUAL commit ele mediu — é o que transforma "a cobertura
  // caiu" em "a cobertura caiu neste commit".
  it("ponto carrega o gitSha carimbado no run", () => {
    const sha = "9f2c1ab34d5e6f708192a3b4c5d6e7f809a1b2c3";
    const p = historyPoint(run(8, { diagnostics: { files: 900, gitSha: sha.toUpperCase() } }));
    assert.equal(p.gitSha, sha, "normalizado, para comparar sem depender de caixa");
  });

  it("run sem carimbo (ou com lixo) → gitSha null, nunca aproximado", () => {
    assert.equal(historyPoint(run(9)).gitSha, null);
    assert.equal(historyPoint(run(10, { diagnostics: { gitSha: "9f2c1ab" } })).gitSha, null);
    assert.equal(historyPoint(run(11, { diagnostics: "lixo" })).gitSha, null);
  });
});

// ── limite ────────────────────────────────────────────────────────────
describe("evidence-history — resolveLimit", () => {
  it("default 90; teto 365; entrada inútil cai no default", () => {
    assert.equal(resolveLimit(undefined), DEFAULT_HISTORY_POINTS);
    assert.equal(resolveLimit("30"), 30);
    assert.equal(resolveLimit("99999"), MAX_HISTORY_POINTS);
    assert.equal(resolveLimit("-5"), DEFAULT_HISTORY_POINTS);
    assert.equal(resolveLimit("abc"), DEFAULT_HISTORY_POINTS);
    assert.equal(resolveLimit("0"), DEFAULT_HISTORY_POINTS);
  });
});

// ── série (fim a fim, com deps injetadas) ─────────────────────────────
describe("evidence-history — buildEvidenceHistory (fim a fim)", () => {
  it("projeto inexistente → null (a rota traduz em 404)", async () => {
    assert.equal(await buildEvidenceHistory(27, deps([], null)), null);
  });

  it("serve em ordem CRONOLÓGICA (mais antigo → mais novo)", async () => {
    // storage devolve DESC (mais novo primeiro), como o Drizzle faz
    const h = (await buildEvidenceHistory(27, deps([run(9), run(8), run(7)])))!;
    assert.deepEqual(h.points.map((p) => p.runId), [7, 8, 9], "eixo X do gráfico não pode vir invertido");
  });

  it("o corte pega os N mais RECENTES — não os mais antigos", async () => {
    const desc = [run(9), run(8), run(7), run(6), run(5)]; // DESC
    const h = (await buildEvidenceHistory(27, deps(desc), { limit: 2 }))!;
    // inverter ANTES de cortar devolveria [5,6] e o gráfico congelaria no passado
    assert.deepEqual(h.points.map((p) => p.runId), [8, 9]);
    assert.equal(h.count, 2);
    assert.equal(h.limit, 2);
  });

  it("runs em voo (pending/analyzing) ficam de fora; falhos entram", async () => {
    const h = (await buildEvidenceHistory(
      27,
      deps([run(4, { status: "analyzing" }), run(3, { status: "failed" }), run(2, { status: "pending" }), run(1)]),
    ))!;
    assert.deepEqual(h.points.map((p) => p.runId), [1, 3]);
    assert.equal(h.points[1].failed, true);
  });

  it("recordedFrom aponta o 1º run COM censo, não o 1º run", async () => {
    const antigo = run(1, { diagnostics: { files: 1 } }); // pré-registro
    const h = (await buildEvidenceHistory(27, deps([run(2), antigo])))!;
    assert.equal(h.points[0].coverage, null);
    assert.equal(h.recordedFrom, "2026-08-02T01:00:00.000Z", "a série 'começa' quando passou a ser medida");
  });

  it("sem histórico → 200 com série vazia (vazio ≠ falhou)", async () => {
    const h = (await buildEvidenceHistory(27, deps([])))!;
    assert.deepEqual(h.points, []);
    assert.equal(h.count, 0);
    assert.equal(h.recordedFrom, null);
  });

  it("storage de runs quebrado → série vazia, sem lançar (fail-soft)", async () => {
    const h = (await buildEvidenceHistory(27, {
      getProject: async () => ({ id: 27 }),
      getAnalysisRuns: async () => {
        throw new Error("db down");
      },
    }))!;
    assert.equal(h.count, 0);
    assert.equal(h.projectId, 27);
  });

  it("consulta os runs DO projeto pedido", async () => {
    const seen: number[] = [];
    await buildEvidenceHistory(42, {
      getProject: async () => ({ id: 42 }),
      getAnalysisRuns: async (id) => {
        seen.push(id);
        return [];
      },
    });
    assert.deepEqual(seen, [42]);
  });

  it("default de 90 pontos quando o limite não é informado", async () => {
    const many = Array.from({ length: 120 }, (_, i) => run(120 - i)); // DESC
    const h = (await buildEvidenceHistory(27, deps(many)))!;
    assert.equal(h.count, DEFAULT_HISTORY_POINTS);
    assert.equal(h.points[h.points.length - 1].runId, 120, "o mais novo é sempre o último ponto");
  });
});

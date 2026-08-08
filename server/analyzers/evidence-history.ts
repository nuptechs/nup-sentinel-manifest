// ─────────────────────────────────────────────────────────────────────────
// Evidence-History — a dimensão TEMPO do mapa epistêmico.
//
// Tudo que o mapa serve hoje é FOTOGRAFIA: "o projeto 27 tem RUNTIME=743,
// STATIC=3085, CONFIG=22". A pergunta que fotografia nenhuma responde é a que
// vende o produto: **"o mapa está mais confirmado que há 30 dias?"**. Série
// histórica é o que nenhum agente lendo código produz — ele lê o presente.
//
// ─── §POR QUE NÃO RECOMPUTAR DO SNAPSHOT (a decisão de fonte) ───────────────
// A tentação óbvia é derivar o histórico na leitura: cada run tem seu snapshot
// (`analysis_snapshots`, nunca podados), então bastaria rodar `shapeSystemGraph`
// em cada um. Isso é ERRADO por dois motivos, o segundo fatal:
//
//   1) CUSTO — o manifesto de cada run traz o grafo inteiro; 90 runs seriam 90
//      leituras multi-MB + 90 shapes por request de gráfico.
//   2) ANACRONISMO (o fatal) — as evidências externas provadas NÃO moram no
//      snapshot: `applyPersistedOverlays` (graph-overlays.ts:48,60) mescla, NA
//      LEITURA, o `project.scipEdges` e o `project.configEdges` — o estado de
//      HOJE. Recomputar o passado com o overlay de hoje pintaria todo run
//      antigo com os 3085 STATIC_PROVEN atuais: a série sairia CHAPADA e diria
//      "sempre estivemos assim". Seria fabricar exatamente a tendência que o
//      endpoint existe para medir.
//
// Por isso a fonte é o que foi **gravado no instante do run**: o pipeline
// persiste um resumo compacto em `analysis_runs.diagnostics.evidence`
// (`summarizeRunEvidence`), com os overlays como estavam naquele momento.
//
// ─── §HONESTIDADE CRAVADA ───────────────────────────────────────────────────
// • Run anterior a este registro não tem o campo ⇒ `coverage: null`. A tela
//   mostra "o histórico começa aqui", NUNCA um zero inventado. Ausência de
//   medida jamais vira medida.
// • Run FALHO entra na série com `failed: true` — a falha é parte da história
//   (um buraco no gráfico é informação: naquele dia o pipeline quebrou).
// • Run em voo (pending/analyzing) não entra: ainda não é história.
// • `overlay.status` distingue "off" (gate desligado) de "ran com 0 traços" —
//   a mesma distinção vazio ≠ falhou que o resto do mapa respeita.
//
// Puro + injeção de dependência: sem express, sem storage, sem rede.
// ─────────────────────────────────────────────────────────────────────────

/** Teto de pontos por request (o `?limit=` é aparado a isto). */
export const MAX_HISTORY_POINTS = 365;
/** Nº de pontos servidos quando o request não pede `?limit=`. */
export const DEFAULT_HISTORY_POINTS = 90;

// ── o resumo COMPACTO gravado no run (formato durável) ────────────────

/** Censo de cobertura tal como o `/graph` o serve, sem as listas grandes. */
export interface EvidenceCoverageSummary {
  edges: { total: number; byMethod: Record<string, number>; observedRatio: number };
  nodes: { observed: number; total: number };
}

export interface EvidenceBimrSummary {
  measurable: boolean;
  observed: number;
  resolved: number;
  minted: number;
  mintedRatio: number;
  mintedRatioExcludingInfrastructure: number;
}

export interface EvidenceCalibrationSummary {
  calibrated: boolean;
  comparablePairs: number;
  reason?: string;
}

/**
 * O que fica em `analysis_runs.diagnostics.evidence`. Deliberadamente SEM as
 * listas (minted[]/resolved[]/byMethod CIs/completeness): isto é gravado a cada
 * run e o gráfico só precisa dos contadores. Resumo pequeno = histórico barato.
 */
export interface EvidenceRunSummary {
  /** versão do formato — deixa evoluir sem quebrar leitor antigo. */
  v: 1;
  coverage: EvidenceCoverageSummary;
  bimr: EvidenceBimrSummary | null;
  calibration: EvidenceCalibrationSummary | null;
}

// ── o ponto servido pelo endpoint ─────────────────────────────────────

export interface EvidenceOverlayPoint {
  /** "ran" | "off" | "error" — off ≠ rodou-e-viu-zero. */
  status: string;
  traces: number | null;
  routePairs: number | null;
  tableEntityEdges: number | null;
  serviceEntityEdges: number | null;
  tablesObserved: number | null;
  entitiesResolved: number | null;
}

export interface EvidenceHistoryPoint {
  runId: number;
  startedAt: string | null;
  completedAt: string | null;
  /** presente só quando o run falhou (a falha é parte da história). */
  failed?: true;
  /** `null` = run anterior ao registro do resumo (nunca fabricar zero). */
  coverage: EvidenceCoverageSummary | null;
  overlay: EvidenceOverlayPoint | null;
  bimr: EvidenceBimrSummary | null;
  calibration: EvidenceCalibrationSummary | null;
}

export interface EvidenceHistory {
  projectId: number;
  /** nº de pontos devolvidos. */
  count: number;
  /** teto efetivamente aplicado nesta resposta. */
  limit: number;
  /**
   * `completedAt` do 1º ponto que TEM censo — quando a série passou a ser
   * medida de verdade. `null` enquanto nenhum run gravou resumo.
   */
  recordedFrom: string | null;
  /** cronológico: mais antigo → mais novo (o eixo X do gráfico). */
  points: EvidenceHistoryPoint[];
}

// ── entrada (o mínimo do storage, sem acoplar ao Drizzle) ─────────────

export interface AnalysisRunLike {
  id: number;
  status?: string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  diagnostics?: unknown;
}

export interface EvidenceHistoryDeps {
  getProject: (id: number) => Promise<unknown>;
  getAnalysisRuns: (id: number) => Promise<AnalysisRunLike[]>;
}

// ── helpers puros ─────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Comprime o censo/bimr/calibração do instante do run no resumo durável.
 * Chamado PELO PIPELINE (nunca na leitura) — ver §POR QUE NÃO RECOMPUTAR.
 * Tolerante a entrada parcial: o que faltar vira `null`, nunca lança.
 */
export function summarizeRunEvidence(input: {
  coverage: unknown;
  bimr?: unknown;
  calibration?: unknown;
}): EvidenceRunSummary | null {
  const cov = obj(input.coverage);
  const edges = obj(cov?.edges);
  const nodes = obj(cov?.nodes);
  const total = num(edges?.total);
  // sem censo de arestas não há ponto a gravar (não inventa zero)
  if (total == null) return null;

  const byMethodRaw = obj(edges?.byMethod) ?? {};
  const byMethod: Record<string, number> = {};
  for (const [k, v] of Object.entries(byMethodRaw)) {
    const n = num(v);
    if (n != null) byMethod[k] = n;
  }

  const b = obj(input.bimr);
  const bimr: EvidenceBimrSummary | null = b
    ? {
        measurable: !!b.measurable,
        observed: num(b.tablesObservedRuntime) ?? 0,
        resolved: num(b.tablesResolvedStatic) ?? 0,
        minted: num(b.tablesMintedRuntimeOnly) ?? 0,
        mintedRatio: num(b.mintedRatio) ?? 0,
        mintedRatioExcludingInfrastructure: num(b.mintedRatioExcludingInfrastructure) ?? 0,
      }
    : null;

  const c = obj(input.calibration);
  const calibration: EvidenceCalibrationSummary | null = c
    ? {
        calibrated: !!c.calibrated,
        comparablePairs: num(c.oracleComparablePairs) ?? 0,
        ...(typeof c.reason === "string" ? { reason: c.reason } : {}),
      }
    : null;

  return {
    v: 1,
    coverage: {
      edges: { total, byMethod, observedRatio: num(edges?.observedRatio) ?? 0 },
      nodes: { observed: num(nodes?.observed) ?? 0, total: num(nodes?.total) ?? 0 },
    },
    bimr,
    calibration,
  };
}

/** Lê o resumo gravado — ausente/malformado ⇒ `null` (run antigo, honesto). */
export function evidenceFromDiagnostics(diagnostics: unknown): EvidenceRunSummary | null {
  const d = obj(diagnostics);
  const e = obj(d?.evidence);
  if (!e) return null;
  // reaproveita o mesmo compressor: o gravado já está no formato, mas passar por
  // aqui blinda contra diagnóstico corrompido/parcial (fail-soft por ponto).
  return summarizeRunEvidence({ coverage: e.coverage, bimr: e.bimr, calibration: e.calibration });
}

/** Extrai os contadores do overlay de runtime do diagnóstico durável. */
export function overlayFromDiagnostics(diagnostics: unknown): EvidenceOverlayPoint | null {
  const d = obj(diagnostics);
  const o = obj(d?.overlay);
  if (!o) return null;
  return {
    status: typeof o.status === "string" ? o.status : "unknown",
    traces: num(o.traces),
    routePairs: num(o.routePairs),
    tableEntityEdges: num(o.tableEntityEdges),
    serviceEntityEdges: num(o.serviceEntityEdges),
    tablesObserved: num(o.tablesObserved),
    entitiesResolved: num(o.entitiesResolved),
  };
}

/** Um run vira um ponto. Nunca lança: diagnóstico ruim vira ponto com nulls. */
export function historyPoint(run: AnalysisRunLike): EvidenceHistoryPoint {
  const failed = run.status === "failed";
  const ev = evidenceFromDiagnostics(run.diagnostics);
  return {
    runId: run.id,
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    ...(failed ? { failed: true as const } : {}),
    coverage: ev?.coverage ?? null,
    overlay: overlayFromDiagnostics(run.diagnostics),
    bimr: ev?.bimr ?? null,
    calibration: ev?.calibration ?? null,
  };
}

/** `?limit=` → nº de pontos (default 90, teto 365, lixo cai no default). */
export function resolveLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HISTORY_POINTS;
  return Math.min(Math.trunc(n), MAX_HISTORY_POINTS);
}

/**
 * Monta a série. `null` quando o projeto não existe (a rota traduz em 404).
 * Runs em voo (pending/analyzing) ficam de fora — ainda não são história.
 */
export async function buildEvidenceHistory(
  projectId: number,
  deps: EvidenceHistoryDeps,
  opts: { limit?: number } = {},
): Promise<EvidenceHistory | null> {
  const project = await deps.getProject(projectId);
  if (!project) return null;

  const limit = opts.limit ?? DEFAULT_HISTORY_POINTS;

  let runs: AnalysisRunLike[] = [];
  try {
    runs = (await deps.getAnalysisRuns(projectId)) ?? [];
  } catch {
    // FAIL-SOFT: storage de runs quebrado devolve série VAZIA, não 500 — a tela
    // mostra "ainda não há histórico" em vez de um gráfico morto.
    runs = [];
  }

  const terminal = runs.filter((r) => r.status === "completed" || r.status === "failed");
  // `getAnalysisRuns` vem DESC (mais novo primeiro): corta os N mais RECENTES e
  // só então inverte para cronológico. Cortar depois de inverter daria os N mais
  // antigos — o gráfico congelaria no passado.
  const points = terminal.slice(0, limit).reverse().map(historyPoint);

  const firstMeasured = points.find((p) => p.coverage != null);
  return {
    projectId,
    count: points.length,
    limit,
    recordedFrom: firstMeasured?.completedAt ?? firstMeasured?.startedAt ?? null,
    points,
  };
}

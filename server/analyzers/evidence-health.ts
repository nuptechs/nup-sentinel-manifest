// ─────────────────────────────────────────────────────────────────────────
// Evidence-Health — freshness do pipeline de evidência (ADR-0028/0030/0035).
//
// A maior fraqueza OPERACIONAL do mapa epistêmico não é a precisão: é o
// pipeline morrer de fome EM SILÊNCIO. O caso real que motivou este módulo: o
// Gateway de um sistema caiu, o hub OTel parou de receber traços, o eixo
// RUNTIME_OBSERVED foi a 0 — e o `/graph` continuou respondendo 200, com um
// `observedRatio: 0` indistinguível de "nunca integrou o runtime". Nenhum
// alarme. Ninguém percebeu.
//
// O `coverage` do `/graph` responde "quanto do mapa é provado". Este módulo
// responde a pergunta ORTOGONAL: "a evidência ainda está CHEGANDO?".
//
// Fontes por eixo (todas já existentes — nenhuma migration):
//   static   → projects.scipEdges   {edges[], ingestedAt}   (POST /scip-edges)
//   config   → projects.configEdges {edges[], ingestedAt}   (POST /config-edges)
//   runtime  → traços do Jaeger, pelo MESMO caminho do runtime-overlay
//   analysis → analysisRuns (a análise que produz o systemGraph em que tudo
//              o mais é mesclado)
//
// A esses quatro soma-se um eixo ORTOGONAL aos demais — `drift` (ver
// evidence-drift.ts): os quatro dizem se a evidência ainda CHEGA; o drift diz
// se o que foi analisado é o BINÁRIO QUE RODA. Um mapa pode estar impecável e
// fresco descrevendo um commit que o ambiente já deixou para trás.
//
// ── Semântica dos estados (o que evita gritar lobo) ──────────────────────
//   fresh   — houve evidência dentro da janela
//   stale   — houve evidência, mas envelheceu além do limiar  ← O ALARME
//   absent  — NUNCA houve evidência deste eixo
//   unknown — não deu para determinar (Jaeger fora do ar, overlay desligado)
//
// `absent` é INFORMATIVO, não degradante: um projeto Node não tem wiring de
// Spring e nunca terá CONFIG_PROVEN — marcá-lo "degradado" para sempre
// treinaria todo mundo a ignorar o alarme. Degradação é o que ESTAVA fluindo e
// parou. `unknown` também não degrada: não se acusa falha sem saber.
//
// FAIL-SOFT ABSOLUTO: qualquer erro (rede, payload corrompido, storage) vira
// `unknown` num eixo. Este endpoint nunca lança e nunca derruba o server — um
// medidor de saúde que quebra o paciente é pior que nenhum medidor.
// ─────────────────────────────────────────────────────────────────────────
import {
  fetchRecentTraces,
  extractRuntimePairs,
  resolveRuntimeOverlayConfig,
  projectOverlayConfig,
  type JaegerTrace,
} from "./runtime-overlay";
import {
  analyzedRefFrom,
  driftHealthFrom,
  driftNotConfigured,
  healthUrlOf,
  probeDeployedSha,
  type DriftHealth,
} from "./evidence-drift";

export type AxisStatus = "fresh" | "stale" | "absent" | "unknown";
export type OverallHealth = "healthy" | "degraded" | "starving";

export interface EdgeAxisHealth {
  status: AxisStatus;
  /** conveniência: só `stale` é o alarme de decaimento. `absent`/`unknown` = false. */
  stale: boolean;
  lastPushAt: string | null;
  ageHours: number | null;
  edgeCount: number;
  thresholdHours: number;
  reason?: string;
}

export interface RuntimeAxisHealth {
  status: AxisStatus;
  stale: boolean;
  lastTraceSeenAt: string | null;
  ageHours: number | null;
  /** ≥1 traço ancorável em rota (span de entrada com rota + span de banco). */
  anchorableTraces: boolean;
  tracesConsidered: number;
  routesObserved: number;
  thresholdHours: number;
  reason?: string;
}

export interface AnalysisAxisHealth {
  status: AxisStatus;
  stale: boolean;
  lastRunId: number | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  ageHours: number | null;
  thresholdHours: number;
  reason?: string;
}

/** Quem pode ser acusado — os 4 eixos de freshness + a cobertura do binário. */
export type CulpritAxis = "static" | "config" | "runtime" | "analysis" | "drift";

/**
 * Uma causa RESOLVIDA PELO SERVIDOR para o veredito não ser `healthy`.
 *
 * Existia antes só no cliente, espelhando à mão as regras daqui
 * (`RUNTIME_DECLARED_BUT_EMPTY` duplicado em decision-health.tsx). Espelho é
 * dívida: no dia em que a regra do servidor mudar, a tela nomeia o culpado
 * errado — e alarme com endereço errado é pior que alarme sem endereço. Agora
 * a autoridade é uma só; o cliente traduz.
 */
export interface Culprit {
  axis: CulpritAxis;
  status: string;
  reason?: string;
}

export interface EvidenceHealth {
  projectId: number;
  generatedAt: string;
  static: EdgeAxisHealth;
  config: EdgeAxisHealth;
  runtime: RuntimeAxisHealth;
  analysis: AnalysisAxisHealth;
  /** o mapa cobre o binário que RODA? (ver evidence-drift.ts) */
  drift: DriftHealth;
  overall: OverallHealth;
  /** vazio quando `healthy`; nunca ausente (leitor não precisa adivinhar). */
  culprits: Culprit[];
}

// ─── Limiares (env-configuráveis, defaults sensatos) ───
// Índice estático/wiring: rodam no push a main — 7 dias sem push é plausível
// num repo calmo, mais que isso já indica CI quebrado.
// Runtime: traço é contínuo; 24 h sem nada é anomalia.
// Análise: 48 h — ela é o chão em que todo o resto é mesclado.
export const DEFAULT_THRESHOLDS = {
  staticHours: 168,
  configHours: 168,
  runtimeHours: 24,
  analysisHours: 48,
} as const;

export interface EvidenceThresholds {
  staticHours: number;
  configHours: number;
  runtimeHours: number;
  analysisHours: number;
}

function positiveNum(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve limiares do env; valor ausente/inválido cai no default (nunca lança). */
export function resolveThresholds(env: Record<string, string | undefined> = {}): EvidenceThresholds {
  return {
    staticHours: positiveNum(env.EVIDENCE_HEALTH_STATIC_STALE_HOURS, DEFAULT_THRESHOLDS.staticHours),
    configHours: positiveNum(env.EVIDENCE_HEALTH_CONFIG_STALE_HOURS, DEFAULT_THRESHOLDS.configHours),
    runtimeHours: positiveNum(env.EVIDENCE_HEALTH_RUNTIME_STALE_HOURS, DEFAULT_THRESHOLDS.runtimeHours),
    analysisHours: positiveNum(env.EVIDENCE_HEALTH_ANALYSIS_STALE_HOURS, DEFAULT_THRESHOLDS.analysisHours),
  };
}

const HOUR_MS = 3_600_000;

function ageHoursFrom(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / HOUR_MS);
}

// ─── Eixos de aresta (static / config) ───

/** Lê o store lateral de arestas defensivamente. PURA. */
export function edgeAxisHealth(
  store: unknown,
  thresholdHours: number,
  nowMs: number,
): EdgeAxisHealth {
  const base = { thresholdHours, edgeCount: 0, lastPushAt: null as string | null, ageHours: null as number | null };

  if (store === null || store === undefined) {
    return { ...base, status: "absent", stale: false, reason: "never-pushed" };
  }
  if (typeof store !== "object") {
    return { ...base, status: "unknown", stale: false, reason: "malformed-store" };
  }

  const s = store as Record<string, unknown>;
  const edgeCount = Array.isArray(s.edges) ? s.edges.length : 0;
  const lastPushAt = typeof s.ingestedAt === "string" ? s.ingestedAt : null;

  if (!lastPushAt) {
    // Payload sem carimbo (dado inserido à mão / de uma versão anterior do
    // endpoint): há arestas, mas não dá para dizer se envelheceram.
    return { ...base, edgeCount, status: "unknown", stale: false, reason: "no-timestamp" };
  }

  const ageHours = ageHoursFrom(lastPushAt, nowMs);
  if (ageHours === null) {
    return { ...base, edgeCount, lastPushAt, status: "unknown", stale: false, reason: "invalid-timestamp" };
  }
  const stale = ageHours > thresholdHours;
  return { thresholdHours, edgeCount, lastPushAt, ageHours, status: stale ? "stale" : "fresh", stale };
}

// ─── Eixo de análise ───

export interface AnalysisRunLike {
  id: number;
  status?: string | null;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  /** diagnóstico durável do run — de onde sai o `gitSha` do eixo de drift. */
  diagnostics?: unknown;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Saúde da última análise. PURA. Runs vêm ordenadas desc por `startedAt`. */
export function analysisAxisHealth(
  runs: AnalysisRunLike[] | null | undefined,
  thresholdHours: number,
  nowMs: number,
): AnalysisAxisHealth {
  const base = {
    thresholdHours,
    lastRunId: null as number | null,
    lastRunAt: null as string | null,
    lastRunStatus: null as string | null,
    ageHours: null as number | null,
  };
  if (!Array.isArray(runs) || runs.length === 0) {
    return { ...base, status: "absent", stale: false, reason: "never-analyzed" };
  }
  const last = runs[0];
  const lastRunAt = toIso(last.completedAt) ?? toIso(last.startedAt);
  const lastRunStatus = last.status ?? null;
  const ageHours = ageHoursFrom(lastRunAt, nowMs);

  if (ageHours === null) {
    return { ...base, lastRunId: last.id, lastRunStatus, status: "unknown", stale: false, reason: "invalid-timestamp" };
  }
  // Última análise que FALHOU é um alarme, por mais recente que seja: o
  // systemGraph em que tudo é mesclado ficou congelado no snapshot anterior.
  if (lastRunStatus && /^(failed|error)$/i.test(lastRunStatus)) {
    return {
      thresholdHours, lastRunId: last.id, lastRunAt, lastRunStatus, ageHours,
      status: "stale", stale: true, reason: "last-run-failed",
    };
  }
  const stale = ageHours > thresholdHours;
  return {
    thresholdHours, lastRunId: last.id, lastRunAt, lastRunStatus, ageHours,
    status: stale ? "stale" : "fresh", stale,
  };
}

// ─── Eixo de runtime (consulta o Jaeger) ───

export interface RuntimeProbeResult {
  traces: JaegerTrace[];
  /** true quando a consulta ao Jaeger falhou (rede/HTTP) — ≠ "não há traço". */
  unreachable: boolean;
}

/**
 * Consulta o Jaeger pelo MESMO caminho do runtime-overlay (`fetchRecentTraces`),
 * distinguindo "sem traço" de "não consegui perguntar". O `fetchRecentTraces`
 * engole erros e devolve `[]` — aqui capturamos os avisos que ele emite pelo
 * logger para separar os dois casos. Nunca lança.
 */
export async function probeJaeger(
  cfg: { jaegerUrl: string; apiKey: string | null; services: string[]; lookbackMs: number; limit: number },
  deps: { fetchFn?: typeof fetch; nowMs: number },
): Promise<RuntimeProbeResult> {
  let warned = false;
  try {
    const traces = await fetchRecentTraces({
      baseUrl: cfg.jaegerUrl,
      apiKey: cfg.apiKey,
      services: cfg.services,
      lookbackMs: cfg.lookbackMs,
      limit: cfg.limit,
      nowMs: deps.nowMs,
      fetchFn: deps.fetchFn,
      logger: { warn: () => { warned = true; } },
    });
    return { traces, unreachable: warned && traces.length === 0 };
  } catch {
    return { traces: [], unreachable: true };
  }
}

/** Maior `startTime` (µs) de qualquer span do lote, em ms. 0 se não houver. */
export function lastSpanMs(traces: JaegerTrace[]): number {
  let max = 0;
  for (const t of traces || []) {
    for (const s of t?.spans || []) {
      if (typeof s.startTime === "number" && Number.isFinite(s.startTime)) {
        max = Math.max(max, Math.round(s.startTime / 1000));
      }
    }
  }
  return max;
}

/**
 * Saúde do eixo runtime a partir de um lote de traços. PURA.
 *
 * "Ancorável" NÃO é reimplementado aqui: usa o `extractRuntimePairs` do próprio
 * overlay. É a única forma de a saúde não divergir do que o mapa de fato
 * consegue produzir — se o overlay muda a heurística, este medidor a acompanha.
 */
export function runtimeAxisHealthFrom(
  probe: RuntimeProbeResult,
  cfg: { gatewayServices: string[]; opPathPattern?: RegExp } | null,
  thresholdHours: number,
  nowMs: number,
): RuntimeAxisHealth {
  const base = {
    thresholdHours,
    lastTraceSeenAt: null as string | null,
    ageHours: null as number | null,
    anchorableTraces: false,
    tracesConsidered: 0,
    routesObserved: 0,
  };

  if (!cfg) {
    return { ...base, status: "unknown", stale: false, reason: "overlay-disabled" };
  }
  if (probe.unreachable) {
    return { ...base, status: "unknown", stale: false, reason: "jaeger-unreachable" };
  }

  const traces = probe.traces || [];
  if (traces.length === 0) {
    return { ...base, status: "absent", stale: false, reason: "no-traces" };
  }

  let pairs: ReturnType<typeof extractRuntimePairs> = [];
  try {
    pairs = extractRuntimePairs(traces, {
      gatewayServices: cfg.gatewayServices,
      opPathPattern: cfg.opPathPattern,
    });
  } catch {
    pairs = [];
  }

  const lastMs = lastSpanMs(traces);
  const lastTraceSeenAt = lastMs > 0 ? new Date(lastMs).toISOString() : null;
  const ageHours = lastMs > 0 ? Math.max(0, (nowMs - lastMs) / HOUR_MS) : null;
  const common = {
    thresholdHours,
    lastTraceSeenAt,
    ageHours,
    tracesConsidered: traces.length,
    routesObserved: pairs.length,
  };

  if (pairs.length === 0) {
    // Telemetria CHEGANDO mas nenhuma vira aresta: só job de background /
    // health-check, ou o serviço de fronteira fora do ar. Para o mapa, a
    // evidência é ausente — mas `tracesConsidered > 0` mostra que não é falta
    // de integração, e é isso que direciona o diagnóstico.
    return { ...common, anchorableTraces: false, status: "absent", stale: false, reason: "no-anchorable-traces" };
  }

  const stale = ageHours !== null && ageHours > thresholdHours;
  return { ...common, anchorableTraces: true, status: stale ? "stale" : "fresh", stale };
}

// ─── Veredito ───

/**
 * `starving` — NENHUM eixo está fresco: o mapa não é alimentado por nada.
 * `degraded` — algum eixo que fluía parou (`stale`), OU o runtime foi
 *              DECLARADO e não entrega evidência.
 * `healthy`  — o resto.
 *
 * ── Por que `absent` degrada no runtime e não nos demais ────────────────
 * `absent` é ausência de evidência, e ausência só é alarme quando alguém
 * DECLAROU que aquele eixo deveria fluir. Um projeto Node nunca terá wiring de
 * Spring: `config: absent` é permanente e normal — degradar por isso treinaria
 * todo mundo a ignorar o alarme. Já um projeto com `runtimeOverlay` configurado
 * declarou "aqui tem telemetria": zero traço (ou traço que não ancora em rota
 * nenhuma) é o pipeline configurado entregando nada — que é EXATAMENTE o caso
 * que motivou este módulo (serviço de fronteira cai, eixo runtime vai a 0, e o
 * `/graph` segue respondendo 200 sem alarme).
 *
 * Os dois `reason` abaixo só são produzidos quando o overlay está configurado —
 * sem config, o eixo vira `unknown/overlay-disabled` e nada é acusado.
 *
 * static/config não têm um sinal equivalente de declaração (o workflow vive no
 * repo do cliente), então `absent` ali segue informativo. Limite honesto: no
 * dia 0 de um projeto, "nunca integrou" e "quebrou antes do primeiro push" são
 * indistinguíveis do lado do Manifest.
 */
const RUNTIME_DECLARED_BUT_EMPTY = new Set(["no-traces", "no-anchorable-traces"]);

export interface HealthAxes {
  static: EdgeAxisHealth;
  config: EdgeAxisHealth;
  runtime: RuntimeAxisHealth;
  analysis: AnalysisAxisHealth;
  /** opcional: relatórios anteriores ao eixo de drift seguem computando igual. */
  drift?: DriftHealth | null;
}

/**
 * Quem causou a degradação. É a ÚNICA definição de "culpado" do sistema —
 * `computeOverall` deriva daqui, então veredito e lista nunca divergem.
 *
 * O drift só acusa quando as DUAS pontas foram medidas e discordam
 * (`status === "drift"`). `unknown` — health não configurado, fora do ar, run
 * sem carimbo — nunca entra: não saber se o mapa cobre o binário não é o mesmo
 * que saber que não cobre.
 */
export function computeCulprits(h: HealthAxes): Culprit[] {
  const out: Culprit[] = [];
  const axes = [
    ["static", h.static],
    ["config", h.config],
    ["runtime", h.runtime],
    ["analysis", h.analysis],
  ] as const;

  for (const [axis, a] of axes) {
    const declaredButEmpty = axis === "runtime" && !!a.reason && RUNTIME_DECLARED_BUT_EMPTY.has(a.reason);
    if (a.stale || declaredButEmpty) {
      out.push({ axis, status: a.status, ...(a.reason ? { reason: a.reason } : {}) });
    }
  }

  if (h.drift?.status === "drift") {
    out.push({ axis: "drift", status: "drift", reason: h.drift.reason ?? "sha-mismatch" });
  }
  return out;
}

/**
 * `starving` — NENHUM eixo de freshness está fresco: o mapa não é alimentado.
 * `degraded` — há culpado (eixo que parou, runtime declarado e vazio, ou o mapa
 *              descrevendo um commit que não é o do ar).
 * `healthy`  — o resto.
 *
 * Drift `unknown` NÃO piora o veredito, pela mesma razão que `jaeger-unreachable`
 * não piora: indisponibilidade da SONDA não é falha do projeto.
 */
export function computeOverall(h: HealthAxes): OverallHealth {
  const axes = [h.static, h.config, h.runtime, h.analysis];
  if (!axes.some((a) => a.status === "fresh")) return "starving";
  return computeCulprits(h).length > 0 ? "degraded" : "healthy";
}

// ─── Orquestrador ───

export interface ProjectLike {
  id: number;
  scipEdges?: unknown;
  configEdges?: unknown;
  conventionProfile?: unknown;
}

export interface EvidenceHealthDeps {
  getProject: (id: number) => Promise<ProjectLike | undefined | null>;
  getAnalysisRuns: (id: number) => Promise<AnalysisRunLike[]>;
  env?: Record<string, string | undefined>;
  nowMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Monta o relatório de saúde. Devolve `null` quando o projeto não existe (a
 * rota traduz em 404). Fail-soft por eixo: uma fonte quebrada vira `unknown`
 * naquele eixo, nunca uma exceção.
 */
export async function buildEvidenceHealth(
  projectId: number,
  deps: EvidenceHealthDeps,
): Promise<EvidenceHealth | null> {
  const nowMs = deps.nowMs ?? Date.now();
  const env = deps.env ?? {};
  const th = resolveThresholds(env);

  const project = await deps.getProject(projectId);
  if (!project) return null;

  const staticAxis = edgeAxisHealth(project.scipEdges ?? null, th.staticHours, nowMs);
  const configAxis = edgeAxisHealth(project.configEdges ?? null, th.configHours, nowMs);

  let runs: AnalysisRunLike[] = [];
  let runsFailed = false;
  let analysisAxis: AnalysisAxisHealth;
  try {
    runs = (await deps.getAnalysisRuns(projectId)) || [];
    analysisAxis = analysisAxisHealth(runs, th.analysisHours, nowMs);
  } catch {
    runsFailed = true;
    analysisAxis = {
      thresholdHours: th.analysisHours, lastRunId: null, lastRunAt: null, lastRunStatus: null,
      ageHours: null, status: "unknown", stale: false, reason: "storage-error",
    };
  }

  // Mesma cascata de config do overlay: projeto > env do processo > default.
  const cfg = resolveRuntimeOverlayConfig(projectOverlayConfig(project), env);
  let runtimeAxis: RuntimeAxisHealth;
  if (!cfg) {
    runtimeAxis = runtimeAxisHealthFrom({ traces: [], unreachable: false }, null, th.runtimeHours, nowMs);
  } else {
    const probe = await probeJaeger(cfg, { fetchFn: deps.fetchFn, nowMs });
    runtimeAxis = runtimeAxisHealthFrom(probe, cfg, th.runtimeHours, nowMs);
  }

  // Eixo de drift: reusa os MESMOS runs já lidos acima (nenhuma consulta extra).
  // `runs-unavailable` ≠ `no-analyzed-sha`: storage quebrado é "não perguntei",
  // ausência de carimbo é "perguntei e não há" — motivos diferentes apontam
  // consertos diferentes.
  const analyzedRef = runsFailed
    ? { sha: null, at: null, reason: "runs-unavailable" }
    : analyzedRefFrom(runs);
  const healthUrl = healthUrlOf(project);
  let driftAxis: DriftHealth;
  if (!healthUrl) {
    driftAxis = driftNotConfigured(analyzedRef);
  } else {
    const deployed = await probeDeployedSha(healthUrl, { fetchFn: deps.fetchFn });
    driftAxis = driftHealthFrom(analyzedRef, deployed);
  }

  const axes = {
    static: staticAxis,
    config: configAxis,
    runtime: runtimeAxis,
    analysis: analysisAxis,
    drift: driftAxis,
  };
  return {
    projectId,
    generatedAt: new Date(nowMs).toISOString(),
    ...axes,
    overall: computeOverall(axes),
    culprits: computeCulprits(axes),
  };
}

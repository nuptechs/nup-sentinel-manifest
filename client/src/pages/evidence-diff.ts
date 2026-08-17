// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Diff + Andon" (lógica PURA).
//
// Small multiples (NUNCA animação — consenso Archambault/Purchase): os 2
// últimos retratos VÁLIDOS lado a lado, com delta por método. Ponto com
// coverage:null ou failed é BURACO rotulado, jamais plotado como zero. O Andon
// junta as luzes que "confessam": culprits do evidence-health + drift +
// derivados honestos do próprio history (queda de observedRatio).
// ─────────────────────────────────────────────
import { EVIDENCE_ORDER, type EvidenceMethod } from "./system-map-evidence";

export interface HistoryPoint {
  runId: number;
  startedAt?: string;
  completedAt?: string;
  failed?: boolean;
  gitSha?: string | null;
  coverage?: {
    edges: { total: number; byMethod: Partial<Record<EvidenceMethod, number>>; observedRatio: number };
    nodes?: { observed: number; total: number };
  } | null;
  overlay?: { status?: "ran" | "off" | "error"; traces?: number } | null;
}
export interface EvidenceHistory {
  count?: number;
  points?: HistoryPoint[];
}

export interface Snapshot {
  runId: number;
  sha: string;
  date: string | null;
  total: number;
  byMethod: Partial<Record<EvidenceMethod, number>>;
  observedRatio: number;
}

/** Um "ponto válido" tem coverage não-nula e não falhou. */
export function isValidPoint(p: HistoryPoint | undefined | null): p is HistoryPoint {
  return !!p && p.failed !== true && !!p.coverage && typeof p.coverage.edges?.total === "number";
}

function toSnapshot(p: HistoryPoint): Snapshot {
  return {
    runId: p.runId,
    sha: (p.gitSha || "").slice(0, 7) || "—",
    date: p.completedAt || p.startedAt || null,
    total: p.coverage!.edges.total,
    byMethod: p.coverage!.edges.byMethod || {},
    observedRatio: p.coverage!.edges.observedRatio ?? 0,
  };
}

export interface DiffResult {
  previous: Snapshot | null;
  current: Snapshot | null;
  deltas: { method: EvidenceMethod; before: number; after: number; delta: number }[];
  observedRatioDelta: number | null;
  holes: number; // pontos inválidos entre o penúltimo e o último válidos
  totalPoints: number;
}

/** Extrai o par (penúltimo, último) VÁLIDO da série cronológica. Puro. */
export function computeDiff(history: EvidenceHistory | null | undefined): DiffResult {
  const points = history?.points ?? [];
  const valid = points.filter(isValidPoint).map(toSnapshot);
  const current = valid.length >= 1 ? valid[valid.length - 1] : null;
  const previous = valid.length >= 2 ? valid[valid.length - 2] : null;
  const deltas: DiffResult["deltas"] = [];
  if (current) {
    for (const m of EVIDENCE_ORDER) {
      const after = current.byMethod[m] || 0;
      const before = previous ? previous.byMethod[m] || 0 : 0;
      if (after === 0 && before === 0) continue;
      deltas.push({ method: m, before, after, delta: after - before });
    }
  }
  const observedRatioDelta =
    current && previous ? Number((current.observedRatio - previous.observedRatio).toFixed(4)) : null;
  const holes = points.filter((p) => !isValidPoint(p)).length;
  return { previous, current, deltas, observedRatioDelta, holes, totalPoints: points.length };
}

// ── Andon ──────────────────────────────────────────────────────────────
export type AndonLevel = "good" | "warn" | "crit";
export interface AndonItem {
  level: AndonLevel;
  title: string;
  detail: string;
  source: string;
}

export interface HealthLike {
  overall?: string;
  culprits?: Array<{ axis?: string; status?: string; reason?: string }>;
  runtime?: { ageHours?: number | null; status?: string };
  static?: { ageHours?: number | null; status?: string };
}
export interface DriftLike {
  edges?: { added?: number; removed?: number };
  newServiceCycles?: unknown[];
  couplingDelta?: Array<{ id?: string; deltaPct?: number }>;
}

const AXIS_LABEL: Record<string, string> = {
  static: "índice estático",
  config: "config/wiring",
  runtime: "tráfego runtime",
  analysis: "análise",
  drift: "cobertura do binário",
};

/** Monta a lista Andon a partir de saúde + drift + o próprio diff. Puro. */
export function buildAndon(
  health: HealthLike | null | undefined,
  drift: DriftLike | null | undefined,
  diff: DiffResult,
): AndonItem[] {
  const items: AndonItem[] = [];

  for (const c of health?.culprits ?? []) {
    const axis = c.axis || "";
    const status = (c.status || "").toLowerCase();
    const level: AndonLevel = status === "absent" ? "crit" : "warn";
    items.push({
      level,
      title: `${AXIS_LABEL[axis] || axis}: ${c.status}`,
      detail: c.reason || "eixo de evidência degradado",
      source: "evidence-health",
    });
  }

  if (drift?.newServiceCycles && drift.newServiceCycles.length > 0) {
    items.push({
      level: "crit",
      title: `${drift.newServiceCycles.length} novo(s) ciclo(s) SERVICE↔SERVICE`,
      detail: "acoplamento cíclico que não existia no retrato anterior",
      source: "graph-drift",
    });
  }
  const topCoupling = (drift?.couplingDelta ?? []).filter((d) => (d.deltaPct ?? 0) >= 25).slice(0, 3);
  for (const d of topCoupling) {
    items.push({
      level: "warn",
      title: `acoplamento de ${d.id} subiu ${Math.round(d.deltaPct || 0)}%`,
      detail: "hub ganhou dependências entre as duas análises",
      source: "graph-drift",
    });
  }
  if (drift?.edges?.removed != null && drift.edges.removed > 0) {
    items.push({
      level: "warn",
      title: `${drift.edges.removed} aresta(s) removida(s)`,
      detail: "sumiram do código entre os dois retratos",
      source: "graph-drift",
    });
  }

  if (diff.observedRatioDelta != null && diff.observedRatioDelta <= -0.03) {
    const pts = Math.abs(Math.round(diff.observedRatioDelta * 100));
    items.push({
      level: "warn",
      title: `cobertura de runtime caiu ${pts} pts`,
      detail: `de ${diff.previous?.sha} para ${diff.current?.sha} — menos do mapa foi confirmado`,
      source: "evidence-history",
    });
  }

  if (items.length === 0) {
    items.push({
      level: "good",
      title: "Nenhum alarme",
      detail: "os eixos de evidência estão frescos e o drift não acendeu nada.",
      source: "evidence-health",
    });
  }
  return items;
}

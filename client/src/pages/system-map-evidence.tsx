// ─────────────────────────────────────────────
// System Map — camada de PROVENIÊNCIA (ADR-0028 P0.3, "Mapa Epistêmico").
//
// O mapa deixa de esconder o que NÃO sabe. Cada aresta carrega um "método de
// evidência" (COMO o Sentinel soube que a aresta existe) e o grafo carrega um
// censo de cobertura. É surfacing de CONTRATO — a técnica de inferência mora no
// backend (P0.1); aqui só REVELAMOS o furo (o caso NuPIdentify, em que arestas
// nunca observadas eram apagadas em silêncio).
//
// Degradação graciosa é lei: se `evidence`/`coverage` não vierem (P0.1 ainda
// não mergeada, snapshot antigo, outro stack), nada quebra e o render atual
// segue byte-a-byte — os acessores caem em `UNKNOWN`/`null`.
// ─────────────────────────────────────────────
import { Activity, ShieldCheck, HelpCircle, Bot, CircleOff, Radar, Cable } from "lucide-react";

export type EvidenceMethod =
  | "RUNTIME_OBSERVED"
  | "STATIC_PROVEN"
  | "CONFIG_PROVEN"
  | "STATIC_UNRESOLVED"
  | "LLM_CONJECTURED"
  | "UNKNOWN";

/** Contrato P0.1 — por aresta. */
export interface EdgeEvidence {
  method: EvidenceMethod;
  confidence: number;
}

/**
 * ADR-0035 — confiança CALIBRADA por método (`coverage.calibration` do /graph).
 * Opcional por contrato: snapshot/servidor antigo simplesmente não traz, e a UI
 * degrada. `calibrated:false` NÃO é erro — é abstenção honesta com motivo.
 */
export interface MethodReliabilityDTO {
  reliability: number;
  lower: number;
  upper: number;
  width: number;
  n: number;
  confirmed: number;
  calibrated: boolean;
  abstainReason?: string;
}
export interface GraphCalibration {
  calibrated: boolean;
  reason?: string;
  hasRuntimeGroundTruth?: boolean;
  runtimeOracleSize?: number;
  oracleComparablePairs?: number;
  confidenceLevelPct?: number;
  byMethod?: Record<string, MethodReliabilityDTO>;
  effectiveConfidenceByMethod?: Record<string, { confidence: number; source: "calibrated" | "fixed"; fixed: number }>;
  completeness?: {
    observed: number;
    estimatedTotal: number;
    missShare: number;
    ci?: { lower: number; upper: number };
    detail?: { reliable: boolean; note?: string };
  };
  completenessLevelPct?: number;
  completenessApplicable?: boolean;
  completenessReason?: string;
  methodOverlapShare?: number;
}

/** Contrato P0.1 — por grafo (o censo honesto de cobertura). */
export interface GraphCoverage {
  edges: {
    byMethod: Partial<Record<EvidenceMethod, number>>;
    total: number;
    observedRatio: number;
  };
  nodes: { observed: number; total: number };
  /** ADR-0035 — presente só quando o servidor já emite a seção. */
  calibration?: GraphCalibration | null;
}

// Ordem canônica: do mais forte (visto rodar) ao mais fraco (nunca soubemos).
// CONFIG_PROVEN entra no TIER PROVADO, logo abaixo do checker de compilador e
// acima do não-resolvido/conjectura (ADR-0035 §4: prova de WIRING determinístico —
// DI/rota/env resolve para AQUELA impl, mais forte que heurística).
export const EVIDENCE_ORDER: readonly EvidenceMethod[] = [
  "RUNTIME_OBSERVED",
  "STATIC_PROVEN",
  "CONFIG_PROVEN",
  "STATIC_UNRESOLVED",
  "LLM_CONJECTURED",
  "UNKNOWN",
] as const;

/** Tier "provado" — caminho verificado (runtime OU compilador OU config/DI determinística). */
export const PROVEN_TIER: ReadonlySet<EvidenceMethod> = new Set<EvidenceMethod>([
  "RUNTIME_OBSERVED",
  "STATIC_PROVEN",
  "CONFIG_PROVEN",
]);

// Rótulo pt-BR + cor + estilo de linha por método. As cores funcionam em claro
// e escuro (o canvas cytoscape não tem tema); o 2º canal (ícone + estilo de
// linha) segue WCAG 1.4.1 — nunca só cor.
export const EVIDENCE: Record<
  EvidenceMethod,
  {
    label: string;
    color: string;
    lineStyle: "solid" | "dashed" | "dotted";
    /** aresta reforçada (viu rodar de verdade). */
    strong?: boolean;
    /** aresta esmaecida/cinza (não sabemos). */
    muted?: boolean;
    icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  }
> = {
  RUNTIME_OBSERVED: { label: "Observado em runtime", color: "#f43f5e", lineStyle: "solid", strong: true, icon: Activity },
  STATIC_PROVEN: { label: "Provado (estático)", color: "#10b981", lineStyle: "solid", icon: ShieldCheck },
  CONFIG_PROVEN: { label: "Provado por config (DI/rota)", color: "#06b6d4", lineStyle: "dashed", strong: true, icon: Cable },
  STATIC_UNRESOLVED: { label: "Não-resolvido", color: "#f59e0b", lineStyle: "dashed", icon: HelpCircle },
  LLM_CONJECTURED: { label: "Conjecturado (IA)", color: "#a78bfa", lineStyle: "dotted", icon: Bot },
  UNKNOWN: { label: "Desconhecido", color: "#94a3b8", lineStyle: "solid", muted: true, icon: CircleOff },
};

const RANK: Record<EvidenceMethod, number> = {
  RUNTIME_OBSERVED: 5,
  STATIC_PROVEN: 4,
  CONFIG_PROVEN: 3,
  STATIC_UNRESOLVED: 2,
  LLM_CONJECTURED: 1,
  UNKNOWN: 0,
};

// Confiança canônica por método (espelha `classifyEdgeEvidence` do backend,
// server/analyzers/system-graph.ts). Fallback quando a aresta não traz o número
// cru — o encoding de opacidade ∝ confiança nunca fica sem dado.
const METHOD_CONFIDENCE: Record<EvidenceMethod, number> = {
  RUNTIME_OBSERVED: 0.95,
  STATIC_PROVEN: 0.8,
  CONFIG_PROVEN: 0.78,
  STATIC_UNRESOLVED: 0.4,
  LLM_CONJECTURED: 0.3,
  UNKNOWN: 0.2,
};

/** Força relativa do método (para escolher o representativo ao agregar). */
export function evidenceRank(m: EvidenceMethod): number {
  return RANK[m] ?? 0;
}

/** Valida um `method` cru da API; enum novo/lixo → `UNKNOWN` (nunca crasha). */
export function normalizeEvidenceMethod(m: unknown): EvidenceMethod {
  return typeof m === "string" && m in EVIDENCE ? (m as EvidenceMethod) : "UNKNOWN";
}

/** Método de uma aresta bruta — fallback seguro quando `evidence` ausente. */
export function evidenceMethodOf(edge: { evidence?: { method?: unknown } | null } | null | undefined): EvidenceMethod {
  return normalizeEvidenceMethod(edge?.evidence?.method);
}

/**
 * Confiança (0..1) de uma aresta bruta. Usa o número cru quando presente e
 * finito; senão cai na confiança canônica do método (nunca fica sem valor, para
 * o encoding de opacidade ∝ confiança). Clampa fora-de-faixa.
 */
export function evidenceConfidenceOf(
  edge: { evidence?: { method?: unknown; confidence?: unknown } | null } | null | undefined,
): number {
  const raw = edge?.evidence?.confidence;
  const method = evidenceMethodOf(edge);
  const c = typeof raw === "number" && Number.isFinite(raw) ? raw : METHOD_CONFIDENCE[method];
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/** Confiança canônica de um método (fallback determinístico). */
export function confidenceOfMethod(m: EvidenceMethod): number {
  return METHOD_CONFIDENCE[m] ?? 0.2;
}

/** Ao colapsar N arestas em 1, o encoding mostra a evidência MAIS FORTE. */
export function strongestEvidence(methods: readonly EvidenceMethod[]): EvidenceMethod {
  let best: EvidenceMethod = "UNKNOWN";
  for (const m of methods) if (evidenceRank(m) > evidenceRank(best)) best = m;
  return best;
}

/** O backend anexou o eixo de evidência? Sem isso, não estilizamos por método. */
export function hasEvidenceData(edges: Array<{ evidence?: unknown } | null | undefined> | null | undefined): boolean {
  return Array.isArray(edges) && edges.some((e) => e != null && e.evidence != null);
}

export interface CoverageSummary {
  total: number;
  observed: number;
  unobserved: number;
  ratioPct: number;
  /** arestas no tier PROVADO (runtime + compilador + config/DI). */
  proven: number;
  /** % de arestas provadas (não só observadas em runtime). */
  provenPct: number;
  nodesObserved?: number;
  nodesTotal?: number;
}

/** Deriva o resumo do badge; `null` = nada a revelar (degradação graciosa). */
export function coverageSummary(coverage?: GraphCoverage | null): CoverageSummary | null {
  const e = coverage?.edges;
  if (!e) return null;
  const total = Number.isFinite(e.total) ? e.total : 0;
  if (total <= 0) return null;
  const bm = e.byMethod ?? {};
  const observed = bm.RUNTIME_OBSERVED ?? 0;
  let proven = 0;
  for (const m of PROVEN_TIER) proven += bm[m] ?? 0;
  const ratio = Number.isFinite(e.observedRatio) ? e.observedRatio : total > 0 ? observed / total : 0;
  return {
    total,
    observed,
    unobserved: Math.max(0, total - observed),
    ratioPct: Math.round(ratio * 100),
    proven,
    provenPct: total > 0 ? Math.round((proven / total) * 100) : 0,
    nodesObserved: coverage?.nodes?.observed,
    nodesTotal: coverage?.nodes?.total,
  };
}

/** A frase da revelação honesta — com plural correto. */
export function coverageBadgeText(s: CoverageSummary): string {
  const arestas = s.unobserved === 1 ? "aresta nunca observada" : "arestas nunca observadas";
  return `cobertura ${s.ratioPct}%, ${s.unobserved} ${arestas}`;
}

// ── Legenda dos 5 métodos (o encoding de proveniência) ────────────────
export function EvidenceLegend() {
  return (
    <div data-testid="evidence-legend">
      <div className="mb-1 font-semibold">Como o Sentinel soube</div>
      <div className="grid grid-cols-1 gap-y-1">
        {EVIDENCE_ORDER.map((m) => {
          const meta = EVIDENCE[m];
          const Icon = meta.icon;
          return (
            <div key={m} className="flex items-center gap-1.5" data-testid={`evidence-legend-item-${m}`}>
              <span
                aria-hidden="true"
                className="inline-block w-5 shrink-0"
                style={{
                  borderTopWidth: meta.strong ? 3 : 2,
                  borderTopStyle: meta.lineStyle,
                  borderTopColor: meta.color,
                  opacity: meta.muted ? 0.5 : 1,
                }}
              />
              <Icon className="h-3 w-3 shrink-0" style={{ color: meta.color }} />
              <span>{meta.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Badge de cobertura (a revelação do furo, no topo) ─────────────────
export function CoverageBadge({ coverage }: { coverage?: GraphCoverage | null }) {
  const s = coverageSummary(coverage);
  if (!s) return null; // sem coverage: não mostra nada (degradação graciosa, não erro)
  const alert = s.unobserved > 0;
  const title = s.nodesTotal
    ? `${s.observed} de ${s.total} arestas observadas em runtime · nós ${s.nodesObserved}/${s.nodesTotal}`
    : `${s.observed} de ${s.total} arestas observadas em runtime`;
  return (
    <span
      data-testid="coverage-badge"
      title={title}
      className={
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium " +
        (alert
          ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
          : "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300")
      }
    >
      <Radar className="h-3 w-3 shrink-0" />
      {coverageBadgeText(s)}
    </span>
  );
}

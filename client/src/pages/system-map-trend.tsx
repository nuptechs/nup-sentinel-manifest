// ─────────────────────────────────────────────
// System Map — vista "Provas": a EVOLUÇÃO da evidência (dimensão TEMPO).
//
// Todo o resto do mapa é fotografia do agora. Esta seção é o filme: consome
// `GET /api/projects/:id/evidence-history` e responde a pergunta que fotografia
// nenhuma responde — **"o mapa está mais confirmado que há N runs?"**. Série
// histórica é o que nenhum agente lendo código produz: ele lê o presente.
//
// Três leituras, nesta ordem de importância:
//   1) a MANCHETE — quantos pontos percentuais o tier provado ganhou (ou perdeu)
//      entre o 1º e o último run medido da janela;
//   2) a linha da COBERTURA por método (runtime × estático × config);
//   3) a linha do BIMR — o ponto cego encolhendo (ou não).
//
// ─── §HONESTIDADE (as regras que a tela não pode quebrar) ─────────────
// • O histórico começou a ser gravado a partir de um deploy: run anterior vem
//   com `coverage: null` e é EXCLUÍDO da série — nunca plotado como zero. A
//   tela DIZ quantos ficaram de fora em vez de fingir um vale no gráfico.
// • Com menos de 2 pontos medidos não existe tendência: o estado é "warming"
//   ("o histórico começa a acumular a partir de hoje"), não um delta de 0%.
// • Run FALHO conta como cicatriz na janela (é reportado), mas não vira ponto
//   de cobertura — ele não mediu nada.
// • Erro de consulta é ERRO, jamais "nenhuma evolução". Carregando ≠ vazio ≠
//   falhou — a mesma regra do resto do mapa.
//
// Como no `EpistemicBreakdown`, todo número asserível vive em DOM comum FORA do
// `<ResponsiveContainer>` (o jsdom não dá dimensão ao recharts).
// ─────────────────────────────────────────────
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, RefreshCw, LineChart as LineChartIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EVIDENCE, type EvidenceMethod } from "./system-map-evidence";

// ── Contrato do payload /evidence-history (defensivo: tudo opcional) ──
export interface EvidenceHistoryCoverageDTO {
  edges?: { total?: number; byMethod?: Partial<Record<EvidenceMethod, number>>; observedRatio?: number };
  nodes?: { observed?: number; total?: number };
}
export interface EvidenceHistoryBimrDTO {
  measurable?: boolean;
  observed?: number;
  resolved?: number;
  minted?: number;
  mintedRatio?: number;
  mintedRatioExcludingInfrastructure?: number;
}
export interface EvidenceHistoryPointDTO {
  runId: number;
  startedAt?: string | null;
  completedAt?: string | null;
  failed?: boolean;
  coverage?: EvidenceHistoryCoverageDTO | null;
  overlay?: { status?: string; traces?: number | null; serviceEntityEdges?: number | null } | null;
  bimr?: EvidenceHistoryBimrDTO | null;
  calibration?: { calibrated?: boolean; comparablePairs?: number } | null;
}
export interface EvidenceHistoryPayload {
  projectId?: number;
  count?: number;
  limit?: number;
  recordedFrom?: string | null;
  points?: EvidenceHistoryPointDTO[];
}

/**
 * Métodos plotados (o tier provado — o que "estar confirmado" quer dizer).
 * O tipo é a união ESTREITA das 3 chaves, não `EvidenceMethod`: assim o
 * compilador garante que todo método plotado tem série no `TrendDatum` (e
 * acusa na hora se alguém adicionar um 4º sem criar a série correspondente).
 */
export type TrendMethod = "RUNTIME_OBSERVED" | "STATIC_PROVEN" | "CONFIG_PROVEN";
export const TREND_METHODS: readonly TrendMethod[] = ["RUNTIME_OBSERVED", "STATIC_PROVEN", "CONFIG_PROVEN"] as const;

export interface TrendDatum extends Record<TrendMethod, number> {
  runId: number;
  /** rótulo curto do eixo X (dd/mm) — cai no #run quando não há data. */
  label: string;
  at: string | null;
  total: number;
  /** % do mapa no tier provado neste run (0..100, arredondado). */
  provenPct: number;
  /** % de pontos cegos (BIMR ex-infra) — `null` quando não foi mensurável. */
  bimrPct: number | null;
  comparablePairs: number | null;
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Série do gráfico — SÓ os pontos que têm censo. `null` quando não há nenhum.
 * Run sem `coverage` (anterior ao registro, ou falho) é omitido de propósito:
 * plotá-lo como zero inventaria um vale que nunca existiu.
 */
export function trendSeries(data?: EvidenceHistoryPayload | null): TrendDatum[] | null {
  const pts = data?.points;
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const out: TrendDatum[] = [];
  for (const p of pts) {
    const edges = p?.coverage?.edges;
    const total = edges?.total;
    if (typeof total !== "number" || !Number.isFinite(total)) continue; // sem censo → fora
    const by = edges?.byMethod ?? {};
    const at = p.completedAt ?? p.startedAt ?? null;
    const proven = TREND_METHODS.reduce((acc, m) => acc + n(by[m]), 0);
    const bimrMeasurable = p.bimr && p.bimr.measurable !== false;
    out.push({
      runId: p.runId,
      at,
      label: shortDate(at) ?? `#${p.runId}`,
      RUNTIME_OBSERVED: n(by.RUNTIME_OBSERVED),
      STATIC_PROVEN: n(by.STATIC_PROVEN),
      CONFIG_PROVEN: n(by.CONFIG_PROVEN),
      total,
      provenPct: total > 0 ? Math.round((proven / total) * 100) : 0,
      bimrPct: bimrMeasurable ? Math.round(n(p.bimr?.mintedRatioExcludingInfrastructure) * 100) : null,
      comparablePairs: p.calibration ? n(p.calibration.comparablePairs) : null,
    });
  }
  return out.length > 0 ? out : null;
}

export type TrendState = "unavailable" | "warming" | "measured";

export interface TrendHeadline {
  state: TrendState;
  headline: string;
  sub: string;
  /** variação em PONTOS PERCENTUAIS do tier provado (só em `measured`). */
  deltaPp?: number;
  direction?: "up" | "down" | "flat";
  first?: TrendDatum;
  last?: TrendDatum;
  /** runs da janela que não têm censo (pré-registro) — dito, nunca escondido. */
  unmeasured: number;
  /** runs falhos na janela. */
  failed: number;
}

/**
 * A manchete honesta. Um único ponto NÃO é tendência — vira "warming", nunca um
 * delta de 0% (que leria como "não melhorou nada", uma afirmação falsa).
 */
export function trendHeadline(data?: EvidenceHistoryPayload | null): TrendHeadline {
  const pts = data?.points ?? [];
  const failed = pts.filter((p) => p.failed).length;
  const series = trendSeries(data);
  const unmeasured = pts.length - (series?.length ?? 0);

  if (!series) {
    return {
      state: "unavailable",
      headline: "Ainda não há histórico para este projeto",
      sub:
        pts.length > 0
          ? `${pts.length} run(s) na janela, nenhum com censo gravado — o histórico passa a ser medido nas próximas análises.`
          : "Rode uma análise: a série começa a ser gravada a partir da próxima.",
      unmeasured,
      failed,
    };
  }

  if (series.length < 2) {
    return {
      state: "warming",
      headline: "O histórico começa a acumular a partir de hoje",
      sub: `1 run medido até agora (${series[0].provenPct}% do mapa no tier provado). Com o próximo run já dá para comparar — tendência exige dois pontos.`,
      first: series[0],
      last: series[0],
      unmeasured,
      failed,
    };
  }

  const first = series[0];
  const last = series[series.length - 1];
  const deltaPp = last.provenPct - first.provenPct;
  const direction: "up" | "down" | "flat" = deltaPp > 0 ? "up" : deltaPp < 0 ? "down" : "flat";
  const janela = `${series.length} runs medidos${first.at && last.at ? ` · ${first.label} → ${last.label}` : ""}`;

  const headline =
    direction === "up"
      ? `O mapa está ${deltaPp} ponto(s) percentual(is) mais confirmado`
      : direction === "down"
        ? `O mapa está ${Math.abs(deltaPp)} ponto(s) percentual(is) menos confirmado`
        : "O mapa está tão confirmado quanto no início da janela";

  return {
    state: "measured",
    headline,
    sub: `${first.provenPct}% → ${last.provenPct}% do mapa no tier provado (${janela}).`,
    deltaPp,
    direction,
    first,
    last,
    unmeasured,
    failed,
  };
}

// ── painel (PRESENTACIONAL — recebe estado por prop) ──────────────────
export function EvidenceTrendPanel({
  data,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  data?: EvidenceHistoryPayload | null;
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  const series = useMemo(() => trendSeries(data), [data]);
  const h = useMemo(() => trendHeadline(data), [data]);

  if (isLoading) {
    return (
      <Card data-testid="trend-loading">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <LineChartIcon className="h-4 w-4 text-primary" /> Evolução da evidência
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="border-destructive/40" data-testid="trend-error">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-destructive" /> Não deu para carregar a evolução
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            A consulta falhou — isto <strong>não</strong> quer dizer que o mapa parou de evoluir, quer dizer que não sabemos.
            {error?.message ? ` (${error.message})` : ""}
          </p>
          {onRetry && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onRetry} data-testid="trend-retry">
              <RefreshCw className="h-3.5 w-3.5" /> Tentar de novo
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const DirIcon = h.direction === "up" ? TrendingUp : h.direction === "down" ? TrendingDown : Minus;
  const dirColor =
    h.direction === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : h.direction === "down"
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";

  return (
    <Card data-testid="trend-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <LineChartIcon className="h-4 w-4 text-primary" /> Evolução da evidência
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          De fotografia para filme — o que nenhuma leitura do código de hoje consegue dizer.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* manchete */}
        <div className="rounded-md border p-3" data-testid={`trend-state-${h.state}`}>
          {h.state === "measured" && (
            <div className="flex items-baseline gap-2">
              <span className={`flex items-center gap-1 text-3xl font-bold tabular-nums leading-none ${dirColor}`} data-testid="trend-delta">
                <DirIcon className="h-6 w-6" />
                {h.deltaPp! > 0 ? "+" : ""}
                {h.deltaPp} pp
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">no tier provado</span>
            </div>
          )}
          <p className={`text-sm font-medium ${h.state === "measured" ? "mt-1" : ""}`} data-testid="trend-headline">
            {h.headline}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="trend-sub">
            {h.sub}
          </p>
          {/* o que ficou de fora — dito, nunca escondido */}
          {(h.unmeasured > 0 || h.failed > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="trend-caveats">
              {h.unmeasured > 0 && (
                <Badge variant="outline" className="text-[11px]" data-testid="trend-unmeasured">
                  {h.unmeasured} run(s) sem censo — anteriores ao registro, fora da linha
                </Badge>
              )}
              {h.failed > 0 && (
                <Badge variant="outline" className="text-[11px]" data-testid="trend-failed">
                  {h.failed} run(s) falhos na janela
                </Badge>
              )}
            </div>
          )}
        </div>

        {series && series.length >= 2 && (
          <>
            {/* linha 1 — cobertura por método */}
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                <span>Arestas provadas por método</span>
                <span className="tabular-nums" data-testid="trend-last-total">
                  {series[series.length - 1].total.toLocaleString("pt-BR")} arestas no último run
                </span>
              </div>
              <div className="h-40 w-full" data-testid="trend-coverage-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={44} />
                    <RTooltip
                      formatter={(value: number, name: string) => [
                        `${value.toLocaleString("pt-BR")} arestas`,
                        EVIDENCE[name as EvidenceMethod]?.label ?? name,
                      ]}
                      contentStyle={{
                        fontSize: 12,
                        borderRadius: 8,
                        border: "1px solid hsl(var(--border))",
                        background: "hsl(var(--popover))",
                        color: "hsl(var(--popover-foreground))",
                      }}
                    />
                    {TREND_METHODS.map((m) => (
                      <Line
                        key={m}
                        type="monotone"
                        dataKey={m}
                        stroke={EVIDENCE[m].color}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {/* legenda em DOM comum (2º canal: rótulo + número, nunca só cor) */}
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {TREND_METHODS.map((m) => {
                  const last = series[series.length - 1][m];
                  const first = series[0][m];
                  const d = last - first;
                  return (
                    <span key={m} className="flex items-center gap-1.5 text-[11px]" data-testid={`trend-legend-${m}`}>
                      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: EVIDENCE[m].color }} />
                      <span className="text-muted-foreground">{EVIDENCE[m].label}</span>
                      <span className="tabular-nums font-medium">{last.toLocaleString("pt-BR")}</span>
                      <span className={`tabular-nums ${d > 0 ? "text-emerald-600 dark:text-emerald-400" : d < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}>
                        ({d > 0 ? "+" : ""}
                        {d.toLocaleString("pt-BR")})
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>

            {/* linha 2 — o ponto cego encolhendo */}
            <BlindTrend series={series} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Tendência do BIMR — só desenha quando houve run mensurável (≥2 pontos). */
export function BlindTrend({ series }: { series: TrendDatum[] }) {
  const measured = series.filter((s) => s.bimrPct != null);
  if (measured.length < 2) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="trend-bimr-unavailable">
        Sem tráfego observado suficiente na janela para acompanhar o ponto cego —{" "}
        <strong>isso não é 0%: é não-medido.</strong>
      </p>
    );
  }
  const first = measured[0].bimrPct!;
  const last = measured[measured.length - 1].bimrPct!;
  const d = last - first;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>Ponto cego (tabelas em produção sem entidade no código)</span>
        <span className="tabular-nums" data-testid="trend-bimr-delta">
          {first}% → {last}% ({d > 0 ? "+" : ""}
          {d} pp)
        </span>
      </div>
      <div className="h-24 w-full" data-testid="trend-bimr-chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={measured} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={44} unit="%" />
            <RTooltip
              formatter={(value: number) => [`${value}%`, "ponto cego"]}
              contentStyle={{
                fontSize: 12,
                borderRadius: 8,
                border: "1px solid hsl(var(--border))",
                background: "hsl(var(--popover))",
                color: "hsl(var(--popover-foreground))",
              }}
            />
            <Line type="monotone" dataKey="bimrPct" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

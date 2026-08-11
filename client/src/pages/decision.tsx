// ─────────────────────────────────────────────
// VISÃO DE DECISÃO — a superfície única de decisão do Manifest.
//
// Responde, em ~10 segundos e para quem não é técnico, as quatro perguntas que
// hoje exigem visitar três vistas e quatro endpoints:
//
//   1. o mapa é confiável AGORA?      → banner de saúde   (/evidence-health)
//   2. onde estão os pontos cegos?    → manchete do BIMR  (/bimr)
//   3. de onde vem a prova?           → censo epistêmico  (/graph)
//   4. está melhorando?               → tendência         (/evidence-history)
//   +  o que mais executa de verdade? → arestas quentes   (/graph)
//
// ─── §COMPOSIÇÃO, NÃO REESCRITA ──────────────────────────────────────
// Nenhum número é recalculado aqui. As leituras vêm dos MESMOS helpers puros
// que as vistas do Mapa do Sistema já usam — `bimrHeadline`/`CalibrationBands`
// (system-map-blind), `breakdownData`/`coverageSummary` (proofs/evidence),
// `trendHeadline`/`trendSeries` (trend), `topRuntimeEdges` (insights). Se um
// deles mudar, esta tela muda junto: uma fonte, duas vitrines.
//
// ─── §REGRAS QUE ESTA TELA NÃO PODE QUEBRAR ──────────────────────────
// • Procedência em TODO número: cada card fecha dizendo de qual endpoint e de
//   qual run ele veio. Número sem origem não entra.
// • Ausente ≠ zero. Sem censo não é "0% provado"; sem tráfego não é "0% de
//   ponto cego"; sem aresta observada não é "nada executa". Cada caso tem
//   texto próprio dizendo o que NÃO sabemos.
// • Degradação isolada: um card que falha vira card de erro; a página segue.
//   Carregando ≠ vazio ≠ falhou, em cada seção separadamente.
// • Se a saúde não está boa, o banner avisa que TUDO abaixo está sob suspeita
//   — porque está.
// ─────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from "recharts";
import {
  AlertTriangle,
  ArrowRight,
  EyeOff,
  Flame,
  Gavel,
  LineChart as LineChartIcon,
  Minus,
  RefreshCw,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EvidenceHealthBanner, healthHeadline, type EvidenceHealthPayload } from "./decision-health";
import { ReasonerPanel } from "./decision-reasoner";
import { EVIDENCE, coverageSummary, hasEvidenceData, type GraphCoverage } from "./system-map-evidence";
import { breakdownData } from "./system-map-proofs";
import { CalibrationBands, bimrHeadline, type BimrPayload } from "./system-map-blind";
import { trendHeadline, trendSeries, type EvidenceHistoryPayload } from "./system-map-trend";
import { topRuntimeEdges, type InsightGraph } from "./system-map-insights";

// ── Contratos consumidos ──────────────────────────────────────────────
export type DecisionGraphPayload = InsightGraph & {
  projectId?: number;
  analysisRunId?: number;
  coverage?: GraphCoverage | null;
};

/** Forma mínima de um resultado de consulta — desacopla a vista do react-query. */
export interface QueryLike<T> {
  data?: T | null;
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
  refetch?: () => void;
}

interface Project {
  id: number;
  name: string;
}

// ── Procedência: a assinatura embaixo de cada número ──────────────────
export function SourceNote({ endpoint, bits, testId }: { endpoint: string; bits?: (string | number | null | undefined)[]; testId: string }) {
  const extras = (bits ?? []).filter((b) => b != null && b !== "").map(String);
  return (
    <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground" data-testid={testId}>
      fonte: {endpoint}
      {extras.length ? ` · ${extras.join(" · ")}` : ""}
    </p>
  );
}

const runLabel = (id?: number | string | null) => (id != null && id !== "" ? `run #${id}` : null);

/**
 * Casca comum: título, estado de carga, estado de erro (com retentativa) e o
 * conteúdo. É aqui que a degradação vira ISOLADA — o erro de uma consulta não
 * escapa para as outras seções.
 */
export function SectionCard({
  title,
  icon,
  hint,
  testId,
  query,
  errorNote,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  hint?: string;
  testId: string;
  query: QueryLike<unknown>;
  /** o que a falha desta seção NÃO significa (anti-conclusão-errada). */
  errorNote: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={query.isError ? "border-destructive/40" : undefined} data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {query.isError ? <AlertTriangle className="h-4 w-4 text-destructive" /> : icon}
          {title}
        </CardTitle>
        {hint && !query.isError && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="space-y-2" data-testid={`${testId}-loading`}>
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : query.isError ? (
          <div className="space-y-3" data-testid={`${testId}-error`}>
            <p className="text-sm text-muted-foreground">
              Não deu para carregar. Isto <strong>não</strong> quer dizer {errorNote} — quer dizer que não sabemos.
              {query.error?.message ? ` (${query.error.message})` : ""}
            </p>
            {query.refetch && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => query.refetch?.()} data-testid={`${testId}-retry`}>
                <RefreshCw className="h-3.5 w-3.5" /> Tentar de novo
              </Button>
            )}
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/** Vazio HONESTO: diz o que não sabemos, nunca desenha um zero no lugar. */
export function NotKnown({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <p className="py-2 text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

// ── 1. Ponto cego (BIMR) ──────────────────────────────────────────────
export function BlindHeadlineCard({ query, projectId }: { query: QueryLike<BimrPayload>; projectId?: number }) {
  const h = bimrHeadline(query.data);
  const proofsHref = projectId != null ? `/system-map?view=proofs&project=${projectId}` : "/system-map?view=proofs";
  return (
    <SectionCard
      title="O que a leitura do código não vê"
      icon={<EyeOff className="h-4 w-4 text-primary" />}
      hint="Medido contra o que a produção realmente usou."
      testId="decision-blind"
      query={query}
      errorNote="que não há pontos cegos"
    >
      {h.state === "measured" ? (
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums leading-none text-amber-600 dark:text-amber-400" data-testid="decision-blind-pct">
            {h.pct}%
          </span>
          <span className="text-sm tabular-nums text-muted-foreground">
            {h.minted} de {h.observed} tabelas
          </span>
        </div>
      ) : null}
      <p className={`text-sm font-medium ${h.state === "measured" ? "mt-1" : ""}`} data-testid="decision-blind-headline">
        {h.headline}
      </p>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="decision-blind-sub">
        {h.sub}
      </p>
      {/* o link só existe quando existe lista: mandar o gestor para uma tela
          vazia é o beco que a "superfície de decisão" deveria eliminar. */}
      {h.minted > 0 && (
        <Link
          href={proofsHref}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          data-testid="decision-blind-link"
        >
          Ver as {h.minted} tabela(s) na lista completa <ArrowRight className="h-3 w-3" />
        </Link>
      )}
      <SourceNote endpoint="/bimr" bits={[runLabel(query.data?.analysisRunId ?? null)]} testId="decision-blind-source" />
    </SectionCard>
  );
}

// ── 2. Censo epistêmico (de onde vem a prova) ─────────────────────────
export function CensusCard({ query }: { query: QueryLike<DecisionGraphPayload> }) {
  const coverage = query.data?.coverage;
  const rows = useMemo(() => breakdownData(coverage), [coverage]);
  const s = useMemo(() => coverageSummary(coverage), [coverage]);

  return (
    <SectionCard
      title="De onde vem a prova"
      icon={<ShieldCheck className="h-4 w-4 text-primary" />}
      hint="Quanto do mapa é provado × conjecturado × desconhecido."
      testId="decision-census"
      query={query}
      errorNote="que o mapa não tem prova"
    >
      {!rows || !s ? (
        <NotKnown testId="decision-census-empty">
          Este retrato não traz o censo de proveniência. <strong>Isso não é 0% de prova: é ausência de censo</strong> —
          re-analise o projeto para o eixo acender.
        </NotKnown>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums leading-none" data-testid="decision-census-proven-pct">
              {s.provenPct}%
            </span>
            <span className="text-sm text-muted-foreground">do mapa está no tier provado</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="decision-census-sub">
            {s.total.toLocaleString("pt-BR")} ligações no censo · {s.observed.toLocaleString("pt-BR")} vistas rodar ·{" "}
            {s.unobserved.toLocaleString("pt-BR")} nunca observadas.
          </p>

          {/* barras horizontais em DOM puro: legíveis, compactas e asseríveis
              (nada de canvas — o 2º canal é sempre rótulo + número). */}
          <div className="mt-3 space-y-1.5">
            {rows.map((r) => (
              <div key={r.method} className="flex items-center gap-2 text-sm" data-testid={`decision-census-row-${r.method}`}>
                <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">{r.label}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                  <span
                    aria-hidden="true"
                    className="block h-full rounded-sm"
                    style={{ width: `${Math.max(r.pct, 1)}%`, background: r.color }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums font-medium">{r.count.toLocaleString("pt-BR")}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-xs text-muted-foreground">{r.pct}%</span>
              </div>
            ))}
          </div>

          {/* a confiança medida — ou a abstenção honesta (componente reusado) */}
          <CalibrationBands calibration={coverage?.calibration} />
        </>
      )}
      <SourceNote endpoint="/graph" bits={[runLabel(query.data?.analysisRunId ?? null)]} testId="decision-census-source" />
    </SectionCard>
  );
}

// ── 3. Tendência (está melhorando?) ───────────────────────────────────
export function TrendCard({ query }: { query: QueryLike<EvidenceHistoryPayload> }) {
  const series = useMemo(() => trendSeries(query.data), [query.data]);
  const h = useMemo(() => trendHeadline(query.data), [query.data]);
  const DirIcon = h.direction === "up" ? TrendingUp : h.direction === "down" ? TrendingDown : Minus;
  const dirColor =
    h.direction === "up"
      ? "text-emerald-600 dark:text-emerald-400"
      : h.direction === "down"
        ? "text-rose-600 dark:text-rose-400"
        : "text-muted-foreground";

  return (
    <SectionCard
      title="Está melhorando?"
      icon={<LineChartIcon className="h-4 w-4 text-primary" />}
      hint="A evolução do tier provado entre os runs medidos."
      testId="decision-trend"
      query={query}
      errorNote="que o mapa parou de evoluir"
    >
      {h.state === "measured" && (
        <div className="flex items-baseline gap-2">
          <span className={`flex items-center gap-1 text-3xl font-bold tabular-nums leading-none ${dirColor}`} data-testid="decision-trend-delta">
            <DirIcon className="h-6 w-6" />
            {h.deltaPp! > 0 ? "+" : ""}
            {h.deltaPp} pp
          </span>
          <span className="text-sm text-muted-foreground">no tier provado</span>
        </div>
      )}
      <p className={`text-sm font-medium ${h.state === "measured" ? "mt-1" : ""}`} data-testid="decision-trend-headline">
        {h.headline}
      </p>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="decision-trend-sub">
        {h.sub}
      </p>

      {series && series.length >= 2 && (
        <div className="mt-3 h-20 w-full" data-testid="decision-trend-spark">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Line type="monotone" dataKey="RUNTIME_OBSERVED" stroke={EVIDENCE.RUNTIME_OBSERVED.color} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="STATIC_PROVEN" stroke={EVIDENCE.STATIC_PROVEN.color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* números da tendência em DOM comum (a sparkline é ilustração, não fonte) */}
      {series && series.length >= 2 && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {(["RUNTIME_OBSERVED", "STATIC_PROVEN"] as const).map((m) => {
            const d = series[series.length - 1][m] - series[0][m];
            return (
              <span key={m} className="flex items-center gap-1.5 text-[11px]" data-testid={`decision-trend-legend-${m}`}>
                <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: EVIDENCE[m].color }} />
                <span className="text-muted-foreground">{EVIDENCE[m].label}</span>
                <span className="tabular-nums font-medium">{series[series.length - 1][m].toLocaleString("pt-BR")}</span>
                <span className={`tabular-nums ${d > 0 ? "text-emerald-600 dark:text-emerald-400" : d < 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}>
                  ({d > 0 ? "+" : ""}
                  {d.toLocaleString("pt-BR")})
                </span>
              </span>
            );
          })}
        </div>
      )}

      {(h.unmeasured > 0 || h.failed > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="decision-trend-caveats">
          {h.unmeasured > 0 && (
            <Badge variant="outline" className="text-[11px]">
              {h.unmeasured} run(s) sem censo — fora da linha
            </Badge>
          )}
          {h.failed > 0 && (
            <Badge variant="outline" className="text-[11px]">
              {h.failed} run(s) falhos na janela
            </Badge>
          )}
        </div>
      )}
      <SourceNote
        endpoint="/evidence-history"
        bits={[series ? `${series.length} run(s) medido(s)` : "nenhum run medido"]}
        testId="decision-trend-source"
      />
    </SectionCard>
  );
}

// ── 4. O que mais executa de verdade ──────────────────────────────────
export function HotPathsCard({ query, limit = 5 }: { query: QueryLike<DecisionGraphPayload>; limit?: number }) {
  const payload = query.data;
  const edges = useMemo(() => (payload ? topRuntimeEdges(payload, limit) : []), [payload, limit]);
  const hasEvidence = useMemo(() => hasEvidenceData(payload?.edges), [payload]);

  return (
    <SectionCard
      title="O que mais executa de verdade"
      icon={<Flame className="h-4 w-4 text-rose-500" />}
      hint="Ligações exercitadas por tráfego real — a prova mais forte que existe."
      testId="decision-hotpaths"
      query={query}
      errorNote="que nada está executando"
    >
      {edges.length === 0 ? (
        <NotKnown testId="decision-hotpaths-empty">
          {hasEvidence ? (
            <>
              Nenhuma ligação foi vista executando nesta janela.{" "}
              <strong>Isso não é zero de execução: é zero de observação</strong> — confira o eixo de tráfego real no
              banner acima.
            </>
          ) : (
            <>
              Este retrato não traz o eixo de proveniência por ligação, então não há como dizer o que executou. Re-analise
              o projeto.
            </>
          )}
        </NotKnown>
      ) : (
        <ol className="space-y-1.5">
          {edges.map((e, i) => (
            <li key={e.id} className="flex items-center gap-2 text-sm" data-testid={`decision-hotpath-${i}`}>
              <span className="w-4 shrink-0 text-right tabular-nums text-xs text-muted-foreground">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={`${e.fromId} → ${e.toId}`}>
                <span className="font-mono text-[13px]">{e.origin === "background" ? "job/background" : e.fromLabel}</span>
                <ArrowRight className="mx-1 inline h-3 w-3 text-muted-foreground" />
                <span className="font-mono text-[13px]">{e.toLabel}</span>
              </span>
              {e.origin === "background" ? (
                <span
                  className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                  data-testid={`decision-hotpath-bg-${i}`}
                >
                  background
                </span>
              ) : null}
              {e.count != null ? (
                <span className="shrink-0 tabular-nums text-xs font-medium text-rose-600 dark:text-rose-400">
                  ×{e.count.toLocaleString("pt-BR")}
                </span>
              ) : (
                <span className="shrink-0 text-[11px] text-muted-foreground">sem contagem</span>
              )}
            </li>
          ))}
        </ol>
      )}
      <SourceNote endpoint="/graph" bits={[runLabel(payload?.analysisRunId ?? null)]} testId="decision-hotpaths-source" />
    </SectionCard>
  );
}

// ── 5. Slot do Tribunal — DECLARADO, não implementado ─────────────────
//
// Os vereditos de convergência vivem no nup-sentinel, não no Manifest. Fundir
// as duas fontes exige autenticação entre serviços, que ainda não existe.
// Prometer o card sem a fonte seria exatamente o tipo de número sem procedência
// que esta tela combate — então o slot fica visível e HONESTO sobre o que falta.
export function TribunalSlotCard() {
  return (
    <Card className="border-dashed" data-testid="decision-tribunal">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base text-muted-foreground">
          <Gavel className="h-4 w-4" /> Vereditos do Tribunal
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Convergência de achados (RUNTIME × STATIC × CONFIG) com tier de confiança.
        </p>
      </CardHeader>
      <CardContent>
        <div className="text-sm text-muted-foreground" data-testid="decision-tribunal-pending">
          <Badge variant="outline" className="mr-2 align-middle text-[11px]">
            integração pendente
          </Badge>
          A fonte é o <strong>nup-sentinel</strong>, um serviço separado. A fusão cross-serviço depende de autenticação
          entre serviços — enquanto ela não existe, este espaço fica vazio de propósito, em vez de exibir um veredito que
          não temos.
        </div>
        <details className="mt-2 text-[11px] text-muted-foreground" data-testid="decision-tribunal-contract">
          <summary className="cursor-pointer list-none underline decoration-dotted underline-offset-2">
            Contrato esperado quando a ponte existir
          </summary>
          <p className="mt-1.5">
            Por projeto: veredito(s) com <code>tier</code> (STRONG/MODERATE/WEAK), as fontes que convergiram
            (<code>sources[]</code>: RUNTIME/STATIC/CONFIG/COMPLIANCE), o achado citado com sua evidência e o
            <code> runId</code> de origem — a mesma regra desta página: nenhum veredito sem procedência.
          </p>
        </details>
      </CardContent>
    </Card>
  );
}

// ── A vista (PRESENTACIONAL — recebe as 4 consultas por prop) ─────────
export function DecisionView({
  health,
  graph,
  bimr,
  history,
  projectId,
}: {
  health: QueryLike<EvidenceHealthPayload>;
  graph: QueryLike<DecisionGraphPayload>;
  bimr: QueryLike<BimrPayload>;
  history: QueryLike<EvidenceHistoryPayload>;
  projectId?: number;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1" data-testid="decision-view">
      <EvidenceHealthBanner
        data={health.data}
        isLoading={health.isLoading}
        isError={health.isError}
        error={health.error}
        onRetry={health.refetch}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <BlindHeadlineCard query={bimr} projectId={projectId} />
        <CensusCard query={graph} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TrendCard query={history} />
        <HotPathsCard query={graph} />
      </div>

      <TribunalSlotCard />
    </div>
  );
}

// ── A página (rota) — só aqui existe I/O ──────────────────────────────
export default function DecisionPage() {
  const projectsQuery = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const projects = projectsQuery.data;
  const [projectId, setProjectId] = useState<number | null>(null);

  useEffect(() => {
    if (projectId == null && projects && projects.length > 0) {
      const easy = projects.find((p) => /easynup/i.test(p.name));
      setProjectId((easy || projects[0]).id);
    }
  }, [projects, projectId]);

  const enabled = projectId != null;
  const key = (suffix: string) => (enabled ? [`/api/projects/${projectId}/${suffix}`] : ["noop", suffix]);

  // Quatro consultas independentes, em paralelo, mesma origem. `/graph` divide
  // o cache com o Mapa do Sistema (mesma queryKey) — abrir as duas telas não
  // paga o payload duas vezes. Cada uma degrada sozinha: sem endpoint
  // agregador, a falha de uma NÃO derruba as outras três.
  const healthQuery = useQuery<EvidenceHealthPayload>({ queryKey: key("evidence-health"), enabled, retry: false });
  const graphQuery = useQuery<DecisionGraphPayload>({ queryKey: key("graph"), enabled, retry: false });
  const bimrQuery = useQuery<BimrPayload>({ queryKey: key("bimr"), enabled, retry: false });
  const historyQuery = useQuery<EvidenceHistoryPayload>({ queryKey: key("evidence-history"), enabled, retry: false });

  // O lembrete do rodapé vem do MESMO helper do banner: qual é a suspeita muda
  // o texto (drift ≠ "a evidência parou"), e duplicar a frase aqui garantiria
  // que uma das duas ficasse errada.
  const health = healthHeadline(healthQuery.isError ? null : healthQuery.data);

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight" data-testid="text-decision-title">
            <Target className="h-6 w-6 text-primary" /> Visão de Decisão
          </h1>
          <p className="text-sm text-muted-foreground">
            O mapa é confiável agora? O que executa de verdade? Onde estão os pontos cegos?
          </p>
        </div>
        <Select
          value={projectId != null ? String(projectId) : undefined}
          onValueChange={(v) => setProjectId(Number(v))}
          disabled={projectsQuery.isLoading || projectsQuery.isError || !projects?.length}
        >
          <SelectTrigger className="w-64" data-testid="select-project">
            <SelectValue placeholder="Selecione um projeto" />
          </SelectTrigger>
          <SelectContent>
            {(projects || []).map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {projectsQuery.isError && (
        <Card className="border-destructive/40" data-testid="decision-projects-error">
          <CardContent className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">
              Não deu para listar os projetos — sem isso não há o que decidir sobre.
              {(projectsQuery.error as Error)?.message ? ` (${(projectsQuery.error as Error).message})` : ""}
            </p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void projectsQuery.refetch()}>
              <RefreshCw className="h-3.5 w-3.5" /> Tentar de novo
            </Button>
          </CardContent>
        </Card>
      )}

      {!projectsQuery.isError && !projectsQuery.isLoading && projects?.length === 0 && (
        <Card data-testid="decision-projects-empty">
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Nenhum projeto cadastrado ainda. Envie um projeto para o Manifest ter o que medir.
          </CardContent>
        </Card>
      )}

      {enabled && (
        <DecisionView
          health={{ ...healthQuery, error: healthQuery.error as Error | null, refetch: () => void healthQuery.refetch() }}
          graph={{ ...graphQuery, error: graphQuery.error as Error | null, refetch: () => void graphQuery.refetch() }}
          bimr={{ ...bimrQuery, error: bimrQuery.error as Error | null, refetch: () => void bimrQuery.refetch() }}
          history={{ ...historyQuery, error: historyQuery.error as Error | null, refetch: () => void historyQuery.refetch() }}
          projectId={projectId ?? undefined}
        />
      )}

      {/* Raciocínio — IA governada sobre o substrato provado (4 endpoints /reasoner/*). */}
      {enabled && <ReasonerPanel projectId={projectId ?? undefined} />}

      {/* âncora de leitura: repete o veredito no rodapé para quem rolou a página */}
      {enabled && health.suspect && (
        <p className="text-center text-xs text-muted-foreground" data-testid="decision-footer-suspect">
          {health.suspectNote}
        </p>
      )}
    </div>
  );
}

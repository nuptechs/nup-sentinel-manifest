// ─────────────────────────────────────────────
// System Map — vista "PROVAS" (peças 2 e 3 do mapa epistêmico).
//
//   • peça 3 (gráfico): a REPARTIÇÃO EPISTÊMICA da cobertura — quanto do mapa é
//     provado × observado × conjecturado × desconhecido (donut recharts sobre o
//     censo `coverage.byMethod` que o /graph já devolve).
//   • peça 2 (insights): "o que importa, PROVADO" — ranking determinístico dos
//     nós de maior alcance, dos pontos cegos e do que foi visto rodar, cada card
//     CITANDO SUA TESTEMUNHA (método + confiança + nº de fontes + arquivo).
//
// Tudo derivado do MESMO payload /graph (cache compartilhado com o mapa). Zero
// dado inventado: sem eixo de evidência, o painel ADMITE que está aguardando
// proveniência em vez de fingir.
// ─────────────────────────────────────────────
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip } from "recharts";
import { ShieldCheck, Radar, EyeOff, Activity, Flame, Layers as LayersIcon, FileCode2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  EVIDENCE,
  EVIDENCE_ORDER,
  type EvidenceMethod,
  type GraphCoverage,
  coverageSummary,
} from "./system-map-evidence";
import {
  topBlastRadius,
  blindSpots,
  runtimeHotpaths,
  insightsSummary,
  type InsightGraph,
  type RankedNode,
} from "./system-map-insights";
import { BlindSpotPanel, CalibrationBands, type BimrPayload } from "./system-map-blind";

// ── peça 3: repartição epistêmica (pura → testável sem recharts) ──────
export interface BreakdownDatum {
  method: EvidenceMethod;
  label: string;
  color: string;
  count: number;
  pct: number;
}

/** Transforma `coverage.edges.byMethod` na série do donut, em ordem canônica
 *  (forte→fraco), só com buckets não-vazios. `null` se não há censo. */
export function breakdownData(coverage?: GraphCoverage | null): BreakdownDatum[] | null {
  const bm = coverage?.edges?.byMethod;
  const total = coverage?.edges?.total ?? 0;
  if (!bm || total <= 0) return null;
  const out: BreakdownDatum[] = [];
  for (const m of EVIDENCE_ORDER) {
    const count = bm[m] ?? 0;
    if (count <= 0) continue;
    out.push({ method: m, label: EVIDENCE[m].label, color: EVIDENCE[m].color, count, pct: Math.round((count / total) * 100) });
  }
  return out;
}

function pctLabel(n: number): string {
  return `${n}%`;
}

// ── peça 3: card do donut + legenda + estatísticas honestas ───────────
export function EpistemicBreakdown({ coverage }: { coverage?: GraphCoverage | null }) {
  const data = useMemo(() => breakdownData(coverage), [coverage]);
  const s = useMemo(() => coverageSummary(coverage), [coverage]);
  if (!data || !s) {
    return null; // sem censo: nada a mostrar (degradação graciosa, não erro)
  }
  const nodeObsPct = s.nodesTotal ? Math.round(((s.nodesObserved ?? 0) / s.nodesTotal) * 100) : null;
  return (
    <Card data-testid="epistemic-breakdown">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-primary" /> Repartição da prova
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Quanto do mapa é <strong>provado</strong> × observado × conjecturado × desconhecido — pelo censo de {s.total.toLocaleString("pt-BR")} arestas.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {/* Donut */}
          <div className="relative h-44 w-full sm:w-44 shrink-0" data-testid="breakdown-donut">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="count" nameKey="label" innerRadius={48} outerRadius={70} paddingAngle={1.5} strokeWidth={0} isAnimationActive={false}>
                  {data.map((d) => (
                    <Cell key={d.method} fill={d.color} />
                  ))}
                </Pie>
                <RTooltip
                  formatter={(value: number, _n, item) => [`${value.toLocaleString("pt-BR")} arestas`, (item?.payload as BreakdownDatum)?.label ?? ""]}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--border))", background: "hsl(var(--popover))", color: "hsl(var(--popover-foreground))" }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-2xl font-bold tabular-nums leading-none" data-testid="breakdown-proven-pct">{pctLabel(s.provenPct)}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">provado</span>
            </div>
          </div>
          {/* Legenda + números (2º canal: sempre rótulo + contagem, nunca só cor) */}
          <div className="flex-1 space-y-1.5">
            {data.map((d) => {
              const Icon = EVIDENCE[d.method].icon;
              return (
                <div key={d.method} className="flex items-center gap-2 text-sm" data-testid={`breakdown-row-${d.method}`}>
                  <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: d.color }} />
                  <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: d.color }} />
                  <span className="flex-1 truncate">{d.label}</span>
                  <span className="tabular-nums font-medium">{d.count.toLocaleString("pt-BR")}</span>
                  <span className="w-9 text-right tabular-nums text-xs text-muted-foreground">{pctLabel(d.pct)}</span>
                </div>
              );
            })}
          </div>
        </div>
        {/* faixa de estatísticas honestas */}
        <div className="mt-4 grid grid-cols-3 gap-3 border-t pt-3 text-center">
          <Stat value={pctLabel(s.provenPct)} label="provado" hint={`${s.proven.toLocaleString("pt-BR")} arestas no tier provado (runtime + compilador + config)`} />
          <Stat value={pctLabel(s.ratioPct)} label="visto rodar" hint={`${s.observed.toLocaleString("pt-BR")} arestas observadas em tráfego real (OTel)`} />
          <Stat value={s.unobserved.toLocaleString("pt-BR")} label="nunca observadas" hint="arestas que o Sentinel nunca viu executar em runtime" />
        </div>
        {nodeObsPct != null && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Radar className="h-3 w-3" /> nós exercitados em runtime</span>
              <span className="tabular-nums">{s.nodesObserved}/{s.nodesTotal} ({pctLabel(nodeObsPct)})</span>
            </div>
            <Progress value={nodeObsPct} className="h-1.5" />
          </div>
        )}
        {/* ADR-0035 — a confiança deixa de ser peso de projeto e vira medida (ou
            ABSTÉM, dizendo por quê). Ausente no /graph antigo: não renderiza. */}
        <CalibrationBands calibration={coverage?.calibration} />
      </CardContent>
    </Card>
  );
}

// ── vitrine do BIMR: busca a própria fonte (/bimr) e delega o render ──
function BlindSpotSection({ projectId }: { projectId: number }) {
  const q = useQuery<BimrPayload>({
    queryKey: [`/api/projects/${projectId}/bimr`],
    retry: false,
  });
  return (
    <BlindSpotPanel
      data={q.data}
      isLoading={q.isLoading}
      isError={q.isError}
      error={q.error as Error | null}
      onRetry={() => void q.refetch()}
    />
  );
}

function Stat({ value, label, hint }: { value: string; label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default">
          <div className="text-lg font-bold tabular-nums leading-tight">{value}</div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{hint}</TooltipContent>
    </Tooltip>
  );
}

// ── peça 2: a testemunha por trás de cada afirmação ───────────────────
function WitnessTags({ methods }: { methods: EvidenceMethod[] }) {
  if (!methods.length) {
    return <span className="text-xs text-muted-foreground">sem eixo de evidência</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      {methods.map((m) => {
        const meta = EVIDENCE[m];
        const Icon = meta.icon;
        return (
          <span
            key={m}
            data-testid={`witness-${m}`}
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium"
            style={{ borderColor: meta.color, color: meta.color }}
          >
            <Icon className="h-3 w-3" /> {meta.label}
          </span>
        );
      })}
    </div>
  );
}

const CONF_FMT = (c: number) => `${Math.round(c * 100)}%`;

export function RankedNodeCard({ node }: { node: RankedNode }) {
  return (
    <div className="rounded-md border p-2.5" data-testid={`insight-node-${node.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-sm font-medium" title={node.id}>{node.label}</span>
            <Badge variant="outline" className="shrink-0 text-[10px]">{node.type}</Badge>
            {node.runtimeHot && (
              <Badge className="shrink-0 gap-1 bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[10px]" variant="secondary">
                <Flame className="h-3 w-3" /> rodou{typeof node.runtimeCount === "number" ? ` ×${node.runtimeCount}` : ""}
              </Badge>
            )}
          </div>
          {node.sourceFile && (
            <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground" title={node.sourceFile}>
              <FileCode2 className="h-3 w-3 shrink-0" /> {node.sourceFile}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="flex items-center gap-1 text-sm font-semibold tabular-nums">
            <LayersIcon className="h-3.5 w-3.5 text-muted-foreground" /> {node.degree}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">alcance</div>
        </div>
      </div>
      {/* a TESTEMUNHA: métodos + corroboração + confiança do elo mais forte */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <WitnessTags methods={node.methods} />
        {node.corroboratedBy >= 2 && (
          <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400" data-testid={`corroboration-${node.id}`}>
            corroborado por {node.corroboratedBy} fontes
          </span>
        )}
        {node.methods.length > 0 && (
          <span className="text-[11px] text-muted-foreground">
            elo mais forte: {EVIDENCE[node.strongest].label} · confiança {CONF_FMT(node.strongestConfidence)}
          </span>
        )}
      </div>
    </div>
  );
}

function InsightSection({
  title,
  hint,
  icon,
  nodes,
  emptyText,
}: {
  title: string;
  hint: string;
  icon: React.ReactNode;
  nodes: RankedNode[];
  emptyText: string;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">{icon} {title}</CardTitle>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent className="flex-1 space-y-2">
        {nodes.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          nodes.map((n) => <RankedNodeCard key={n.id} node={n} />)
        )}
      </CardContent>
    </Card>
  );
}

// ── vista principal ───────────────────────────────────────────────────
export function ProofsView({
  payload,
  projectId,
}: {
  payload: InsightGraph & { coverage?: GraphCoverage | null };
  /** ausente = a vitrine do BIMR não é montada (o resto da vista segue igual). */
  projectId?: number;
}) {
  const summary = useMemo(() => insightsSummary(payload), [payload]);
  const blast = useMemo(() => topBlastRadius(payload, 8), [payload]);
  const blind = useMemo(() => blindSpots(payload, 6), [payload]);
  const hot = useMemo(() => runtimeHotpaths(payload, 6), [payload]);

  return (
    <div className="min-h-0 flex-1 overflow-auto pr-1" data-testid="proofs-view">
      {!summary.hasEvidence && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300" data-testid="proofs-awaiting-evidence">
          Este snapshot ainda não traz o eixo de proveniência por aresta — o ranking mostra alcance,
          mas a corroboração e a repartição da prova <strong>acendem sozinhas</strong> quando o /graph
          passar a emitir <code>evidence</code>/<code>coverage</code> (re-analise o projeto).
        </div>
      )}

      {/* manchete + gráfico (peça 3) */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <EpistemicBreakdown coverage={payload.coverage} />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4 text-primary" /> O que importa, provado</CardTitle>
            <p className="text-xs text-muted-foreground">Leitura determinística do grafo — cada card cita a testemunha.</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <HeadStat value={summary.nodes.toLocaleString("pt-BR")} label="nós" />
              <HeadStat value={summary.corroborated.toLocaleString("pt-BR")} label="corroborados ≥2 fontes" tone="emerald" />
              <HeadStat value={summary.hot.toLocaleString("pt-BR")} label="vistos rodar" tone="rose" />
              <HeadStat value={summary.blind.toLocaleString("pt-BR")} label="pontos cegos" tone="amber" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* o que a leitura estática não vê (BIMR) */}
      {projectId != null && (
        <div className="mt-4">
          <BlindSpotSection projectId={projectId} />
        </div>
      )}

      {/* insights (peça 2) */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <InsightSection
          title="Maior alcance"
          hint="Nós cuja mudança repercute mais (grau no grafo de dependências)."
          icon={<LayersIcon className="h-4 w-4 text-primary" />}
          nodes={blast}
          emptyText="Sem nós com dependências."
        />
        <InsightSection
          title="Visto rodar"
          hint="Exercitado por tráfego real (traço OTel) — a prova mais forte."
          icon={<Flame className="h-4 w-4 text-rose-500" />}
          nodes={hot}
          emptyText="Nenhum nó observado em runtime neste snapshot."
        />
        <InsightSection
          title="Pontos cegos"
          hint="Só arestas não-resolvidas/desconhecidas — não sabemos provar como conectam."
          icon={<EyeOff className="h-4 w-4 text-amber-500" />}
          nodes={blind}
          emptyText="Nenhum ponto cego — todo nó conectado tem ≥1 prova."
        />
      </div>
    </div>
  );
}

function HeadStat({ value, label, tone }: { value: string; label: string; tone?: "emerald" | "rose" | "amber" }) {
  const color =
    tone === "emerald" ? "text-emerald-600 dark:text-emerald-400"
    : tone === "rose" ? "text-rose-600 dark:text-rose-400"
    : tone === "amber" ? "text-amber-600 dark:text-amber-400"
    : "";
  return (
    <div className="rounded-md border p-2 text-center">
      <div className={`text-xl font-bold tabular-nums leading-tight ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{label}</div>
    </div>
  );
}

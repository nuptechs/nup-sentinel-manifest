// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Radar Executivo" (componente).
//
// Anéis PROVADO (centro) → INFERIDO → CEGO. Cada blip é um domínio: o raio vem
// do share de arestas provadas dos membros (proven/total); sem aresta → anel
// CEGO com rótulo "sem evidência" (nunca posição fabricada). Cor herda o pior
// tier. A tendência é GLOBAL (não há história por domínio) — sparkline do
// observedRatio ao longo dos runs, com nota do limite.
// ─────────────────────────────────────────────
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Radar as RadarIcon } from "lucide-react";
import type { EvidenceGraphPayload } from "./evidence-diagrams";
import { EVIDENCE } from "./system-map-evidence";
import { computeDomainEvidence, type DomainsReport, type EdgeLite } from "./evidence-domains";
import { computeDiff, type EvidenceHistory } from "./evidence-diff";

const HALO: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "hsl(var(--card))",
  strokeWidth: 3,
  strokeLinejoin: "round",
};

const CX = 300;
const CY = 300;
const R_MAX = 250; // raio do anel CEGO (borda)
const RING_PROVEN = ["PROVADO", "INFERIDO", "CEGO"];

export default function RadarView({ payload, projectId }: { payload: EvidenceGraphPayload; projectId?: number | null }) {
  const en = projectId != null;
  const domainsQuery = useQuery<DomainsReport>({
    queryKey: en ? [`/api/projects/${projectId}/reasoner/domains?minSize=4`] : ["noop-radar-dom"],
    enabled: en,
    retry: false,
  });
  const historyQuery = useQuery<EvidenceHistory>({
    queryKey: en ? [`/api/projects/${projectId}/evidence-history?limit=30`] : ["noop-radar-hist"],
    enabled: en,
    retry: false,
  });

  const edges: EdgeLite[] = payload.edges;
  const domainEv = useMemo(() => computeDomainEvidence(domainsQuery.data, edges), [domainsQuery.data, edges]);

  // raio: quanto MAIS provado, mais perto do centro. Cego vai pra borda.
  const blips = useMemo(() => {
    const n = domainEv.length || 1;
    const maxSize = Math.max(1, ...domainEv.map((d) => d.size));
    return domainEv.map((d, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const blind = d.provenShare < 0;
      // provenShare 1 → r pequeno (centro); 0 → anel inferido; cego → borda.
      const norm = blind ? 1 : 1 - Math.max(0, Math.min(1, d.provenShare));
      const r = 40 + norm * (R_MAX - 50);
      return {
        d,
        blind,
        x: CX + Math.cos(a) * r,
        y: CY + Math.sin(a) * r,
        size: 6 + (d.size / maxSize) * 16,
      };
    });
  }, [domainEv]);

  const diff = useMemo(() => computeDiff(historyQuery.data), [historyQuery.data]);
  const trend = useMemo(() => {
    const pts = (historyQuery.data?.points ?? []).filter((p) => p.coverage && p.failed !== true);
    return pts.map((p) => p.coverage!.edges.observedRatio ?? 0);
  }, [historyQuery.data]);

  const provenCount = domainEv.filter((d) => !((d.provenShare) < 0) && d.provenShare >= 0.6).length;
  const blindCount = domainEv.filter((d) => d.provenShare < 0).length;

  return (
    <div className="flex flex-1 flex-col gap-4 lg:flex-row" data-testid="radar-view">
      <Card className="flex-1 overflow-auto">
        <CardHeader className="pb-1">
          <CardTitle className="flex items-center gap-2 text-sm">
            <RadarIcon className="h-4 w-4 text-primary" /> Domínios por evidência
          </CardTitle>
        </CardHeader>
        <CardContent>
          {domainsQuery.isLoading ? (
            <p className="py-16 text-center text-sm text-muted-foreground" data-testid="radar-loading">carregando domínios…</p>
          ) : domainEv.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground" data-testid="radar-empty">
              Nenhum domínio deste tamanho neste snapshot.
            </p>
          ) : (
            <svg viewBox="0 0 600 600" className="mx-auto w-full max-w-[560px]" role="img" aria-label="Radar de domínios por nível de evidência: centro provado, borda cego" data-testid="radar-svg">
              {/* anéis */}
              {[R_MAX, (R_MAX * 2) / 3, R_MAX / 3].map((r, i) => (
                <circle key={i} cx={CX} cy={CY} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={1} strokeDasharray="3 4" />
              ))}
              {RING_PROVEN.map((label, i) => (
                <text key={label} x={CX} y={CY - (i === 0 ? 30 : i === 1 ? (R_MAX * 2) / 3 - 6 : R_MAX - 6)} textAnchor="middle" fontSize={10} fontWeight={700} fill="hsl(var(--muted-foreground))" style={HALO}>
                  {label}
                </text>
              ))}
              {blips.map((b) => {
                const meta = EVIDENCE[b.d.worstTier];
                return (
                  <g key={b.d.id} data-testid={`radar-blip-${b.d.id}`}>
                    <circle cx={b.x} cy={b.y} r={b.size} fill={meta.color} opacity={b.blind ? 0.4 : 0.85} stroke={b.blind ? meta.color : "none"} strokeWidth={b.blind ? 1.5 : 0} strokeDasharray={b.blind ? "2 2" : undefined}>
                      <title>
                        {b.d.name} · {b.d.size} membros · pior tier {meta.label}
                        {b.blind ? " · CEGO (sem evidência)" : ` · ${Math.round(b.d.provenShare * 100)}% provado`}
                      </title>
                    </circle>
                    <text x={b.x} y={b.y - b.size - 3} textAnchor="middle" fontSize={9} fill="hsl(var(--foreground))" style={HALO}>
                      {b.blind ? "◌ " : ""}{shortName(b.d.name)}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </CardContent>
      </Card>

      <div className="flex w-full flex-col gap-4 lg:w-80">
        <Card data-testid="radar-summary">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Resumo executivo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Stat label="Domínios provados (≥60%)" value={provenCount} total={domainEv.length} tone="good" />
            <Stat label="Domínios cegos (sem evidência)" value={blindCount} total={domainEv.length} tone={blindCount > 0 ? "crit" : "good"} />
          </CardContent>
        </Card>

        <Card data-testid="radar-trend">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tendência de cobertura</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {trend.length < 2 ? (
              <p className="text-xs text-muted-foreground" data-testid="radar-trend-empty">
                Menos de 2 retratos válidos — sem tendência a mostrar.
              </p>
            ) : (
              <>
                <Sparkline values={trend} />
                <div className="flex items-baseline justify-between text-xs">
                  <span className="tabular-nums text-lg font-bold">{Math.round((diff.current?.observedRatio ?? 0) * 100)}%</span>
                  {diff.observedRatioDelta != null && (
                    <span className={diff.observedRatioDelta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"} data-testid="radar-trend-delta">
                      {diff.observedRatioDelta >= 0 ? "+" : ""}{Math.round(diff.observedRatioDelta * 100)} pts desde {diff.previous?.sha}
                    </span>
                  )}
                </div>
              </>
            )}
            <p className="text-[11px] text-muted-foreground">
              A história é do sistema (não há série por domínio) — os blips mostram o agora.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function shortName(s: string): string {
  return s.length > 18 ? s.slice(0, 17) + "…" : s;
}

function Stat({ label, value, total, tone }: { label: string; value: number; total: number; tone: "good" | "crit" }) {
  const color = tone === "crit" ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums font-semibold ${color}`}>
        {value}
        <span className="ml-1 text-xs font-normal text-muted-foreground">/ {total}</span>
      </span>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 260;
  const h = 44;
  const max = Math.max(...values, 0.01);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Tendência do percentual observado ao longo dos runs" data-testid="radar-sparkline">
      <polyline points={pts.join(" ")} fill="none" stroke="#10b981" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={w} cy={h - ((values[values.length - 1] - min) / span) * (h - 6) - 3} r={3} fill="#10b981" />
    </svg>
  );
}

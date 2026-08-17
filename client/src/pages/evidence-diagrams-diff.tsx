// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Diff + Andon" (componente).
//
// Dois retratos VÁLIDOS lado a lado (small multiples, nunca animação) + delta
// por método + Andon (a luz que confessa). Buracos da série (coverage:null /
// failed) aparecem rotulados, nunca como zero. graph-drift tolera 404
// (1 snapshot só = "sem diff ainda").
// ─────────────────────────────────────────────
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowDownRight, ArrowUpRight, GitCompareArrows, Minus } from "lucide-react";
import type { EvidenceGraphPayload } from "./evidence-diagrams";
import { EVIDENCE, type EvidenceMethod } from "./system-map-evidence";
import {
  buildAndon,
  computeDiff,
  type DriftLike,
  type EvidenceHistory,
  type HealthLike,
  type Snapshot,
} from "./evidence-diff";

const ANDON_COLOR: Record<string, string> = { good: "#10b981", warn: "#f59e0b", crit: "#ef4444" };

export default function DiffView({ projectId }: { payload: EvidenceGraphPayload; projectId?: number | null }) {
  const en = projectId != null;
  const historyQuery = useQuery<EvidenceHistory>({
    queryKey: en ? [`/api/projects/${projectId}/evidence-history?limit=30`] : ["noop-diff-hist"],
    enabled: en,
    retry: false,
  });
  const healthQuery = useQuery<HealthLike>({
    queryKey: en ? [`/api/projects/${projectId}/evidence-health`] : ["noop-diff-health"],
    enabled: en,
    retry: false,
  });
  const driftQuery = useQuery<DriftLike>({
    queryKey: en ? [`/api/projects/${projectId}/graph-drift`] : ["noop-diff-drift"],
    enabled: en,
    retry: false, // 404 NEED_TWO_SNAPSHOTS é esperado (1 snapshot só)
  });

  const diff = useMemo(() => computeDiff(historyQuery.data), [historyQuery.data]);
  const andon = useMemo(
    () => buildAndon(healthQuery.data, driftQuery.isError ? null : driftQuery.data, diff),
    [healthQuery.data, driftQuery.data, driftQuery.isError, diff],
  );

  if (historyQuery.isLoading) return <Card className="flex-1 animate-pulse" data-testid="diff-loading" />;

  if (!diff.current) {
    return (
      <Card className="flex flex-1 items-center justify-center" data-testid="diff-empty">
        <div className="max-w-md py-16 text-center">
          <GitCompareArrows className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">Sem retrato válido</h3>
          <p className="text-sm text-muted-foreground">
            O histórico não tem nenhum ponto com cobertura registrada{diff.holes > 0 ? ` (${diff.holes} buraco(s) — runs sem overlay ou falhos)` : ""}.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="diff-view">
      {diff.holes > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="diff-holes-note">
          {diff.holes} ponto(s) da série sem cobertura (run falho ou sem overlay) — mostrados como buraco, nunca como zero.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1.1fr]">
        <SnapshotCard title="Retrato anterior" snap={diff.previous} testid="diff-prev" />
        <SnapshotCard title="Retrato atual" snap={diff.current} testid="diff-curr" />

        {/* Andon */}
        <Card data-testid="diff-andon">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Andon — o grafo confessa</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {andon.map((it, i) => (
              <div key={i} className="flex gap-2 text-xs" data-testid={`diff-andon-${i}`}>
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: ANDON_COLOR[it.level] }} aria-hidden="true" />
                <div>
                  <div className="font-medium">{it.title}</div>
                  <div className="text-muted-foreground">{it.detail}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{it.source}</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* delta por método */}
      <Card data-testid="diff-deltas">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Delta por método {diff.previous ? `· ${diff.previous.sha} → ${diff.current.sha}` : "· (sem retrato anterior)"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {diff.deltas.map((d) => {
            const meta = EVIDENCE[d.method];
            const Icon = d.delta > 0 ? ArrowUpRight : d.delta < 0 ? ArrowDownRight : Minus;
            const color = d.delta > 0 ? "#10b981" : d.delta < 0 ? "#ef4444" : "hsl(var(--muted-foreground))";
            return (
              <div key={d.method} className="flex items-center gap-2 text-xs" data-testid={`diff-delta-${d.method}`}>
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                <span className="w-40 shrink-0">{meta.label}</span>
                <span className="tabular-nums text-muted-foreground">{d.before.toLocaleString("pt-BR")} → {d.after.toLocaleString("pt-BR")}</span>
                <span className="ml-auto flex items-center gap-0.5 tabular-nums" style={{ color }}>
                  <Icon className="h-3 w-3" /> {d.delta > 0 ? "+" : ""}{d.delta.toLocaleString("pt-BR")}
                </span>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function SnapshotCard({ title, snap, testid }: { title: string; snap: Snapshot | null; testid: string }) {
  return (
    <Card data-testid={testid}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          {title}
          {snap && (
            <Badge variant="secondary" className="font-mono text-[10px]" data-testid={`${testid}-sha`}>
              {snap.sha}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!snap ? (
          <p className="py-6 text-center text-xs text-muted-foreground" data-testid={`${testid}-hole`}>
            sem retrato anterior válido — buraco, não zero
          </p>
        ) : (
          <>
            <div className="mb-2 text-xs text-muted-foreground">
              {snap.date ? new Date(snap.date).toLocaleString("pt-BR") : "sem data"} · {snap.total.toLocaleString("pt-BR")} arestas ·{" "}
              {Math.round(snap.observedRatio * 100)}% observado
            </div>
            <MiniBars snap={snap} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function MiniBars({ snap }: { snap: Snapshot }) {
  const methods = Object.keys(snap.byMethod).filter((m) => (snap.byMethod[m as EvidenceMethod] || 0) > 0) as EvidenceMethod[];
  const max = Math.max(1, ...methods.map((m) => snap.byMethod[m] || 0));
  return (
    <div className="space-y-1">
      {methods.map((m) => {
        const v = snap.byMethod[m] || 0;
        const meta = EVIDENCE[m];
        return (
          <div key={m} className="flex items-center gap-2 text-[11px]">
            <span className="w-24 shrink-0 truncate text-muted-foreground">{meta.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full rounded" style={{ width: `${Math.max(3, (v / max) * 100)}%`, backgroundColor: meta.color }} />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums">{v.toLocaleString("pt-BR")}</span>
          </div>
        );
      })}
    </div>
  );
}

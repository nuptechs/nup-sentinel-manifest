// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Conformidade: desenhado × executado".
//
// Não é process-mining (não existe no Manifest — decisão declarada). É o
// análogo real, com 3 faixas honestas: CONFIRMADO (censo por método do /graph)
// · DESENHADO, NUNCA VISTO (/reasoner/runtime-gap: pontos de entrada com 0
// execução) · VISTO SEM DESENHO (/bimr: tabelas mintadas + entidades hot sem
// inbound estático → finding pro Tribunal). Respeita available/measurable.
// ─────────────────────────────────────────────
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, EyeOff, PencilRuler, Scale } from "lucide-react";
import type { EvidenceGraphPayload } from "./evidence-diagrams";
import { EVIDENCE, EVIDENCE_ORDER, PROVEN_TIER, type EvidenceMethod } from "./system-map-evidence";

interface UncoveredEntry {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  reach: number;
  hint?: string;
}
interface RuntimeGapReport {
  totalEntries?: number;
  observedEntries?: number;
  coverage?: number;
  uncovered?: UncoveredEntry[];
}
interface MintedTable {
  id: string;
  table: string;
  runtimeCount?: number;
  likelyInfrastructure?: boolean;
}
interface BimrReport {
  available?: boolean;
  measurable?: boolean;
  reason?: string;
  tablesMintedRuntimeOnly?: number;
  mintedRatio?: number;
  minted?: MintedTable[];
  entitiesHotWithoutStaticInbound?: { count?: number; nodes?: Array<{ id: string; label?: string; runtimeCount?: number }> };
  caveats?: string[];
}

export default function ConformanceView({
  payload,
  projectId,
}: {
  payload: EvidenceGraphPayload;
  projectId?: number | null;
}) {
  const en = projectId != null;
  const gapQuery = useQuery<RuntimeGapReport>({
    queryKey: en ? [`/api/projects/${projectId}/reasoner/runtime-gap`] : ["noop-conf-gap"],
    enabled: en,
    retry: false,
  });
  const bimrQuery = useQuery<BimrReport>({
    queryKey: en ? [`/api/projects/${projectId}/bimr`] : ["noop-conf-bimr"],
    enabled: en,
    retry: false,
  });

  const byMethod = payload.coverage?.edges.byMethod ?? {};
  const total = payload.coverage?.edges.total ?? 0;
  const provenTotal = EVIDENCE_ORDER.filter((m) => PROVEN_TIER.has(m)).reduce((s, m) => s + (byMethod[m] || 0), 0);

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="conformance-view">
      <div className="grid gap-4 lg:grid-cols-3">
        {/* FAIXA 1 — Confirmado (censo por método) */}
        <Card data-testid="conformance-confirmed">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Confirmado
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {total === 0 ? (
              <p className="text-sm text-muted-foreground">Sem censo de cobertura neste snapshot.</p>
            ) : (
              <>
                <div className="text-2xl font-bold tabular-nums" data-testid="conformance-proven-total">
                  {provenTotal.toLocaleString("pt-BR")}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">/ {total.toLocaleString("pt-BR")} arestas provadas</span>
                </div>
                <MethodBars byMethod={byMethod} total={total} />
                <p className="text-xs text-muted-foreground">
                  Censo sobre a aresta crua (invariante de view). Provado = runtime ∨ compilador ∨ config/DI.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* FAIXA 2 — Desenhado, nunca visto */}
        <Card data-testid="conformance-drawn-unseen">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <PencilRuler className="h-4 w-4 text-amber-500" /> Desenhado, nunca visto
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {gapQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">carregando…</p>
            ) : gapQuery.isError ? (
              <p className="text-sm text-muted-foreground">runtime-gap indisponível.</p>
            ) : (
              <>
                <div className="text-2xl font-bold tabular-nums" data-testid="conformance-uncovered-count">
                  {(gapQuery.data?.uncovered?.length ?? 0).toLocaleString("pt-BR")}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    de {(gapQuery.data?.totalEntries ?? 0).toLocaleString("pt-BR")} entradas
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {(gapQuery.data?.uncovered ?? []).slice(0, 8).map((u) => (
                    <li key={u.nodeId} className="rounded border bg-muted/30 px-2 py-1 text-xs" data-testid={`conformance-uncovered-${u.nodeId}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{u.label}</span>
                        <Badge variant="secondary" className="shrink-0">alcança {u.reach}</Badge>
                      </div>
                      {u.sourceFile && <div className="truncate text-muted-foreground">{u.sourceFile}</div>}
                    </li>
                  ))}
                </ul>
                {(gapQuery.data?.uncovered?.length ?? 0) === 0 && (
                  <p className="text-sm text-muted-foreground">Toda entrada conhecida foi exercitada — 0 pontos cegos.</p>
                )}
                <p className="text-xs text-muted-foreground">0 execução na janela: código morto? job raro? feature desligada?</p>
              </>
            )}
          </CardContent>
        </Card>

        {/* FAIXA 3 — Visto sem desenho (bimr) */}
        <Card data-testid="conformance-seen-undrawn">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <EyeOff className="h-4 w-4 text-rose-500" /> Visto sem desenho
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {bimrQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">carregando…</p>
            ) : bimrQuery.isError ? (
              <p className="text-sm text-muted-foreground">bimr indisponível.</p>
            ) : bimrQuery.data?.available === false || bimrQuery.data?.measurable === false ? (
              <div className="rounded border border-dashed px-3 py-4 text-xs text-muted-foreground" data-testid="conformance-bimr-unmeasurable">
                <AlertTriangle className="mb-1 h-4 w-4" />
                Não mensurável neste snapshot{bimrQuery.data?.reason ? ` — ${bimrQuery.data.reason}` : ""}. Não é erro: falta tráfego ancorável a tabela.
              </div>
            ) : (
              <>
                <div className="text-2xl font-bold tabular-nums" data-testid="conformance-minted-count">
                  {(bimrQuery.data?.tablesMintedRuntimeOnly ?? 0).toLocaleString("pt-BR")}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">tabelas mintadas</span>
                </div>
                <ul className="space-y-1.5">
                  {(bimrQuery.data?.minted ?? []).slice(0, 8).map((m) => (
                    <li key={m.id} className="flex items-center justify-between rounded border bg-muted/30 px-2 py-1 text-xs" data-testid={`conformance-minted-${m.id}`}>
                      <span className="font-medium">{m.table}{m.likelyInfrastructure ? " (infra)" : ""}</span>
                      {m.runtimeCount != null && <Badge variant="secondary">{m.runtimeCount}×</Badge>}
                    </li>
                  ))}
                </ul>
                {(bimrQuery.data?.entitiesHotWithoutStaticInbound?.count ?? 0) > 0 && (
                  <p className="text-xs text-rose-600 dark:text-rose-400" data-testid="conformance-hot-orphan">
                    {bimrQuery.data!.entitiesHotWithoutStaticInbound!.count} entidade(s) quente(s) sem inbound estático → finding pro Tribunal.
                  </p>
                )}
                {(bimrQuery.data?.caveats ?? []).map((c, i) => (
                  <p key={i} className="text-xs text-muted-foreground">⚠ {c}</p>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Scale className="h-3.5 w-3.5" /> Conformidade real = o mapa desenhado × o tráfego observado. Nenhum número é
        estimado — cada faixa vem de um endpoint que se abstém quando não sabe.
      </p>
    </div>
  );
}

function MethodBars({ byMethod, total }: { byMethod: Partial<Record<EvidenceMethod, number>>; total: number }) {
  return (
    <div className="space-y-1" data-testid="conformance-method-bars">
      {EVIDENCE_ORDER.map((m) => {
        const v = byMethod[m] || 0;
        if (v === 0) return null;
        const pct = total ? (v / total) * 100 : 0;
        const meta = EVIDENCE[m];
        return (
          <div key={m} className="flex items-center gap-2 text-xs" data-testid={`conformance-bar-${m}`}>
            <span className="w-28 shrink-0 text-muted-foreground">{meta.label}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full rounded" style={{ width: `${Math.max(2, pct)}%`, backgroundColor: meta.color }} />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums">{v.toLocaleString("pt-BR")}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Metro Map de Requisições" (componente).
//
// Seletor de até 4 rotas (do /reasoner/sequence/catalog, observadas primeiro);
// cada rota selecionada busca seu /reasoner/sequence próprio (4 slots FIXOS de
// useQuery — nada de hooks dinâmicos). O layout octilinear vem do helper puro;
// baldeações (participante em 2+ linhas) ganham anel + badge "N linhas".
// ─────────────────────────────────────────────
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, TrainFront } from "lucide-react";
import type { EvidenceGraphPayload } from "./evidence-diagrams";
import {
  buildMetroLayout,
  METRO_CONF_STYLE,
  type MetroLineInput,
  type SequenceModel,
} from "./evidence-metro";

const HALO: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "hsl(var(--card))",
  strokeWidth: 3,
  strokeLinejoin: "round",
};

interface CatalogEntry {
  id: string;
  label: string;
  kind: string;
  httpMethod?: string;
  httpPath?: string;
  observed?: boolean;
}
interface CatalogResponse {
  total?: number;
  observed?: number;
  entries?: CatalogEntry[];
}
interface SequenceResponse {
  model?: SequenceModel;
}

const MAX_LINES = 4;

export default function MetroView({ projectId }: { payload: EvidenceGraphPayload; projectId?: number | null }) {
  const catalogQuery = useQuery<CatalogResponse>({
    queryKey:
      projectId != null ? [`/api/projects/${projectId}/reasoner/sequence/catalog`] : ["noop-metro-cat"],
    enabled: projectId != null,
    retry: false,
  });

  const entries = useMemo(() => catalogQuery.data?.entries ?? [], [catalogQuery.data]);
  // default: as 4 primeiras rotas observadas (o catálogo já vem com observadas na frente).
  const [selected, setSelected] = useState<string[] | null>(null);
  const effectiveSelected = useMemo(() => {
    if (selected != null) return selected;
    const routes = entries.filter((e) => e.kind === "route");
    return routes.slice(0, MAX_LINES).map((e) => e.id);
  }, [selected, entries]);

  function toggle(id: string) {
    const base = effectiveSelected;
    if (base.includes(id)) {
      setSelected(base.filter((x) => x !== id));
    } else if (base.length < MAX_LINES) {
      setSelected([...base, id]);
    }
  }

  // 4 slots FIXOS de useQuery — a regra dos hooks proíbe contagem dinâmica.
  const slotIds = [0, 1, 2, 3].map((i) => effectiveSelected[i] ?? null);
  const q0 = useSequence(projectId, slotIds[0]);
  const q1 = useSequence(projectId, slotIds[1]);
  const q2 = useSequence(projectId, slotIds[2]);
  const q3 = useSequence(projectId, slotIds[3]);
  const slotQueries = [q0, q1, q2, q3];

  const labelFor = (id: string) => entries.find((e) => e.id === id)?.label || id;

  const layout = useMemo(() => {
    const inputs: MetroLineInput[] = effectiveSelected
      .slice(0, MAX_LINES)
      .map((id, i) => ({ routeLabel: labelFor(id), model: slotQueries[i].data?.model }));
    return buildMetroLayout(inputs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSelected, q0.data, q1.data, q2.data, q3.data, entries]);

  if (catalogQuery.isLoading) {
    return <Card className="flex-1 animate-pulse" data-testid="metro-loading" />;
  }
  if (catalogQuery.isError) {
    return (
      <Card className="flex flex-1 items-center justify-center border-destructive/40" data-testid="metro-error">
        <div className="max-w-md py-16 text-center text-sm text-muted-foreground">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" />
          O catálogo de rotas não respondeu. Tente novamente.
        </div>
      </Card>
    );
  }
  if (entries.filter((e) => e.kind === "route").length === 0) {
    return (
      <Card className="flex flex-1 items-center justify-center" data-testid="metro-empty">
        <div className="max-w-md py-16 text-center">
          <TrainFront className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">Nenhuma rota no catálogo</h3>
          <p className="text-sm text-muted-foreground">
            Este snapshot não tem pontos de entrada de rota. Rode uma análise para alimentar o mapa.
          </p>
        </div>
      </Card>
    );
  }

  const routeEntries = entries.filter((e) => e.kind === "route");

  return (
    <div className="flex flex-1 flex-col gap-3" data-testid="metro-view">
      <style>{`
        @keyframes evidence-runtime-pulse { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
        @media (prefers-reduced-motion: no-preference) {
          .metro-pulse { stroke-dasharray: 10 4; animation: evidence-runtime-pulse 1.2s linear infinite; }
        }
      `}</style>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Linhas (máx {MAX_LINES}):</span>
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto" data-testid="metro-route-picker">
          {routeEntries.slice(0, 24).map((e) => {
            const on = effectiveSelected.includes(e.id);
            return (
              <Button
                key={e.id}
                variant={on ? "secondary" : "ghost"}
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={() => toggle(e.id)}
                disabled={!on && effectiveSelected.length >= MAX_LINES}
                data-testid={`metro-route-${e.id}`}
              >
                {e.observed && <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden="true" />}
                {e.label}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <LegendSwatch label="observado" pulse />
        <LegendSwatch label="provado" />
        <LegendSwatch label="inferido" dash />
        <Badge variant="secondary" className="gap-1" data-testid="metro-interchange-legend">
          ◎ baldeação = ponto de acoplamento
        </Badge>
      </div>

      <Card className="flex-1 overflow-auto">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="w-full"
          style={{ minHeight: "60vh" }}
          role="img"
          aria-label="Mapa de metrô das requisições — linhas são rotas, estações são serviços e tabelas, baldeações são pontos de acoplamento"
          data-testid="metro-svg"
        >
          {/* linhas */}
          {layout.lines.map((ln, li) => (
            <g key={li} data-testid={`metro-line-${li}`}>
              <text x={12} y={ln.y + 4} fontSize={11} fontWeight={700} fill={ln.color} style={HALO}>
                L{li + 1}
              </text>
              <text x={12} y={ln.y - 14} fontSize={10} fill="hsl(var(--muted-foreground))" style={HALO}>
                {ln.routeLabel}
              </text>
              {ln.empty && (
                <text x={COL_LABEL_X} y={ln.y + 4} fontSize={10} fill="hsl(var(--muted-foreground))" style={HALO}>
                  sequência não pôde ser traçada (fonte: {ln.source ?? "—"})
                </text>
              )}
              {ln.segments.map((sg, si) => {
                const st = METRO_CONF_STYLE[sg.confidence];
                return (
                  <line
                    key={si}
                    x1={sg.x1}
                    y1={ln.y}
                    x2={sg.x2}
                    y2={ln.y}
                    stroke={ln.color}
                    strokeWidth={7}
                    strokeLinecap="round"
                    className={st.pulse ? "metro-pulse" : undefined}
                    strokeDasharray={st.pulse ? undefined : st.dash}
                    opacity={sg.confidence === "inferred" ? 0.55 : 0.9}
                    data-testid={`metro-seg-${li}-${si}`}
                  >
                    <title>{st.label}</title>
                  </line>
                );
              })}
              {ln.stations.map((s) => (
                <g key={s.id} data-testid={`metro-station-${li}-${s.col}`}>
                  {s.interchange >= 2 ? (
                    <>
                      <circle cx={s.x} cy={ln.y} r={11} fill="hsl(var(--card))" stroke="hsl(var(--foreground))" strokeWidth={3} />
                      <circle cx={s.x} cy={ln.y} r={16} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth={1.2} opacity={0.6} />
                    </>
                  ) : s.isDb ? (
                    <rect x={s.x - 7} y={ln.y - 7} width={14} height={14} rx={2} fill="hsl(var(--card))" stroke={ln.color} strokeWidth={3} />
                  ) : (
                    <circle cx={s.x} cy={ln.y} r={7} fill="hsl(var(--card))" stroke={ln.color} strokeWidth={3} />
                  )}
                </g>
              ))}
            </g>
          ))}
          {/* rótulos de coluna (uma vez, no topo) — baldeações levam o badge */}
          {layout.columnLabels.map((c) => (
            <g key={c.id}>
              <text x={c.x} y={40} textAnchor="middle" fontSize={11} fontWeight={c.interchange >= 2 ? 700 : 500} fill="hsl(var(--foreground))" style={HALO}>
                {c.isDb ? "▤ " : ""}
                {c.label}
              </text>
              {c.interchange >= 2 && (
                <text x={c.x} y={54} textAnchor="middle" fontSize={9} fill="hsl(var(--muted-foreground))" style={HALO}>
                  baldeação · {c.interchange} linhas
                </text>
              )}
            </g>
          ))}
        </svg>
      </Card>
    </div>
  );
}

const COL_LABEL_X = 150;

function useSequence(projectId: number | null | undefined, entryId: string | null) {
  return useQuery<SequenceResponse>({
    queryKey:
      projectId != null && entryId
        ? [`/api/projects/${projectId}/reasoner/sequence?entry=${encodeURIComponent(entryId)}&maxSteps=40`]
        : ["noop-metro-seq", entryId ?? "none"],
    enabled: projectId != null && !!entryId,
    retry: false,
  });
}

function LegendSwatch({ label, pulse, dash }: { label: string; pulse?: boolean; dash?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground" data-testid={`metro-legend-${label}`}>
      <svg width={22} height={8} aria-hidden="true">
        <line
          x1={1}
          y1={4}
          x2={21}
          y2={4}
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={dash ? "5 4" : undefined}
          opacity={dash ? 0.6 : 0.9}
          className={pulse ? "metro-pulse" : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

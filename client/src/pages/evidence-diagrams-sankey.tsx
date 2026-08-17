// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Sankey de Autorização" (componente).
//
// Junta 4 relatórios reais (permission-governance + sensitive-exposure +
// entity-access + sequence/catalog) em Guarda → Permissão → Rota → Tabela.
// Largura = nº de endpoints (estático honesto). Fluxo fantasma (rota nunca
// observada) = tracejado; fluxo sem guarda = crítico. Cada fonte degrada
// sozinha — sem governança, a vista mostra o vazio honesto.
// ─────────────────────────────────────────────
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Share2 } from "lucide-react";
import type { EvidenceGraphPayload } from "./evidence-diagrams";
import {
  buildFlowUnits,
  buildSankeyModel,
  SANKEY_COLS,
  SANKEY_NODE_W,
  type CatalogLite,
  type EntityAccessReport,
  type ExposureReport,
  type GovernanceReport,
  type SankeyNode,
} from "./evidence-sankey";

const HALO: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "hsl(var(--card))",
  strokeWidth: 3,
  strokeLinejoin: "round",
};

const COL_X = [70, 340, 640, 940];
const CRIT = "#ef4444";
const GHOST = "#94a3b8";
const FLOW = "#0ea5e9";

export default function SankeyView({ projectId }: { payload: EvidenceGraphPayload; projectId?: number | null }) {
  const key = (suffix: string) =>
    projectId != null ? [`/api/projects/${projectId}/${suffix}`] : [`noop-sankey-${suffix}`];
  const en = projectId != null;

  const govQuery = useQuery<GovernanceReport>({ queryKey: key("permission-governance"), enabled: en, retry: false });
  const expQuery = useQuery<ExposureReport>({ queryKey: key("sensitive-exposure"), enabled: en, retry: false });
  const entQuery = useQuery<EntityAccessReport>({ queryKey: key("entity-access"), enabled: en, retry: false });
  const catQuery = useQuery<CatalogLite>({ queryKey: key("reasoner/sequence/catalog"), enabled: en, retry: false });

  const model = useMemo(() => {
    const units = buildFlowUnits(govQuery.data, expQuery.data, entQuery.data, catQuery.data);
    return buildSankeyModel(units);
  }, [govQuery.data, expQuery.data, entQuery.data, catQuery.data]);

  if (govQuery.isLoading) return <Card className="flex-1 animate-pulse" data-testid="sankey-loading" />;

  if (govQuery.isError) {
    return (
      <Card className="flex flex-1 items-center justify-center border-destructive/40" data-testid="sankey-error">
        <div className="max-w-md py-16 text-center text-sm text-muted-foreground">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" />
          A governança de permissões não respondeu. Tente novamente.
        </div>
      </Card>
    );
  }

  if (model.empty) {
    return (
      <Card className="flex flex-1 items-center justify-center" data-testid="sankey-empty">
        <div className="max-w-md py-16 text-center">
          <Share2 className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">Nenhum endpoint catalogado</h3>
          <p className="text-sm text-muted-foreground">
            Este snapshot não tem endpoints com permissão nem rotas sem guarda para desenhar o fluxo de autorização.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3" data-testid="sankey-view">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary" data-testid="sankey-stat-endpoints">{model.stats.endpoints} endpoints</Badge>
        {model.stats.unguarded > 0 && (
          <Badge variant="destructive" data-testid="sankey-stat-unguarded">{model.stats.unguarded} sem guarda</Badge>
        )}
        {model.stats.ghost > 0 && (
          <Badge variant="secondary" className="gap-1" data-testid="sankey-stat-ghost">
            <span style={{ color: GHOST }}>◌</span> {model.stats.ghost} permitidos · nunca observados
          </Badge>
        )}
        <Badge variant="secondary" data-testid="sankey-stat-tables">{model.stats.tables} tabelas</Badge>
        {entQuery.isError && (
          <span className="text-muted-foreground" data-testid="sankey-entity-degraded">
            entity-access indisponível — coluna Tabela reduzida
          </span>
        )}
      </div>

      <Card className="flex-1 overflow-auto">
        <svg
          viewBox={`0 0 ${model.width} ${model.height}`}
          className="w-full"
          style={{ minHeight: "60vh" }}
          role="img"
          aria-label="Sankey de autorização: guarda, permissão, rota e tabela, com largura proporcional ao número de endpoints"
          data-testid="sankey-svg"
        >
          {/* cabeçalhos de coluna */}
          {SANKEY_COLS.map((label, c) => (
            <text key={label} x={COL_X[c] + SANKEY_NODE_W / 2} y={22} textAnchor="middle" fontSize={11} fontWeight={700} fill="hsl(var(--muted-foreground))" style={HALO}>
              {label}
            </text>
          ))}

          {/* links (fitas) */}
          {model.links.map((lk, i) => {
            const color = lk.critical ? CRIT : lk.ghost ? GHOST : FLOW;
            const mx = (lk.sx + lk.tx) / 2;
            const d = `M ${lk.sx} ${lk.sy0} C ${mx} ${lk.sy0}, ${mx} ${lk.ty0}, ${lk.tx} ${lk.ty0} L ${lk.tx} ${lk.ty1} C ${mx} ${lk.ty1}, ${mx} ${lk.sy1}, ${lk.sx} ${lk.sy1} Z`;
            return (
              <path
                key={i}
                d={d}
                fill={color}
                opacity={lk.ghost ? 0.14 : lk.critical ? 0.3 : 0.22}
                stroke={lk.ghost ? color : "none"}
                strokeWidth={lk.ghost ? 1 : 0}
                strokeDasharray={lk.ghost ? "5 4" : undefined}
                data-testid={`sankey-link-${i}`}
              >
                <title>
                  {lk.count} endpoint(s){lk.critical ? " · SEM GUARDA" : ""}{lk.ghost ? " · nunca observado" : ""}
                </title>
              </path>
            );
          })}

          {/* nós */}
          {model.nodes.map((n) => (
            <SankeyNodeRect key={n.id} node={n} />
          ))}
        </svg>
      </Card>
    </div>
  );
}

function SankeyNodeRect({ node }: { node: SankeyNode }) {
  const crit = node.kind === "guard" && node.guard === "none";
  const fill = crit ? CRIT : node.ghost ? GHOST : "hsl(var(--foreground))";
  const labelRight = node.col >= 2;
  const tx = labelRight ? node.x - 6 : node.x + SANKEY_NODE_W + 6;
  const anchor = labelRight ? "end" : "start";
  const cy = (node.y0 + node.y1) / 2;
  return (
    <g data-testid={`sankey-node-${node.id}`}>
      <rect x={node.x} y={node.y0} width={SANKEY_NODE_W} height={Math.max(4, node.y1 - node.y0)} rx={2} fill={fill} opacity={node.ghost ? 0.5 : 0.85}>
        <title>
          {node.label} · {node.count}
          {node.aggregated ? ` (${node.aggregated} agregadas)` : ""}
          {node.ghost ? " · nunca observada" : ""}
        </title>
      </rect>
      <text x={tx} y={cy + 3} textAnchor={anchor} fontSize={10} fontWeight={crit ? 700 : 500} fill={crit ? CRIT : "hsl(var(--foreground))"} style={HALO}>
        {node.ghost ? "◌ " : ""}
        {truncate(node.label, 26)}
        <tspan fill="hsl(var(--muted-foreground))"> · {node.count}</tspan>
      </text>
    </g>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

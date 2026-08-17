// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Uma Geometria, N Lentes" (componente).
//
// A geometria (colunas por camada) é FIXA — trocar de lente muda só cor/
// estilo/realce (invariância travada em teste no evidence-lenses.test.ts).
// A lente Sensível+Guarda busca /permission-governance por conta própria e
// degrada sozinha (sem governança → só os nós `sensitive` acendem, com nota).
// ─────────────────────────────────────────────
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Boxes } from "lucide-react";
import {
  LENSES,
  LENS_COLUMNS,
  LENS_VIEW,
  applyLens,
  buildLensGeometry,
  type GovernanceLike,
  type LensGraph,
  type LensId,
} from "./evidence-lenses";
import { humanLabel } from "./evidence-label";

const HALO: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "hsl(var(--card))",
  strokeWidth: 3,
  strokeLinejoin: "round",
};

const COL_X = [90, 295, 500, 705, 910];

export default function LensesView({
  payload,
  projectId,
}: {
  payload: LensGraph;
  projectId?: number | null;
}) {
  const [lens, setLens] = useState<LensId>("evidence");

  // Fonte extra SÓ da lente Sensível+Guarda — degrada sozinha (erro vira nota,
  // a lente segue com o que o payload prova por si: os nós `sensitive`).
  const governanceQuery = useQuery<GovernanceLike>({
    queryKey: projectId != null ? [`/api/projects/${projectId}/permission-governance`] : ["noop-governance"],
    enabled: lens === "sensitive" && projectId != null,
    retry: false,
  });

  const geometry = useMemo(() => buildLensGeometry(payload), [payload]);
  const styles = useMemo(
    () => applyLens(lens, geometry, lens === "sensitive" ? governanceQuery.data : undefined),
    [lens, geometry, governanceQuery.data],
  );

  // Hover-pra-isolar: com um nó sob o cursor, acende só ele + suas arestas
  // incidentes e escurece o resto — é o que torna a geometria densa LEGÍVEL
  // (sem isso, 400 nós × N arestas viram hairball). O System Map já faz isso.
  const [hovered, setHovered] = useState<string | null>(null);
  const neighbors = useMemo(() => {
    if (!hovered) return null;
    const set = new Set<string>([hovered]);
    for (const le of geometry.edges) {
      if (le.edge.fromNode === hovered) set.add(le.edge.toNode);
      else if (le.edge.toNode === hovered) set.add(le.edge.fromNode);
    }
    return set;
  }, [hovered, geometry.edges]);
  const edgeLit = (le: (typeof geometry.edges)[number]) =>
    !hovered || le.edge.fromNode === hovered || le.edge.toNode === hovered;

  if (geometry.nodes.length === 0) {
    return (
      <Card className="flex flex-1 items-center justify-center" data-testid="lenses-empty">
        <div className="max-w-md py-16 text-center">
          <Boxes className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">Sem nós para olhar</h3>
          <p className="text-sm text-muted-foreground">
            O grafo deste snapshot não tem nós. Rode uma análise para gerar a geometria.
          </p>
        </div>
      </Card>
    );
  }

  const { width, height } = LENS_VIEW;

  return (
    <div className="flex flex-1 flex-col gap-3" data-testid="lenses-view">
      <style>{`
        @keyframes evidence-runtime-pulse { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
        .runtime-pulse { stroke-dasharray: 1 0; }
        @media (prefers-reduced-motion: no-preference) {
          .runtime-pulse { stroke-dasharray: 10 4; animation: evidence-runtime-pulse 1.2s linear infinite; }
        }
      `}</style>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5" data-testid="lens-switch">
          {LENSES.map((l) => (
            <Button
              key={l.id}
              variant={lens === l.id ? "secondary" : "ghost"}
              size="sm"
              className="h-8"
              onClick={() => setLens(l.id)}
              data-testid={`lens-${l.id}`}
            >
              {l.label}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {geometry.truncated && (
            <Badge variant="secondary" className="gap-1" data-testid="lenses-truncation">
              <AlertTriangle className="h-3 w-3" /> mostrando {geometry.shown} de {geometry.total} nós (por grau)
            </Badge>
          )}
          <Badge variant="secondary" data-testid="lenses-edge-count">
            {geometry.edges.length} arestas
          </Badge>
        </div>
      </div>

      <p className="text-xs text-muted-foreground" data-testid="lenses-hover-hint" aria-live="polite">
        {hovered ? (
          <>
            Isolando <b>{humanLabel(geometry.nodes.find((n) => n.node.id === hovered)!.node)}</b> e suas conexões — tire o
            mouse para ver tudo.
          </>
        ) : (
          <>Passe o mouse sobre um nó para isolar suas conexões (sem isso, a densidade vira ruído).</>
        )}
      </p>

      {lens === "sensitive" && governanceQuery.isError && (
        <p className="text-xs text-muted-foreground" data-testid="lenses-governance-degraded">
          /permission-governance indisponível — mostrando só o que o grafo prova por si (nós sensíveis);
          rotas sem guarda ficam de fora até a fonte voltar.
        </p>
      )}
      {lens === "recency" && (
        <p className="text-xs text-muted-foreground" data-testid="lenses-recency-note">
          O Manifest não tem histórico de co-mudança git (decisão declarada) — recência aqui é a última
          observação de runtime POR NÓ.
        </p>
      )}

      <Card className="flex-1 overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[70vh] w-full"
          role="img"
          aria-label="Geometria fixa do sistema sob a lente selecionada"
          data-testid="lenses-svg"
        >
          {/* cabeçalhos das colunas (a geometria que o olho aprende uma vez) */}
          {LENS_COLUMNS.map((label, c) => (
            <text
              key={label}
              x={COL_X[c]}
              y={22}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="hsl(var(--muted-foreground))"
              style={HALO}
            >
              {label}
            </text>
          ))}

          {geometry.edges.map((le, i) => {
            const s = styles.edges[i];
            const lit = edgeLit(le);
            return (
              <path
                key={i}
                d={`M ${le.x1} ${le.y1} Q ${le.qx} ${le.qy} ${le.x2} ${le.y2}`}
                fill="none"
                className={s.pulse && lit ? "runtime-pulse" : undefined}
                stroke={s.color}
                strokeWidth={lit && hovered ? 2 : 1.4}
                strokeDasharray={s.pulse && lit ? undefined : s.dash}
                opacity={lit ? s.opacity : 0.04}
                data-testid={`lenses-edge-${i}`}
              />
            );
          })}

          {geometry.nodes.map((ln, i) => {
            const s = styles.nodes[i];
            const dim = neighbors && !neighbors.has(ln.node.id) ? 0.12 : 1;
            return (
              <g
                key={ln.node.id}
                data-testid={`lenses-node-${i}`}
                onMouseEnter={() => setHovered(ln.node.id)}
                onMouseLeave={() => setHovered((h) => (h === ln.node.id ? null : h))}
                style={{ cursor: "pointer", opacity: dim }}
              >
                {/* alvo de hover generoso (o ponto tem r=4; sem isto é difícil pegar) */}
                <circle cx={ln.x} cy={ln.y} r={9} fill="transparent" />
                {s.halo != null && <circle cx={ln.x} cy={ln.y} r={4 + s.halo} fill={s.fill} opacity={0.22} />}
                <circle cx={ln.x} cy={ln.y} r={hovered === ln.node.id ? 6 : 4} fill={s.fill} opacity={s.opacity}>
                  <title>
                    {humanLabel(ln.node) + (s.badge ? ` — ${s.badge}` : "")}
                  </title>
                </circle>
                {s.ring && (
                  <circle
                    cx={ln.x}
                    cy={ln.y}
                    r={8}
                    fill="none"
                    stroke={s.ring.color}
                    strokeWidth={1.8}
                    strokeDasharray={s.ring.dash}
                  />
                )}
              </g>
            );
          })}
        </svg>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Grafo + Prova" (componente).
//
// "Cada aresta abre o recibo": ego-network 1-hop radial em SVG PURO; clicar
// numa aresta abre o painel-recibo (método+confiança, resolution, fontes das
// pontas, recência POR NÓ com a ressalva de honestidade); clicar num vizinho
// re-centra o ego. Layout e recibo vêm 100% de evidence-proof.ts (puro).
//
// Halo cartográfico em todo <text> (paint-order: stroke, cor do card) — rótulo
// nunca some atrás de linha. Pulso runtime respeita prefers-reduced-motion.
// ─────────────────────────────────────────────
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Boxes, Clock, Receipt, Search, X } from "lucide-react";
import { EVIDENCE, evidenceMethodOf } from "./system-map-evidence";
import {
  EGO_VIEW,
  buildEgoLayout,
  defaultCenterId,
  edgeReceipt,
  proofLabel,
  searchNode,
  type ProofGraph,
  type ReceiptEndpoint,
} from "./evidence-proof";
import { strokeDashOf } from "./evidence-lenses";

const HALO: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "hsl(var(--card))",
  strokeWidth: 3,
  strokeLinejoin: "round",
};

const fmtLastSeen = (ms?: number): string | null => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toLocaleString("pt-BR");
  } catch {
    return null;
  }
};

export default function ProofView({ payload }: { payload: ProofGraph; projectId?: number | null }) {
  const [centerId, setCenterId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [searchMiss, setSearchMiss] = useState(false);

  const effectiveCenter = centerId ?? defaultCenterId(payload.nodes);
  const layout = useMemo(
    () => (effectiveCenter ? buildEgoLayout(payload, effectiveCenter) : null),
    [payload, effectiveCenter],
  );

  const receipt = useMemo(() => {
    if (!layout || selectedEdge == null) return null;
    const laid = layout.edges[selectedEdge];
    return laid ? edgeReceipt(laid.edge, payload.nodes) : null;
  }, [layout, selectedEdge, payload.nodes]);

  const recenter = (id: string) => {
    setCenterId(id);
    setSelectedEdge(null);
  };

  const runSearch = () => {
    const hit = searchNode(payload.nodes, search);
    setSearchMiss(!hit && search.trim().length > 0);
    if (hit) recenter(hit.id);
  };

  if (!layout) {
    return (
      <Card className="flex flex-1 items-center justify-center" data-testid="proof-empty">
        <CardContent className="max-w-md py-16 text-center">
          <Boxes className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">Sem nós para provar</h3>
          <p className="text-sm text-muted-foreground">
            O grafo deste snapshot não tem nós. Rode uma análise para gerar arestas com recibo.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { width, height } = EGO_VIEW;

  return (
    <div className="flex flex-1 gap-4" data-testid="proof-view">
      {/* pulso runtime — desativado sob prefers-reduced-motion (fica estático) */}
      <style>{`
        @keyframes evidence-runtime-pulse { from { stroke-dashoffset: 24; } to { stroke-dashoffset: 0; } }
        .runtime-pulse { stroke-dasharray: 1 0; }
        @media (prefers-reduced-motion: no-preference) {
          .runtime-pulse { stroke-dasharray: 10 4; animation: evidence-runtime-pulse 1.2s linear infinite; }
        }
      `}</style>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSearchMiss(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder="Buscar nó (classe, método, id)…"
              className="w-72 pl-8"
              data-testid="input-proof-search"
            />
          </div>
          {searchMiss && (
            <span className="text-xs text-muted-foreground" data-testid="proof-search-miss">
              nenhum nó encontrado
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {layout.shown < layout.totalNeighbors && (
              <Badge variant="secondary" className="gap-1" data-testid="proof-truncation">
                <AlertTriangle className="h-3 w-3" /> mostrando {layout.shown} de {layout.totalNeighbors} vizinhos
              </Badge>
            )}
            <Badge variant="secondary" data-testid="proof-edge-count">
              {layout.edges.length} arestas com recibo
            </Badge>
          </div>
        </div>

        <Card className="flex-1 overflow-hidden">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-[70vh] w-full"
            role="img"
            aria-label="Ego-network do nó central; cada aresta abre o recibo de evidência"
            data-testid="proof-svg"
          >
            <defs>
              <marker id="proof-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" opacity={0.7} />
              </marker>
            </defs>

            {layout.edges.map((le) => {
              const method = evidenceMethodOf(le.edge);
              const meta = EVIDENCE[method];
              const selected = selectedEdge === le.index;
              return (
                <g key={le.index}>
                  {/* hitbox generosa: a linha fina é difícil de clicar */}
                  <path
                    d={`M ${le.x1} ${le.y1} Q ${le.qx} ${le.qy} ${le.x2} ${le.y2}`}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    style={{ cursor: "pointer" }}
                    data-testid={`proof-edge-${le.index}`}
                    onClick={() => setSelectedEdge(le.index)}
                  />
                  <path
                    d={`M ${le.x1} ${le.y1} Q ${le.qx} ${le.qy} ${le.x2} ${le.y2}`}
                    fill="none"
                    className={method === "RUNTIME_OBSERVED" ? "runtime-pulse" : undefined}
                    stroke={meta.color}
                    strokeWidth={selected ? 3.5 : meta.strong ? 2.5 : 1.8}
                    strokeDasharray={method === "RUNTIME_OBSERVED" ? undefined : strokeDashOf(method)}
                    opacity={selected ? 0.95 : meta.muted ? 0.4 : 0.75}
                    markerEnd="url(#proof-arrow)"
                    style={{ color: meta.color, pointerEvents: "none" }}
                  />
                </g>
              );
            })}

            {/* centro */}
            <g data-testid="proof-center">
              <circle cx={layout.center.x} cy={layout.center.y} r={20} fill="hsl(var(--primary))" opacity={0.9} />
              <text
                x={layout.center.x}
                y={layout.center.y + 36}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                fill="hsl(var(--foreground))"
                style={HALO}
                data-testid="proof-center-label"
              >
                {proofLabel(layout.center.node)}
              </text>
            </g>

            {/* vizinhos (clicáveis: re-centra o ego) */}
            {layout.neighbors.map((ln, i) => (
              <g
                key={ln.node.id}
                style={{ cursor: "pointer" }}
                data-testid={`proof-node-${i}`}
                onClick={() => recenter(ln.node.id)}
              >
                {ln.node.runtimeHot && <circle cx={ln.x} cy={ln.y} r={14} fill="#f43f5e" opacity={0.25} />}
                <circle
                  cx={ln.x}
                  cy={ln.y}
                  r={9}
                  fill="#64748b"
                  stroke={ln.node.sensitive ? "#ef4444" : "transparent"}
                  strokeWidth={ln.node.sensitive ? 2.5 : 0}
                  opacity={0.9}
                />
                <text
                  x={ln.x}
                  y={ln.y + (ln.y >= layout.center.y ? 24 : -16)}
                  textAnchor="middle"
                  fontSize={11}
                  fill="hsl(var(--foreground))"
                  style={HALO}
                >
                  {proofLabel(ln.node)}
                </text>
              </g>
            ))}
          </svg>
        </Card>
      </div>

      {/* painel-recibo */}
      {receipt && (
        <Card className="w-96 shrink-0 overflow-y-auto" data-testid="proof-receipt">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Receipt className="h-4 w-4" /> Recibo da aresta
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => setSelectedEdge(null)}
                data-testid="proof-receipt-close"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {(() => {
              const meta = EVIDENCE[receipt.method];
              const Icon = meta.icon;
              return (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant="outline"
                    className="gap-1"
                    style={{ borderColor: meta.color, color: meta.color }}
                    data-testid="proof-receipt-method"
                  >
                    <Icon className="h-3 w-3" /> {meta.label}
                  </Badge>
                  <span className="text-xs text-muted-foreground" data-testid="proof-receipt-confidence">
                    confiança {Math.round(receipt.confidence * 100)}%
                  </span>
                </div>
              );
            })()}

            {receipt.unresolvedWarning && (
              <p
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                data-testid="proof-receipt-unresolved"
              >
                heurística de convenção — o compilador não confirmou; desconfie.
              </p>
            )}

            <dl className="space-y-1.5 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">relação</dt>
                <dd data-testid="proof-receipt-relation">{receipt.relationType}</dd>
              </div>
              {receipt.resolution && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">resolution</dt>
                  <dd className="font-mono" data-testid="proof-receipt-resolution">{receipt.resolution}</dd>
                </div>
              )}
              {receipt.count != null && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">traços observados</dt>
                  <dd data-testid="proof-receipt-count">×{receipt.count}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">observada em runtime</dt>
                <dd data-testid="proof-receipt-observed">{receipt.observed ? "sim" : "não"}</dd>
              </div>
            </dl>

            <ReceiptEndpointBlock title="De" endpoint={receipt.from} testId="proof-receipt-from" />
            <ReceiptEndpointBlock title="Para" endpoint={receipt.to} testId="proof-receipt-to" />

            <p className="border-t pt-2 text-[11px] text-muted-foreground" data-testid="proof-receipt-recency-note">
              <Clock className="mr-1 inline h-3 w-3" />
              recência é do nó, não da aresta — o traço marca quando cada PONTA foi vista, não este elo.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ReceiptEndpointBlock({
  title,
  endpoint,
  testId,
}: {
  title: string;
  endpoint: ReceiptEndpoint;
  testId: string;
}) {
  const lastSeen = fmtLastSeen(endpoint.runtimeLastSeenMs);
  return (
    <div className="rounded-md border p-2" data-testid={testId}>
      <div className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">{title}</div>
      <div className="truncate text-sm font-medium" title={endpoint.id}>
        {endpoint.label}
      </div>
      {endpoint.sourceFile && (
        <div className="truncate text-xs text-muted-foreground" title={endpoint.sourceFile} data-testid={`${testId}-source`}>
          {endpoint.sourceFile}
        </div>
      )}
      {lastSeen && (
        <div className="mt-1 text-[11px] text-muted-foreground" data-testid={`${testId}-last-seen`}>
          visto por último: {lastSeen}
          {endpoint.runtimeStale ? " (janela anterior)" : ""}
        </div>
      )}
    </div>
  );
}

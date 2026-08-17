// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Zoom Epistêmico" (componente).
//
// Um slider de 3 níveis (nós → domínios expandidos → domínios colapsados). A
// regra do conceito: ao AFASTAR, o domínio herda o PIOR tier dos membros
// (fail-honest, nunca média) — a cor de um bloco denuncia o elo mais fraco que
// ele esconde. Hubs transversais ficam à parte (não pertencem a um domínio).
// ─────────────────────────────────────────────
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Boxes } from "lucide-react";
import type { EvidenceGraphPayload } from "./evidence-diagrams";
import { EVIDENCE } from "./system-map-evidence";
import { humanLabel } from "./evidence-label";
import {
  computeDomainEvidence,
  computeSeamEvidence,
  type DomainsReport,
  type EdgeLite,
} from "./evidence-domains";

const HALO: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "hsl(var(--card))",
  strokeWidth: 3,
  strokeLinejoin: "round",
};

const LEVELS = ["Métodos", "Domínios", "Sistema"] as const;
const VIEW_W = 1000;
const VIEW_H = 560;

export default function ZoomView({ payload, projectId }: { payload: EvidenceGraphPayload; projectId?: number | null }) {
  const [level, setLevel] = useState(1);
  const en = projectId != null;
  // minSize=6 corta o long-tail de domínios minúsculos (tamanho 4-5) que
  // entopem o anel; ainda assim capamos a top-K por tamanho abaixo.
  const domainsQuery = useQuery<DomainsReport>({
    queryKey: en ? [`/api/projects/${projectId}/reasoner/domains?minSize=6`] : ["noop-zoom-dom"],
    enabled: en && level >= 1,
    retry: false,
  });

  const edges: EdgeLite[] = payload.edges;
  const allDomainEv = useMemo(() => computeDomainEvidence(domainsQuery.data, edges), [domainsQuery.data, edges]);
  // top-K por tamanho — o anel só respira até ~24 domínios; o resto é anunciado.
  const DOMAIN_CAP = 24;
  const domainEv = useMemo(
    () => [...allDomainEv].sort((a, b) => b.size - a.size).slice(0, DOMAIN_CAP),
    [allDomainEv],
  );
  const domainTruncated = allDomainEv.length > DOMAIN_CAP;
  const shownIds = useMemo(() => new Set(domainEv.map((d) => d.id)), [domainEv]);
  const seamEv = useMemo(
    () => computeSeamEvidence(domainsQuery.data, edges).filter((s) => shownIds.has(s.from) && shownIds.has(s.to)),
    [domainsQuery.data, edges, shownIds],
  );
  const hubs = domainsQuery.data?.hubs ?? [];

  // posiciona os domínios (top-K) num anel; o rótulo vai PRA FORA, radialmente,
  // ancorado pelo hemisfério — nunca colide no centro.
  const placed = useMemo(() => {
    const n = domainEv.length || 1;
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;
    const R = Math.min(VIEW_W, VIEW_H) * 0.34;
    const maxSize = Math.max(1, ...domainEv.map((d) => d.size));
    return domainEv.map((d, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const r = 16 + (d.size / maxSize) * 30;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      return {
        d,
        x: cx + cos * R,
        y: cy + sin * R,
        r,
        // rótulo empurrado radialmente pra fora do círculo
        lx: cx + cos * (R + r + 10),
        ly: cy + sin * (R + r + 10) + 3,
        anchor: cos < -0.2 ? "end" : cos > 0.2 ? "start" : ("middle" as "start" | "end" | "middle"),
      };
    });
  }, [domainEv]);
  const posById = useMemo(() => new Map(placed.map((p) => [p.d.id, p])), [placed]);

  return (
    <div className="flex flex-1 flex-col gap-3" data-testid="zoom-view">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border p-0.5" data-testid="zoom-level-switch">
          {LEVELS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`h-8 rounded px-3 text-sm ${level === i ? "bg-secondary font-medium" : "text-muted-foreground"}`}
              onClick={() => setLevel(i)}
              data-testid={`zoom-level-${i}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={2}
          step={1}
          value={level}
          onChange={(e) => setLevel(Number(e.target.value))}
          className="w-40"
          aria-label="Nível de zoom epistêmico"
          data-testid="zoom-range"
        />
        <p className="text-xs text-muted-foreground">
          Ao afastar, cada bloco herda o <b>pior</b> tier dos membros — a cor denuncia o elo mais fraco.
        </p>
        {level >= 1 && domainTruncated && (
          <Badge variant="secondary" className="gap-1" data-testid="zoom-truncation">
            <AlertTriangle className="h-3 w-3" /> mostrando os {DOMAIN_CAP} maiores de {allDomainEv.length} domínios
          </Badge>
        )}
      </div>

      {level === 0 ? (
        <MethodsLevel payload={payload} />
      ) : (
        <Card className="flex-1 overflow-auto">
          {domainsQuery.isLoading ? (
            <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground" data-testid="zoom-loading">
              carregando domínios…
            </div>
          ) : domainEv.length === 0 ? (
            <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-center" data-testid="zoom-domains-empty">
              <Boxes className="h-10 w-10 text-muted-foreground/50" />
              <p className="max-w-sm text-sm text-muted-foreground">
                Nenhum domínio deste tamanho. Ajuste a análise ou veja no nível Métodos.
              </p>
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              className="w-full"
              style={{ minHeight: "60vh" }}
              role="img"
              aria-label="Domínios do sistema; a cor de cada bloco é o pior tier de evidência dos seus membros"
              data-testid="zoom-svg"
            >
              {/* seams (feixes entre domínios) com o pior tier do feixe */}
              {seamEv.map((s, i) => {
                const a = posById.get(s.from);
                const b = posById.get(s.to);
                if (!a || !b) return null;
                const meta = EVIDENCE[s.worstTier];
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={meta.color}
                    strokeWidth={Math.min(6, 1 + Math.log2(s.edges + 1))}
                    strokeDasharray={meta.lineStyle === "dashed" ? "7 5" : meta.lineStyle === "dotted" ? "2 4" : undefined}
                    opacity={0.4}
                    data-testid={`zoom-seam-${i}`}
                  >
                    <title>{s.from} ↔ {s.to} · {s.edges} arestas · pior tier {meta.label}</title>
                  </line>
                );
              })}
              {/* domínios */}
              {placed.map((p) => {
                const meta = EVIDENCE[p.d.worstTier];
                const blind = p.d.provenShare < 0;
                return (
                  <g key={p.d.id} data-testid={`zoom-domain-${p.d.id}`}>
                    <circle cx={p.x} cy={p.y} r={p.r} fill={meta.color} opacity={level === 2 ? 0.75 : 0.5} stroke={meta.color} strokeWidth={2} strokeDasharray={blind ? "3 3" : undefined}>
                      <title>
                        {p.d.name} · {p.d.size} membros · pior tier {meta.label}
                        {blind ? " · CEGO (sem aresta)" : ` · ${Math.round(p.d.provenShare * 100)}% provado`}
                      </title>
                    </circle>
                    {level === 1 && (
                      <text x={p.lx} y={p.ly} textAnchor={p.anchor} fontSize={10.5} fontWeight={600} fill="hsl(var(--foreground))" style={HALO}>
                        {domainName(p.d.name)}
                      </text>
                    )}
                    <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="hsl(var(--card))" style={{ paintOrder: "stroke", stroke: meta.color, strokeWidth: 2.5 }}>
                      {p.d.size}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </Card>
      )}

      {level >= 1 && hubs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="zoom-hubs">
          <span className="text-muted-foreground">Hubs transversais (não pertencem a um domínio):</span>
          {hubs.slice(0, 8).map((h) => (
            <Badge key={h} variant="secondary">{h.split(":").pop()}</Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** Nome de domínio enxuto (o /reasoner/domains às vezes nomeia pelo método cru). */
function domainName(name: string): string {
  const clean = (name || "").replace(/[()#]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 22 ? clean.slice(0, 21) + "…" : clean;
}

function MethodsLevel({ payload }: { payload: EvidenceGraphPayload }) {
  // amostra de nós por grau — o nível mais granular (sem agregação).
  const nodes = useMemo(() => [...payload.nodes].sort((a, b) => b.inDegree - a.inDegree).slice(0, 60), [payload.nodes]);
  return (
    <Card className="flex-1 overflow-auto p-4" data-testid="zoom-methods">
      <p className="mb-3 text-xs text-muted-foreground">
        Nível granular — os {nodes.length} nós de maior grau (amostra por grau), sem agregação.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {nodes.map((n) => (
          <span
            key={n.id}
            className="rounded border bg-muted/40 px-1.5 py-0.5 text-[11px]"
            style={{ borderColor: n.runtimeHot ? "#f43f5e" : undefined }}
            data-testid={`zoom-method-node-${n.id}`}
            title={n.runtimeHot ? "quente em runtime" : undefined}
          >
            {humanLabel(n)}
          </span>
        ))}
      </div>
    </Card>
  );
}

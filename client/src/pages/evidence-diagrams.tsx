// ─────────────────────────────────────────────
// DIAGRAMAS DE EVIDÊNCIA — a família de vistas "o diagrama que sabe o quanto
// sabe". 8 modos (VizMode) sobre os endpoints REAIS que já existem — zero
// mudança de servidor; regra de ouro: dado real ou nada (vazio ≠ falhou ≠
// carregando; nenhum número fabricado).
//
// Padrão System Map: página-mãe com barra segmentada + deep-link ?view=&project=,
// 1 módulo por vista (componente fino) + lógica pura em .ts irmão testada com
// fixtures. A gramática de evidência (cores/tiers/legenda) vem TODA de
// system-map-evidence — nunca redefinida aqui.
// ─────────────────────────────────────────────
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  GitCompareArrows,
  Glasses,
  LogIn,
  Microscope,
  Radar,
  Receipt,
  RefreshCw,
  Scale,
  Share2,
  TrainFront,
  ZoomIn,
} from "lucide-react";
import {
  CoverageBadge,
  EvidenceLegend,
  type EdgeEvidence,
  type GraphCoverage,
} from "./system-map-evidence";
import MetroView from "./evidence-diagrams-metro";
import SankeyView from "./evidence-diagrams-sankey";
import ProofView from "./evidence-diagrams-proof";
import LensesView from "./evidence-diagrams-lenses";
import ConformanceView from "./evidence-diagrams-conformance";
import DiffView from "./evidence-diagrams-diff";
import ZoomView from "./evidence-diagrams-zoom";
import RadarView from "./evidence-diagrams-radar";

// ── Tipos do payload /api/projects/:id/graph (subconjunto que a família usa) ──
export interface EvidenceNode {
  id: string;
  type: string;
  className?: string;
  methodName?: string;
  qualifiedSignature?: string;
  inDegree: number;
  outDegree: number;
  sensitive?: boolean;
  sourceFile?: string;
  entryPoint?: string[];
  layer?: string;
  runtimeHot?: boolean;
  runtimeCount?: number;
  runtimeStale?: boolean;
  runtimeLastSeenMs?: number;
  observed?: boolean;
}
export interface EvidenceEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  resolution?: string;
  synthetic?: boolean;
  observed?: boolean;
  count?: number;
  configProven?: boolean;
  evidence?: EdgeEvidence;
}
export interface EvidenceGraphPayload {
  projectId: number;
  analysisRunId: number;
  counts: { nodes: number; edges: number; byType: Record<string, number> };
  nodes: EvidenceNode[];
  edges: EvidenceEdge[];
  coverage?: GraphCoverage | null;
}
interface Project {
  id: number;
  name: string;
}

// ── Os 8 modos (o array canônico da família) ──────────────────────────
export type VizMode =
  | "metro"
  | "sankey"
  | "proof"
  | "lenses"
  | "conformance"
  | "diff"
  | "zoom"
  | "radar";

export const VIZ_MODES: readonly {
  id: VizMode;
  label: string;
  question: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "metro", label: "Metrô", question: "Por onde passa esta operação — e onde cruza com as outras?", icon: TrainFront },
  { id: "sankey", label: "Autorização", question: "Quem pode o quê — e o que é de fato usado?", icon: Share2 },
  { id: "proof", label: "Prova", question: "Cada aresta abre o recibo.", icon: Receipt },
  { id: "lenses", label: "Lentes", question: "A mesma geometria sob quatro perguntas.", icon: Glasses },
  { id: "conformance", label: "Conformidade", question: "O que foi desenhado × o que de fato executou?", icon: Scale },
  { id: "diff", label: "Diff", question: "O que mudou entre os dois últimos retratos?", icon: GitCompareArrows },
  { id: "zoom", label: "Zoom", question: "Quanto sabemos em cada nível de agregação?", icon: ZoomIn },
  { id: "radar", label: "Radar", question: "Quais domínios estão provados — e quais estão cegos?", icon: Radar },
] as const;

const MODE_IDS: readonly string[] = VIZ_MODES.map((m) => m.id);

/**
 * Deep-link (`?view=proof&project=27`). Lido UMA vez, no estado inicial: valor
 * fora do union ou id não-numérico é ignorado (cai no default) — link torto
 * nunca quebra a página.
 */
function initialFromUrl(): { view: VizMode | null; project: number | null } {
  if (typeof window === "undefined") return { view: null, project: null };
  try {
    const q = new URLSearchParams(window.location.search);
    const v = q.get("view");
    const p = Number(q.get("project"));
    return {
      view: v && MODE_IDS.includes(v) ? (v as VizMode) : null,
      project: Number.isFinite(p) && p > 0 ? p : null,
    };
  } catch {
    return { view: null, project: null };
  }
}

const VIEW_COMPONENTS: Record<
  VizMode,
  React.ComponentType<{ payload: EvidenceGraphPayload; projectId?: number | null }>
> = {
  metro: MetroView,
  sankey: SankeyView,
  proof: ProofView,
  lenses: LensesView,
  conformance: ConformanceView,
  diff: DiffView,
  zoom: ZoomView,
  radar: RadarView,
};

export default function EvidenceDiagramsPage() {
  const projectsQuery = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const projects = projectsQuery.data;
  const [initial] = useState(initialFromUrl);
  const [projectId, setProjectId] = useState<number | null>(initial.project);
  const [viewMode, setViewMode] = useState<VizMode>(initial.view ?? "proof");

  useEffect(() => {
    if (projectId == null && projects && projects.length > 0) {
      // Prioriza um projeto "de verdade" (easynup) se existir; senão o 1º.
      const easy = projects.find((p) => /easynup|EasyNuP/.test(p.name));
      setProjectId((easy || projects[0]).id);
    }
  }, [projects, projectId]);

  // MESMA queryKey do system-map — cache compartilhado intencional.
  const graphQuery = useQuery<EvidenceGraphPayload>({
    queryKey: projectId != null ? [`/api/projects/${projectId}/graph`] : ["noop"],
    enabled: projectId != null,
    retry: false,
  });

  const active = VIZ_MODES.find((m) => m.id === viewMode)!;
  const ActiveView = VIEW_COMPONENTS[viewMode];

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight" data-testid="text-evidence-title">
            <Microscope className="h-6 w-6 text-primary" /> Diagramas de Evidência
          </h1>
          <p className="text-sm text-muted-foreground">O diagrama que sabe o quanto sabe.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap rounded-md border p-0.5" data-testid="viz-mode">
            {VIZ_MODES.map((m) => {
              const Icon = m.icon;
              return (
                <Button
                  key={m.id}
                  variant={viewMode === m.id ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => setViewMode(m.id)}
                  data-testid={`view-${m.id}`}
                >
                  <Icon className="h-4 w-4" /> {m.label}
                </Button>
              );
            })}
          </div>
          <Select
            value={projectId != null ? String(projectId) : undefined}
            onValueChange={(v) => setProjectId(Number(v))}
            disabled={projectsQuery.isLoading || projectsQuery.isError || !projects?.length}
          >
            <SelectTrigger className="w-56" data-testid="select-project">
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
      </div>

      {/* pergunta-guia do modo ativo + a revelação honesta da cobertura + a
          gramática de evidência — sempre à vista, nunca redefinida aqui. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm italic text-muted-foreground" data-testid="viz-question">
            {active.question}
          </p>
          <CoverageBadge coverage={graphQuery.data?.coverage} />
        </div>
        <details className="rounded-md border bg-background/90 px-3 py-2 text-xs" data-testid="evidence-legend-box">
          <summary className="cursor-pointer select-none font-semibold">Como o Sentinel soube (legenda)</summary>
          <div className="pt-2">
            <EvidenceLegend />
          </div>
        </details>
      </div>

      {projectsQuery.isLoading && <EvidenceSkeleton />}

      {projectsQuery.isError && (
        <ProjectListError error={projectsQuery.error as Error} onRetry={() => void projectsQuery.refetch()} />
      )}

      {!projectsQuery.isLoading && !projectsQuery.isError && projects?.length === 0 && <ProjectListEmpty />}

      {!projectsQuery.isError && projectId != null && graphQuery.isLoading && <EvidenceSkeleton />}

      {!projectsQuery.isError && graphQuery.isError && (
        <GraphEmptyOrError error={graphQuery.error as Error} />
      )}

      {!projectsQuery.isError && graphQuery.data && (
        <ActiveView payload={graphQuery.data} projectId={projectId} />
      )}
    </div>
  );
}

function EvidenceSkeleton() {
  return (
    <div className="flex flex-1 gap-4" data-testid="evidence-skeleton">
      <div className="flex-1 space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    </div>
  );
}

function ProjectListError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const requiresAuthentication = error.message.startsWith("401:");
  return (
    <Card className="border-destructive/40" data-testid="evidence-projects-error">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          {requiresAuthentication ? "Entre para carregar os projetos" : "Não foi possível carregar os projetos"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p>
          {requiresAuthentication
            ? "Os diagramas leem a análise salva, mas esta sessão não tem acesso aos projetos. Entre com a conta autorizada e tente novamente."
            : "A lista de projetos não respondeu. Tente carregar novamente."}
        </p>
        {requiresAuthentication ? (
          <Button asChild size="sm">
            <a href="/auth/login?returnTo=%2Fevidence" data-testid="evidence-login-link">
              <LogIn className="mr-2 h-4 w-4" /> Entrar
            </a>
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" /> Tentar novamente
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectListEmpty() {
  return (
    <Card className="flex flex-1 items-center justify-center" data-testid="evidence-projects-empty">
      <CardContent className="max-w-md py-16 text-center">
        <Microscope className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
        <h3 className="mb-2 text-lg font-semibold">Nenhum projeto disponível</h3>
        <p className="text-sm text-muted-foreground">
          Esta conta não tem projetos analisados. Sem análise não há evidência — e sem evidência não há
          diagrama (dado real ou nada).
        </p>
      </CardContent>
    </Card>
  );
}

// Distinção dura vazio≠falhou: 404 GRAPH_NOT_IN_SNAPSHOT = precisa reanalisar
// (não é erro de sistema); demais = erro real.
function GraphEmptyOrError({ error }: { error: Error }) {
  const msg = error?.message || "";
  const needsReanalysis = /re-run|GRAPH_NOT_IN_SNAPSHOT|snapshot/i.test(msg);
  return (
    <Card className="flex flex-1 items-center justify-center" data-testid="evidence-graph-error">
      <CardContent className="max-w-md py-16 text-center">
        <Microscope className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
        <h3 className="mb-2 text-lg font-semibold">
          {needsReanalysis ? "Grafo ainda não gerado" : "Não foi possível carregar o grafo"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {needsReanalysis
            ? "Este projeto não tem o grafo no snapshot. Rode uma análise (Catalog → Analyze) para alimentar os diagramas."
            : msg || "Erro ao buscar o grafo do sistema."}
        </p>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────
// System Map — o "mapa do sistema" que o Sentinel lê (controllers/services/
// repositories/entities + arestas CALLS/READS_ENTITY/WRITES_ENTITY).
//
// Design ancorado em pesquisa de fronteira (2026):
//  - Layout LAYERED/Sugiyama (ELK) — arestas direcionadas + camadas reais
//    ficam legíveis (ELK docs; Ghoniem/Fekete InfoVis'04). Force só para
//    vizinhança pequena. https://eclipse.dev/elk/reference/algorithms
//  - Codificação com 2º canal (WCAG 1.4.1): cor + FORMA distinta por camada;
//    tamanho = importância (grau de entrada); saúde/risco no ANEL da borda,
//    nunca no preenchimento (padrão Datadog/Grafana service map).
//  - Interação canônica dos líderes: hover → realça vizinhança e esmaece o
//    resto; clique → Isolate (upstream/downstream) + painel lateral; busca
//    dirige a exploração (Sourcetrail/Neo4j Bloom); filtro por tipo de aresta.
//  - Anti-hairball: nunca force-directed como default; filtros; foco.
// ─────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import cytoscape from "cytoscape";
import elk from "cytoscape-elk";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Boxes,
  Search,
  Maximize2,
  X,
  ArrowRight,
  ArrowLeft,
  AlertTriangle,
  ServerCog,
  Database,
  Route as RouteIcon,
  Container,
  Clock,
  Monitor,
  Waypoints,
  Puzzle,
  Braces,
  Grid3x3,
  Network,
  GitFork,
  Shapes,
  Layers,
  LayoutGrid,
  Radar,
  RefreshCw,
  LogIn,
} from "lucide-react";
import {
  type EdgeEvidence,
  type EvidenceMethod,
  type GraphCoverage,
  evidenceMethodOf,
  evidenceConfidenceOf,
  strongestEvidence,
  hasEvidenceData,
  EvidenceLegend,
  CoverageBadge,
} from "./system-map-evidence";
import { NarrativeView } from "./system-map-narrative";
import { ProofsView } from "./system-map-proofs";
import { BookOpen, ShieldCheck } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
cytoscape.use(elk as any);

// ── Tipos do payload /api/projects/:id/graph ──────────────────────────
type NodeType = "CONTROLLER" | "SERVICE" | "REPOSITORY" | "ENTITY" | "VIEW" | "ROUTE" | "COMPONENT" | "COMPOSABLE" | "INTERFACE" | "SUPERTYPE";
type EdgeRelation = "CALLS" | "READS_ENTITY" | "WRITES_ENTITY" | "ASSOCIATES" | "EXTENDS" | "IMPLEMENTS" | "RUNTIME_OBSERVED";

interface GraphNode {
  id: string;
  type: NodeType;
  className?: string;
  methodName?: string;
  qualifiedSignature?: string;
  inDegree: number;
  outDegree: number;
  sensitive?: boolean;
  sourceFile?: string;
  /** ADR-0025 Onda 4: gatilhos de fundo (@Scheduled/…) — root legítimo */
  entryPoint?: string[];
  /** ADR-0026 CM1: faceta canônica (camada/stack) — para a vista Matriz. */
  layer?: string;
  stack?: string;
  /** ADR-0026 costura: nó exercitado por tráfego real (traços OTel/Jaeger). */
  runtimeHot?: boolean;
  runtimeCount?: number;
}
interface GraphEdge {
  fromNode: string;
  toNode: string;
  relationType: EdgeRelation;
  /** ADR-0026 costura: aresta observada em traço + nº de traços. */
  observed?: boolean;
  count?: number;
  /** ADR-0028 P0.3: COMO o Sentinel soube desta aresta (proveniência). */
  evidence?: EdgeEvidence;
}
interface GraphPayload {
  projectId: number;
  analysisRunId: number;
  truncated: boolean;
  counts: { nodes: number; edges: number; byType: Record<string, number> };
  byLayer?: Record<string, number>;
  byStack?: Record<string, number>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** ADR-0028 P0.3: censo de cobertura — o que o mapa NÃO observou. */
  coverage?: GraphCoverage;
}
interface Project {
  id: number;
  name: string;
}

// ── Vocabulário visual (cor + forma = 2 canais) ───────────────────────
const LAYER: Record<
  NodeType,
  { label: string; color: string; shape: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }> }
> = {
  VIEW: { label: "Tela", color: "#ec4899", shape: "round-tag", icon: Monitor },
  COMPONENT: { label: "Componente", color: "#fb7185", shape: "tag", icon: Puzzle },
  COMPOSABLE: { label: "Composable", color: "#a78bfa", shape: "rhomboid", icon: Braces },
  ROUTE: { label: "Rota gateway", color: "#64748b", shape: "diamond", icon: Waypoints },
  CONTROLLER: { label: "Controller", color: "#6366f1", shape: "round-rectangle", icon: RouteIcon },
  SERVICE: { label: "Service", color: "#0ea5e9", shape: "ellipse", icon: ServerCog },
  REPOSITORY: { label: "Repository", color: "#14b8a6", shape: "hexagon", icon: Container },
  ENTITY: { label: "Entity", color: "#f59e0b", shape: "barrel", icon: Database },
  INTERFACE: { label: "Interface", color: "#22d3ee", shape: "round-diamond", icon: GitFork },
  SUPERTYPE: { label: "Supertipo", color: "#94a3b8", shape: "round-hexagon", icon: Shapes },
};
const REL: Record<EdgeRelation, { label: string; color: string }> = {
  CALLS: { label: "chama", color: "#94a3b8" },
  READS_ENTITY: { label: "lê", color: "#38bdf8" },
  WRITES_ENTITY: { label: "escreve", color: "#fb923c" },
  ASSOCIATES: { label: "associa", color: "#c084fc" },
  EXTENDS: { label: "estende", color: "#22d3ee" },
  IMPLEMENTS: { label: "implementa", color: "#2dd4bf" },
  RUNTIME_OBSERVED: { label: "observado (tráfego real)", color: "#f43f5e" },
};

// Acessos seguros aos mapas indexados por dado da API: um `type`/`relationType`
// fora do union (enum novo no Sentinel, snapshot de outro stack) não pode
// crashar o painel — cai num fallback neutro.
const LAYER_FALLBACK = { label: "Nó", color: "#94a3b8", shape: "ellipse", icon: Shapes };
const REL_FALLBACK = { label: "relaciona", color: "#94a3b8" };
const layerOf = (t: string) => LAYER[t as NodeType] ?? LAYER_FALLBACK;
const relOf = (r: string) => REL[r as EdgeRelation] ?? REL_FALLBACK;

function labelOf(n: GraphNode): string {
  return n.className || n.qualifiedSignature || n.id;
}

type ViewMode = "graph" | "matrix" | "layers" | "treemap" | "chord" | "er" | "narrative" | "proofs";

export default function SystemMapPage() {
  const projectsQuery = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const projects = projectsQuery.data;
  const [projectId, setProjectId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");

  useEffect(() => {
    if (projectId == null && projects && projects.length > 0) {
      // Prioriza um projeto "de verdade" (easynup) se existir; senão o 1º.
      const easy = projects.find((p) => /easynup|EasyNuP/.test(p.name));
      setProjectId((easy || projects[0]).id);
    }
  }, [projects, projectId]);

  const graphQuery = useQuery<GraphPayload>({
    queryKey: projectId != null ? [`/api/projects/${projectId}/graph`] : ["noop"],
    enabled: projectId != null,
    retry: false,
  });

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight" data-testid="text-system-map-title">
            <Boxes className="h-6 w-6 text-primary" /> Mapa do Sistema
          </h1>
          <p className="text-sm text-muted-foreground">
            O que o Sentinel leu: camadas, dependências e quem escreve em cada entidade.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Seletor de VISTA (AT2): mesmo modelo, várias maneiras de ler.
              Grafo (node-link, seguir caminho) × Matriz (DSM, estrutura de
              conjunto densa — lei Ghoniem/Fekete). */}
          <div className="flex rounded-md border p-0.5" data-testid="view-mode">
            <Button
              variant={viewMode === "graph" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("graph")}
              data-testid="view-graph"
            >
              <Network className="h-4 w-4" /> Grafo
            </Button>
            <Button
              variant={viewMode === "matrix" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("matrix")}
              data-testid="view-matrix"
            >
              <Grid3x3 className="h-4 w-4" /> Matriz
            </Button>
            <Button
              variant={viewMode === "layers" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("layers")}
              data-testid="view-layers"
            >
              <Layers className="h-4 w-4" /> Camadas
            </Button>
            <Button
              variant={viewMode === "treemap" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("treemap")}
              data-testid="view-treemap"
            >
              <LayoutGrid className="h-4 w-4" /> Treemap
            </Button>
            <Button
              variant={viewMode === "chord" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("chord")}
              data-testid="view-chord"
            >
              <Radar className="h-4 w-4" /> Roda
            </Button>
            <Button
              variant={viewMode === "er" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("er")}
              data-testid="view-er"
            >
              <Database className="h-4 w-4" /> Dados
            </Button>
            <Button
              variant={viewMode === "narrative" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("narrative")}
              data-testid="view-narrative"
            >
              <BookOpen className="h-4 w-4" /> Narrativa
            </Button>
            <Button
              variant={viewMode === "proofs" ? "secondary" : "ghost"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => setViewMode("proofs")}
              data-testid="view-proofs"
            >
              <ShieldCheck className="h-4 w-4" /> Provas
            </Button>
          </div>
          <Select
            value={projectId != null ? String(projectId) : undefined}
            onValueChange={(v) => setProjectId(Number(v))}
            disabled={projectsQuery.isLoading || projectsQuery.isError || !projects?.length}
          >
            <SelectTrigger className="w-64" data-testid="select-project">
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

      {projectsQuery.isLoading && <MapSkeleton />}

      {projectsQuery.isError && (
        <ProjectListError
          error={projectsQuery.error as Error}
          onRetry={() => void projectsQuery.refetch()}
        />
      )}

      {!projectsQuery.isLoading && !projectsQuery.isError && projects?.length === 0 && (
        <ProjectListEmpty />
      )}

      {/* A vista Narrativa busca a própria fonte (endpoint /narrative) — não
          depende do graph payload; renderiza mesmo com o grafo carregando. */}
      {!projectsQuery.isError && projectId != null && viewMode === "narrative" && <NarrativeView projectId={projectId} />}

      {graphQuery.isLoading && viewMode !== "narrative" && <MapSkeleton />}

      {!projectsQuery.isError && graphQuery.isError && viewMode !== "narrative" && (
        <GraphEmptyOrError error={graphQuery.error as Error} />
      )}

      {!projectsQuery.isError && graphQuery.data && viewMode === "graph" && <GraphCanvas payload={graphQuery.data} />}
      {!projectsQuery.isError && graphQuery.data && viewMode === "matrix" && projectId != null && (
        <MatrixView projectId={projectId} payload={graphQuery.data} />
      )}
      {!projectsQuery.isError && graphQuery.data && viewMode === "layers" && <LayersFlowView payload={graphQuery.data} />}
      {!projectsQuery.isError && graphQuery.data && viewMode === "treemap" && <TreemapView payload={graphQuery.data} />}
      {!projectsQuery.isError && graphQuery.data && viewMode === "chord" && <ChordView payload={graphQuery.data} />}
      {!projectsQuery.isError && graphQuery.data && viewMode === "er" && <ErView payload={graphQuery.data} />}
      {!projectsQuery.isError && graphQuery.data && viewMode === "proofs" && (
        <ProofsView payload={graphQuery.data} projectId={projectId ?? undefined} />
      )}
    </div>
  );
}

function ProjectListError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const requiresAuthentication = error.message.startsWith("401:");

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-5 w-5 text-destructive" />
          {requiresAuthentication ? "Entre para carregar o EasyNuP" : "Não foi possível carregar os projetos"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p>
          {requiresAuthentication
            ? "O mapa já lê a análise salva, mas esta sessão não tem acesso aos projetos. Entre com a conta autorizada e tente novamente."
            : "A lista de projetos não respondeu. Tente carregar novamente."}
        </p>
        {requiresAuthentication ? (
          <Button asChild size="sm">
            <a href="/auth/login?returnTo=%2Fsystem-map">
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
    <Card className="flex flex-1 items-center justify-center">
      <CardContent className="max-w-md py-16 text-center">
        <Boxes className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
        <h3 className="mb-2 text-lg font-semibold">Nenhum projeto disponível</h3>
        <p className="text-sm text-muted-foreground">
          Esta conta não tem projetos analisados disponíveis. Entre com a conta que possui acesso ao EasyNuP ou selecione outro projeto quando ele estiver disponível.
        </p>
      </CardContent>
    </Card>
  );
}

function MapSkeleton() {
  return (
    <div className="flex flex-1 gap-4">
      <div className="flex-1 space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[70vh] w-full" />
      </div>
    </div>
  );
}

// Distinção dura vazio≠falhou: 404 GRAPH_NOT_IN_SNAPSHOT = precisa reanalisar
// (não é erro de sistema); demais = erro real.
function GraphEmptyOrError({ error }: { error: Error }) {
  const msg = error?.message || "";
  const needsReanalysis = /re-run|GRAPH_NOT_IN_SNAPSHOT|snapshot/i.test(msg);
  return (
    <Card className="flex flex-1 items-center justify-center">
      <CardContent className="max-w-md py-16 text-center">
        <Boxes className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
        <h3 className="mb-2 text-lg font-semibold">
          {needsReanalysis ? "Mapa ainda não gerado" : "Não foi possível carregar o mapa"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {needsReanalysis
            ? "Este projeto não tem o grafo no snapshot. Rode uma análise (Catalog → Analyze) para gerar o Mapa do Sistema."
            : msg || "Erro ao buscar o grafo do sistema."}
        </p>
      </CardContent>
    </Card>
  );
}

// ── O canvas do grafo (cytoscape imperativo em ref) ───────────────────
function GraphCanvas({ payload }: { payload: GraphPayload }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [search, setSearch] = useState("");
  const [relOn, setRelOn] = useState<Record<EdgeRelation, boolean>>({
    CALLS: true,
    READS_ENTITY: true,
    WRITES_ENTITY: true,
    ASSOCIATES: true,
    EXTENDS: true,
    IMPLEMENTS: true,
    RUNTIME_OBSERVED: true,
  });

  // Escopo de renderização (foco-primeiro, anti-hairball — a pesquisa é
  // unânime: nenhum líder desenha 500+ nós de uma vez). Grafo grande abre na
  // "camada de dados + vizinhança" (entidades e quem as toca — a lente de
  // arquitetura mais útil e naturalmente limitada); pequeno abre inteiro.
  const RENDER_THRESHOLD = 500;
  const RENDER_CAP = 900;
  const isLarge = payload.nodes.length > RENDER_THRESHOLD;
  const [scope, setScope] = useState<"data" | "all">(isLarge ? "data" : "all");

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of payload.nodes) m.set(n.id, n);
    return m;
  }, [payload]);

  // Subgrafo visível conforme o escopo. "data" = entidades (a espinha do
  // sistema JPA) + vizinhos diretos (repos/services/controllers que as tocam),
  // ranqueado por grau e limitado ao RENDER_CAP para nunca virar hairball.
  const scopedNodes = useMemo(() => {
    if (scope === "all") return payload.nodes;
    const entityIds = new Set(payload.nodes.filter((n) => n.type === "ENTITY").map((n) => n.id));
    const neighborIds = new Set<string>();
    for (const e of payload.edges) {
      if (entityIds.has(e.toNode)) neighborIds.add(e.fromNode);
      if (entityIds.has(e.fromNode)) neighborIds.add(e.toNode);
    }
    // entidades sempre entram; DEPOIS a camada de dados INTEIRA (todos os
    // repositories que tocam entidade) — num sistema JPA o repository É a
    // camada de dados e NUNCA pode ser cortado; ranquear só por grau enchia o
    // teto de services (grau alto) e escondia ~todos os repositories (bug
    // achado ao revisar a tela: 4 repos exibidos vs 202 reais). Só então o
    // teto é preenchido com os services de maior grau.
    const keep = new Set<string>(entityIds);
    for (const n of payload.nodes) {
      if (n.type === "REPOSITORY" && neighborIds.has(n.id)) keep.add(n.id);
    }
    const services = payload.nodes
      .filter((n) => n.type === "SERVICE" && neighborIds.has(n.id) && !keep.has(n.id))
      .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree));
    for (const n of services) {
      if (keep.size >= RENDER_CAP) break;
      keep.add(n.id);
    }
    // qualquer outro vizinho (ex.: controller que toca entidade direto) até o teto
    const rest = payload.nodes
      .filter((n) => neighborIds.has(n.id) && !keep.has(n.id))
      .sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree));
    for (const n of rest) {
      if (keep.size >= RENDER_CAP) break;
      keep.add(n.id);
    }
    return payload.nodes.filter((n) => keep.has(n.id));
  }, [payload, scope]);

  const scopedIds = useMemo(() => new Set(scopedNodes.map((n) => n.id)), [scopedNodes]);

  // Arestas agregadas por (from,to,type) com contagem → espessura (padrão
  // Sourcetrail: troca N linhas por 1 rotulada). Só entre nós visíveis.
  const aggEdges = useMemo(() => {
    const map = new Map<
      string,
      { source: string; target: string; rel: EdgeRelation; weight: number; methods: EvidenceMethod[]; confs: number[] }
    >();
    for (const e of payload.edges) {
      if (!scopedIds.has(e.fromNode) || !scopedIds.has(e.toNode)) continue;
      const key = `${e.fromNode}|${e.toNode}|${e.relationType}`;
      const method = evidenceMethodOf(e);
      const conf = evidenceConfidenceOf(e);
      const prev = map.get(key);
      if (prev) {
        prev.weight += 1;
        prev.methods.push(method);
        prev.confs.push(conf);
      } else {
        map.set(key, { source: e.fromNode, target: e.toNode, rel: e.relationType, weight: 1, methods: [method], confs: [conf] });
      }
    }
    // O encoding de uma aresta agregada usa a evidência MAIS FORTE que a compõe;
    // a confiança do encoding é a do elo mais forte (max), ∝ opacidade no canvas.
    return Array.from(map.values()).map((e) => ({
      ...e,
      method: strongestEvidence(e.methods),
      conf: e.confs.length ? Math.max(...e.confs) : 0.2,
    }));
  }, [payload, scopedIds]);

  // O backend (P0.1) anexou o eixo de evidência? Só então estilizamos por
  // método e mostramos a legenda de proveniência — senão, render atual intacto.
  const showEvidence = useMemo(() => hasEvidenceData(payload.edges), [payload]);

  const maxInDegree = useMemo(
    () => Math.max(1, ...payload.nodes.map((n) => n.inDegree)),
    [payload],
  );

  // Monta o cytoscape UMA vez por payload.
  useEffect(() => {
    if (!boxRef.current) return;
    const dark = document.documentElement.classList.contains("dark");
    const labelColor = dark ? "#e2e8f0" : "#1e293b";
    const labelBg = dark ? "#0f172a" : "#ffffff";

    const cy = cytoscape({
      container: boxRef.current,
      wheelSensitivity: 0.2,
      elements: {
        nodes: scopedNodes.map((n) => ({
          data: {
            id: n.id,
            label: labelOf(n),
            type: n.type,
            sensitive: n.sensitive ? 1 : 0,
            hot: n.runtimeHot ? 1 : 0, // costura: exercitado por tráfego real
            // tamanho normalizado 24..64 por grau de entrada (importância)
            size: 24 + Math.round((n.inDegree / maxInDegree) * 40),
          },
        })),
        edges: aggEdges.map((e, i) => ({
          data: {
            id: `e${i}`,
            source: e.source,
            target: e.target,
            rel: e.rel,
            weight: e.weight,
            width: Math.min(6, 1 + Math.log2(e.weight + 1)),
            // Só entra no dado quando há evidência — sem isso o seletor
            // `edge[method]` não casa e o encoding por `rel` segue intacto.
            // `conf` habilita o encoding de opacidade ∝ confiança (só quando há evidência).
            ...(showEvidence ? { method: e.method, conf: e.conf } : {}),
          },
        })),
      },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 9,
            color: labelColor,
            "text-background-color": labelBg,
            "text-background-opacity": 0.75,
            "text-background-padding": "2px",
            "text-valign": "bottom",
            "text-margin-y": 3,
            "text-max-width": "120px",
            "text-wrap": "ellipsis",
            width: "data(size)",
            height: "data(size)",
            "border-width": 2,
            "border-color": "#00000022",
            "transition-property": "opacity, border-color, border-width",
            "transition-duration": 150,
          },
        },
        // cor + forma por camada (2 canais)
        ...(Object.keys(LAYER) as NodeType[]).map((t) => ({
          selector: `node[type = "${t}"]`,
          style: {
            "background-color": LAYER[t].color,
            shape: LAYER[t].shape as cytoscape.Css.NodeShape,
          },
        })),
        // saúde/risco no ANEL (nunca no preenchimento)
        {
          selector: "node[sensitive = 1]",
          style: { "border-width": 4, "border-color": "#ef4444" },
        },
        {
          // costura ADR-0026: halo rosa nos nós QUENTES (tráfego real observado),
          // combina com a borda de sensível — os dois sinais coexistem.
          selector: "node[hot = 1]",
          style: { "underlay-color": "#f43f5e", "underlay-opacity": 0.4, "underlay-padding": 7 },
        },
        {
          selector: "edge",
          style: {
            width: "data(width)",
            "curve-style": "bezier",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.9,
            opacity: 0.55,
            "transition-property": "opacity",
            "transition-duration": 150,
          },
        },
        ...(Object.keys(REL) as EdgeRelation[]).map((r) => ({
          selector: `edge[rel = "${r}"]`,
          style: { "line-color": REL[r].color, "target-arrow-color": REL[r].color },
        })),
        // aresta OBSERVADA (tráfego real): tracejada — proveniência distinta do estático
        { selector: `edge[rel = "RUNTIME_OBSERVED"]`, style: { "line-style": "dashed", "line-dash-pattern": [6, 3] } },
        // ADR-0028 P0.3: estilo por MÉTODO DE EVIDÊNCIA (proveniência da aresta).
        // Aplicado DEPOIS do `rel` (herda a cor da relação) e só quando o backend
        // emitiu `evidence` — sem isso `method` nem existe no dado (degradação
        // graciosa). O mapa passa a MOSTRAR o que não sabe: não-resolvido =
        // tracejado, conjectura de IA = pontilhado, desconhecido = cinza esmaecido.
        { selector: `edge[method = "STATIC_PROVEN"]`, style: { "line-style": "solid" } },
        // CONFIG_PROVEN (DI/rota/env): tracejada FORTE — traço longo [8,3] (mais
        // "cheio" que o não-resolvido [4,4]) + tint ciano do método, pra destacar
        // que a aresta é wiring determinístico provado, não conjectura.
        { selector: `edge[method = "CONFIG_PROVEN"]`, style: { "line-style": "dashed", "line-dash-pattern": [8, 3], "line-color": "#06b6d4", "target-arrow-color": "#06b6d4" } },
        { selector: `edge[method = "STATIC_UNRESOLVED"]`, style: { "line-style": "dashed", "line-dash-pattern": [4, 4] } },
        { selector: `edge[method = "LLM_CONJECTURED"]`, style: { "line-style": "dotted" } },
        { selector: `edge[method = "RUNTIME_OBSERVED"]`, style: { "line-style": "solid" } },
        { selector: `edge[method = "UNKNOWN"]`, style: { "line-color": "#94a3b8", "target-arrow-color": "#94a3b8" } },
        // Opacidade ∝ confiança (0.20→0.95 vira 0.28→0.9): o quão SEGUROS estamos
        // da aresta vira o quão nítida ela é. Aplicado depois dos métodos, só nas
        // arestas que trazem `conf` (há evidência) — as classes de ênfase (.faded/
        // .hl), por virem por último, ainda vencem no hover/seleção.
        // cytoscape aceita a sintaxe de mapper como string em runtime; os tipos só
        // conhecem `number`, então casamos aqui (o encoding é válido no canvas).
        { selector: `edge[conf]`, style: { opacity: "mapData(conf, 0.2, 0.95, 0.28, 0.9)" as unknown as number } },
        // estados de ênfase
        { selector: ".faded", style: { opacity: 0.08 } },
        { selector: "node.hl", style: { "border-color": "#0f172a", "border-width": 3 } },
        { selector: "edge.hl", style: { opacity: 0.95, width: 3 } },
        { selector: "node.pick", style: { "border-color": "#111827", "border-width": 5 } },
      ],
    });
    cyRef.current = cy;

    // O layout ELK roda ASSÍNCRONO (aplica as posições num microtask). Se o
    // React destrói/recria a instância (troca de payload/scope, refetch do
    // react-query, foco da janela após o login) antes desse microtask, a
    // aplicação cai numa instância já destruída → "Cannot read properties of
    // null (reading 'notify')" e o grafo fica EM BRANCO (repro headless
    // confirmou: `layout.stop()` sozinho NÃO evita — o microtask já está
    // agendado). O fix é ADIAR o start do layout um frame e checar
    // `cy.destroyed()`: se a instância morreu no meio, o layout nem começa.
    let disposed = false;
    let layout: cytoscape.Layouts | null = null;
    const rafId = requestAnimationFrame(() => {
      if (disposed || cy.destroyed()) return;
      layout = cy.layout({
        name: "elk",
        elk: {
          algorithm: "layered",
          "elk.direction": "DOWN",
          "elk.layered.spacing.nodeNodeBetweenLayers": 60,
          "elk.spacing.nodeNode": 30,
          "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        },
        fit: true,
        padding: 30,
      } as unknown as cytoscape.LayoutOptions);
      layout.run();
    });

    const clearEmphasis = () => {
      cy.elements().removeClass("faded hl pick");
    };
    const emphasize = (node: cytoscape.NodeSingular, pick: boolean) => {
      const neighborhood = node.closedNeighborhood();
      cy.elements().addClass("faded");
      neighborhood.removeClass("faded").addClass("hl");
      node.removeClass("faded");
      if (pick) node.addClass("pick");
    };

    cy.on("mouseover", "node", (evt) => {
      if (selectedIdRef.current) return; // com seleção ativa, hover não interfere
      emphasize(evt.target, false);
    });
    cy.on("mouseout", "node", () => {
      if (selectedIdRef.current) return;
      clearEmphasis();
    });
    cy.on("tap", "node", (evt) => {
      const node = evt.target as cytoscape.NodeSingular;
      selectedIdRef.current = node.id();
      clearEmphasis();
      emphasize(node, true);
      const gn = nodeById.get(node.id());
      if (gn) setSelected(gn);
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) {
        selectedIdRef.current = null;
        clearEmphasis();
        setSelected(null);
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      try { layout?.stop(); } catch { /* layout já concluído/parado */ }
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, scope]);

  // ref espelho da seleção (os handlers de cytoscape capturam o valor no mount)
  const selectedIdRef = useRef<string | null>(null);

  // filtros por tipo de aresta
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    (Object.keys(relOn) as EdgeRelation[]).forEach((r) => {
      const eles = cy.edges(`[rel = "${r}"]`);
      if (relOn[r]) eles.style("display", "element");
      else eles.style("display", "none");
    });
  }, [relOn]);

  // busca → centra + seleciona
  const runSearch = (term: string) => {
    const cy = cyRef.current;
    if (!cy || !term.trim()) return;
    const t = term.trim().toLowerCase();
    const hit = cy.nodes().filter((n) => String(n.data("label")).toLowerCase().includes(t));
    if (hit.length === 0) return;
    const first = hit[0];
    cy.animate({ center: { eles: first }, zoom: 1.5 }, { duration: 300 });
    selectedIdRef.current = first.id();
    cy.elements().removeClass("faded hl pick");
    const nb = first.closedNeighborhood();
    cy.elements().addClass("faded");
    nb.removeClass("faded").addClass("hl");
    first.removeClass("faded").addClass("pick");
    const gn = nodeById.get(first.id());
    if (gn) setSelected(gn);
  };

  const fit = () => cyRef.current?.animate({ fit: { eles: cyRef.current.elements(), padding: 30 } }, { duration: 300 });

  // vizinhança do nó selecionado para o painel (upstream/downstream)
  const upstream = useMemo(() => {
    if (!selected) return [];
    return aggEdges
      .filter((e) => e.target === selected.id)
      .map((e) => ({ node: nodeById.get(e.source)!, rel: e.rel }))
      .filter((x) => x.node);
  }, [selected, aggEdges, nodeById]);
  const downstream = useMemo(() => {
    if (!selected) return [];
    return aggEdges
      .filter((e) => e.source === selected.id)
      .map((e) => ({ node: nodeById.get(e.target)!, rel: e.rel }))
      .filter((x) => x.node);
  }, [selected, aggEdges, nodeById]);

  const focusNode = (id: string) => {
    const cy = cyRef.current;
    if (!cy) return;
    const node = cy.getElementById(id);
    if (node.empty()) return;
    cy.animate({ center: { eles: node }, zoom: 1.5 }, { duration: 300 });
    selectedIdRef.current = id;
    cy.elements().removeClass("faded hl pick");
    const nb = node.closedNeighborhood();
    cy.elements().addClass("faded");
    nb.removeClass("faded").addClass("hl");
    node.removeClass("faded").addClass("pick");
    const gn = nodeById.get(id);
    if (gn) setSelected(gn);
  };

  return (
    <div className="flex flex-1 gap-4">
      {/* Coluna principal: toolbar + canvas */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch(search)}
              placeholder="Buscar controller, service, entidade…"
              className="w-72 pl-8"
              data-testid="input-graph-search"
            />
          </div>
          <div className="flex items-center gap-1">
            {(Object.keys(REL) as EdgeRelation[]).map((r) => (
              <Toggle
                key={r}
                pressed={relOn[r]}
                onPressedChange={(v) => setRelOn((s) => ({ ...s, [r]: v }))}
                size="sm"
                data-testid={`toggle-rel-${r}`}
              >
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: REL[r].color }}
                />
                {REL[r].label}
              </Toggle>
            ))}
          </div>
          {isLarge && (
            <Select value={scope} onValueChange={(v) => setScope(v as "data" | "all")}>
              <SelectTrigger className="w-56" data-testid="select-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="data">Camada de dados + vizinhança</SelectItem>
                <SelectItem value="all">Tudo (pode ficar denso)</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="sm" onClick={fit} data-testid="button-fit">
            <Maximize2 className="mr-1 h-4 w-4" /> Ajustar
          </Button>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary" data-testid="badge-shown">
              {scopedNodes.length === payload.counts.nodes
                ? `${payload.counts.nodes} nós`
                : `${scopedNodes.length} de ${payload.counts.nodes} nós`}
            </Badge>
            <Badge variant="secondary">{aggEdges.length} arestas</Badge>
            {/* ADR-0028 P0.3: a revelação honesta da cobertura. Auto-degrada
                (não renderiza) quando o backend não emite `coverage`. */}
            <CoverageBadge coverage={payload.coverage} />
            {payload.truncated && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" /> truncado
              </Badge>
            )}
          </div>
        </div>

        {isLarge && scope === "data" && (
          <div className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Grafo grande ({payload.counts.nodes} nós): mostrando a camada de dados e sua vizinhança direta. Use a busca ou troque o escopo para explorar o resto.
          </div>
        )}

        <Card className="relative flex-1 overflow-hidden">
          <div ref={boxRef} className="h-[72vh] w-full" data-testid="graph-canvas" />
          {/* Legenda (encoding) */}
          <div className="absolute bottom-3 left-3 rounded-md border bg-background/90 p-3 text-xs shadow-sm backdrop-blur">
            <div className="mb-1 font-semibold">Camadas</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {(Object.keys(LAYER) as NodeType[]).map((t) => {
                const Icon = LAYER[t].icon;
                return (
                  <div key={t} className="flex items-center gap-1.5">
                    <Icon className="h-3 w-3" style={{ color: LAYER[t].color }} />
                    <span>{LAYER[t].label}</span>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full border-2 border-red-500" />
              <span>anel vermelho = sensível/risco</span>
            </div>
            {/* ADR-0028 P0.3: proveniência por aresta — só quando o backend
                (P0.1) a emite; sem isso a legenda de método nem aparece. */}
            {showEvidence && (
              <div className="mt-2 border-t pt-2">
                <EvidenceLegend />
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Painel lateral: Isolate Mode (upstream / downstream) */}
      {selected && (
        <Card className="w-80 shrink-0 overflow-y-auto">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {(() => {
                    const Icon = layerOf(selected.type).icon;
                    return <Icon className="h-4 w-4 shrink-0" style={{ color: layerOf(selected.type).color }} />;
                  })()}
                  <CardTitle className="truncate text-base" title={labelOf(selected)}>
                    {labelOf(selected)}
                  </CardTitle>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge variant="outline" style={{ borderColor: layerOf(selected.type).color }}>
                    {layerOf(selected.type).label}
                  </Badge>
                  {selected.sensitive && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" /> sensível
                    </Badge>
                  )}
                  {selected.runtimeHot && (
                    <Badge
                      variant="outline"
                      className="gap-1"
                      style={{ borderColor: "#f43f5e", color: "#f43f5e" }}
                      title="Exercitado por tráfego real (traços OTel/Jaeger) — não só existe no código, roda."
                    >
                      🔥 {selected.runtimeCount ? `${selected.runtimeCount} traços` : "tráfego real"}
                    </Badge>
                  )}
                  {selected.entryPoint && selected.entryPoint.length > 0 && (
                    <Badge
                      variant="outline"
                      className="gap-1"
                      title={`Root legítimo — acionado por ${selected.entryPoint.join(", ")}, não por código do sistema`}
                      data-testid="badge-entry-point"
                    >
                      <Clock className="h-3 w-3" /> gatilho de fundo
                    </Badge>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => {
                  setSelected(null);
                  selectedIdRef.current = null;
                  cyRef.current?.elements().removeClass("faded hl pick");
                }}
                data-testid="button-close-panel"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {selected.sourceFile && (
              <div className="truncate text-xs text-muted-foreground" title={selected.sourceFile}>
                {selected.sourceFile}
              </div>
            )}
            <div className="flex gap-4 text-xs">
              <span><b>{selected.inDegree}</b> dependem dele</span>
              <span><b>{selected.outDegree}</b> ele usa</span>
            </div>

            <IsolateList
              title="Quem depende (upstream)"
              icon={<ArrowLeft className="h-3.5 w-3.5" />}
              items={upstream}
              onPick={focusNode}
            />
            <IsolateList
              title="Do que depende (downstream)"
              icon={<ArrowRight className="h-3.5 w-3.5" />}
              items={downstream}
              onPick={focusNode}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function IsolateList({
  title,
  icon,
  items,
  onPick,
}: {
  title: string;
  icon: React.ReactNode;
  items: { node: GraphNode; rel: EdgeRelation }[];
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        {icon} {title} <span className="font-normal">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground/60">nenhum</div>
      ) : (
        <ul className="space-y-1">
          {items.slice(0, 40).map(({ node, rel }, i) => {
            const Icon = layerOf(node.type).icon;
            return (
              <li key={`${node.id}-${i}`}>
                <button
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => onPick(node.id)}
                >
                  <Icon className="h-3 w-3 shrink-0" style={{ color: layerOf(node.type).color }} />
                  <span className="truncate">{labelOf(node)}</span>
                  <span
                    className="ml-auto shrink-0 rounded px-1 text-[10px]"
                    style={{ color: relOf(rel).color }}
                  >
                    {relOf(rel).label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Vista MATRIZ (DSM / Levelized Structure Map) — AT2 ────────────────
// A leitura de ESTRUTURA DE CONJUNTO (lei Ghoniem/Fekete: matriz supera
// node-link acima de ~20 nós). Camada×camada (do `layer` canônico CM1) + bandas
// de nível (partição LSM do /dsm) + tangles (ciclos) + saúde. Um modelo, N vistas.
const LAYER_ORDER = ["presentation", "api", "domain", "data", "infra"] as const;
const LAYER_META: Record<string, { label: string; color: string }> = {
  presentation: { label: "Apresentação", color: "#ec4899" },
  api: { label: "API", color: "#6366f1" },
  domain: { label: "Domínio", color: "#0ea5e9" },
  data: { label: "Dados", color: "#f59e0b" },
  infra: { label: "Infra", color: "#94a3b8" },
};

interface DsmPayload {
  partitions: { level: number; nodes: string[] }[];
  cycles: string[][];
  levelizable: boolean;
  stats: { nodes: number; edges: number; levels: number; cycleCount: number; nodesInCycles: number; feedbackEdges: number; feedbackPct: number };
}

function shortName(id: string): string {
  const afterColon = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const base = afterColon.split("(")[0];
  return base.split(".").filter(Boolean).pop() || base;
}

function StatCard({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border px-4 py-3 ${warn ? "border-amber-500/40 bg-amber-500/5" : ""}`}>
      <div className={`text-2xl font-semibold tabular-nums ${warn ? "text-amber-600 dark:text-amber-400" : ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function MatrixView({ projectId, payload }: { projectId: number; payload: GraphPayload }) {
  const dsmQuery = useQuery<DsmPayload>({
    queryKey: [`/api/projects/${projectId}/dsm`],
    retry: false,
  });

  const { matrix, layerCounts } = useMemo(() => {
    const idLayer = new Map<string, string>();
    const layerCounts: Record<string, number> = {};
    for (const n of payload.nodes) {
      const l = n.layer && LAYER_META[n.layer] ? n.layer : "—";
      idLayer.set(n.id, l);
      layerCounts[l] = (layerCounts[l] || 0) + 1;
    }
    const cols = [...LAYER_ORDER, "—"];
    const matrix: Record<string, Record<string, number>> = {};
    for (const a of cols) { matrix[a] = {}; for (const b of cols) matrix[a][b] = 0; }
    for (const e of payload.edges) {
      const a = idLayer.get(e.fromNode); const b = idLayer.get(e.toNode);
      if (!a || !b) continue;
      matrix[a][b] += 1;
    }
    return { matrix, layerCounts };
  }, [payload]);

  const cols = [...LAYER_ORDER, "—"] as string[];
  const idx = (l: string) => (LAYER_ORDER as readonly string[]).indexOf(l);

  return (
    <div className="flex-1 overflow-auto space-y-6" data-testid="matrix-view">
      {dsmQuery.data && (
        <div className="flex flex-wrap gap-3">
          <StatCard label="Camadas descobertas" value={dsmQuery.data.stats.levels} />
          <StatCard label="Ciclos (tangles)" value={dsmQuery.data.stats.cycleCount} warn={dsmQuery.data.stats.cycleCount > 0} />
          <StatCard label="Nós em ciclo" value={dsmQuery.data.stats.nodesInCycles} warn={dsmQuery.data.stats.nodesInCycles > 0} />
          <StatCard label="Feedback" value={`${dsmQuery.data.stats.feedbackEdges} (${dsmQuery.data.stats.feedbackPct}%)`} warn={dsmQuery.data.stats.feedbackPct > 0} />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Grid3x3 className="h-4 w-4" /> Dependência entre camadas (DSM)</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="text-sm border-collapse">
            <thead>
              <tr>
                <th className="p-2 text-left text-xs text-muted-foreground whitespace-nowrap">de ↓ / para →</th>
                {cols.map((c) => (
                  <th key={c} className="p-2 text-xs font-medium" style={{ color: LAYER_META[c]?.color }}>
                    {LAYER_META[c]?.label || "outros"}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cols.map((from) => (
                <tr key={from}>
                  <td className="p-2 text-xs font-medium whitespace-nowrap" style={{ color: LAYER_META[from]?.color }}>
                    {LAYER_META[from]?.label || "outros"} <span className="text-muted-foreground">({layerCounts[from] || 0})</span>
                  </td>
                  {cols.map((to) => {
                    const v = matrix[from]?.[to] || 0;
                    const upward = idx(from) >= 0 && idx(to) >= 0 && idx(from) > idx(to);
                    const diag = from === to;
                    const bg = v === 0 ? "transparent" : upward ? "rgba(239,68,68,0.14)" : diag ? "rgba(148,163,184,0.10)" : "rgba(34,197,94,0.10)";
                    return (
                      <td key={to} className="p-2 text-center tabular-nums"
                          style={{ background: bg, color: upward && v ? "#ef4444" : undefined, fontWeight: v ? 500 : 400 }}
                          title={upward && v ? "dependência para cima — possível violação de camada" : undefined}>
                        {v || "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">
            Verde = sentido esperado (apresentação→api→domínio→dados). <span className="text-red-500">Vermelho = para cima</span> (possível violação). Cinza = intra-camada.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {dsmQuery.data && (
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shapes className="h-4 w-4" /> Camadas niveladas (LSM)</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {dsmQuery.data.partitions.map((p) => (
                <div key={p.level} className="flex items-center gap-2">
                  <span className="w-16 text-xs text-muted-foreground">nível {p.level}</span>
                  <div className="h-4 rounded bg-primary/70" style={{ width: `${Math.min(100, Math.max(3, (p.nodes.length / Math.max(1, dsmQuery.data!.stats.nodes)) * 100 * 4))}%` }} />
                  <span className="text-xs tabular-nums">{p.nodes.length}</span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground pt-1">
                {dsmQuery.data.levelizable ? "Grafo nivelável (sem ciclos): as camadas emergiram sozinhas." : "Ciclos impedem a nivelação total (ver tangles)."}
              </p>
            </CardContent>
          </Card>
        )}
        {dsmQuery.data && (
          <Card>
            <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Ciclos (tangles) — {dsmQuery.data.cycles.length}</CardTitle></CardHeader>
            <CardContent>
              {dsmQuery.data.cycles.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhum ciclo — arquitetura acíclica.</p>
              ) : (
                <ul className="space-y-2 max-h-64 overflow-auto">
                  {[...dsmQuery.data.cycles].sort((a, b) => b.length - a.length).slice(0, 12).map((c, i) => (
                    <li key={i} className="text-sm">
                      <Badge variant="outline" className="mr-2">{c.length} nós</Badge>
                      <span className="text-muted-foreground">{c.slice(0, 4).map(shortName).join(" ↔ ")}{c.length > 4 ? " …" : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {dsmQuery.isLoading && <Skeleton className="h-40 w-full" />}
      {dsmQuery.isError && <p className="text-sm text-muted-foreground">Sem DSM para este projeto (reanalise necessária).</p>}
    </div>
  );
}

// ── Vista CAMADAS (fluxo clique→dado em colunas) — AT3 ────────────────
// A leitura "de fora pra dentro": Tela→Componente→Composable→Rota→Módulo Node→
// Endpoint→Controller→Service→Repository→Entity, com o RECORTE EXECUTIVO
// (top-N por importância por coluna — a mesma ideia de foco-primeiro anti-hairball
// da tela; ~180 nós do grafo inteiro). Arestas bezier coloridas por relação.
// SVG puro (sem cytoscape) — 1 modelo, mais uma maneira de ler.
const FLOW_COLS: { key: string; label: string; cap: number; color: string }[] = [
  { key: "VIEW", label: "Tela", cap: 24, color: "#ec4899" },
  { key: "COMPONENT", label: "Componente", cap: 12, color: "#fb7185" },
  { key: "COMPOSABLE", label: "Composable", cap: 6, color: "#a78bfa" },
  { key: "ROUTE", label: "Rota gateway", cap: 8, color: "#64748b" },
  { key: "NODEMOD", label: "Módulo Node", cap: 8, color: "#475569" },
  { key: "ENDPOINT", label: "Endpoint", cap: 36, color: "#818cf8" },
  { key: "CONTROLLER", label: "Controller", cap: 24, color: "#6366f1" },
  { key: "SERVICE", label: "Service", cap: 36, color: "#0ea5e9" },
  { key: "REPOSITORY", label: "Repository", cap: 8, color: "#14b8a6" },
  { key: "ENTITY", label: "Entity", cap: 36, color: "#f59e0b" },
  // NOTA: supertipos/interfaces (INTERFACE/SUPERTYPE) NÃO entram na vista Camadas —
  // são âncora de HERANÇA, não etapa do fluxo clique→dado (dariam nós "0 a jusante"
  // confusos). O lugar deles é a vista Dados/ER. flowColKey ainda os mapeia p/ TIPO,
  // mas sem coluna aqui eles ficam de fora do fluxo (aparecem no ER).
];

function flowColKey(n: GraphNode): string {
  if (n.id.startsWith("wsv1:")) return "ENDPOINT";
  if (n.id.startsWith("node:")) return "NODEMOD";
  if (n.type === "INTERFACE" || n.type === "SUPERTYPE") return "TIPO";
  return n.type;
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function LayersFlowView({ payload }: { payload: GraphPayload }) {
  const COL_W = 150, ROW_H = 22, TOP = 54, LEFT = 20, DOT = 4;
  const [hovered, setHovered] = useState<string | null>(null);

  const layout = useMemo(() => {
    const byCol = new Map<string, GraphNode[]>();
    const totalByCol: Record<string, number> = {};
    for (const n of payload.nodes) {
      const k = flowColKey(n);
      totalByCol[k] = (totalByCol[k] || 0) + 1;
      (byCol.get(k) || byCol.set(k, []).get(k)!).push(n);
    }
    const deg = (n: GraphNode) => (n.inDegree || 0) + (n.outDegree || 0);
    const activeCols = FLOW_COLS.filter((c) => (byCol.get(c.key) || []).length > 0);
    const pos = new Map<string, { x: number; y: number; color: string }>();
    const cols = activeCols.map((c, ci) => {
      const picked = (byCol.get(c.key) || []).slice().sort((a, b) => deg(b) - deg(a)).slice(0, c.cap);
      const x = LEFT + ci * COL_W;
      const nodes = picked.map((n, ri) => {
        const y = TOP + ri * ROW_H;
        pos.set(n.id, { x, y, color: c.color });
        return { id: n.id, label: trunc(labelOf(n), 15), y, deg: deg(n), sensitive: n.sensitive };
      });
      return { ...c, x, total: totalByCol[c.key] || 0, sel: picked.length, nodes };
    });
    const edges: { d: string; color: string; from: string; to: string }[] = [];
    const neighbors = new Map<string, Set<string>>();     // 1 salto (para o contador do detalhe)
    const out = new Map<string, string[]>();              // dirigido: quem ESTE chama/usa (a jusante → dado)
    const inc = new Map<string, string[]>();              // dirigido: quem chama ESTE (a montante → tela)
    const link = (a: string, b: string) => (neighbors.get(a) || neighbors.set(a, new Set()).get(a)!).add(b);
    const dir = (m: Map<string, string[]>, a: string, b: string) => (m.get(a) || m.set(a, []).get(a)!).push(b);
    for (const e of payload.edges) {
      const a = pos.get(e.fromNode), b = pos.get(e.toNode);
      if (!a || !b || a === b) continue;
      const x1 = a.x + DOT, x2 = b.x - DOT, mx = (x1 + x2) / 2;
      edges.push({ d: `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`, color: (REL[e.relationType]?.color) || "#94a3b8", from: e.fromNode, to: e.toNode });
      link(e.fromNode, e.toNode); link(e.toNode, e.fromNode);
      dir(out, e.fromNode, e.toNode); dir(inc, e.toNode, e.fromNode);
    }
    const maxRows = Math.max(1, ...cols.map((c) => c.nodes.length));
    const width = LEFT + cols.length * COL_W + 40;
    const height = TOP + maxRows * ROW_H + 20;
    // contagens p/ sidebar
    const relCounts: Record<string, number> = {};
    const resCounts: Record<string, number> = {};
    for (const e of payload.edges) {
      relCounts[e.relationType] = (relCounts[e.relationType] || 0) + 1;
      const r = (e as unknown as { resolution?: string }).resolution || "convenção/sintética";
      resCounts[r] = (resCounts[r] || 0) + 1;
    }
    const selTotal = cols.reduce((s, c) => s + c.sel, 0);
    const labelFull = new Map<string, string>();
    for (const c of cols) for (const n of c.nodes) labelFull.set(n.id, labelOf(payload.nodes.find((p) => p.id === n.id) || ({} as GraphNode)) || n.label);
    return { cols, edges, neighbors, out, inc, width, height, relCounts, resCounts, totalByCol, selTotal, labelFull };
  }, [payload]);

  // realce do CAMINHO INTEIRO no hover (cone transitivo): a jusante segue as
  // arestas pra frente (até o dado) e a montante pra trás (até a tela) — não só
  // 1 salto. É a leitura "clique→dado" de ponta a ponta.
  const closure = (start: string, adj: Map<string, string[]>) => {
    const seen = new Set<string>(); const stack = [start];
    while (stack.length) { const v = stack.pop()!; for (const w of adj.get(v) || []) if (!seen.has(w)) { seen.add(w); stack.push(w); } }
    return seen;
  };
  const down = hovered ? closure(hovered, layout.out) : null;
  const up = hovered ? closure(hovered, layout.inc) : null;
  const hi = hovered ? new Set<string>([hovered, ...Array.from(down!), ...Array.from(up!)]) : null;
  const nodeOpacity = (id: string) => (!hi ? 1 : hi.has(id) ? 1 : 0.1);
  const edgeState = (from: string, to: string) => (!hi ? { o: 0.4, w: 0.7 } : hi.has(from) && hi.has(to) ? { o: 0.9, w: 1.3 } : { o: 0.03, w: 0.6 });

  const RES_LABEL: Record<string, string> = {
    "compiler": "compilador", "syntactic-resolved": "código resolvido",
    "syntactic-declared": "tipo declarado", "interface-impl": "fan-out interface",
    "convention-name": "convenção", "convenção/sintética": "convenção/sintética",
  };

  return (
    <div className="flex flex-1 gap-4 overflow-hidden" data-testid="layers-view">
      {/* sidebar */}
      <div className="w-56 shrink-0 space-y-4 overflow-y-auto pr-1 text-sm">
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Camadas</div>
          {layout.cols.map((c) => (
            <div key={c.key} className="flex items-center justify-between py-0.5">
              <span className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: c.color }} /> {c.label}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">{c.sel} de {c.total}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relações</div>
          {Object.entries(layout.relCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between py-0.5">
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-4 rounded-sm" style={{ background: REL[k as EdgeRelation]?.color || "#94a3b8" }} /> {REL[k as EdgeRelation]?.label || k}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">{v}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Confiança da aresta</div>
          {Object.entries(layout.resCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between py-0.5 text-xs">
              <span>{RES_LABEL[k] || k}</span>
              <span className="text-muted-foreground tabular-nums">{v}</span>
            </div>
          ))}
        </div>
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          {hovered ? (
            <><b className="text-foreground">{layout.labelFull.get(hovered) || hovered}</b><br /><span className="text-muted-foreground">{down?.size || 0} a jusante (→ dado) · {up?.size || 0} a montante (telas) · {(layout.neighbors.get(hovered)?.size || 0)} diretos</span></>
          ) : (
            <span className="text-muted-foreground"><b className="text-foreground">Recorte executivo:</b> {layout.selTotal} de {payload.nodes.length} nós. Passe o mouse num nó — realça o caminho inteiro (clique→dado).</span>
          )}
        </div>
      </div>

      {/* canvas SVG */}
      <div className="flex-1 overflow-auto rounded-lg border bg-card">
        <svg width={layout.width} height={layout.height} className="min-w-full">
          {/* arestas atrás */}
          <g>
            {layout.edges.map((e, i) => {
              const s = edgeState(e.from, e.to);
              return <path key={i} d={e.d} fill="none" stroke={e.color} strokeWidth={s.w} strokeOpacity={s.o} />;
            })}
          </g>
          {/* colunas */}
          {layout.cols.map((c) => (
            <g key={c.key}>
              <text x={c.x} y={26} fontSize={11} fontWeight={600} fill={c.color}>{c.label.toUpperCase()}</text>
              <text x={c.x} y={40} fontSize={10} fill="currentColor" className="text-muted-foreground">{c.sel}/{c.total}</text>
              {c.nodes.map((n) => {
                const isH = hovered === n.id;
                return (
                  <g key={n.id} opacity={nodeOpacity(n.id)} onMouseEnter={() => setHovered(n.id)} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
                    <circle cx={c.x} cy={n.y} r={isH ? DOT + 2 : DOT} fill={c.color} stroke={isH ? "var(--foreground)" : n.sensitive ? "#ef4444" : "none"} strokeWidth={isH ? 1.5 : n.sensitive ? 1.5 : 0} />
                    <text x={c.x + 8} y={n.y + 3} fontSize={10} fontWeight={isH ? 700 : 400} fill="currentColor">{n.label}</text>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

// ── Vista TREEMAP (hotspot: onde está a massa e o risco) — AT4 ─────────
// Slice-and-dice por CAMADA canônica: cada bloco = uma camada (largura ∝ massa),
// cada retângulo = um nó (altura ∝ importância/grau); borda vermelha = campo
// sensível. Lê "onde o sistema pesa e onde dói" num relance. SVG puro.
function TreemapView({ payload }: { payload: GraphPayload }) {
  const W = 1120, H = 620, PAD = 2, TOPH = 22;
  const layout = useMemo(() => {
    const order = ["presentation", "api", "domain", "data", "infra", "—"];
    const meta: Record<string, { l: string; c: string }> = {
      presentation: { l: "Apresentação", c: "#ec4899" }, api: { l: "API", c: "#6366f1" },
      domain: { l: "Domínio", c: "#0ea5e9" }, data: { l: "Dados", c: "#f59e0b" },
      infra: { l: "Infra", c: "#94a3b8" }, "—": { l: "Outros", c: "#64748b" },
    };
    const deg = (n: GraphNode) => (n.inDegree || 0) + (n.outDegree || 0) + 1;
    const byLayer = new Map<string, GraphNode[]>();
    for (const n of payload.nodes) {
      const l = n.layer && meta[n.layer] ? n.layer : "—";
      (byLayer.get(l) || byLayer.set(l, []).get(l)!).push(n);
    }
    const layers = order.filter((l) => (byLayer.get(l) || []).length);
    const layerMass = (l: string) => (byLayer.get(l) || []).reduce((s, n) => s + deg(n), 0);
    const totalMass = layers.reduce((s, l) => s + layerMass(l), 0) || 1;
    let x = 0;
    const blocks = layers.map((l) => {
      const nodes = (byLayer.get(l) || []).slice().sort((a, b) => deg(b) - deg(a)).slice(0, 60);
      const bw = Math.max(60, (layerMass(l) / totalMass) * W);
      const colMass = nodes.reduce((s, n) => s + deg(n), 0) || 1;
      let y = TOPH;
      const rects = nodes.map((n) => {
        const rh = Math.max(3, (deg(n) / colMass) * (H - TOPH));
        const r = { x, y, w: bw, h: rh, label: n.className || n.id, deg: deg(n) - 1, sensitive: n.sensitive };
        y += rh;
        return r;
      });
      const b = { key: l, label: meta[l].l, color: meta[l].c, x, w: bw, count: (byLayer.get(l) || []).length, rects };
      x += bw;
      return b;
    });
    return { blocks, meta };
  }, [payload]);

  return (
    <div className="flex-1 overflow-auto rounded-lg border bg-card p-2" data-testid="treemap-view">
      <svg width={W} height={H} className="min-w-full">
        {layout.blocks.map((b) => (
          <g key={b.key}>
            <text x={b.x + 4} y={15} fontSize={12} fontWeight={700} fill={b.color}>{b.label} <tspan fontWeight={400} fill="currentColor" className="text-muted-foreground">({b.count})</tspan></text>
            {b.rects.map((r, i) => (
              <g key={i}>
                <rect x={r.x + PAD} y={r.y} width={Math.max(0, r.w - PAD * 2)} height={Math.max(0, r.h - PAD)} rx={2}
                      fill={b.color} fillOpacity={0.18 + Math.min(0.55, r.deg / 60)} stroke={r.sensitive ? "#ef4444" : b.color} strokeWidth={r.sensitive ? 1.5 : 0.5} strokeOpacity={r.sensitive ? 1 : 0.4}>
                  <title>{r.label} — {r.deg} conexões{r.sensitive ? " · campo sensível" : ""}</title>
                </rect>
                {r.h > 13 && r.w > 60 && (
                  <text x={r.x + 6} y={r.y + Math.min(r.h - 4, 13)} fontSize={10} fill="currentColor" className="pointer-events-none">
                    {trunc(r.label, Math.floor(r.w / 7))}{r.h > 26 ? "" : ""}
                  </text>
                )}
              </g>
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── Vista RODA (dependência entre camadas — acoplamento) — AT5 ─────────
// Roda de dependências: cada camada é um ponto no círculo; cada arco = fluxo de
// dependência camada→camada, largura ∝ nº de arestas, cor = camada de origem.
// A leitura circular do ACOPLAMENTO (quem puxa quem) num relance. SVG puro.
function ChordView({ payload }: { payload: GraphPayload }) {
  const S = 620, cx = S / 2, cy = S / 2, R = 210;
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => {
    const meta: Record<string, { l: string; c: string }> = {
      presentation: { l: "Apresentação", c: "#ec4899" }, api: { l: "API", c: "#6366f1" },
      domain: { l: "Domínio", c: "#0ea5e9" }, data: { l: "Dados", c: "#f59e0b" },
      infra: { l: "Infra", c: "#94a3b8" }, "—": { l: "Outros", c: "#64748b" },
    };
    const order = ["presentation", "api", "domain", "data", "infra", "—"];
    const idLayer = new Map<string, string>();
    const count: Record<string, number> = {};
    for (const n of payload.nodes) { const l = n.layer && meta[n.layer] ? n.layer : "—"; idLayer.set(n.id, l); count[l] = (count[l] || 0) + 1; }
    const layers = order.filter((l) => count[l]);
    const mat: Record<string, Record<string, number>> = {};
    for (const a of layers) { mat[a] = {}; for (const b of layers) mat[a][b] = 0; }
    let maxE = 1;
    for (const e of payload.edges) {
      const a = idLayer.get(e.fromNode), b = idLayer.get(e.toNode);
      if (!a || !b || !mat[a] || mat[a][b] === undefined) continue;
      mat[a][b]++; if (a !== b && mat[a][b] > maxE) maxE = mat[a][b];
    }
    const pts = layers.map((l, i) => {
      const ang = (i / layers.length) * 2 * Math.PI - Math.PI / 2;
      return { key: l, label: meta[l].l, color: meta[l].c, count: count[l], ang, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), lx: cx + (R + 26) * Math.cos(ang), ly: cy + (R + 26) * Math.sin(ang) };
    });
    const pm = new Map(pts.map((p) => [p.key, p]));
    const arcs: { d: string; color: string; w: number; from: string; to: string; fromKey: string; toKey: string; n: number }[] = [];
    for (const a of layers) for (const b of layers) {
      if (a === b) continue;
      const n = mat[a][b]; if (!n) continue;
      const pa = pm.get(a)!, pb = pm.get(b)!;
      arcs.push({ d: `M${pa.x},${pa.y} Q${cx},${cy} ${pb.x},${pb.y}`, color: pa.color, w: 1 + Math.sqrt(n / maxE) * 12, from: meta[a].l, to: meta[b].l, fromKey: a, toKey: b, n });
    }
    arcs.sort((x, y) => y.w - x.w);
    return { pts, arcs, mat, layers, meta };
  }, [payload]);

  return (
    <div className="flex flex-1 gap-4 overflow-auto" data-testid="chord-view">
      <div className="rounded-lg border bg-card p-2">
        <svg width={S} height={S}>
          <g>
            {layout.arcs.map((a, i) => {
              const on = !hovered || a.fromKey === hovered || a.toKey === hovered;
              return (
                <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={a.w} strokeOpacity={on ? (hovered ? 0.85 : 0.28) : 0.04} strokeLinecap="round">
                  <title>{a.from} → {a.to}: {a.n} dependências</title>
                </path>
              );
            })}
          </g>
          {layout.pts.map((p) => (
            <g key={p.key} onMouseEnter={() => setHovered(p.key)} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
              <circle cx={p.x} cy={p.y} r={hovered === p.key ? 10 : 7} fill={p.color} stroke={hovered === p.key ? "var(--foreground)" : "none"} strokeWidth={hovered === p.key ? 1.5 : 0} />
              <text x={p.lx} y={p.ly} fontSize={12} fontWeight={600} fill={p.color}
                    textAnchor={Math.cos(p.ang) < -0.3 ? "end" : Math.cos(p.ang) > 0.3 ? "start" : "middle"}>
                {p.label} <tspan fontWeight={400} fill="currentColor" className="text-muted-foreground">({p.count})</tspan>
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="w-64 shrink-0 space-y-2 text-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Acoplamento camada→camada</div>
        {layout.arcs.slice(0, 12).map((a, i) => (
          <div key={i} className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: a.color }} /> {a.from} → {a.to}
            </span>
            <Badge variant="outline" className="tabular-nums">{a.n}</Badge>
          </div>
        ))}
        <p className="pt-2 text-xs text-muted-foreground">Largura do arco = nº de dependências. Cor = camada de origem. Arco para fora do sentido esperado revela acoplamento invertido.</p>
      </div>
    </div>
  );
}

// ── Vista DADOS (ER / modelo de domínio — constelação) — AT6 ──────────
// As ENTIDADES do domínio num círculo: ASSOCIATES (@OneToMany/@ManyToOne) como
// cordas entre elas; EXTENDS/IMPLEMENTS como starburst pros SUPERTIPOS no centro
// (revela "tudo herda de BaseEntity"). Cor = grupo de base. A leitura do modelo
// de dados num relance. SVG puro.
function ErView({ payload }: { payload: GraphPayload }) {
  const S = 760, cx = S / 2, cy = S / 2, R = 320;
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => {
    const isEntity = (n: GraphNode) => n.type === "ENTITY";
    const isSuper = (n: GraphNode) => n.type === "SUPERTYPE" || n.type === "INTERFACE";
    const entIds = new Set(payload.nodes.filter(isEntity).map((n) => n.id));
    const superNodes = payload.nodes.filter(isSuper);
    const superIds = new Set(superNodes.map((n) => n.id));
    // entidade → supertipo (via EXTENDS)
    const extOf = new Map<string, string>();
    const assoc: [string, string][] = [];
    const extLinks: [string, string][] = [];
    for (const e of payload.edges) {
      if (e.relationType === "ASSOCIATES" && entIds.has(e.fromNode) && entIds.has(e.toNode)) assoc.push([e.fromNode, e.toNode]);
      if ((e.relationType === "EXTENDS" || e.relationType === "IMPLEMENTS") && entIds.has(e.fromNode) && superIds.has(e.toNode)) {
        extLinks.push([e.fromNode, e.toNode]);
        if (e.relationType === "EXTENDS" && !extOf.has(e.fromNode)) extOf.set(e.fromNode, e.toNode);
      }
    }
    // grupos por supertipo (cores)
    const GROUP_COLORS = ["#f59e0b", "#14b8a6", "#a78bfa", "#fb7185", "#38bdf8"];
    const superOrder = superNodes.map((n) => n.id);
    const groupColor = new Map<string, string>();
    superOrder.forEach((id, i) => groupColor.set(id, GROUP_COLORS[i % GROUP_COLORS.length]));
    // entidades conectadas (com associação OU herança)
    const connected = new Set<string>();
    for (const [a, b] of assoc) { connected.add(a); connected.add(b); }
    for (const [a] of extLinks) connected.add(a);
    const ents = payload.nodes.filter((n) => isEntity(n) && connected.has(n.id));
    // ordena por grupo (supertipo) depois nome — agrupa cores no círculo
    ents.sort((a, b) => (extOf.get(a.id) || "z").localeCompare(extOf.get(b.id) || "z") || (a.className || "").localeCompare(b.className || ""));
    const pos = new Map<string, { x: number; y: number }>();
    ents.forEach((n, i) => {
      const ang = (i / ents.length) * 2 * Math.PI - Math.PI / 2;
      pos.set(n.id, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) });
    });
    // supertipos: dispostos no centro (coluna vertical)
    const sPos = new Map<string, { x: number; y: number; label: string; color: string }>();
    superNodes.forEach((n, i) => {
      const y = cy + (i - (superNodes.length - 1) / 2) * 46;
      sPos.set(n.id, { x: cx, y, label: n.className || n.id.split(":").pop() || "?", color: groupColor.get(n.id)! });
    });
    const neighbors = new Map<string, Set<string>>();
    const link = (a: string, b: string) => (neighbors.get(a) || neighbors.set(a, new Set()).get(a)!).add(b);
    const assocArcs = assoc.filter(([a, b]) => pos.has(a) && pos.has(b)).map(([a, b]) => {
      const pa = pos.get(a)!, pb = pos.get(b)!;
      link(a, b); link(b, a);
      return { d: `M${pa.x},${pa.y} Q${cx},${cy} ${pb.x},${pb.y}`, a, b };
    });
    const extRays = extLinks.filter(([a, b]) => pos.has(a) && sPos.has(b)).map(([a, b]) => {
      const pa = pos.get(a)!, pb = sPos.get(b)!;
      link(a, b); link(b, a);
      return { d: `M${pa.x},${pa.y} L${pb.x},${pb.y}`, color: sPos.get(b)!.color, a, b };
    });
    const entDots = ents.map((n) => {
      const p = pos.get(n.id)!;
      const sup = extOf.get(n.id);
      const ang = Math.atan2(p.y - cy, p.x - cx);
      return { id: n.id, x: p.x, y: p.y, color: sup ? groupColor.get(sup)! : "#64748b", sensitive: n.sensitive, full: n.className || n.id, lx: cx + (R + 10) * Math.cos(ang), ly: cy + (R + 10) * Math.sin(ang), anchor: p.x < cx - 20 ? "end" : p.x > cx + 20 ? "start" : "middle" };
    });
    const supDots = Array.from(sPos.entries()).map(([id, s]) => ({ id, ...s, count: extLinks.filter(([, b]) => b === id).length }));
    const totalEnt = payload.nodes.filter(isEntity).length;
    return { assocArcs, extRays, entDots, supDots, neighbors, shown: ents.length, totalEnt, assocCount: assoc.length, extCount: extLinks.length };
  }, [payload]);

  const hi = hovered ? new Set<string>([hovered, ...Array.from(layout.neighbors.get(hovered) || [])]) : null;
  const dot = (id: string) => (!hi ? 1 : hi.has(id) ? 1 : 0.1);
  const touches = (a: string, b: string) => !hovered || a === hovered || b === hovered;

  return (
    <div className="flex flex-1 gap-4 overflow-auto" data-testid="er-view">
      <div className="rounded-lg border bg-card p-2">
        <svg width={S} height={S}>
          <g>
            {layout.extRays.map((r, i) => (
              <path key={"e" + i} d={r.d} fill="none" stroke={r.color} strokeWidth={touches(r.a, r.b) && hovered ? 1.6 : 0.6} strokeOpacity={touches(r.a, r.b) ? (hovered ? 0.85 : 0.3) : 0.04} />
            ))}
          </g>
          <g>
            {layout.assocArcs.map((a, i) => (
              <path key={"a" + i} d={a.d} fill="none" stroke="#c084fc" strokeWidth={touches(a.a, a.b) && hovered ? 1.4 : 0.7} strokeOpacity={touches(a.a, a.b) ? (hovered ? 0.9 : 0.35) : 0.03} />
            ))}
          </g>
          {layout.entDots.map((n) => {
            const isH = hovered === n.id;
            return (
              <g key={n.id} opacity={dot(n.id)} onMouseEnter={() => setHovered(n.id)} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }}>
                <circle cx={n.x} cy={n.y} r={isH ? 6 : 3.5} fill={n.color} stroke={isH ? "var(--foreground)" : n.sensitive ? "#ef4444" : "none"} strokeWidth={isH ? 1.5 : n.sensitive ? 1.5 : 0} />
                {isH && <text x={n.lx} y={n.ly + 3} fontSize={11} fontWeight={700} textAnchor={n.anchor} fill="currentColor">{trunc(n.full, 22)}</text>}
              </g>
            );
          })}
          {layout.supDots.map((s) => (
            <g key={"s" + s.id} onMouseEnter={() => setHovered(s.id)} onMouseLeave={() => setHovered(null)} style={{ cursor: "pointer" }} opacity={dot(s.id)}>
              <circle cx={s.x} cy={s.y} r={hovered === s.id ? 11 : 9} fill={s.color} stroke="var(--background)" strokeWidth={2} />
              <text x={s.x + 14} y={s.y + 4} fontSize={13} fontWeight={700} fill={s.color}>{s.label} <tspan fontWeight={400} fill="currentColor" className="text-muted-foreground">({s.count})</tspan></text>
            </g>
          ))}
        </svg>
      </div>
      <div className="w-64 shrink-0 space-y-3 text-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Modelo de dados</div>
        <div className="flex items-center justify-between"><span>Entidades conectadas</span><Badge variant="outline">{layout.shown} / {layout.totalEnt}</Badge></div>
        <div className="flex items-center justify-between"><span className="flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-sm" style={{ background: "#c084fc" }} /> Associações</span><Badge variant="outline">{layout.assocCount}</Badge></div>
        <div className="flex items-center justify-between"><span className="flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-sm" style={{ background: "#22d3ee" }} /> Herança</span><Badge variant="outline">{layout.extCount}</Badge></div>
        <div>
          <div className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supertipos (raiz do domínio)</div>
          {layout.supDots.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-0.5">
              <span className="flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} /> {s.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{s.count} herdeiros</span>
            </div>
          ))}
        </div>
        <p className="pt-2 text-xs text-muted-foreground">Cordas roxas = associações JPA (@OneToMany/@ManyToOne). Raios = herança até o supertipo no centro. Cor da entidade = seu supertipo.</p>
      </div>
    </div>
  );
}

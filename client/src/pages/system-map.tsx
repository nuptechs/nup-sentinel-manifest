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
} from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
cytoscape.use(elk as any);

// ── Tipos do payload /api/projects/:id/graph ──────────────────────────
type NodeType = "CONTROLLER" | "SERVICE" | "REPOSITORY" | "ENTITY" | "VIEW" | "ROUTE" | "COMPONENT" | "COMPOSABLE" | "INTERFACE" | "SUPERTYPE";
type EdgeRelation = "CALLS" | "READS_ENTITY" | "WRITES_ENTITY" | "ASSOCIATES" | "EXTENDS" | "IMPLEMENTS";

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
}
interface GraphEdge {
  fromNode: string;
  toNode: string;
  relationType: EdgeRelation;
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
};

function labelOf(n: GraphNode): string {
  return n.className || n.qualifiedSignature || n.id;
}

type ViewMode = "graph" | "matrix" | "layers";

export default function SystemMapPage() {
  const { data: projects } = useQuery<Project[]>({ queryKey: ["/api/projects"] });
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
          </div>
          <Select
            value={projectId != null ? String(projectId) : undefined}
            onValueChange={(v) => setProjectId(Number(v))}
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

      {graphQuery.isLoading && <MapSkeleton />}

      {graphQuery.isError && (
        <GraphEmptyOrError error={graphQuery.error as Error} />
      )}

      {graphQuery.data && viewMode === "graph" && <GraphCanvas payload={graphQuery.data} />}
      {graphQuery.data && viewMode === "matrix" && projectId != null && (
        <MatrixView projectId={projectId} payload={graphQuery.data} />
      )}
      {graphQuery.data && viewMode === "layers" && <LayersFlowView payload={graphQuery.data} />}
    </div>
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
    const map = new Map<string, { source: string; target: string; rel: EdgeRelation; weight: number }>();
    for (const e of payload.edges) {
      if (!scopedIds.has(e.fromNode) || !scopedIds.has(e.toNode)) continue;
      const key = `${e.fromNode}|${e.toNode}|${e.relationType}`;
      const prev = map.get(key);
      if (prev) prev.weight += 1;
      else map.set(key, { source: e.fromNode, target: e.toNode, rel: e.relationType, weight: 1 });
    }
    return Array.from(map.values());
  }, [payload, scopedIds]);

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
        // estados de ênfase
        { selector: ".faded", style: { opacity: 0.08 } },
        { selector: "node.hl", style: { "border-color": "#0f172a", "border-width": 3 } },
        { selector: "edge.hl", style: { opacity: 0.95, width: 3 } },
        { selector: "node.pick", style: { "border-color": "#111827", "border-width": 5 } },
      ],
      layout: {
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
      } as unknown as cytoscape.LayoutOptions,
    });
    cyRef.current = cy;

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
                    const Icon = LAYER[selected.type].icon;
                    return <Icon className="h-4 w-4 shrink-0" style={{ color: LAYER[selected.type].color }} />;
                  })()}
                  <CardTitle className="truncate text-base" title={labelOf(selected)}>
                    {labelOf(selected)}
                  </CardTitle>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge variant="outline" style={{ borderColor: LAYER[selected.type].color }}>
                    {LAYER[selected.type].label}
                  </Badge>
                  {selected.sensitive && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="h-3 w-3" /> sensível
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
            const Icon = LAYER[node.type].icon;
            return (
              <li key={`${node.id}-${i}`}>
                <button
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-muted"
                  onClick={() => onPick(node.id)}
                >
                  <Icon className="h-3 w-3 shrink-0" style={{ color: LAYER[node.type].color }} />
                  <span className="truncate">{labelOf(node)}</span>
                  <span
                    className="ml-auto shrink-0 rounded px-1 text-[10px]"
                    style={{ color: REL[rel].color }}
                  >
                    {REL[rel].label}
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
  { key: "TIPO", label: "Interface/Supertipo", cap: 8, color: "#22d3ee" },
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
    const edges: { d: string; color: string }[] = [];
    for (const e of payload.edges) {
      const a = pos.get(e.fromNode), b = pos.get(e.toNode);
      if (!a || !b || a === b) continue;
      const x1 = a.x + DOT, x2 = b.x - DOT, mx = (x1 + x2) / 2;
      edges.push({ d: `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`, color: (REL[e.relationType]?.color) || "#94a3b8" });
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
    return { cols, edges, width, height, relCounts, resCounts, totalByCol, selTotal };
  }, [payload]);

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
        <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
          <b className="text-foreground">Recorte executivo:</b> os nós mais importantes de cada camada (grau) + suas ligações — {layout.selTotal} de {payload.nodes.length} do grafo.
        </div>
      </div>

      {/* canvas SVG */}
      <div className="flex-1 overflow-auto rounded-lg border bg-card">
        <svg width={layout.width} height={layout.height} className="min-w-full">
          {/* arestas atrás */}
          <g opacity={0.4}>
            {layout.edges.map((e, i) => (
              <path key={i} d={e.d} fill="none" stroke={e.color} strokeWidth={0.7} />
            ))}
          </g>
          {/* colunas */}
          {layout.cols.map((c) => (
            <g key={c.key}>
              <text x={c.x} y={26} fontSize={11} fontWeight={600} fill={c.color}>{c.label.toUpperCase()}</text>
              <text x={c.x} y={40} fontSize={10} fill="currentColor" className="text-muted-foreground">{c.sel}/{c.total}</text>
              {c.nodes.map((n) => (
                <g key={n.id}>
                  <circle cx={c.x} cy={n.y} r={DOT} fill={c.color} stroke={n.sensitive ? "#ef4444" : "none"} strokeWidth={n.sensitive ? 1.5 : 0} />
                  <text x={c.x + 8} y={n.y + 3} fontSize={10} fill="currentColor">{n.label}</text>
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

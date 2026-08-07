// ─────────────────────────────────────────────
// System Map — camada de INSIGHTS "o que importa, PROVADO" (peça 2 do mapa
// epistêmico). Ranking 100% DETERMINÍSTICO derivado do MESMO payload /graph que
// o mapa já carrega — cada afirmação cita sua testemunha (o método de evidência
// + confiança + o arquivo-fonte + o nº de fontes que corroboram). É o que um
// agente lendo código NÃO entrega: não é opinião, é o censo do que o Sentinel
// provou, com a proveniência anexada.
//
// Puro, sem I/O, sem React — testável isoladamente. Degrada honestamente: sem
// eixo de evidência, `corroboratedBy` cai a 0 e nada é inventado.
// ─────────────────────────────────────────────
import {
  type EvidenceMethod,
  EVIDENCE_ORDER,
  PROVEN_TIER,
  evidenceMethodOf,
  confidenceOfMethod,
  type GraphCoverage,
} from "./system-map-evidence";

// ── Forma mínima do payload que consumimos (estruturalmente compatível com o
//    GraphPayload da página — só o subconjunto que o ranking precisa). ────────
export interface InsightNode {
  id: string;
  type: string;
  className?: string;
  qualifiedSignature?: string;
  inDegree: number;
  outDegree: number;
  sourceFile?: string;
  runtimeHot?: boolean;
  runtimeCount?: number;
  sensitive?: boolean;
  layer?: string;
  stack?: string;
}
export interface InsightEdge {
  fromNode: string;
  toNode: string;
  relationType?: string;
  evidence?: { method?: unknown; confidence?: unknown } | null;
}
export interface InsightGraph {
  nodes: InsightNode[];
  edges: InsightEdge[];
  coverage?: GraphCoverage | null;
}

/** Métodos que ADMITEM que não sabemos — se TODAS as arestas de um nó são
 *  assim, ele é um ponto cego (não conseguimos provar como conecta). */
const BLIND: ReadonlySet<EvidenceMethod> = new Set<EvidenceMethod>(["UNKNOWN", "STATIC_UNRESOLVED"]);

const orderIndex = (m: EvidenceMethod): number => {
  const i = EVIDENCE_ORDER.indexOf(m);
  return i === -1 ? EVIDENCE_ORDER.length : i;
};

/** Nome curto legível de um nó (className, senão o fim do id `TYPE:pkg.Classe`). */
export function nodeLabel(n: InsightNode): string {
  if (n.className) return n.className;
  const afterColon = n.id.includes(":") ? n.id.slice(n.id.indexOf(":") + 1) : n.id;
  return afterColon.split(".").filter(Boolean).pop() || afterColon;
}

/** Um nó ranqueado com sua proveniência agregada — a linha de insight. */
export interface RankedNode {
  id: string;
  label: string;
  type: string;
  sourceFile?: string;
  inDegree: number;
  outDegree: number;
  /** alcance de mudança (proxy de blast radius): grau total no grafo de dependências. */
  degree: number;
  /** métodos DISTINTOS presentes nas arestas incidentes, do mais forte ao mais fraco. */
  methods: EvidenceMethod[];
  /** o método mais forte que toca o nó (a testemunha principal). */
  strongest: EvidenceMethod;
  /** confiança do método mais forte (0..1). */
  strongestConfidence: number;
  /** nº de métodos de evidência DISTINTOS = quantas fontes independentes corroboram. */
  corroboratedBy: number;
  /** ≥1 aresta incidente no tier PROVADO (runtime/compilador/config). */
  proven: boolean;
  /** exercitado por tráfego real (traço OTel). */
  runtimeHot: boolean;
  runtimeCount?: number;
  sensitive: boolean;
  /** nº de arestas incidentes (grau efetivo no grafo shaped). */
  incidentEdges: number;
  /** arestas incidentes em método cego (UNKNOWN/STATIC_UNRESOLVED). */
  blindEdges: number;
}

interface NodeAgg {
  methods: Set<EvidenceMethod>;
  incident: number;
  blind: number;
  hasProven: boolean;
}

function emptyAgg(): NodeAgg {
  return { methods: new Set(), incident: 0, blind: 0, hasProven: false };
}

/**
 * Anota CADA nó com a proveniência agregada das suas arestas incidentes, num
 * único passe sobre as arestas. Determinístico: a ordenação final desempata por
 * corroboração e depois por id (estável → reproduzível → não-forjável).
 */
export function buildRankedNodes(graph: InsightGraph): RankedNode[] {
  const agg = new Map<string, NodeAgg>();
  const touch = (id: string, method: EvidenceMethod) => {
    let a = agg.get(id);
    if (!a) {
      a = emptyAgg();
      agg.set(id, a);
    }
    a.methods.add(method);
    a.incident += 1;
    if (BLIND.has(method)) a.blind += 1;
    if (PROVEN_TIER.has(method)) a.hasProven = true;
  };

  for (const e of graph.edges) {
    const method = evidenceMethodOf(e);
    if (typeof e.fromNode === "string") touch(e.fromNode, method);
    if (typeof e.toNode === "string") touch(e.toNode, method);
  }

  const ranked: RankedNode[] = graph.nodes.map((n) => {
    const a = agg.get(n.id) ?? emptyAgg();
    // métodos distintos, do mais forte (menor orderIndex) ao mais fraco.
    const methods = Array.from(a.methods).sort((x, y) => orderIndex(x) - orderIndex(y));
    const strongest = methods[0] ?? "UNKNOWN";
    return {
      id: n.id,
      label: nodeLabel(n),
      type: n.type,
      sourceFile: n.sourceFile,
      inDegree: n.inDegree ?? 0,
      outDegree: n.outDegree ?? 0,
      degree: (n.inDegree ?? 0) + (n.outDegree ?? 0),
      methods,
      strongest,
      strongestConfidence: methods.length ? confidenceOfMethod(strongest) : 0,
      corroboratedBy: a.methods.size,
      proven: a.hasProven,
      runtimeHot: !!n.runtimeHot,
      runtimeCount: n.runtimeCount,
      sensitive: !!n.sensitive,
      incidentEdges: a.incident,
      blindEdges: a.blind,
    };
  });

  return ranked;
}

/** Compara por alcance (desc), depois corroboração (desc), depois id (estável). */
function byBlastRadius(a: RankedNode, b: RankedNode): number {
  if (b.degree !== a.degree) return b.degree - a.degree;
  if (b.corroboratedBy !== a.corroboratedBy) return b.corroboratedBy - a.corroboratedBy;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Top-N por alcance de mudança. `onlyCorroborated`: exige ≥2 fontes de evidência. */
export function topBlastRadius(graph: InsightGraph, limit = 8, onlyCorroborated = false): RankedNode[] {
  const ranked = buildRankedNodes(graph)
    .filter((r) => r.degree > 0 && (!onlyCorroborated || r.corroboratedBy >= 2))
    .sort(byBlastRadius);
  return ranked.slice(0, limit);
}

/**
 * Pontos cegos: nós com ≥1 aresta incidente e TODAS elas em método cego
 * (UNKNOWN/STATIC_UNRESOLVED). O Sentinel ADMITE que não sabe provar como
 * conectam — é o oposto de esconder o furo. Ordena pelos de maior alcance.
 */
export function blindSpots(graph: InsightGraph, limit = 8): RankedNode[] {
  return buildRankedNodes(graph)
    .filter((r) => r.incidentEdges > 0 && r.blindEdges === r.incidentEdges)
    .sort(byBlastRadius)
    .slice(0, limit);
}

/**
 * Hotpaths de runtime: nós EXERCITADOS por tráfego real (traço OTel). A prova
 * mais forte que existe — "visto rodar", não inferido. Ordena por nº de traços
 * e depois alcance.
 */
export function runtimeHotpaths(graph: InsightGraph, limit = 8): RankedNode[] {
  return buildRankedNodes(graph)
    .filter((r) => r.runtimeHot)
    .sort((a, b) => {
      const ca = a.runtimeCount ?? 0;
      const cb = b.runtimeCount ?? 0;
      if (cb !== ca) return cb - ca;
      return byBlastRadius(a, b);
    })
    .slice(0, limit);
}

export interface InsightsSummary {
  nodes: number;
  edges: number;
  /** nós de alto alcance corroborados por ≥2 fontes de evidência. */
  corroborated: number;
  /** nós que são ponto cego (só arestas UNKNOWN/STATIC_UNRESOLVED). */
  blind: number;
  /** nós vistos rodar em tráfego real. */
  hot: number;
  /** o backend anexou o eixo de evidência? (senão, corroboração não se aplica) */
  hasEvidence: boolean;
}

/** Números de topo para a manchete honesta do painel. */
export function insightsSummary(graph: InsightGraph): InsightsSummary {
  const ranked = buildRankedNodes(graph);
  const hasEvidence = graph.edges.some((e) => e != null && e.evidence != null);
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    corroborated: ranked.filter((r) => r.corroboratedBy >= 2).length,
    blind: ranked.filter((r) => r.incidentEdges > 0 && r.blindEdges === r.incidentEdges).length,
    hot: ranked.filter((r) => r.runtimeHot).length,
    hasEvidence,
  };
}

// ─────────────────────────────────────────────────────────────
// Agregação de DATA-ACCESS (Opção A) — liga o `dataAccess` do deriver ao grafo.
//
// O `tools/scip-typescript/scip-data-access.mjs` já prova, com o compilador,
// quais FUNÇÕES leem/escrevem quais TABELAS (verbo Drizzle `select/insert/…` +
// a const `pgTable` na mesma linha). O deriver empacota isso em `payload.dataAccess`,
// MAS o ingest descartava o campo e a agregação nunca existiu — o eixo de dados
// do grafo continuava 100% heurístico (STATIC_UNRESOLVED). Este módulo fecha isso:
//
//   dataAccess[{from:fn-sym, to:table-sym, access, fromFile, toFile}]
//     → aresta  <módulo-do-arquivo>  --READS_ENTITY|WRITES_ENTITY-->  <entidade|table:físico>
//       com `resolution:'compiler'` ⇒ classificada STATIC_PROVEN (0.80).
//
// GRANULARIDADE: arquivo→tabela (o módulo do `fromFile` → a entidade). Conservador
// e robusto — reusa `buildFileNodeIndex` (a MESMA resolução de arquivo→nó do
// scip-aggregate) e `toSnakeCase` (a MESMA convenção de casamento de entidade do
// runtime-overlay). Sub-nó de função é refinamento futuro. PURO; nunca lança.
// ─────────────────────────────────────────────────────────────
import { buildFileNodeIndex, functionOfScipSymbol } from "./scip-aggregate";
import { toSnakeCase } from "./nuptechs-conventions";

interface RawNode {
  id: string;
  type: string;
  className?: string;
  metadata?: Record<string, unknown>;
}
interface RawEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  metadata?: Record<string, unknown>;
}
interface RawGraph {
  nodes: RawNode[];
  edges: RawEdge[];
}
interface DataAccessEdge {
  from: string;
  to: string;
  access: "read" | "write";
  fromFile?: string;
  toFile?: string;
}
export interface DataAccessStats {
  received: number;
  edgesAdded: number;
  tableNodesMinted: number;
  fromUnresolved: number; // arquivo-fonte sem nó no grafo → não atribui (honesto)
  tableUnresolved: number;
}

const REL = { read: "READS_ENTITY", write: "WRITES_ENTITY" } as const;

/**
 * Nome físico da tabela a partir do símbolo da const Drizzle (o rótulo é o nome da
 * const). O `functionOfScipSymbol` foi feito p/ MÉTODOS (termina em `().`) — numa
 * const/term o descritor termina só em `.` (sem parênteses), então o rótulo vem com
 * o ponto terminal (`contract.`); tiramos o(s) `.`/`#`/`/` residual(is). */
function physicalTableName(sym: string, file?: string): string | null {
  const r = functionOfScipSymbol(sym, file ?? null); // const → {file, fn:<nome-da-const> + '.'}
  if (!r || !r.fn || r.fn === "<module>") return null;
  const name = r.fn.replace(/[.#/]+$/, "").trim(); // remove pontuação terminal de descritor
  return name || null;
}

/**
 * Índice `snake(className) → id` das ENTITY existentes, para casar a tabela física
 * a uma entidade JÁ no grafo (a MESMA convenção que o runtime-overlay usa para
 * `table:<snake>` → ENTITY). Sem match → mint de `table:<snake>` sintético.
 */
function entityIndex(nodes: RawNode[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const n of nodes) {
    if (n.type !== "ENTITY") continue;
    const cn = n.className || "";
    if (cn) idx.set(toSnakeCase(cn).toLowerCase(), n.id);
    // também casa o id `table:x` já materializado (runtime)
    if (n.id.startsWith("table:")) idx.set(n.id.slice(6).toLowerCase(), n.id);
  }
  return idx;
}

/**
 * Mescla o `dataAccess` como arestas READS/WRITES_ENTITY compiler-proven.
 * PURO: clona o grafo (não muta o snapshot). Fail-soft por aresta.
 */
export function mergeDataAccessEdges(
  rawGraph: RawGraph | null | undefined,
  dataAccess: DataAccessEdge[] | null | undefined,
): { graph: RawGraph; stats: DataAccessStats } {
  const zero: DataAccessStats = { received: 0, edgesAdded: 0, tableNodesMinted: 0, fromUnresolved: 0, tableUnresolved: 0 };
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) return { graph: rawGraph as RawGraph, stats: zero };
  if (!Array.isArray(dataAccess) || dataAccess.length === 0) return { graph: rawGraph, stats: { ...zero } };

  const graph: RawGraph = {
    ...rawGraph,
    nodes: rawGraph.nodes.slice(),
    edges: rawGraph.edges.map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : e.metadata })),
  };
  const fileIndex = buildFileNodeIndex(graph.nodes as never);
  const entIdx = entityIndex(graph.nodes);
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  const seenEdge = new Set<string>();
  for (const e of graph.edges) seenEdge.add(`${e.fromNode}|${e.toNode}|${e.relationType}`);

  const stats: DataAccessStats = { received: dataAccess.length, edgesAdded: 0, tableNodesMinted: 0, fromUnresolved: 0, tableUnresolved: 0 };

  for (const da of dataAccess) {
    if (!da || (da.access !== "read" && da.access !== "write")) continue;
    // FROM: o nó de módulo/entidade do arquivo-fonte. Sem nó → não atribui (honesto).
    const fromNode = da.fromFile ? fileIndex.get(da.fromFile) : undefined;
    if (!fromNode) { stats.fromUnresolved++; continue; }
    // TO: nome físico → entidade existente OU `table:<snake>` sintético.
    const phys = physicalTableName(da.to, da.toFile);
    if (!phys) { stats.tableUnresolved++; continue; }
    const snake = toSnakeCase(phys).toLowerCase();
    let toNode = entIdx.get(snake);
    if (!toNode) {
      toNode = `table:${snake}`;
      if (!existingIds.has(toNode)) {
        existingIds.add(toNode);
        graph.nodes.push({
          id: toNode,
          type: "ENTITY",
          className: snake,
          metadata: { sourceFile: da.toFile, scipProven: true, materializedFrom: "scip-data-access", dataProven: true },
        });
        entIdx.set(snake, toNode);
        stats.tableNodesMinted++;
      }
    }
    if (fromNode === toNode) continue;
    const rel = REL[da.access];
    const key = `${fromNode}|${toNode}|${rel}`;
    if (seenEdge.has(key)) {
      // já existe (heurística) → PROMOVE a provada
      const ex = graph.edges.find((x) => x.fromNode === fromNode && x.toNode === toNode && x.relationType === rel);
      if (ex) {
        const md = (ex.metadata || {}) as Record<string, unknown>;
        md.resolution = "compiler";
        delete md.synthetic;
        md.scipProven = true;
        md.dataProven = true;
        ex.metadata = md;
      }
      continue;
    }
    seenEdge.add(key);
    graph.edges.push({ fromNode, toNode, relationType: rel, metadata: { resolution: "compiler", scipProven: true, dataProven: true } });
    stats.edgesAdded++;
  }
  return { graph, stats };
}

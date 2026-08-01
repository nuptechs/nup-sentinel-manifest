// ─────────────────────────────────────────────
// DSM / Levelized Structure Map (ADR-0026 Onda AT1) — a representação de ATLAS
// para ler a estrutura de conjunto de um sistema denso.
//
// Por quê (lei empírica, ADR-0026 §3.1 — Ghoniem/Fekete 2005, LIDO): acima de
// ~20 nós o node-link vira novelo ilegível e a MATRIZ/DSM supera na maioria das
// tarefas de leitura; node-link só vence em SEGUIR UM CAMINHO. O grafo do easynup
// tem 3.444 nós — jogá-lo como bolinhas é o anti-padrão que a fronteira condena.
//
// O que o DSM entrega (escola Structure101 LSM / Lattix / Sonargraph):
//  - PARTIÇÃO AUTOMÁTICA em camadas niveladas (block-triangular): reordena os
//    nós por nível de dependência de modo que, num sistema acíclico, TODAS as
//    dependências caem de um lado da diagonal — as camadas que ninguém desenhou
//    emergem sozinhas (partitioning da DSM).
//  - TANGLES (ciclos): SCCs ≥2 = dependências cíclicas, as regiões que impedem a
//    nivelação (as "caixas vermelhas" do Structure101). Reusa o Tarjan do
//    graph-drift (§2.5, reuso-primeiro).
//  - ARESTAS DE FEEDBACK: quantas dependências "sobem" (violam a ordem em
//    camadas) — a medida de quão longe o sistema está de uma arquitetura limpa.
//
// Puro e testável — recebe o ShapedGraph (class-level), devolve a estrutura.
// A ESCOLHA matriz×node-link (B5) é do cliente; aqui produzimos o DADO do DSM.
// ─────────────────────────────────────────────
import { sccs } from "./graph-drift";
import type { ShapedGraph } from "./system-graph";

export interface DsmPartition {
  level: number;          // 0 = fontes (não dependem de ninguém acima); cresce p/ baixo
  nodes: string[];        // ids nesta camada nivelada
}
export interface DsmResult {
  /** ordem block-triangular dos nós (por nível, depois por id) — as linhas/colunas da matriz. */
  order: string[];
  /** camadas niveladas descobertas automaticamente (LSM). */
  partitions: DsmPartition[];
  /** tangles: SCCs ≥2 (dependências cíclicas que impedem a nivelação). */
  cycles: string[][];
  /** true quando o grafo é acíclico ⇒ perfeitamente nivelável (block-triangular puro). */
  levelizable: boolean;
  stats: {
    nodes: number;
    edges: number;          // arestas de dependência únicas consideradas
    levels: number;         // nº de camadas niveladas
    cycleCount: number;     // nº de tangles (SCCs ≥2)
    nodesInCycles: number;  // nós presos em tangles
    feedbackEdges: number;  // dependências que "sobem" ou fecham ciclo (violam a ordem)
    feedbackPct: number;    // % das arestas que são feedback (0 = arquitetura limpa)
  };
}

/**
 * Constrói o DSM/LSM a partir do grafo class-level. Toda relação
 * (CALLS/READS_ENTITY/WRITES_ENTITY/ASSOCIATES) conta como dependência dirigida
 * from→to. Puro.
 */
export function computeDsm(shaped: ShapedGraph): DsmResult {
  const nodeIds = shaped.nodes.map((n) => n.id);
  const idSet = new Set(nodeIds);

  // adjacência dirigida (dedup), só arestas cujos dois extremos existem
  const adj = new Map<string, string[]>();
  const seen = new Set<string>();
  let edgeCount = 0;
  for (const e of shaped.edges) {
    if (!idSet.has(e.fromNode) || !idSet.has(e.toNode) || e.fromNode === e.toNode) continue;
    const k = `${e.fromNode}->${e.toNode}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edgeCount++;
    (adj.get(e.fromNode) || adj.set(e.fromNode, []).get(e.fromNode)!).push(e.toNode);
  }

  // tangles (SCCs ≥2)
  const cycles = sccs(nodeIds, adj);
  const compOf = new Map<string, string>(); // nó → representante do SCC
  for (const comp of cycles) {
    const rep = comp[0];
    for (const n of comp) compOf.set(n, rep);
  }
  const repOf = (n: string) => compOf.get(n) || n; // nó fora de ciclo = ele mesmo

  // condensação: DAG de componentes; adjacência entre reps distintos
  const compAdj = new Map<string, Set<string>>();
  const comps = new Set<string>(nodeIds.map(repOf));
  for (const c of comps) compAdj.set(c, new Set());
  for (const [from, tos] of adj) {
    const a = repOf(from);
    for (const to of tos) {
      const b = repOf(to);
      if (a !== b) compAdj.get(a)!.add(b);
    }
  }

  // nivelação por caminho mais longo (topo via Kahn na condensação): level(c) =
  // 0 se não tem predecessor; senão max(level(pred))+1 — revela as camadas.
  const indeg = new Map<string, number>();
  for (const c of comps) indeg.set(c, 0);
  for (const [, tos] of compAdj) for (const b of tos) indeg.set(b, (indeg.get(b) || 0) + 1);
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const c of comps) if ((indeg.get(c) || 0) === 0) { level.set(c, 0); queue.push(c); }
  while (queue.length) {
    const c = queue.shift()!;
    const lc = level.get(c) || 0;
    for (const b of compAdj.get(c) || []) {
      if ((level.get(b) || 0) < lc + 1) level.set(b, lc + 1);
      indeg.set(b, (indeg.get(b) || 0) - 1);
      if ((indeg.get(b) || 0) === 0) queue.push(b);
    }
  }
  // qualquer comp sem nível (não deveria, DAG) cai em 0 defensivamente
  const levelOf = (n: string) => level.get(repOf(n)) ?? 0;

  // partições + ordem block-triangular
  const byLevel = new Map<number, string[]>();
  for (const n of nodeIds) {
    const l = levelOf(n);
    (byLevel.get(l) || byLevel.set(l, []).get(l)!).push(n);
  }
  const levels = Array.from(byLevel.keys()).sort((a, b) => a - b);
  const partitions: DsmPartition[] = levels.map((l) => ({ level: l, nodes: byLevel.get(l)!.slice().sort() }));
  const order: string[] = partitions.flatMap((p) => p.nodes);

  // arestas de feedback: destino em nível <= origem (sobe/lateral) OU fecha ciclo
  let feedback = 0;
  for (const [from, tos] of adj) {
    for (const to of tos) {
      if (repOf(from) === repOf(to)) { feedback++; continue; } // intra-tangle
      if (levelOf(to) <= levelOf(from)) feedback++;
    }
  }

  const nodesInCycles = cycles.reduce((s, c) => s + c.length, 0);
  return {
    order,
    partitions,
    cycles,
    levelizable: cycles.length === 0,
    stats: {
      nodes: nodeIds.length,
      edges: edgeCount,
      levels: partitions.length,
      cycleCount: cycles.length,
      nodesInCycles,
      feedbackEdges: feedback,
      feedbackPct: edgeCount ? Math.round((feedback / edgeCount) * 1000) / 10 : 0,
    },
  };
}

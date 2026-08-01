// ─────────────────────────────────────────────
// Máquina do tempo do grafo (ADR-0025 além-fronteira, Obra 3) — DIFF entre dois
// snapshots do systemGraph, class-level. É a capacidade que um agente NÃO tem:
// ele não tem "ontem". Prior-art: CodeScene (tendência/trend de code health),
// CAST/Sonargraph (delta de arquitetura entre builds), literatura de erosão
// arquitetural. Aqui: churn de nós, arestas novas/mortas, NOVOS ciclos entre
// serviços, delta de acoplamento dos hubs, e delta de isolamento.
// Puro e testável — recebe dois RawSystemGraph, devolve o diff + findings.
// ─────────────────────────────────────────────
import { shapeSystemGraph, type RawSystemGraph, type ShapedEdge } from "./system-graph";

export interface GraphDrift {
  nodes: { added: string[]; removed: string[]; byLayerDelta: Record<string, number> };
  edges: { added: number; removed: number; addedSample: string[]; removedSample: string[] };
  newServiceCycles: string[][];        // ciclos SERVICE↔SERVICE que NÃO existiam antes
  couplingDelta: { id: string; before: number; after: number; deltaPct: number }[]; // hubs que mais mudaram
  isolationDelta: { before: number; after: number };
  counts: { nodesBefore: number; nodesAfter: number; edgesBefore: number; edgesAfter: number };
}

const edgeKey = (e: ShapedEdge) => `${e.fromNode}->${e.toNode}:${e.relationType}`;

/** SCCs (Tarjan iterativo) ≥2 do subgrafo dado (id→[ids]). Puro. */
function sccs(nodeIds: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = []; let counter = 0; const out: string[][] = [];
  for (const start of nodeIds) {
    if (index.has(start)) continue;
    const call: [string, number][] = [[start, 0]];
    while (call.length) {
      const frame = call[call.length - 1]; const v = frame[0];
      if (!index.has(v)) { index.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v); }
      const ns = adj.get(v) || []; let advanced = false;
      while (frame[1] < ns.length) {
        const w = ns[frame[1]++];
        if (!index.has(w)) { call.push([w, 0]); advanced = true; break; }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
      if (advanced) continue;
      call.pop();
      if (call.length) { const p = call[call.length - 1][0]; low.set(p, Math.min(low.get(p)!, low.get(v)!)); }
      if (low.get(v) === index.get(v)) {
        const comp: string[] = []; let w: string;
        do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
        if (comp.length >= 2) out.push(comp.sort());
      }
    }
  }
  return out;
}

function serviceCycles(nodes: { id: string; type: string }[], edges: ShapedEdge[]): Set<string> {
  const svc = new Set(nodes.filter((n) => n.type === "SERVICE").map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.relationType !== "CALLS" || !svc.has(e.fromNode) || !svc.has(e.toNode)) continue;
    (adj.get(e.fromNode) || adj.set(e.fromNode, []).get(e.fromNode)!).push(e.toNode);
  }
  const set = new Set<string>();
  for (const comp of sccs(Array.from(svc), adj)) set.add(comp.join("|"));
  return set;
}

/**
 * Diff class-level entre o snapshot ANTERIOR e o ATUAL. `topCoupling` = quantos
 * hubs de maior variação de acoplamento reportar. Puro.
 */
export function computeGraphDrift(prev: RawSystemGraph, curr: RawSystemGraph, topCoupling = 10): GraphDrift {
  const A = shapeSystemGraph(prev, "class");
  const B = shapeSystemGraph(curr, "class");
  const aNodes = new Map(A.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(B.nodes.map((n) => [n.id, n]));

  const added = B.nodes.filter((n) => !aNodes.has(n.id)).map((n) => n.id);
  const removed = A.nodes.filter((n) => !bNodes.has(n.id)).map((n) => n.id);
  const byLayerDelta: Record<string, number> = {};
  for (const n of B.nodes) byLayerDelta[n.type] = (byLayerDelta[n.type] || 0) + 1;
  for (const n of A.nodes) byLayerDelta[n.type] = (byLayerDelta[n.type] || 0) - 1;
  for (const k of Object.keys(byLayerDelta)) if (byLayerDelta[k] === 0) delete byLayerDelta[k];

  const aEdges = new Set(A.edges.map(edgeKey));
  const bEdges = new Set(B.edges.map(edgeKey));
  const edgesAdded = B.edges.filter((e) => !aEdges.has(edgeKey(e)));
  const edgesRemoved = A.edges.filter((e) => !bEdges.has(edgeKey(e)));

  const cyclesA = serviceCycles(A.nodes, A.edges);
  const cyclesB = serviceCycles(B.nodes, B.edges);
  const newServiceCycles = Array.from(cyclesB).filter((c) => !cyclesA.has(c)).map((c) => c.split("|"));

  // acoplamento = inDegree (quantos dependem do nó). Delta% sobre nós presentes nos dois.
  const couplingDelta: GraphDrift["couplingDelta"] = [];
  for (const [id, b] of Array.from(bNodes.entries())) {
    const a = aNodes.get(id); if (!a) continue;
    if (a.inDegree === b.inDegree) continue;
    const before = a.inDegree, after = b.inDegree;
    const deltaPct = before > 0 ? Math.round(((after - before) / before) * 100) : (after > 0 ? 999 : 0);
    couplingDelta.push({ id, before, after, deltaPct });
  }
  couplingDelta.sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before));

  const isoOf = (g: typeof A) => {
    const deg = new Map<string, number>(); g.nodes.forEach((n) => deg.set(n.id, 0));
    g.edges.forEach((e) => { deg.set(e.fromNode, (deg.get(e.fromNode) || 0) + 1); deg.set(e.toNode, (deg.get(e.toNode) || 0) + 1); });
    return Array.from(deg.values()).filter((d) => d === 0).length;
  };

  return {
    nodes: { added, removed, byLayerDelta },
    edges: { added: edgesAdded.length, removed: edgesRemoved.length,
      addedSample: edgesAdded.slice(0, 10).map(edgeKey), removedSample: edgesRemoved.slice(0, 10).map(edgeKey) },
    newServiceCycles,
    couplingDelta: couplingDelta.slice(0, topCoupling),
    isolationDelta: { before: isoOf(A), after: isoOf(B) },
    counts: { nodesBefore: A.nodes.length, nodesAfter: B.nodes.length, edgesBefore: A.edges.length, edgesAfter: B.edges.length },
  };
}

/**
 * Traduz o drift em findings para o Tribunal (source auto_arch_conformance,
 * type architectural). Só o que É drift REAL de risco: ciclo NOVO entre
 * serviços (erosão) e salto de acoplamento (≥50% e ≥+5 dependentes num hub).
 * Churn puro de nós/arestas NÃO vira finding (é evolução normal — fica no diff
 * para a tela). Cada finding com grounding. Puro.
 */
export function driftToFindings(drift: GraphDrift, ctx: { projectId: string; organizationId?: string | null }): any[] {
  const base = { projectId: ctx.projectId, ...(ctx.organizationId ? { organizationId: ctx.organizationId } : {}),
    source: "auto_arch_conformance", type: "architectural" as const };
  const out: any[] = [];
  const short = (id: string) => id.split(/[.:]/).pop() || id;
  for (const comp of drift.newServiceCycles.slice(0, 20)) {
    const names = comp.map(short);
    out.push({ ...base, subtype: "graph-drift-new-cycle", severity: "medium",
      title: `Ciclo NOVO entre serviços apareceu: ${names.slice(0, 6).join(" ↔ ")}${names.length > 6 ? ` (+${names.length - 6})` : ""}`,
      description: `Um componente fortemente conexo de ${comp.length} serviços NÃO existia no snapshot anterior — erosão arquitetural introduzida entre as duas análises. Determinístico (diff de grafo no tempo).`,
      symbolRef: { kind: "file", identifier: comp[0] },
      evidences: [{ source: "auto_arch_conformance", observation: `graph-drift new-cycle: ${comp.join(" -> ")}` }] });
  }
  for (const c of drift.couplingDelta) {
    if (c.after - c.before < 5 || c.deltaPct < 50) continue; // só salto relevante
    out.push({ ...base, subtype: "graph-drift-coupling-spike", severity: "low",
      title: `Acoplamento de ${short(c.id)} subiu ${c.deltaPct}% (${c.before}→${c.after} dependentes)`,
      description: `O nº de componentes que dependem de ${c.id} saltou entre as duas análises — hub crescendo, risco de ponto único de mudança. Determinístico (diff de grafo no tempo).`,
      symbolRef: { kind: "file", identifier: c.id },
      evidences: [{ source: "auto_arch_conformance", observation: `graph-drift coupling: ${c.id} ${c.before}->${c.after} (+${c.deltaPct}%)` }] });
  }
  return out;
}

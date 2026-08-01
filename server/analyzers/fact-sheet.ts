// ─────────────────────────────────────────────
// Ficha de Fatos (ADR-0025 além-fronteira, Obra 4) — a fonte-da-verdade
// determinística e versionada dos números de arquitetura, que uma IA CITA em
// vez de recontar (e contra a qual sua contagem é VERIFICADA). Prior-art: Meta
// Glean (fatos de código como serviço), Backstage catalog (fonte canônica).
// O diferencial vs. agente: proveniência (qual análise), frescor (quando), e a
// checagem de DIVERGÊNCIA — o Sentinel deixa de competir com o agente e passa
// a CORRIGI-LO. Puro e testável.
// ─────────────────────────────────────────────
import { shapeSystemGraph, type RawSystemGraph } from "./system-graph";

export interface FactSheet {
  provenance: { analysisRunId: number | null; computedAt: string; snapshotAt: string | null; freshnessSeconds: number | null };
  /**
   * Camadas por ÂNCORA de id-prefixo (view RAW): `wsv1:`→ENDPOINT, `node:`→
   * NODE_MODULE, `table:`→ENTITY, senão o tipo do produtor. São conjuntos
   * DISJUNTOS (um nó cai em exatamente um balde) — não há dupla contagem no
   * total. ENDPOINT e CONTROLLER são âncoras distintas do MESMO fluxo de api
   * (C2 da ADR-0026): o endpoint é o contrato HTTP, o controller é a classe.
   */
  layers: Record<string, number>;
  /**
   * CM2 (ADR-0026 C2) — camada CANÔNICA deduplicada (do modelo canônico): o
   * tier arquitetural real (api/domain/data/presentation/infra), onde ENDPOINT
   * e CONTROLLER convergem em `api` (sem a dupla-representação da view raw).
   * É a verdade que a IA deve CITAR para "quantos endpoints/controllers há".
   */
  byLayer: Record<string, number>;
  /** CM2 (ADR-0026) — distribuição por STACK (spring/express/vue/node). */
  byStack: Record<string, number>;
  inventory: Record<string, unknown> | null;      // código: telas roteadas, .vue, composables (denominador)
  participation: { views: number; components: number; composables: number }; // alcançam backend
  topHubs: { id: string; dependents: number; sensitive: boolean }[]; // entidades mais dependidas
  edges: { total: number; byRelation: Record<string, number> };
  isolatedInjustified: number;                    // isolados que NÃO são entry-point
  totals: { nodes: number; edges: number };
}

/** Constrói a ficha canônica a partir do systemGraph cru + metadados do snapshot. Puro. */
export function buildFactSheet(
  raw: RawSystemGraph,
  meta: { analysisRunId?: number | null; snapshotAt?: string | Date | null; now?: number } = {},
): FactSheet {
  const g = shapeSystemGraph(raw, "class");
  const nowMs = meta.now ?? Date.parse(new Date().toISOString()); // now injetável p/ teste
  const snapAt = meta.snapshotAt ? new Date(meta.snapshotAt).toISOString() : null;
  const freshness = snapAt ? Math.max(0, Math.round((nowMs - Date.parse(snapAt)) / 1000)) : null;

  // camadas (ENDPOINT = wsv1; node: = módulo Node; table: = drizzle-only já é ENTITY)
  const layers: Record<string, number> = {};
  const rel: Record<string, number> = {};
  const deg = new Map<string, number>();
  for (const n of g.nodes) {
    const layer = n.id.startsWith("wsv1:") ? "ENDPOINT" : (n.id.startsWith("node:") ? "NODE_MODULE" : n.type);
    layers[layer] = (layers[layer] || 0) + 1;
    deg.set(n.id, 0);
  }
  for (const e of g.edges) {
    rel[e.relationType] = (rel[e.relationType] || 0) + 1;
    deg.set(e.fromNode, (deg.get(e.fromNode) || 0) + 1);
    deg.set(e.toNode, (deg.get(e.toNode) || 0) + 1);
  }

  const topHubs = g.nodes
    .filter((n) => n.type === "ENTITY")
    .map((n) => ({ id: n.className || n.id, dependents: n.inDegree, sensitive: !!n.sensitive }))
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, 15);

  const isolatedInjustified = g.nodes.filter((n) => (deg.get(n.id) || 0) === 0 && !(n.entryPoint && n.entryPoint.length)).length;

  return {
    provenance: { analysisRunId: meta.analysisRunId ?? null, computedAt: new Date(nowMs).toISOString(), snapshotAt: snapAt, freshnessSeconds: freshness },
    layers,
    byLayer: g.byLayer || {},   // CM2 — camada canônica deduplicada (C2)
    byStack: g.byStack || {},   // CM2 — distribuição por stack
    inventory: (g.inventory && typeof g.inventory === "object") ? (g.inventory as Record<string, unknown>) : null,
    participation: {
      views: g.nodes.filter((n) => n.type === "VIEW" && (deg.get(n.id) || 0) > 0).length,
      components: g.nodes.filter((n) => n.type === "COMPONENT" && (deg.get(n.id) || 0) > 0).length,
      composables: g.nodes.filter((n) => n.type === "COMPOSABLE" && (deg.get(n.id) || 0) > 0).length,
    },
    topHubs,
    edges: { total: g.edges.length, byRelation: rel },
    isolatedInjustified,
    totals: { nodes: g.nodes.length, edges: g.edges.length },
  };
}

/**
 * Verificação de DIVERGÊNCIA (o Sentinel corrige o agente). Recebe uma alegação
 * {metric, value} e devolve o valor canônico + se bate. `metric` é um caminho
 * simples: "layers.ENDPOINT", "inventory.routedPages", "totals.nodes",
 * "participation.views", "isolatedInjustified". Puro.
 */
export function checkClaim(sheet: FactSheet, metric: string, value: number): {
  metric: string; canonical: number | null; claimed: number; matches: boolean; delta: number | null; provenance: FactSheet["provenance"];
} {
  const parts = String(metric || "").split(".");
  let cur: any = sheet;
  for (const p of parts) cur = cur == null ? null : cur[p];
  const canonical = typeof cur === "number" ? cur : null;
  const matches = canonical !== null && canonical === value;
  return { metric, canonical, claimed: value, matches, delta: canonical !== null ? value - canonical : null, provenance: sheet.provenance };
}

// ─────────────────────────────────────────────
// Diagramas de Evidência — lógica PURA compartilhada por Zoom e Radar.
//
// A regra central (o conceito publicável): um agregado (domínio) herda o PIOR
// tier de evidência presente entre seus membros — fail-honest, NUNCA a média.
// Um domínio "verde no papel" cujo único elo interno é heurística deve aparecer
// tão incerto quanto esse elo. Também: share de arestas provadas por domínio
// (proven / total), com abstenção honesta quando não há aresta.
// ─────────────────────────────────────────────
import {
  EVIDENCE_ORDER,
  PROVEN_TIER,
  evidenceMethodOf,
  evidenceRank,
  type EvidenceMethod,
} from "./system-map-evidence";

export interface DomainLite {
  id: string;
  name: string;
  size: number;
  members?: string[];
  nodeIds?: string[];
  byType?: Record<string, number>;
  runtimeHot?: number;
}
export interface SeamLite {
  from: string;
  to: string;
  edges: number;
}
export interface DomainsReport {
  domains?: DomainLite[];
  seams?: SeamLite[];
  hubs?: string[];
}

export interface EdgeLite {
  fromNode: string;
  toNode: string;
  evidence?: { method?: unknown } | null;
}

/** O tier mais fraco de um conjunto de métodos (ou UNKNOWN se vazio). */
export function worstTier(methods: readonly EvidenceMethod[]): EvidenceMethod {
  if (methods.length === 0) return "UNKNOWN";
  let worst = methods[0];
  for (const m of methods) if (evidenceRank(m) < evidenceRank(worst)) worst = m;
  return worst;
}

export interface DomainEvidence {
  id: string;
  name: string;
  size: number;
  worstTier: EvidenceMethod; // herda o PIOR dos elos incidentes
  provenShare: number; // arestas provadas / total incidentes (0..1); -1 = sem aresta (cego)
  edgeCount: number;
  runtimeHot: number;
}

/**
 * Mapeia cada nó ao seu domínio (por nodeIds) e agrega os elos incidentes:
 * worstTier = pior método entre TODOS os elos internos+incidentes dos membros;
 * provenShare = fração provada. Sem elo → provenShare -1 (cego, não fabricar). Puro.
 */
export function computeDomainEvidence(report: DomainsReport | null | undefined, edges: EdgeLite[]): DomainEvidence[] {
  const domains = report?.domains ?? [];
  const nodeToDomain = new Map<string, string>();
  for (const d of domains) for (const nid of d.nodeIds ?? []) nodeToDomain.set(nid, d.id);

  const methodsByDomain = new Map<string, EvidenceMethod[]>();
  const provenByDomain = new Map<string, number>();
  const totalByDomain = new Map<string, number>();
  for (const d of domains) {
    methodsByDomain.set(d.id, []);
    provenByDomain.set(d.id, 0);
    totalByDomain.set(d.id, 0);
  }

  for (const e of edges) {
    const df = nodeToDomain.get(e.fromNode);
    const dt = nodeToDomain.get(e.toNode);
    const method = evidenceMethodOf(e);
    // conta o elo para todo domínio que ele toca (interno ou incidente).
    for (const dom of new Set([df, dt].filter(Boolean) as string[])) {
      methodsByDomain.get(dom)!.push(method);
      totalByDomain.set(dom, (totalByDomain.get(dom) || 0) + 1);
      if (PROVEN_TIER.has(method)) provenByDomain.set(dom, (provenByDomain.get(dom) || 0) + 1);
    }
  }

  return domains.map((d) => {
    const methods = methodsByDomain.get(d.id) || [];
    const total = totalByDomain.get(d.id) || 0;
    const proven = provenByDomain.get(d.id) || 0;
    return {
      id: d.id,
      name: d.name,
      size: d.size,
      worstTier: worstTier(methods),
      provenShare: total === 0 ? -1 : proven / total,
      edgeCount: total,
      runtimeHot: d.runtimeHot || 0,
    };
  });
}

export interface SeamEvidence {
  from: string;
  to: string;
  edges: number;
  worstTier: EvidenceMethod;
}

/** Agrega o pior tier de cada seam (feixe entre domínios). Puro. */
export function computeSeamEvidence(report: DomainsReport | null | undefined, edges: EdgeLite[]): SeamEvidence[] {
  const seams = report?.seams ?? [];
  const domains = report?.domains ?? [];
  const nodeToDomain = new Map<string, string>();
  for (const d of domains) for (const nid of d.nodeIds ?? []) nodeToDomain.set(nid, d.id);
  const methodsBySeam = new Map<string, EvidenceMethod[]>();
  const keyOf = (a: string, b: string) => `${a}=>${b}`;
  for (const s of seams) methodsBySeam.set(keyOf(s.from, s.to), []);
  for (const e of edges) {
    const df = nodeToDomain.get(e.fromNode);
    const dt = nodeToDomain.get(e.toNode);
    if (!df || !dt || df === dt) continue;
    const k = keyOf(df, dt);
    if (methodsBySeam.has(k)) methodsBySeam.get(k)!.push(evidenceMethodOf(e));
  }
  return seams.map((s) => ({
    from: s.from,
    to: s.to,
    edges: s.edges,
    worstTier: worstTier(methodsBySeam.get(keyOf(s.from, s.to)) || []),
  }));
}

/** Censo global de tiers a partir das arestas (fallback quando não há coverage). Puro. */
export function tierCensus(edges: EdgeLite[]): Record<EvidenceMethod, number> {
  const census = Object.fromEntries(EVIDENCE_ORDER.map((m) => [m, 0])) as Record<EvidenceMethod, number>;
  for (const e of edges) census[evidenceMethodOf(e)] += 1;
  return census;
}

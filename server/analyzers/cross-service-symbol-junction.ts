// ─────────────────────────────────────────────────────────────────────────
// OBS-D04 (ADR-0036 WS-D) — JUNÇÃO CROSS-SERVICE POR SÍMBOLO (não por string).
//
// Hoje o elo ENTRE serviços (gateway→Java, easynup→identify) é feito por NOME:
// o `full-stack-augment.ts` casa a URL do frontend/gateway com o path do
// endpoint (`urlMatchesRoute`, `wsv1ByPath`, `proxiesTo`) — string-matching, que
// erra quando o path é computado, versionado ou renomeado só de um lado. É o
// elo mais FRÁGIL do mapa e o único que atravessa a fronteira de serviço.
//
// ESTE MÓDULO faz a junção pelo SÍMBOLO SCIP (compiler-accurate), não pela
// string: dado um par {símbolo-cliente no serviço A, símbolo-handler no serviço
// B} que o índice SCIP provou corresponderem (o stub gerado/o cliente tipado e o
// handler compartilham o mesmo símbolo de contrato, ou o deriver cross-service os
// pareia), resolve CADA ponta ao seu nó-de-sistema (reusando a mesma máquina de
// `scip-aggregate.ts`: `functionOfScipSymbol` + índice arquivo→nó POR SERVIÇO) e
// emite UMA aresta cross-service `CALLS` STATIC_PROVEN entre ids QUALIFICADOS por
// serviço (`<serviço>::<nodeId>`). O par símbolo→símbolo é a prova; a string some.
//
// INERTE por construção (régua D2): nenhum produtor POSTa pares cross-service
// ainda (o deriver cross-service é PR futuro no integration-kit), e NADA no
// pipeline chama isto — o `/graph` por-projeto segue byte-a-byte. Espelha o
// contrato inerte do `EdgeRefutation`/`field-graph`: o CONTRATO e o MOTOR moram
// aqui; o produtor liga depois. Depende de D01 (dataAccess) no placar, mas a
// junção de CHAMADA símbolo→símbolo aqui é independente dele.
//
// HONESTIDADE (§2.3 ADR-0036): só emite quando AMBAS as pontas resolvem a um nó
// REAL do serviço respectivo (símbolo sem nó → descartado e CONTADO, nunca
// mis-atribuído). Par intra-serviço (mesmo serviço nas duas pontas) é recusado —
// isso é trabalho do `scip-aggregate.ts`, não da junção cross-service. PURA:
// nunca lança, nenhum I/O.
// ─────────────────────────────────────────────────────────────────────────

import type { RawSystemNode } from "./system-graph";
import { buildFileNodeIndex, functionOfScipSymbol } from "./scip-aggregate";

/** Par cross-service provado pelo índice SCIP (símbolo no serviço A → serviço B). */
export interface CrossServiceSymbolEdge {
  fromService: string;
  /** símbolo SCIP do CLIENTE (stub/cliente tipado) no serviço de origem. */
  from: string;
  /** arquivo-fonte de definição do símbolo de origem (F1 — agnóstico à linguagem). */
  fromFile?: string;
  toService: string;
  /** símbolo SCIP do HANDLER (endpoint) no serviço de destino. */
  to: string;
  toFile?: string;
  /** resolução SCIP: `compiler` (resolução única) ou `interface-impl` (CHA 1-de-N). */
  resolution: "compiler" | "interface-impl";
}

/** Grafo (nós) de UM serviço, rotulado pelo nome do serviço. */
export interface ServiceGraph {
  service: string;
  nodes: RawSystemNode[];
}

/** Aresta cross-service agregada, pronta p/ mesclar num grafo unificado (D11). */
export interface AggregatedCrossServiceEdge {
  /** id QUALIFICADO por serviço: `<fromService>::<nodeId>`. */
  fromNode: string;
  /** id QUALIFICADO por serviço: `<toService>::<nodeId>`. */
  toNode: string;
  relationType: "CALLS";
  resolution: "compiler" | "interface-impl";
  crossService: true;
  fromService: string;
  toService: string;
}

export interface CrossServiceJunctionStats {
  /** pares recebidos. */
  received: number;
  /** arestas cross-service únicas emitidas (dedup, compiler > interface-impl). */
  aggregated: number;
  /** par cujo símbolo (de um ou dos dois lados) não resolveu a um nó → descartado. */
  unresolvedEndpoint: number;
  /** par cujo serviço não tem grafo fornecido → descartado. */
  unknownService: number;
  /** par intra-serviço (mesmo serviço nas duas pontas) → recusado (é do scip-aggregate). */
  intraServiceDropped: number;
  /** auto-elo (mesmo nó qualificado nas duas pontas) → descartado. */
  selfDropped: number;
}

/** id qualificado por serviço — a identidade do nó no grafo unificado (D11). */
export function qualifyNodeId(service: string, nodeId: string): string {
  return `${service}::${nodeId}`;
}

const SEP = "\u0001"; // separador interno de chave (não aparece em id de nó)

/**
 * Agrega pares cross-service símbolo→símbolo em arestas nó→nó QUALIFICADAS por
 * serviço. PURA. Para cada par: resolve o nó de cada ponta no grafo do SEU
 * serviço (reusando `functionOfScipSymbol` + `buildFileNodeIndex` — a MESMA
 * resolução do scip-aggregate, agora por serviço). Dedup por par; `compiler`
 * prevalece sobre `interface-impl` no mesmo par.
 */
export function joinCrossServiceBySymbol(
  services: ServiceGraph[] | null | undefined,
  pairs: CrossServiceSymbolEdge[] | null | undefined,
): { edges: AggregatedCrossServiceEdge[]; stats: CrossServiceJunctionStats } {
  const stats: CrossServiceJunctionStats = {
    received: Array.isArray(pairs) ? pairs.length : 0,
    aggregated: 0, unresolvedEndpoint: 0, unknownService: 0, intraServiceDropped: 0, selfDropped: 0,
  };
  if (!Array.isArray(services) || services.length === 0 || !Array.isArray(pairs) || pairs.length === 0) {
    return { edges: [], stats };
  }

  // Índice arquivo→nó POR SERVIÇO (a mesma regra honesta do scip-aggregate:
  // arquivo com >1 nó não-módulo/entidade é ambíguo e não indexa).
  const fileIndexByService = new Map<string, Map<string, string>>();
  for (const s of services) {
    if (!s || typeof s.service !== "string" || !s.service || !Array.isArray(s.nodes)) continue;
    fileIndexByService.set(s.service, buildFileNodeIndex(s.nodes));
  }

  const resolveNode = (service: string, symbol: string, file?: string): string | null => {
    const idx = fileIndexByService.get(service);
    if (!idx) return null; // serviço desconhecido (tratado pelo chamador)
    const parsed = functionOfScipSymbol(symbol, file);
    if (!parsed) return null;
    // Resolução COARSE por arquivo (granularidade de serviço — a junção cross-
    // service é entre nós arquiteturais, não sub-nós de função intra-serviço).
    return idx.get(parsed.file) || null;
  };

  // Dedup por par qualificado; compiler > interface-impl.
  const best = new Map<string, { edge: AggregatedCrossServiceEdge; res: "compiler" | "interface-impl" }>();
  for (const p of pairs) {
    if (!p || (p.resolution !== "compiler" && p.resolution !== "interface-impl")) continue;
    if (typeof p.fromService !== "string" || typeof p.toService !== "string") continue;
    if (!fileIndexByService.has(p.fromService) || !fileIndexByService.has(p.toService)) {
      stats.unknownService++;
      continue;
    }
    if (p.fromService === p.toService) { stats.intraServiceDropped++; continue; }
    const fromNodeRaw = resolveNode(p.fromService, p.from, p.fromFile);
    const toNodeRaw = resolveNode(p.toService, p.to, p.toFile);
    if (!fromNodeRaw || !toNodeRaw) { stats.unresolvedEndpoint++; continue; }
    const fromNode = qualifyNodeId(p.fromService, fromNodeRaw);
    const toNode = qualifyNodeId(p.toService, toNodeRaw);
    if (fromNode === toNode) { stats.selfDropped++; continue; }
    const key = `${fromNode}${SEP}${toNode}`;
    const prev = best.get(key);
    if (prev?.res === "compiler") continue; // já é o mais forte
    if (prev === undefined || p.resolution === "compiler") {
      best.set(key, {
        res: p.resolution,
        edge: { fromNode, toNode, relationType: "CALLS", resolution: p.resolution, crossService: true, fromService: p.fromService, toService: p.toService },
      });
    }
  }

  const edges = Array.from(best.values()).map((v) => v.edge);
  stats.aggregated = edges.length;
  return { edges, stats };
}

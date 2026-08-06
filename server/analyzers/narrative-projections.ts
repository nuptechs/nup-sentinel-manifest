// ─────────────────────────────────────────────
// Projeções multi-perspectiva — ADR-0033 P4.4 (VIEWS da MESMA espinha).
//
// Perspectiva NÃO é grafo novo: é FILTRO/RÓTULO sobre as MESMAS arestas
// verificadas do subgrafo (modelo 4+1 de Kruchten / C4 — §3.5). Cada projeção
// carrega a MESMA `evidence`/`confidence`/proveniência das arestas — é o que
// prova "uma espinha só", jamais um grafo paralelo (que reintroduziria drift
// entre views). Perspectiva sem nada verificado = "nada verificado sob esta
// lente aqui" (≠ falhou).
//
// Puro; opera sobre o `NarrativeSubgraph` já montado (referências às MESMAS
// arestas — não copia nem recomputa evidência).
// ─────────────────────────────────────────────

import type { NarrativeSubgraph, NarrativeEdge, RefutedNarrativeEdge, SubgraphAdrLink, EdgeFacets } from "./narrative-subgraph";
import type { BlindSpotEdge } from "./impact-confidence";

export type Persona = "dev" | "security" | "data" | "architect" | "business" | "impact";

export const PERSONAS: readonly Persona[] = ["dev", "security", "data", "architect", "business", "impact"] as const;

export interface PerspectiveView {
  persona: Persona;
  /** nome pt-BR da lente. */
  label: string;
  /** o que esta lente recorta. */
  focus: string;
  /** as MESMAS arestas verificadas do subgrafo, filtradas por preocupação. */
  edges: NarrativeEdge[];
  /** blind spots relevantes à lente (nomeados, nunca fabricados). */
  blindSpots: BlindSpotEdge[];
  /**
   * ADR-0033 P4.5 — arestas REFUTADAS pelo laço ativo, filtradas por esta lente.
   * NÃO são fato afirmado (o estático as previu, o robô não confirmou) — viajam
   * junto sob a mesma preocupação para a lente ser honesta sobre elas.
   */
  refutedEdges: RefutedNarrativeEdge[];
  /** ADR links relevantes (só a lente `business`/decisão os surfaça). */
  adrLinks: SubgraphAdrLink[];
  /** true quando nada verificado cai sob esta lente (≠ falhou). */
  empty: boolean;
  /** frase honesta quando `empty`. */
  note?: string;
}

const LABELS: Record<Persona, { label: string; focus: string }> = {
  dev: { label: "Desenvolvedor", focus: "cadeia de chamadas verificada (quem chama o quê)" },
  security: { label: "Segurança", focus: "arestas tocando nós sensíveis / autenticação / permissão" },
  data: { label: "Dados", focus: "arestas de/para repositório e entidade (leitura/escrita de dado)" },
  architect: { label: "Arquiteto", focus: "arestas que cruzam camada/stack (fronteiras de arquitetura)" },
  business: { label: "Negócio", focus: "controladores/telas + decisões (ADR) que governam" },
  impact: { label: "Impacto", focus: "o raio inteiro de dependentes verificados" },
};

const SENSITIVE_TYPES = /AUTH|PERMISSION|SECURITY|TOKEN|CREDENTIAL/i;
const DATA_TYPES = /ENTITY|REPOSITORY|TABLE|MODEL/i;
const DATA_RELATIONS = /READS_ENTITY|WRITES_ENTITY|READS|WRITES/i;
const BUSINESS_TYPES = /CONTROLLER|ENDPOINT|SCREEN|ROUTE|COMPONENT|PAGE/i;

// Predicados de lente sobre as FACETAS (comuns à aresta andável e à refutada —
// o mesmo recorte de preocupação vale para ambas).
/** A aresta toca segurança? (nó sensível OU tipo de auth/permissão). */
function touchesSecurity(e: EdgeFacets): boolean {
  return e.fromSensitive || e.toSensitive || SENSITIVE_TYPES.test(e.fromType) || SENSITIVE_TYPES.test(e.toType);
}
function touchesData(e: EdgeFacets): boolean {
  return DATA_TYPES.test(e.fromType) || DATA_TYPES.test(e.toType) || DATA_RELATIONS.test(e.relationType);
}
/** Cruza camada ou stack? (aresta de fronteira arquitetural). */
function crossesBoundary(e: EdgeFacets): boolean {
  const layerCross = !!e.fromLayer && !!e.toLayer && e.fromLayer !== e.toLayer;
  const stackCross = !!e.fromStack && !!e.toStack && e.fromStack !== e.toStack;
  return layerCross || stackCross;
}
function touchesBusiness(e: EdgeFacets): boolean {
  return BUSINESS_TYPES.test(e.fromType) || BUSINESS_TYPES.test(e.toType);
}

function edgeFilterFor(persona: Persona): (e: EdgeFacets) => boolean {
  switch (persona) {
    case "security":
      return touchesSecurity;
    case "data":
      return touchesData;
    case "architect":
      return crossesBoundary;
    case "business":
      return touchesBusiness;
    case "dev":
    case "impact":
    default:
      return () => true; // dev = call chain inteira; impact = raio inteiro
  }
}

/** Blind spots relevantes à lente (mesma preocupação; nomeados). */
function blindSpotsFor(persona: Persona, blindSpots: BlindSpotEdge[]): BlindSpotEdge[] {
  switch (persona) {
    case "security":
      return blindSpots.filter((b) => SENSITIVE_TYPES.test(b.relationType) || SENSITIVE_TYPES.test(b.fromNode) || SENSITIVE_TYPES.test(b.toNode));
    case "data":
      return blindSpots.filter((b) => DATA_RELATIONS.test(b.relationType) || DATA_TYPES.test(b.fromNode) || DATA_TYPES.test(b.toNode));
    case "dev":
    case "architect":
    case "impact":
      return blindSpots; // ponto-cego é preocupação transversal — sempre visível
    case "business":
    default:
      return blindSpots;
  }
}

/**
 * Projeta o subgrafo por perspectiva. Retorna as MESMAS arestas (referências),
 * filtradas — a `evidence`/`confidence` viaja idêntica em toda persona.
 */
export function projectPerspective(sub: NarrativeSubgraph, persona: Persona): PerspectiveView {
  const meta = LABELS[persona];
  const lens = edgeFilterFor(persona);
  const edges = sub.edges.filter(lens);
  const refutedEdges = sub.refutedEdges.filter(lens); // P4.5 — mesma lente, arestas refutadas
  const blindSpots = blindSpotsFor(persona, sub.blindSpots);
  const adrLinks = persona === "business" ? sub.adrLinks : [];
  // "empty" = NADA verificado sob a lente. Refutada NÃO conta como verificado
  // (é ausência de prova, não prova) — mas se só há refutada/cego, a lente
  // ainda tem o que mostrar, então não é vazia.
  const empty = edges.length === 0 && blindSpots.length === 0 && refutedEdges.length === 0 && adrLinks.length === 0;
  return {
    persona,
    label: meta.label,
    focus: meta.focus,
    edges,
    blindSpots,
    refutedEdges,
    adrLinks,
    empty,
    ...(empty ? { note: `Nada verificado sob a lente "${meta.label}" para "${sub.symbol}" (≠ falhou — nenhuma aresta verificada casa esta preocupação aqui).` } : {}),
  };
}

/** Projeta TODAS as perspectivas (para a resposta consolidada). */
export function projectAllPerspectives(sub: NarrativeSubgraph): Record<Persona, PerspectiveView> {
  const out = {} as Record<Persona, PerspectiveView>;
  for (const p of PERSONAS) out[p] = projectPerspective(sub, p);
  return out;
}

/** Coerção segura de string → Persona (para query params). null se inválida. */
export function parsePersona(raw: unknown): Persona | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().toLowerCase();
  return (PERSONAS as readonly string[]).includes(p) ? (p as Persona) : null;
}

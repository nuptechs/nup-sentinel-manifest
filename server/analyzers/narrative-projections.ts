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

import type { NarrativeSubgraph, NarrativeEdge, SubgraphAdrLink } from "./narrative-subgraph";
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

/** A aresta toca segurança? (nó sensível OU tipo de auth/permissão). */
function touchesSecurity(e: NarrativeEdge): boolean {
  return e.fromSensitive || e.toSensitive || SENSITIVE_TYPES.test(e.fromType) || SENSITIVE_TYPES.test(e.toType);
}
function touchesData(e: NarrativeEdge): boolean {
  return DATA_TYPES.test(e.fromType) || DATA_TYPES.test(e.toType) || DATA_RELATIONS.test(e.relationType);
}
/** Cruza camada ou stack? (aresta de fronteira arquitetural). */
function crossesBoundary(e: NarrativeEdge): boolean {
  const layerCross = !!e.fromLayer && !!e.toLayer && e.fromLayer !== e.toLayer;
  const stackCross = !!e.fromStack && !!e.toStack && e.fromStack !== e.toStack;
  return layerCross || stackCross;
}
function touchesBusiness(e: NarrativeEdge): boolean {
  return BUSINESS_TYPES.test(e.fromType) || BUSINESS_TYPES.test(e.toType);
}

function edgeFilterFor(persona: Persona): (e: NarrativeEdge) => boolean {
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
  const edges = sub.edges.filter(edgeFilterFor(persona));
  const blindSpots = blindSpotsFor(persona, sub.blindSpots);
  const adrLinks = persona === "business" ? sub.adrLinks : [];
  const empty = edges.length === 0 && blindSpots.length === 0 && adrLinks.length === 0;
  return {
    persona,
    label: meta.label,
    focus: meta.focus,
    edges,
    blindSpots,
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

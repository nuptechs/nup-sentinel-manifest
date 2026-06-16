/**
 * Cobertura de domínio (ADR-070 Onda 7 — crítica de negócio "falta Y dado o
 * domínio").
 *
 * Cruza o mapa de entidades que o Manifest extrai com a ontologia-semente do
 * domínio (texto regulatório citável) e flagga os conceitos esperados que o
 * sistema NÃO modela. Determinístico e ADVISORY — a base é a lei, não opinião de
 * LLM. Falta de conceito CORE é o sinal forte; recommended é orientação. Puro.
 */

import { PUBLIC_PROCUREMENT_ONTOLOGY, type DomainConcept, type ConceptImportance } from "./domain-ontology";

export interface ConceptCoverage {
  concept: string;
  importance: ConceptImportance;
  covered: boolean;
  matchedEntities: string[];
  legalBasis: string;
  why: string;
}

export interface DomainCoverageReport {
  domain: string;
  entitiesConsidered: number;
  conceptsTotal: number;
  conceptsCovered: number;
  coreMissing: number;
  gaps: ConceptCoverage[];     // só os NÃO cobertos (a crítica)
  coverage: ConceptCoverage[]; // todos, p/ transparência
}

/** Extrai os nomes de entidade do manifest (do espelho de entidades do grafo). */
function entityNames(manifest: any): string[] {
  const out = new Set<string>();
  // 1ª escolha: allEntitiesFromGraph (nome cru das entidades)
  const fromGraph: any[] = Array.isArray(manifest?.allEntitiesFromGraph) ? manifest.allEntitiesFromGraph : [];
  for (const e of fromGraph) if (e?.name) out.add(String(e.name));
  // fallback: entidades tocadas por endpoints
  const eps: any[] = Array.isArray(manifest?.impactEndpoints) ? manifest.impactEndpoints : [];
  for (const ep of eps) for (const e of (ep?.entitiesTouched || [])) out.add(String(e));
  // fallback: manifest.entities (catálogo curado)
  const cur: any[] = Array.isArray(manifest?.entities) ? manifest.entities : [];
  for (const e of cur) if (e?.name) out.add(String(e.name));
  return Array.from(out);
}

function matchConcept(concept: DomainConcept, names: string[]): string[] {
  return names.filter((n) => concept.patterns.some((re) => re.test(n)));
}

/**
 * Computa a cobertura de domínio do sistema. `ontology` default = contratação
 * pública. Puro.
 */
export function checkDomainCoverage(
  manifest: any,
  ontology: DomainConcept[] = PUBLIC_PROCUREMENT_ONTOLOGY,
  domain = "Contratação pública (Lei 14.133/2021)",
): DomainCoverageReport {
  const names = entityNames(manifest);
  const coverage: ConceptCoverage[] = ontology.map((c) => {
    const matched = matchConcept(c, names);
    return {
      concept: c.concept,
      importance: c.importance,
      covered: matched.length > 0,
      matchedEntities: matched.sort(),
      legalBasis: c.legalBasis,
      why: c.why,
    };
  });

  const gaps = coverage.filter((c) => !c.covered);
  // core primeiro nos gaps
  gaps.sort((a, b) => Number(b.importance === "core") - Number(a.importance === "core") || a.concept.localeCompare(b.concept));

  return {
    domain,
    entitiesConsidered: names.length,
    conceptsTotal: ontology.length,
    conceptsCovered: coverage.filter((c) => c.covered).length,
    coreMissing: gaps.filter((c) => c.importance === "core").length,
    gaps,
    coverage,
  };
}

/** Render Markdown da crítica de domínio (advisory, citável). */
export function renderDomainCoverageMarkdown(report: DomainCoverageReport, opts: { projectName?: string } = {}): string {
  const L: string[] = [];
  L.push("# Crítica de domínio (falta Y dado o domínio)");
  L.push("");
  if (opts.projectName) L.push(`**Sistema:** ${opts.projectName}  `);
  L.push(`**Domínio:** ${report.domain}  `);
  L.push(`**Conceitos cobertos:** ${report.conceptsCovered}/${report.conceptsTotal} · **faltando (core):** ${report.coreMissing}`);
  L.push("");
  L.push("> Advisory ancorado em texto regulatório citável (não opinião de LLM). Falta de conceito **core** é o sinal forte; recommended é orientação.");
  L.push("");
  if (report.gaps.length === 0) {
    L.push("> Todos os conceitos esperados do domínio têm entidade correspondente. ✅");
    L.push("");
  } else {
    L.push("## Conceitos esperados SEM entidade no sistema");
    L.push("");
    for (const g of report.gaps) {
      const sev = g.importance === "core" ? "🔴 core" : "🟠 recomendado";
      L.push(`- ${sev} — **${g.concept}** (${g.legalBasis})`);
      L.push(`  - ${g.why}`);
    }
    L.push("");
  }
  return L.join("\n");
}

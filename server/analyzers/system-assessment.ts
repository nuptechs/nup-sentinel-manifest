/**
 * Dossiê de Avaliação do Sistema (ADR-070 — "diagnóstico definitivo, pronto p/
 * documentação").
 *
 * Agrega, num relatório único e determinístico, os críticos de grafo que o
 * Manifest já computa sobre o snapshot persistido: superfície de impacto
 * (endpoints × entidades), sobreposição funcional, incompletude de ciclo de
 * vida e decisões arquiteturais indexadas. Reuso-primeiro (§2.5): nenhum
 * detector novo — só consolida os existentes na visão que o gestor/dev abre.
 * Puro; sem I/O.
 */

import { detectFunctionalOverlap, type OverlapReport } from "./overlap-detector";
import { detectCompletenessGaps, type CompletenessReport } from "./completeness-detector";

export interface SystemAssessment {
  surface: {
    endpoints: number;
    endpointsTouchingEntity: number;
    entitiesTouched: number;
    adrsIndexed: number;
  };
  overlap: OverlapReport;
  completeness: CompletenessReport;
  // contagem de sinais acionáveis (os de maior suspeita) — a "manchete".
  signals: {
    overlapWrites: number;
    lifecycleHigh: number;
  };
}

/** Computa o dossiê a partir do manifest persistido. Puro. */
export function buildSystemAssessment(manifest: any): SystemAssessment {
  const impactEndpoints: any[] = Array.isArray(manifest?.impactEndpoints) ? manifest.impactEndpoints : [];
  const entities = new Set<string>();
  let touching = 0;
  for (const ep of impactEndpoints) {
    const ents = Array.isArray(ep?.entitiesTouched) ? ep.entitiesTouched : [];
    if (ents.length > 0) touching += 1;
    for (const e of ents) entities.add(String(e));
  }

  const overlap = detectFunctionalOverlap(manifest);
  const completeness = detectCompletenessGaps(manifest);

  return {
    surface: {
      endpoints: impactEndpoints.length,
      endpointsTouchingEntity: touching,
      entitiesTouched: entities.size,
      adrsIndexed: Array.isArray(manifest?.adrIndex) ? manifest.adrIndex.length : 0,
    },
    overlap,
    completeness,
    signals: {
      overlapWrites: overlap.reviewGroups,
      lifecycleHigh: completeness.highGaps,
    },
  };
}

/** Render Markdown do dossiê (documentável). */
export function renderSystemAssessmentMarkdown(a: SystemAssessment, opts: { projectName?: string } = {}): string {
  const L: string[] = [];
  L.push("# Dossiê de Avaliação do Sistema");
  L.push("");
  if (opts.projectName) L.push(`**Sistema:** ${opts.projectName}  `);
  const actionable = a.signals.overlapWrites + a.signals.lifecycleHigh;
  L.push(`**Sinais acionáveis:** ${actionable} (🟠 ${a.signals.overlapWrites} sobreposições de escrita · 🔴 ${a.signals.lifecycleHigh} entidades escritas sem leitura)`);
  L.push("");

  L.push("## Superfície");
  L.push("");
  const pct = a.surface.endpoints > 0 ? Math.round((a.surface.endpointsTouchingEntity / a.surface.endpoints) * 100) : 0;
  L.push(`- **Endpoints:** ${a.surface.endpoints} (${a.surface.endpointsTouchingEntity} tocam alguma entidade — ${pct}%)`);
  L.push(`- **Entidades tocadas:** ${a.surface.entitiesTouched}`);
  L.push(`- **ADRs indexadas:** ${a.surface.adrsIndexed}`);
  L.push("");

  L.push("## Sobreposição funcional (candidatos a duplicação)");
  L.push("");
  if (a.overlap.reviewGroups === 0) {
    L.push("> Nenhuma sobreposição de escrita — cada operação de escrita tem caminho único por entidade.");
  } else {
    for (const o of a.overlap.overlaps.filter((g) => g.severity === "review")) {
      L.push(`- **${o.opClass} \`${o.entity}\`** — ${o.endpoints.map((e) => e.operation).join(", ")}`);
    }
  }
  L.push("");

  L.push("## Incompletude de ciclo de vida");
  L.push("");
  if (a.completeness.highGaps === 0) {
    L.push("> Nenhuma entidade escrita sem leitura própria.");
  } else {
    for (const f of a.completeness.findings.filter((g) => g.severity === "high")) {
      L.push(`- **${f.entity}** — escrita (${f.has.join("/")}) sem find/list próprio`);
    }
  }
  L.push("");

  return L.join("\n");
}

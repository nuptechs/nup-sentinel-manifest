/**
 * Cobertura de capacidades de mercado (ADR-070 Onda 7 — "grandes players já
 * fazem Y"), versão segura sobre base curada.
 *
 * Cruza a base de capacidades-padrão do setor com o que o sistema expõe
 * (entidades + operações de endpoint) e flagga as capacidades esperadas que o
 * sistema NÃO aparenta ter. Determinístico, ADVISORY, citável e com
 * **verificação humana obrigatória** (a ausência de match pode ser só
 * nomenclatura diferente, não ausência real). Puro.
 */

import { PUBLIC_SECTOR_CAPABILITIES, type MarketCapability, type CapabilityTier } from "./market-capabilities";

export interface CapabilityCoverage {
  capability: string;
  tier: CapabilityTier;
  present: boolean;
  matchedSignals: string[];
  source: string;
  why: string;
}

export interface MarketCoverageReport {
  sector: string;
  signalsConsidered: number;
  capabilitiesTotal: number;
  capabilitiesPresent: number;
  mandatoryMissing: number;
  gaps: CapabilityCoverage[];
  coverage: CapabilityCoverage[];
  disclaimer: string;
}

/** Sinais do sistema: nomes de entidade + operações de endpoint (/easynup/<op>.vN). */
function systemSignals(manifest: any): string[] {
  const out = new Set<string>();
  const fromGraph: any[] = Array.isArray(manifest?.allEntitiesFromGraph) ? manifest.allEntitiesFromGraph : [];
  for (const e of fromGraph) if (e?.name) out.add(String(e.name));
  const eps: any[] = Array.isArray(manifest?.impactEndpoints) ? manifest.impactEndpoints : [];
  for (const ep of eps) {
    const path = String(ep?.path ?? "");
    const m = path.match(/\/easynup\/([A-Za-z0-9]+)\.v\d+$/);
    if (m) out.add(m[1]);
    for (const e of (ep?.entitiesTouched || [])) out.add(String(e));
  }
  const cur: any[] = Array.isArray(manifest?.entities) ? manifest.entities : [];
  for (const e of cur) if (e?.name) out.add(String(e.name));
  return Array.from(out);
}

function matchCapability(cap: MarketCapability, signals: string[]): string[] {
  return signals.filter((s) => cap.patterns.some((re) => re.test(s)));
}

const DISCLAIMER = "Advisory, verificação humana obrigatória: base curada de capacidades padrão/mandadas (fonte citável), NÃO scraping de concorrentes. Ausência de match pode ser nomenclatura diferente.";

/** Computa a cobertura de capacidades de mercado do sistema. Puro. */
export function checkMarketCoverage(
  manifest: any,
  capabilities: MarketCapability[] = PUBLIC_SECTOR_CAPABILITIES,
  sector = "Gestão de contratação pública (Brasil)",
): MarketCoverageReport {
  const signals = systemSignals(manifest);
  const coverage: CapabilityCoverage[] = capabilities.map((c) => {
    const matched = matchCapability(c, signals);
    return {
      capability: c.capability,
      tier: c.tier,
      present: matched.length > 0,
      matchedSignals: matched.sort(),
      source: c.source,
      why: c.why,
    };
  });

  const gaps = coverage.filter((c) => !c.present);
  gaps.sort((a, b) => Number(b.tier === "mandatory") - Number(a.tier === "mandatory") || a.capability.localeCompare(b.capability));

  return {
    sector,
    signalsConsidered: signals.length,
    capabilitiesTotal: capabilities.length,
    capabilitiesPresent: coverage.filter((c) => c.present).length,
    mandatoryMissing: gaps.filter((c) => c.tier === "mandatory").length,
    gaps,
    coverage,
    disclaimer: DISCLAIMER,
  };
}

/** Render Markdown (advisory, citável). */
export function renderMarketCoverageMarkdown(report: MarketCoverageReport, opts: { projectName?: string } = {}): string {
  const L: string[] = [];
  L.push("# Capacidades de mercado (o setor já faz Y)");
  L.push("");
  if (opts.projectName) L.push(`**Sistema:** ${opts.projectName}  `);
  L.push(`**Setor:** ${report.sector}  `);
  L.push(`**Capacidades presentes:** ${report.capabilitiesPresent}/${report.capabilitiesTotal} · **mandadas faltando:** ${report.mandatoryMissing}`);
  L.push("");
  L.push(`> ${report.disclaimer}`);
  L.push("");
  if (report.gaps.length === 0) {
    L.push("> Todas as capacidades-padrão do setor têm sinal correspondente no sistema. ✅");
    L.push("");
  } else {
    L.push("## Capacidades esperadas SEM sinal no sistema");
    L.push("");
    for (const g of report.gaps) {
      const sev = g.tier === "mandatory" ? "🔴 mandada por lei" : "🟠 padrão de mercado";
      L.push(`- ${sev} — **${g.capability}** (${g.source})`);
      L.push(`  - ${g.why}`);
    }
    L.push("");
  }
  return L.join("\n");
}

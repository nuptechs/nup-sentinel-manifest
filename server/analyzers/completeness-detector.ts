/**
 * Detecção de INCOMPLETUDE de ciclo de vida via grafo (ADR-070 Onda 4 — crítico
 * "incompleteness").
 *
 * Determinístico sobre o grafo de endpoints × entidades (impactEndpoints do
 * snapshot). Cruza, por entidade REAL (nome do grafo, via `entitiesTouched`), as
 * classes de operação expostas por endpoint (CREATE/UPDATE/DELETE/READ) e flagga
 * assimetrias que indicam buraco:
 *
 *   - WRITABLE_NOT_READABLE (alto): endpoints ESCREVEM a entidade mas NENHUM a
 *     lê — dado gerenciado sem como consultar via API. Sinal forte e preciso
 *     (se há escrita, a entidade existe; a ausência de leitura é o buraco).
 *   - READABLE_NOT_WRITABLE (info): entidade só lida via API — provável dado de
 *     referência/seed, ou escrita por fluxo não-convencional (ressalva no texto).
 *
 * Precisão > recall: usa nomes de entidade do grafo (sem mangling de plural) e
 * só conta operações cuja convergência verbo→entidade o Manifest já resolveu.
 * Um write por op não-convencional só SUPRIME um achado (seguro: não gera falso
 * positivo de "writable não readable"). Advisory; puro; sem I/O.
 */

import { classifyVerb, operationOf } from "./overlap-detector";

export type GapKind = "WRITABLE_NOT_READABLE" | "READABLE_NOT_WRITABLE";

export interface EntityCapabilities {
  entity: string;
  create: boolean;
  update: boolean;
  delete: boolean;
  read: boolean;
}

export interface CompletenessGap {
  entity: string;
  kind: GapKind;
  severity: "high" | "info";
  has: string[]; // classes presentes (CREATE/UPDATE/DELETE/READ)
  missing: string[]; // classes ausentes relevantes
  reason: string;
}

export interface CompletenessReport {
  entities: number; // entidades com ao menos 1 operação convencional
  gaps: number;
  highGaps: number;
  capabilities: EntityCapabilities[];
  findings: CompletenessGap[];
}

/**
 * Mapeia cada entidade real para suas capacidades de ciclo de vida e flagga as
 * assimetrias. Lê `manifest.impactEndpoints`. Puro.
 */
export function detectCompletenessGaps(manifest: any): CompletenessReport {
  const endpoints: any[] = Array.isArray(manifest?.impactEndpoints) ? manifest.impactEndpoints : [];

  // entidade → set de classes (CREATE/UPDATE/DELETE/READ)
  const caps = new Map<string, Set<string>>();

  for (const ep of endpoints) {
    const op = operationOf(String(ep?.path ?? ""));
    if (!op) continue;
    const cls = classifyVerb(op);
    if (cls === "OTHER") continue; // transições de estado não contam p/ ciclo de vida
    const entities: string[] = Array.isArray(ep?.entitiesTouched) ? ep.entitiesTouched : [];
    for (const ent of entities) {
      const name = String(ent);
      if (!name) continue;
      let s = caps.get(name);
      if (!s) { s = new Set(); caps.set(name, s); }
      s.add(cls);
    }
  }

  const capabilities: EntityCapabilities[] = Array.from(caps.entries())
    .map(([entity, s]) => ({
      entity,
      create: s.has("CREATE"),
      update: s.has("UPDATE"),
      delete: s.has("DELETE"),
      read: s.has("READ"),
    }))
    .sort((a, b) => a.entity.localeCompare(b.entity));

  const findings: CompletenessGap[] = [];
  for (const c of capabilities) {
    const has: string[] = [];
    if (c.create) has.push("CREATE");
    if (c.update) has.push("UPDATE");
    if (c.delete) has.push("DELETE");
    if (c.read) has.push("READ");
    const hasWrite = c.create || c.update || c.delete;

    if (hasWrite && !c.read) {
      findings.push({
        entity: c.entity,
        kind: "WRITABLE_NOT_READABLE",
        severity: "high",
        has,
        missing: ["READ"],
        reason: `Endpoints escrevem '${c.entity}' (${has.join("/")}) mas nenhum a lê — dado gerenciado sem consulta via API.`,
      });
    } else if (c.read && !hasWrite) {
      findings.push({
        entity: c.entity,
        kind: "READABLE_NOT_WRITABLE",
        severity: "info",
        has,
        missing: ["CREATE/UPDATE/DELETE"],
        reason: `'${c.entity}' é lida via API mas nenhum endpoint a escreve — provável dado de referência/seed (ou escrita por fluxo não-convencional).`,
      });
    }
  }

  // alto primeiro, depois alfabético
  findings.sort((a, b) =>
    Number(b.severity === "high") - Number(a.severity === "high") || a.entity.localeCompare(b.entity),
  );

  return {
    entities: capabilities.length,
    gaps: findings.length,
    highGaps: findings.filter((f) => f.severity === "high").length,
    capabilities,
    findings,
  };
}

/** Render Markdown do relatório de incompletude (advisory). */
export function renderCompletenessMarkdown(report: CompletenessReport, opts: { projectName?: string } = {}): string {
  const L: string[] = [];
  L.push("# Incompletude de ciclo de vida (entidades × operações)");
  L.push("");
  if (opts.projectName) L.push(`**Sistema:** ${opts.projectName}  `);
  L.push(`**Entidades com operações:** ${report.entities} · **buracos:** ${report.gaps} (${report.highGaps} alto)`);
  L.push("");
  if (!report.gaps) {
    L.push("> Nenhum buraco de ciclo de vida — toda entidade escrita também é legível via API.");
    L.push("");
    return L.join("\n");
  }
  L.push("> Advisory: candidatos a buraco para revisão humana. Ler-sem-escrever costuma ser dado de referência; escrever-sem-ler é o sinal forte.");
  L.push("");
  for (const f of report.findings) {
    const sev = f.severity === "high" ? "🔴 escreve mas não lê" : "⚪ lê mas não escreve";
    L.push(`- **${f.entity}** — ${sev} · tem: ${f.has.join(", ")} · falta: ${f.missing.join(", ")}`);
  }
  L.push("");
  return L.join("\n");
}

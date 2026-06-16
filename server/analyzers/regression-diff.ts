/**
 * Diff de regressão entre dois snapshots (ADR-070 Onda 3 — braço *differential*
 * da garantia por execução).
 *
 * Compara o snapshot ATUAL com o ANTERIOR e flagga o que PIOROU: conexões
 * endpoint→entidade perdidas, queda de cobertura, novas sobreposições, novos
 * buracos de ciclo de vida, endpoints sumidos. É a guarda de não-regressão
 * entre rodadas (o cron roda diário) — "essa mudança quebrou X". Reuso-primeiro
 * (§2.5): roda os mesmos detectores nos dois snapshots e diferencia. Puro.
 */

import { detectFunctionalOverlap } from "./overlap-detector";
import { detectCompletenessGaps } from "./completeness-detector";

export type RegressionKind =
  | "LOST_ENTITY_LINK"   // endpoint tocava entidade antes, agora não toca (quebrou)
  | "REMOVED_ENDPOINT"   // endpoint existia antes, sumiu (advisory)
  | "COVERAGE_DROP"      // % de endpoints tocando entidade caiu
  | "NEW_OVERLAP"        // nova sobreposição funcional de escrita
  | "NEW_LIFECYCLE_GAP"; // nova entidade escrita sem leitura própria

export interface Regression {
  kind: RegressionKind;
  severity: "high" | "medium" | "low";
  target: string;
  detail: string;
}

export interface RegressionReport {
  comparable: boolean;       // false quando falta um dos snapshots
  regressions: number;
  improvements: number;      // problemas que sumiram (melhoraram)
  bySeverity: { high: number; medium: number; low: number };
  findings: Regression[];
  resolved: string[];        // descrição curta do que melhorou
}

const COVERAGE_DROP_PP = 3; // queda mínima (pontos %) p/ flaggar

function endpointEntityMap(manifest: any): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const eps: any[] = Array.isArray(manifest?.impactEndpoints) ? manifest.impactEndpoints : [];
  for (const ep of eps) {
    const path = String(ep?.path ?? "");
    if (!path || path === "/") continue;
    m.set(path, Array.isArray(ep?.entitiesTouched) ? ep.entitiesTouched : []);
  }
  return m;
}

function coverage(manifest: any): number {
  const eps: any[] = Array.isArray(manifest?.impactEndpoints) ? manifest.impactEndpoints : [];
  if (eps.length === 0) return 0;
  const touching = eps.filter((e) => Array.isArray(e?.entitiesTouched) && e.entitiesTouched.length > 0).length;
  return Math.round((touching / eps.length) * 100);
}

function overlapWriteKeys(manifest: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const o of detectFunctionalOverlap(manifest).overlaps) {
    if (o.severity !== "review") continue;
    out.set(`${o.opClass}:${o.entity}`, `${o.opClass} de '${o.entity}' (${o.endpoints.map((e) => e.operation).join(", ")})`);
  }
  return out;
}

function lifecycleHighKeys(manifest: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of detectCompletenessGaps(manifest).findings) {
    if (f.severity !== "high") continue;
    out.set(f.entity, `'${f.entity}' escrita (${f.has.join("/")}) sem leitura própria`);
  }
  return out;
}

/** Compara dois snapshots (manifestJson) e produz o relatório de regressão. Puro. */
export function buildRegressionDiff(prev: any, curr: any): RegressionReport {
  if (!prev || !curr) {
    return { comparable: false, regressions: 0, improvements: 0, bySeverity: { high: 0, medium: 0, low: 0 }, findings: [], resolved: [] };
  }

  const findings: Regression[] = [];
  const resolved: string[] = [];

  // 1) endpoint × entidade
  const prevEp = endpointEntityMap(prev);
  const currEp = endpointEntityMap(curr);
  for (const [path, prevEnts] of Array.from(prevEp.entries())) {
    if (!currEp.has(path)) {
      findings.push({ kind: "REMOVED_ENDPOINT", severity: "low", target: path, detail: `Endpoint '${path}' existia no snapshot anterior e sumiu (verifique se foi intencional).` });
      continue;
    }
    const currEnts = currEp.get(path) || [];
    if (prevEnts.length > 0 && currEnts.length === 0) {
      findings.push({ kind: "LOST_ENTITY_LINK", severity: "high", target: path, detail: `'${path}' tocava ${prevEnts.join(", ")} e agora não toca nenhuma entidade — conexão quebrada.` });
    }
  }

  // 2) cobertura
  const prevCov = coverage(prev);
  const currCov = coverage(curr);
  if (prevCov - currCov >= COVERAGE_DROP_PP) {
    findings.push({ kind: "COVERAGE_DROP", severity: "medium", target: "cobertura", detail: `Cobertura endpoint→entidade caiu de ${prevCov}% para ${currCov}%.` });
  }

  // 3) sobreposições novas (e resolvidas)
  const prevOv = overlapWriteKeys(prev);
  const currOv = overlapWriteKeys(curr);
  for (const [k, desc] of Array.from(currOv.entries())) {
    if (!prevOv.has(k)) findings.push({ kind: "NEW_OVERLAP", severity: "medium", target: k, detail: `Nova sobreposição: ${desc}.` });
  }
  for (const [k, desc] of Array.from(prevOv.entries())) {
    if (!currOv.has(k)) resolved.push(`Sobreposição resolvida: ${desc}`);
  }

  // 4) buracos de ciclo de vida novos (e resolvidos)
  const prevLc = lifecycleHighKeys(prev);
  const currLc = lifecycleHighKeys(curr);
  for (const [k, desc] of Array.from(currLc.entries())) {
    if (!prevLc.has(k)) findings.push({ kind: "NEW_LIFECYCLE_GAP", severity: "medium", target: k, detail: `Novo buraco: ${desc}.` });
  }
  for (const [k, desc] of Array.from(prevLc.entries())) {
    if (!currLc.has(k)) resolved.push(`Buraco resolvido: ${desc}`);
  }

  const rank = { high: 3, medium: 2, low: 1 };
  findings.sort((a, b) => rank[b.severity] - rank[a.severity] || a.target.localeCompare(b.target));

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity] += 1;

  return {
    comparable: true,
    regressions: findings.length,
    improvements: resolved.length,
    bySeverity,
    findings,
    resolved,
  };
}

/** Render Markdown do relatório de regressão (advisory). */
export function renderRegressionMarkdown(report: RegressionReport, opts: { projectName?: string } = {}): string {
  const L: string[] = [];
  L.push("# Regressão entre snapshots (differential)");
  L.push("");
  if (opts.projectName) L.push(`**Sistema:** ${opts.projectName}  `);
  if (!report.comparable) {
    L.push("> Sem dois snapshots para comparar — rode a análise ao menos duas vezes.");
    L.push("");
    return L.join("\n");
  }
  L.push(`**Regressões:** ${report.regressions} (🔴 ${report.bySeverity.high} · 🟠 ${report.bySeverity.medium} · ⚪ ${report.bySeverity.low}) · **melhorias:** ${report.improvements}`);
  L.push("");
  if (report.regressions === 0) {
    L.push("> Nenhuma regressão vs o snapshot anterior. ✅");
  } else {
    L.push("> Advisory: o que PIOROU desde a última análise. Quebra de conexão é o sinal forte.");
    L.push("");
    for (const f of report.findings) {
      const sev = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟠" : "⚪";
      L.push(`- ${sev} **${f.kind}** — ${f.detail}`);
    }
  }
  if (report.resolved.length) {
    L.push("");
    L.push("## Melhorias");
    L.push("");
    for (const r of report.resolved) L.push(`- ✅ ${r}`);
  }
  L.push("");
  return L.join("\n");
}

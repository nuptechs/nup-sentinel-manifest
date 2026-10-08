// ─────────────────────────────────────────────────────────────────────────
// OBS-E06 (ADR-0036 WS-E) — CONFIRMAÇÃO POR TRIPLE-ORPHAN (estático+runtime+config).
//
// O eixo ESTÁTICO sozinho (sem chamador / sem wiring de rota) gera CANDIDATOS a
// morto, nunca uma sentença — análise estática erra por DI/reflexão/montagem
// dinâmica. Esta composição PURA só deixa um candidato SUBIR a "morto confirmado"
// quando os TRÊS eixos concordam:
//
//   ESTÁTICO  — alguém já marcou o nó como suspeito (dead-code isolado/refutado,
//               OU superfície órfã sem wiring). É a entrada desta função.
//   RUNTIME   — há cobertura de runtime E o nó NUNCA foi observado nela.
//   CONFIG    — o nó não é ponto de entrada, não é import-reachable, não roda por config.
//
// HONESTIDADE (§2.2/§2.4 da ADR-0036 — fail-closed, ausência ≠ morto):
//   • SEM cobertura de runtime, o eixo runtime NÃO pode ser afirmado → o verdito é
//     `unknown-no-runtime`, NUNCA `confirmed`. Ausência de tráfego só vira prova de
//     morte quando SABEMOS que o runtime estava observando.
//   • Qualquer eixo que REFUTE (observado / entrypoint / import / config) manda o nó
//     para `refuted`, listando TODOS os eixos que refutaram (transparência).
//   • A confiança do confirmado é alta (3 eixos) mas NUNCA 1 — o ponto-cego existe.
//
// A IA não entra: o veredito é 100% determinístico (§2.3). PURO; nunca lança.
// ─────────────────────────────────────────────────────────────────────────

import type { OrphanSurfaceReport } from "./orphan-surface";

/** Suspeito do eixo ESTÁTICO (entrada): já marcado por dead-code OU orphan-surface. */
export interface StaticSuspect {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  /** confiança do eixo estático (0..1, nunca 1). */
  staticConfidence: number;
  staticReasons: string[];
  /** origem do sinal estático: "orphan-surface" | "dead-code" | outro. */
  staticSource?: string;
}

/** Sinais dos outros dois eixos, injetados (compõe runtime-overlay + config-aggregate). */
export interface TripleOrphanAxes {
  /** há cobertura de runtime suficiente p/ "nunca observado" significar algo? */
  runtimeCoveragePresent: boolean;
  /** nós observados por tráfego real — refuta morte. */
  observedNodeIds?: Set<string>;
  /** nós que são ponto de entrada legítimo (@Scheduled/listener/rota-raiz). */
  entryPointIds?: Set<string>;
  /** nós/arquivos import-reachable (re-export/tipos/DI) — não morto. */
  importReachableIds?: Set<string>;
  /** nós/arquivos rodados direto por config (package.json/index.html). */
  configEntryIds?: Set<string>;
}

export type TripleOrphanState = "confirmed" | "unknown-no-runtime" | "refuted";
export type RefutingAxis = "runtime-observed" | "config-entry-point" | "import-reachable" | "config-entry";

export interface TripleOrphanVerdict {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  state: TripleOrphanState;
  /** só em `confirmed`: confiança combinada dos 3 eixos — alta, nunca 1. */
  confidence?: number;
  axes: {
    static: { dead: true; confidence: number; reasons: string[]; source?: string };
    runtime: { coveragePresent: boolean; observed: boolean };
    config: { entryPoint: boolean; importReachable: boolean; configEntry: boolean };
  };
  /** só em `refuted`: todos os eixos que refutaram (transparência). */
  refutedBy?: RefutingAxis[];
}

export interface TripleOrphanReport {
  runtimeCoveragePresent: boolean;
  confirmed: TripleOrphanVerdict[];
  unknownNoRuntime: TripleOrphanVerdict[];
  refuted: TripleOrphanVerdict[];
  summary: string;
}

/** Teto de confiança do confirmado — convergência de 3 eixos é forte, não infalível. */
const MAX_CONFIRMED_CONFIDENCE = 0.95;

function confirmedConfidence(staticConfidence: number): number {
  const s = Number.isFinite(staticConfidence) ? Math.max(0, Math.min(1, staticConfidence)) : 0.5;
  // Convergência runtime+config eleva o estático, sem jamais chegar a 1.
  return Math.min(MAX_CONFIRMED_CONFIDENCE, Math.round((s + 0.2) * 100) / 100);
}

/**
 * Converge os 3 eixos. PURO, determinístico. A ORDEM de saída dentro de cada balde
 * é estável (confiança desc, depois tipo/label), para o recibo (E08) ser reprodutível.
 */
export function confirmTripleOrphan(
  suspects: StaticSuspect[] | null | undefined,
  axes: TripleOrphanAxes,
): TripleOrphanReport {
  const coverage = !!axes?.runtimeCoveragePresent;
  const observed = axes?.observedNodeIds ?? new Set<string>();
  const entry = axes?.entryPointIds ?? new Set<string>();
  const importReach = axes?.importReachableIds ?? new Set<string>();
  const configEntry = axes?.configEntryIds ?? new Set<string>();

  const confirmed: TripleOrphanVerdict[] = [];
  const unknownNoRuntime: TripleOrphanVerdict[] = [];
  const refuted: TripleOrphanVerdict[] = [];

  for (const s of Array.isArray(suspects) ? suspects : []) {
    if (!s || typeof s.nodeId !== "string" || !s.nodeId) continue;
    const key = s.nodeId;
    const sf = s.sourceFile;
    const isObserved = observed.has(key);
    const isEntry = entry.has(key);
    const isImport = sf ? importReach.has(sf) || importReach.has(key) : importReach.has(key);
    const isConfig = sf ? configEntry.has(sf) || configEntry.has(key) : configEntry.has(key);

    const base: TripleOrphanVerdict = {
      nodeId: key,
      type: s.type,
      label: s.label,
      ...(sf ? { sourceFile: sf } : {}),
      state: "refuted",
      axes: {
        static: { dead: true, confidence: s.staticConfidence, reasons: s.staticReasons ?? [], ...(s.staticSource ? { source: s.staticSource } : {}) },
        runtime: { coveragePresent: coverage, observed: isObserved },
        config: { entryPoint: isEntry, importReachable: isImport, configEntry: isConfig },
      },
    };

    const refutedBy: RefutingAxis[] = [];
    if (isObserved) refutedBy.push("runtime-observed");
    if (isEntry) refutedBy.push("config-entry-point");
    if (isImport) refutedBy.push("import-reachable");
    if (isConfig) refutedBy.push("config-entry");

    if (refutedBy.length > 0) {
      refuted.push({ ...base, state: "refuted", refutedBy });
      continue;
    }
    // Nenhum eixo refutou. Sem cobertura de runtime → NÃO pode confirmar (honesto).
    if (!coverage) {
      unknownNoRuntime.push({ ...base, state: "unknown-no-runtime" });
      continue;
    }
    // 3 eixos concordam: estático suspeito + runtime observando-e-nunca-viu + config limpo.
    confirmed.push({ ...base, state: "confirmed", confidence: confirmedConfidence(s.staticConfidence) });
  }

  const sortStable = (a: TripleOrphanVerdict, b: TripleOrphanVerdict) =>
    (b.confidence ?? b.axes.static.confidence) - (a.confidence ?? a.axes.static.confidence) ||
    a.type.localeCompare(b.type) ||
    a.label.localeCompare(b.label);
  confirmed.sort(sortStable);
  unknownNoRuntime.sort(sortStable);
  refuted.sort(sortStable);

  const summary = !coverage
    ? `Sem cobertura de runtime: ${unknownNoRuntime.length} suspeito(s) estático(s) ficam UNKNOWN (não confirmados), ${refuted.length} refutado(s) por config. Nenhum morto confirmado — honesto: ausência de tráfego só prova morte com runtime observando.`
    : `${confirmed.length} morto(s) CONFIRMADO(s) por convergência tri-eixo (estático+runtime+config), ${refuted.length} refutado(s) por ≥1 eixo. Confiança do confirmado < 1 (ponto-cego de DI/reflexão permanece).`;

  return { runtimeCoveragePresent: coverage, confirmed, unknownNoRuntime, refuted, summary };
}

// ── Adaptadores: transformam as saídas da leva 1 em StaticSuspect (composição real) ──

/** Suspeitos a partir do detector de superfície órfã (OBS-E01). Vazio se cego. */
export function suspectsFromOrphanSurface(report: OrphanSurfaceReport | null | undefined): StaticSuspect[] {
  if (!report || !report.wiringPresent || !Array.isArray(report.candidates)) return [];
  return report.candidates.map((c) => ({
    nodeId: c.nodeId,
    type: c.type,
    label: c.label,
    ...(c.sourceFile ? { sourceFile: c.sourceFile } : {}),
    staticConfidence: c.confidence,
    staticReasons: c.reasons,
    staticSource: "orphan-surface",
  }));
}

/** Formato mínimo de um candidato de dead-code (reasoner/dead-code.ts) p/ adaptar. */
export interface DeadCodeLikeCandidate {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  confidence: number;
  reasons: string[];
}

/** Suspeitos a partir dos candidatos de dead-code (OBS-E02/triagem tri-eixo). */
export function suspectsFromDeadCode(candidates: DeadCodeLikeCandidate[] | null | undefined): StaticSuspect[] {
  if (!Array.isArray(candidates)) return [];
  return candidates.map((c) => ({
    nodeId: c.nodeId,
    type: c.type,
    label: c.label,
    ...(c.sourceFile ? { sourceFile: c.sourceFile } : {}),
    staticConfidence: c.confidence,
    staticReasons: c.reasons,
    staticSource: "dead-code",
  }));
}

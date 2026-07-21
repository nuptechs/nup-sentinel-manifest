// ─────────────────────────────────────────────
// delivery-risk — ADR-0018 Onda 3 (D3: risco como NATUREZAS, não veredito)
//
// Ranqueia o RISCO de uma entrega (diff) em facetas ADVISORY — o espírito do
// Tribunal: cada faceta é uma natureza com nível + evidência; nunca allow/deny,
// nunca nota única mágica. Fontes, todas determinísticas e disponíveis NO
// momento do request:
//
//   • churn/difusão/entropia — do PRÓPRIO diff (Kamei et al., "Just-in-Time
//     Quality Assurance": mudanças grandes e difusas são estatisticamente mais
//     defeituosas; a entropia de distribuição é a métrica de difusão dele);
//   • símbolo-hub (fan-in) — do grafo do manifesto (Arcan-lite: tocar um nó de
//     alto fan-in propaga; fan-in = nº de endpoints cuja fullCallChain passa
//     pelo símbolo — o mesmo índice reverso da Onda 2);
//   • quebra alcançada — o BreakingReport da Onda 2 (breaking-AND-reachable é
//     o sinal mais forte de risco de entrega);
//   • área sensível — caminho tocado (migration/segurança) por convenção.
//
// O que NÃO é computável aqui é DECLARADO em `notComputed` (D7 — nunca fingir):
//   • co-change histórico (ROSE) — exige clone do repo; o servidor do Manifest
//     lê por API (github/gitlab provider) e não guarda working tree. O sinal
//     pertence a quem tem o clone (Sentinel).
//   • verificação de COMPORTAMENTO antes×depois — invisível ao diff estrutural
//     (ChangeGuard FSE'25: teste perde ~92% das mudanças de comportamento);
//     cobertura é do canal runtime/navegador do Sentinel (ADR-0016/0017).
//
// Limiares DECLARADOS em código com a razão — heurística calibrável, exposta na
// evidência de cada faceta. Puro; sem I/O.
// ─────────────────────────────────────────────

import type { DiffFile } from "./changed-symbols";
import { extractChangedSymbols } from "./changed-symbols";
import type { BreakingReport } from "./breaking-changes";

export type RiskLevel = "low" | "medium" | "high";

export interface RiskFacet {
  /** nome estável da natureza (chave de máquina) */
  name: "quebra-alcancada" | "churn-difusao" | "entropia" | "simbolo-hub" | "area-sensivel";
  level: RiskLevel;
  /** evidência legível, com os números que geraram o nível */
  evidence: string;
}

export interface HotSymbol {
  symbol: string; // qualificado: Classe.metodo | Classe
  fanIn: number;  // nº de endpoints cuja cadeia passa pelo símbolo
}

export interface NotComputedSignal {
  signal: "co-change" | "comportamento-antes-depois";
  reason: string;
}

export interface ChurnMetrics {
  filesTouched: number;
  dirsTouched: number;
  linesAdded: number;
  linesRemoved: number;
  /** entropia de Shannon normalizada [0..1] da distribuição do churn por arquivo (Kamei) */
  entropy: number;
}

export interface DeliveryRiskReport {
  /** nível agregado = MÁXIMO das facetas (nunca média — natureza alta não dilui) */
  level: RiskLevel;
  facets: RiskFacet[];
  churn: ChurnMetrics;
  /** símbolos tocados de maior fan-in no grafo (top 5) */
  hotSymbols: HotSymbol[];
  /** sinais NÃO computados nesta análise, com a razão (nunca fingidos) */
  notComputed: NotComputedSignal[];
}

// ── limiares declarados (com a razão) ──
// Kamei: entregas grandes/difusas concentram defeitos. Os cortes abaixo são
// heurística explícita — aparecem na evidência para o leitor calibrar.
const CHURN_HIGH_LINES = 800;
const CHURN_HIGH_FILES = 25;
const CHURN_MED_LINES = 200;
const CHURN_MED_FILES = 8;
// entropia normalizada: 1.0 = churn uniformemente espalhado (difusão máxima).
// Só significativa com ≥3 arquivos (com 1-2 o valor é degenerado).
const ENTROPY_HIGH = 0.85;
const ENTROPY_MED = 0.6;
const ENTROPY_MIN_FILES = 3;
// fan-in: nº de endpoints cuja cadeia passa pelo símbolo tocado (hub Arcan-lite)
const HUB_HIGH_FANIN = 20;
const HUB_MED_FANIN = 5;

const SENSITIVE_MIGRATION = /(^|\/)(db\/)?(migrations?|liquibase|flyway|changelog)s?\//i;
const SENSITIVE_SECURITY = /(security|auth|permission|rbac|crypto|token|secret)/i;

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function classBaseName(path: string): string {
  const base = (path || "").split("/").pop() || path;
  return base.replace(/\.[A-Za-z0-9]+$/, "");
}

/** churn + difusão + entropia (Kamei) — só do diff. */
export function computeChurn(files: DiffFile[]): ChurnMetrics {
  let linesAdded = 0;
  let linesRemoved = 0;
  const perFile: number[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    let c = 0;
    for (const h of f.hunks) {
      c += h.addedLines.length + h.removedLines.length;
      linesAdded += h.addedLines.length;
      linesRemoved += h.removedLines.length;
    }
    perFile.push(c);
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
    dirs.add(dir);
  }
  const total = perFile.reduce((a, b) => a + b, 0);
  let entropy = 0;
  if (files.length >= 2 && total > 0) {
    let h = 0;
    for (const c of perFile) {
      if (c <= 0) continue;
      const p = c / total;
      h -= p * Math.log2(p);
    }
    entropy = h / Math.log2(files.length); // normalizada [0..1]
  }
  return {
    filesTouched: files.length,
    dirsTouched: dirs.size,
    linesAdded,
    linesRemoved,
    entropy: Number(entropy.toFixed(4)),
  };
}

/**
 * fan-in por símbolo tocado: nº de endpoints cuja fullCallChain contém a
 * ENTRADA `Classe.simbolo` (igualdade inteira — mesma régua anti-superalarme da
 * Onda 2) + fan-in de CLASSE (`Classe.` como prefixo de entrada). Top 5.
 */
export function computeHotSymbols(manifest: any, files: DiffFile[]): HotSymbol[] {
  const endpoints: any[] =
    Array.isArray(manifest?.impactEndpoints) && manifest.impactEndpoints.length
      ? manifest.impactEndpoints
      : Array.isArray(manifest?.endpoints)
        ? manifest.endpoints
        : [];
  if (!endpoints.length) return [];

  const fanIn = new Map<string, number>();
  const bump = (sym: string, n: number) => {
    if (n > 0) fanIn.set(sym, Math.max(fanIn.get(sym) || 0, n));
  };

  for (const f of files) {
    if (!/\.(java|kt)$/i.test(f.path)) continue; // cadeias do grafo são backend
    const cls = classBaseName(f.path);
    const lcCls = lc(cls);

    // fan-in da CLASSE tocada (qualquer entrada `classe.` na cadeia)
    const clsCount = endpoints.filter((ep) =>
      (ep?.fullCallChain || []).some((c: unknown) => lc(c).startsWith(lcCls + ".")),
    ).length;
    bump(cls, clsCount);

    // fan-in por símbolo qualificado `classe.simbolo`
    for (const sym of extractChangedSymbols(f)) {
      const q = `${lcCls}.${lc(sym)}`;
      const n = endpoints.filter((ep) =>
        (ep?.fullCallChain || []).some((c: unknown) => lc(c) === q),
      ).length;
      bump(`${cls}.${sym}`, n);
    }
  }

  return Array.from(fanIn.entries())
    .filter(([, n]) => n > 0)
    // fan-in desc; em EMPATE, o símbolo QUALIFICADO (Classe.metodo) vence a
    // classe crua — mais específico = mais acionável no relatório.
    .sort((a, b) => b[1] - a[1] || Number(b[0].includes(".")) - Number(a[0].includes(".")) || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([symbol, n]) => ({ symbol, fanIn: n }));
}

function levelMax(levels: RiskLevel[]): RiskLevel {
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return "low";
}

/**
 * Relatório de risco da entrega — facetas advisory com evidência. Determinístico.
 */
export function computeDeliveryRisk(
  manifest: any,
  files: DiffFile[],
  breaking?: BreakingReport,
): DeliveryRiskReport {
  const churn = computeChurn(files);
  const hotSymbols = computeHotSymbols(manifest, files);
  const facets: RiskFacet[] = [];

  // 1) quebra alcançada (Onda 2) — o sinal mais forte
  const alerts = breaking?.summary.alerts ?? 0;
  const dead = breaking?.summary.suppressedDead ?? 0;
  facets.push({
    name: "quebra-alcancada",
    level: alerts > 0 ? "high" : "low",
    evidence:
      alerts > 0
        ? `${alerts} quebra(s) com consumidor no grafo: ${breaking!.alerts.map((a) => a.symbol).join(", ")}`
        : `0 quebra alcançada${dead ? ` (${dead} morta(s) suprimida(s))` : ""}`,
  });

  // 2) churn/difusão (Kamei)
  const lines = churn.linesAdded + churn.linesRemoved;
  const churnLevel: RiskLevel =
    lines > CHURN_HIGH_LINES || churn.filesTouched > CHURN_HIGH_FILES
      ? "high"
      : lines > CHURN_MED_LINES || churn.filesTouched > CHURN_MED_FILES
        ? "medium"
        : "low";
  facets.push({
    name: "churn-difusao",
    level: churnLevel,
    evidence: `${lines} linhas (+${churn.linesAdded}/−${churn.linesRemoved}) em ${churn.filesTouched} arquivo(s), ${churn.dirsTouched} diretório(s) [cortes: >${CHURN_MED_LINES}/${CHURN_MED_FILES} médio, >${CHURN_HIGH_LINES}/${CHURN_HIGH_FILES} alto]`,
  });

  // 3) entropia da difusão (Kamei) — só significativa com ≥3 arquivos
  const entLevel: RiskLevel =
    churn.filesTouched >= ENTROPY_MIN_FILES && churn.entropy >= ENTROPY_HIGH
      ? "high"
      : churn.filesTouched >= ENTROPY_MIN_FILES && churn.entropy >= ENTROPY_MED
        ? "medium"
        : "low";
  facets.push({
    name: "entropia",
    level: entLevel,
    evidence:
      churn.filesTouched >= ENTROPY_MIN_FILES
        ? `entropia normalizada ${churn.entropy} em ${churn.filesTouched} arquivos [≥${ENTROPY_MED} médio, ≥${ENTROPY_HIGH} alto]`
        : `n/a (${churn.filesTouched} arquivo(s) — mínimo ${ENTROPY_MIN_FILES} pra difusão significar algo)`,
  });

  // 4) símbolo-hub tocado (Arcan-lite)
  const maxFanIn = hotSymbols[0]?.fanIn ?? 0;
  const hubLevel: RiskLevel =
    maxFanIn >= HUB_HIGH_FANIN ? "high" : maxFanIn >= HUB_MED_FANIN ? "medium" : "low";
  facets.push({
    name: "simbolo-hub",
    level: hubLevel,
    evidence: hotSymbols.length
      ? `maior fan-in tocado: ${hotSymbols[0].symbol} alcançado por ${maxFanIn} endpoint(s) [≥${HUB_MED_FANIN} médio, ≥${HUB_HIGH_FANIN} alto]`
      : "nenhum símbolo tocado aparece em cadeia do grafo",
  });

  // 5) área sensível por convenção de caminho
  const migrationFiles = files.filter((f) => SENSITIVE_MIGRATION.test(f.path)).map((f) => f.path);
  const securityFiles = files.filter((f) => SENSITIVE_SECURITY.test(f.path)).map((f) => f.path);
  const sensLevel: RiskLevel =
    migrationFiles.length && securityFiles.length
      ? "high"
      : migrationFiles.length || securityFiles.length
        ? "medium"
        : "low";
  facets.push({
    name: "area-sensivel",
    level: sensLevel,
    evidence:
      sensLevel === "low"
        ? "nenhum caminho de migration/segurança tocado"
        : [
            migrationFiles.length ? `migration: ${migrationFiles.slice(0, 3).join(", ")}${migrationFiles.length > 3 ? "…" : ""}` : "",
            securityFiles.length ? `segurança: ${securityFiles.slice(0, 3).join(", ")}${securityFiles.length > 3 ? "…" : ""}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
  });

  const notComputed: NotComputedSignal[] = [
    {
      signal: "co-change",
      reason:
        "acoplamento histórico (ROSE) exige o clone do repositório — o Manifest lê por API; o sinal pertence a quem tem o clone (Sentinel). Complementar, nunca fonte única (precisão ~0,3–0,5).",
    },
    {
      signal: "comportamento-antes-depois",
      reason:
        "mudança de comportamento é invisível ao diff estrutural (teste perde ~92% — ChangeGuard FSE'25); a verificação antes×depois é do canal runtime/navegador do Sentinel (OTel + Playwright, ADR-0016/0017).",
    },
  ];

  return {
    level: levelMax(facets.map((f) => f.level)),
    facets,
    churn,
    hotSymbols,
    notComputed,
  };
}

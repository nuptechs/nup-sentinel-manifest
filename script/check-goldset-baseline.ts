// ─────────────────────────────────────────────
// check-goldset-baseline — ADR-0015 G1 (gate executável do baseline full-repo).
//
// Compara uma medição do goldset easynup (produzida pela receita de
// docs/benchmark/goldset-easynup.md §"Como reproduzir") contra o baseline
// CONGELADO em tests/regression/baseline-easynup-full.json.
//
//   uso:  npx tsx script/check-goldset-baseline.ts <metricas.json>
//   exit: 0 = nenhuma regressão · 1 = regressão (ou métrica ausente — fail-closed)
//
// Shape esperado de <metricas.json> (chaves numéricas planas):
//   { "totalEndpoints": 1330, "totalEntities": 214, ... , "fakeEndpoints": 0 }
//
// Regras:
//   floors   → medido >= floor  (cair abaixo = regressão)
//   ceilings → medido <= ceiling (ex.: fakeEndpoints não pode voltar)
//   métrica do baseline AUSENTE na medição → falha (fail-closed: não se
//   declara "sem regressão" sobre o que não foi medido).
// ─────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface BaselineSpec {
  floors: Record<string, number>;
  ceilings: Record<string, number>;
}

export interface BaselineReport {
  ok: boolean;
  checked: number;
  failures: string[];
  improvements: string[];
}

export function compareBaseline(
  measured: Record<string, unknown>,
  spec: BaselineSpec,
): BaselineReport {
  const failures: string[] = [];
  const improvements: string[] = [];
  let checked = 0;

  for (const [key, floor] of Object.entries(spec.floors ?? {})) {
    checked++;
    const value = measured[key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      failures.push(`métrica ausente/inválida na medição: "${key}" (fail-closed)`);
      continue;
    }
    if (value < floor) {
      failures.push(`REGRESSÃO ${key}: medido ${value} < piso ${floor}`);
    } else if (value > floor) {
      improvements.push(`${key}: ${value} > piso ${floor} (considere subir o piso no mesmo PR)`);
    }
  }

  for (const [key, ceiling] of Object.entries(spec.ceilings ?? {})) {
    checked++;
    const value = measured[key];
    if (typeof value !== "number" || Number.isNaN(value)) {
      failures.push(`métrica ausente/inválida na medição: "${key}" (fail-closed)`);
      continue;
    }
    if (value > ceiling) {
      failures.push(`REGRESSÃO ${key}: medido ${value} > teto ${ceiling}`);
    }
  }

  return { ok: failures.length === 0, checked, failures, improvements };
}

// ── CLI ──
const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const measuredPath = process.argv[2];
  if (!measuredPath) {
    console.error("uso: npx tsx script/check-goldset-baseline.ts <metricas.json>");
    process.exit(1);
  }
  const baselinePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "tests/regression/baseline-easynup-full.json",
  );
  const spec = JSON.parse(readFileSync(baselinePath, "utf-8")) as BaselineSpec;
  const measured = JSON.parse(readFileSync(measuredPath, "utf-8"));

  const report = compareBaseline(measured, spec);
  for (const line of report.improvements) console.log(`↑ ${line}`);
  for (const line of report.failures) console.error(`✗ ${line}`);
  console.log(
    report.ok
      ? `✓ baseline OK — ${report.checked} métricas verificadas, 0 regressões`
      : `✗ baseline REPROVADO — ${report.failures.length} falha(s) em ${report.checked} métricas`,
  );
  process.exit(report.ok ? 0 : 1);
}

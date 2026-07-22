// ─────────────────────────────────────────────
// sarif-report — ADR-0019 Onda 3 (interoperabilidade SOTA)
//
// Converte o DiffImpactReport em SARIF 2.1.0 — o formato-padrão que o GitHub
// code scanning renderiza INLINE no PR (aba Security + anotações) sem UI nossa.
// Régua de sinal (anti-spam, espírito Ochoa):
//   • quebra ALCANÇADA  → result level "error"   (o 7,9% que importa)
//   • inconclusiva      → result level "note"    (transparência, não alarme)
//   • quebra MORTA      → NÃO vira result (suprimida é suprimida) — vai só na
//     invocation como propriedade de contagem.
// Puro; sem I/O.
// ─────────────────────────────────────────────

interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
    };
  }>;
}

const RULE_BREAKING = "sentinel/breaking-reachable";
const RULE_INCONCLUSIVE = "sentinel/breaking-inconclusive";

const RULES = [
  {
    id: RULE_BREAKING,
    name: "BreakingChangeReachable",
    shortDescription: { text: "Quebra de contrato COM consumidor conhecido no grafo" },
    fullDescription: {
      text:
        "Símbolo removido ou com assinatura alterada que é alcançado por endpoints/telas do sistema (breaking-AND-reachable). Quebras sem consumidor conhecido são suprimidas (Ochoa EMSE'22: ~92% do alarme contract-only é morto).",
    },
    defaultConfiguration: { level: "error" },
  },
  {
    id: RULE_INCONCLUSIVE,
    name: "BreakingChangeInconclusive",
    shortDescription: { text: "Remoção que não pôde ser confirmada (conservador)" },
    fullDescription: {
      text:
        "O símbolo removido ainda é referenciado nas linhas adicionadas, ou o runtime não está modelado no manifesto — na dúvida, não alarma (vira nota).",
    },
    defaultConfiguration: { level: "note" },
  },
];

/**
 * Converte um DiffImpactReport (ADR-0018) em documento SARIF 2.1.0.
 * `report` é o shape retornado por computeImpactForDiff; tolerante a campos
 * ausentes (relatório do caminho `files` → SARIF vazio, honesto).
 */
export function toSarif(report: any, opts: { projectName?: string; serverUrl?: string } = {}): any {
  const brk = report?.breaking || {};
  const results: SarifResult[] = [];

  for (const a of brk.alerts || []) {
    const eps = a?.consumers?.endpoints?.length ?? 0;
    const screens = a?.consumers?.screens?.length ?? 0;
    const label = a.change === "removed" ? "removido" : "assinatura alterada";
    const sample = (a?.consumers?.endpoints || [])
      .slice(0, 3)
      .map((e: any) => `${e.method} ${e.path}`)
      .join(", ");
    results.push({
      ruleId: RULE_BREAKING,
      level: "error",
      message: {
        text:
          `\`${a.symbol}\` (${a.kind}) ${label} — ${eps} endpoint(s) dependente(s), ${screens} tela(s) consumidora(s)` +
          (sample ? `. Dependentes: ${sample}` : "") +
          `. Via: ${a.via}.`,
      },
      locations: [{ physicalLocation: { artifactLocation: { uri: a.file } } }],
    });
  }

  for (const ic of brk.inconclusive || []) {
    results.push({
      ruleId: RULE_INCONCLUSIVE,
      level: "note",
      message: { text: `\`${ic.symbol}\`: ${ic.reason}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: ic.file || "" } } }],
    });
  }

  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "NuPtechs Sentinel",
            informationUri: opts.serverUrl || "https://nuptechs.com",
            version: "1.0.0",
            rules: RULES,
          },
        },
        results,
        // contagens de transparência (o que foi SUPRIMIDO de propósito)
        properties: {
          suppressedDeadBreaking: brk.summary?.suppressedDead ?? 0,
          refactorsDowngraded: brk.summary?.refactors ?? 0,
          riskLevel: report?.risk?.level ?? null,
          functionalBoxes: (report?.functional?.boxes || []).map((b: any) => b.concept),
          projectName: opts.projectName ?? null,
        },
      },
    ],
  };
}

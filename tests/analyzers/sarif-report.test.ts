// ─────────────────────────────────────────────
// sarif-report — testes (ADR-0019 Onda 3). Puro, determinístico.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toSarif } from "../../server/analyzers/sarif-report.ts";
import _idx from "../../cli/src/commands/index-map.ts";
const { shouldIndexEntry } = _idx as any;

const REPORT = {
  breaking: {
    alerts: [
      {
        symbol: "ContractService.update", kind: "method", change: "removed", file: "src/main/java/ContractService.java",
        via: "callChain",
        consumers: {
          endpoints: [{ method: "POST", path: "/easynup/updateContract.v1" }],
          screens: [{ name: "ContractEdit" }],
        },
      },
    ],
    inconclusive: [
      { file: "services/gateway/x.js", symbol: "x.morto", reason: "runtime Node/JS não modelado no manifesto deste projeto" },
    ],
    suppressedDead: [{ symbol: "Orphan.dead" }],
    summary: { alerts: 1, suppressedDead: 1, refactors: 2, inconclusive: 1, candidates: 3 },
  },
  risk: { level: "high" },
  functional: { boxes: [{ concept: "Sanção/Glosa (penalidade)" }] },
};

describe("toSarif (ADR-0019 Onda 3)", () => {
  it("quebra ALCANÇADA → result level error com arquivo + mensagem com consumidores", () => {
    const s = toSarif(REPORT, { projectName: "cliente-x" });
    assert.equal(s.version, "2.1.0");
    const run = s.runs[0];
    assert.equal(run.tool.driver.name, "NuPtechs Sentinel");
    const errs = run.results.filter((r: any) => r.level === "error");
    assert.equal(errs.length, 1);
    assert.match(errs[0].message.text, /ContractService\.update/);
    assert.match(errs[0].message.text, /1 endpoint/);
    assert.match(errs[0].message.text, /updateContract\.v1/);
    assert.equal(errs[0].locations[0].physicalLocation.artifactLocation.uri, "src/main/java/ContractService.java");
    assert.equal(errs[0].ruleId, "sentinel/breaking-reachable");
  });

  it("inconclusiva → note (transparência, não alarme); MORTA NÃO vira result (só contagem)", () => {
    const s = toSarif(REPORT);
    const run = s.runs[0];
    const notes = run.results.filter((r: any) => r.level === "note");
    assert.equal(notes.length, 1);
    assert.match(notes[0].message.text, /não modelado/);
    // morta suprimida: zero results, contada nas properties
    assert.ok(!run.results.some((r: any) => /Orphan\.dead/.test(r.message.text)));
    assert.equal(run.properties.suppressedDeadBreaking, 1);
    assert.equal(run.properties.riskLevel, "high");
    assert.deepEqual(run.properties.functionalBoxes, ["Sanção/Glosa (penalidade)"]);
  });

  it("regras declaradas no driver (breaking-reachable + inconclusive)", () => {
    const s = toSarif(REPORT);
    const ids = s.runs[0].tool.driver.rules.map((r: any) => r.id).sort();
    assert.deepEqual(ids, ["sentinel/breaking-inconclusive", "sentinel/breaking-reachable"]);
  });

  it("relatório sem breaking (caminho files) → SARIF vazio honesto, nunca quebra", () => {
    const s = toSarif({ aggregate: {} });
    assert.equal(s.runs[0].results.length, 0);
    assert.equal(s.runs[0].properties.suppressedDeadBreaking, 0);
  });
});

describe("shouldIndexEntry (filtro do auto-map)", () => {
  it("exclui node_modules/.git/dist/build/target em qualquer nível; mantém código", () => {
    assert.equal(shouldIndexEntry("src/main/java/X.java"), true);
    assert.equal(shouldIndexEntry("services/gateway/src/a.js"), true);
    assert.equal(shouldIndexEntry("node_modules/x/y.js"), false);
    assert.equal(shouldIndexEntry("frontend/node_modules/a.ts"), false);
    assert.equal(shouldIndexEntry(".git/HEAD"), false);
    assert.equal(shouldIndexEntry("java-engine/target/x.jar"), false);
    assert.equal(shouldIndexEntry("app/dist/bundle.js"), false);
    // nomes que CONTÊM os termos mas não são os diretórios não são excluídos
    assert.equal(shouldIndexEntry("src/distributed/queue.ts"), true);
    assert.equal(shouldIndexEntry("src/targeting/rules.ts"), true);
  });
});

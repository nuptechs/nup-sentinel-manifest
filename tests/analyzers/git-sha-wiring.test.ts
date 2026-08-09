import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────
// PROVA (estrutural) de que o SHA analisado chega ao diagnóstico DURÁVEL.
//
// O comportamento puro (normalização, leitura do diagnóstico, veredito) tem
// teste de verdade em evidence-drift.test.ts. O que NÃO dá para exercitar aqui
// é o pipeline em si: ele importa `storage` no topo, que abre conexão — o
// mesmo motivo pelo qual runtime-overlay-pipeline-wiring.test.ts crava a
// costura por leitura de fonte. Este teste guarda os três elos que um refactor
// distraído quebraria em silêncio, sem nenhum teste ficar vermelho:
//
//   1. `/api/analyze` REPASSA `options.gitSha` (senão o carimbo nunca chega);
//   2. o pipeline carimba com `normalizeGitSha` (senão entra SHA curto/lixo e a
//      comparação com o ambiente vira falso drift);
//   3. o carimbo é feito ANTES do try (senão o run que FALHA perde o SHA — e é
//      justamente no run falho que saber o commit mais importa).
// ─────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, "../../server", rel), "utf8");

describe("wiring: o SHA analisado entra no diagnóstico durável do run", () => {
  const pipeline = read("pipeline/analysis-pipeline.ts");
  const routes = read("routes.ts");

  const runFullAnalysisBody = () => {
    const start = pipeline.indexOf("async runFullAnalysis(");
    assert.ok(start >= 0, "runFullAnalysis existe");
    const next = pipeline.indexOf("async runFromProject(", start);
    return pipeline.slice(start, next > 0 ? next : undefined);
  };

  it("/api/analyze repassa options.gitSha ao pipeline", () => {
    const at = routes.indexOf('app.post("/api/analyze"');
    assert.ok(at >= 0, "rota /api/analyze existe");
    const block = routes.slice(at, at + 4000);
    assert.match(block, /runFullAnalysis\([^)]*gitSha:\s*options\?\.gitSha/s);
  });

  it("runFullAnalysis aceita o SHA por opções (nunca adivinha do disco)", () => {
    assert.ok(pipeline.includes("opts: RunAnalysisOptions = {}"), "assinatura opcional — call-sites antigos intactos");
    assert.ok(pipeline.includes("gitSha?: string | null"), "a opção é declarada e tipada");
  });

  it("o carimbo passa pelo normalizador — SHA curto/lixo nunca é gravado", () => {
    const body = runFullAnalysisBody();
    assert.match(body, /normalizeGitSha\(opts\.gitSha\)/, "usa o normalizador único (40-hex ou nada)");
    assert.match(body, /if \(gitSha\) diag\.gitSha = gitSha/, "grava só quando há SHA válido");
  });

  it("carimba ANTES do try — o run que FALHA também guarda o commit", () => {
    const body = runFullAnalysisBody();
    const carimbo = body.indexOf("diag.gitSha = gitSha");
    const tryAt = body.indexOf("try {");
    assert.ok(carimbo > 0 && tryAt > 0, "os dois marcos existem");
    assert.ok(carimbo < tryAt, "o carimbo precede o try (vale nos dois caminhos: sucesso e falha)");
    // e o caminho de falha grava o MESMO objeto diag
    assert.match(body, /status: "failed",[\s\S]*diagnostics: diag/, "o catch persiste o diag carimbado");
  });

  it("runFromProject repassa as opções (um único funil, sem caminho que perde o SHA)", () => {
    assert.match(pipeline, /return this\.runFullAnalysis\(projectId, fileData, opts\)/);
  });

  it("o contrato público documenta gitSha como 40-hex", () => {
    const spec = read("api-spec.ts");
    const at = spec.indexOf('"/api/analyze"');
    const block = spec.slice(at, at + 2500);
    assert.ok(block.includes("gitSha"), "a opção aparece no OpenAPI servido");
    assert.ok(block.includes("[0-9a-fA-F]{40}"), "com o formato cravado (não aceita SHA curto)");
  });
});

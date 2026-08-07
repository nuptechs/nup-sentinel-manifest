import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────
// PROVA (estrutural) de que o caminho HEADLESS-por-nome (`POST /api/analyze`,
// o que o `manifest_analyze` do sentinel usa) INVOCA a costura de runtime.
//
// O sintoma ao vivo foi "o overlay não LOGA na análise" → o bloco não roda. Este
// teste crava que NÃO há gate/branch por entrypoint: os DOIS caminhos
// (`/api/analyze` e `/api/projects/:id/analyze`) funilam pelo ÚNICO
// `runFullAnalysis`, que chama `runRuntimeOverlay` INCONDICIONALMENTE dentro do
// try principal (só depende de `cfg` resolvido, nunca de como o projeto chegou).
// Regressão-guard: se alguém puser o overlay atrás de um branch de entrypoint ou
// remover a chamada, este teste quebra.
// ─────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, "../../server", rel), "utf8");

describe("wiring: o caminho /api/analyze invoca o runtime overlay", () => {
  const pipeline = read("pipeline/analysis-pipeline.ts");
  const routes = read("routes.ts");

  it("runFullAnalysis chama runRuntimeOverlay (a costura) dentro do try principal", () => {
    const start = pipeline.indexOf("async runFullAnalysis(");
    assert.ok(start >= 0, "runFullAnalysis existe");
    // corta do início de runFullAnalysis até o início do próximo método (runFromProject)
    const next = pipeline.indexOf("async runFromProject(", start);
    const body = pipeline.slice(start, next > 0 ? next : undefined);
    assert.ok(body.includes("runRuntimeOverlay("), "runFullAnalysis invoca runRuntimeOverlay");
    // a costura roda ANTES do saveSnapshot (as arestas observadas entram no snapshot)
    assert.ok(
      body.indexOf("runRuntimeOverlay(") < body.indexOf("saveSnapshot("),
      "overlay roda antes do saveSnapshot",
    );
  });

  it("NÃO há gate por entrypoint/projectName em volta do overlay", () => {
    // janela = do resolve da config até a chamada da costura (o bloco do overlay)
    const cfgAt = pipeline.indexOf("resolveRuntimeOverlayConfig(projectOverlayConfig");
    const callAt = pipeline.indexOf("runRuntimeOverlay(", cfgAt);
    assert.ok(cfgAt >= 0 && callAt > cfgAt, "bloco do overlay localizado");
    const block = pipeline.slice(cfgAt, callAt);
    // a chamada não pode estar condicionada a projectName/headless/options/req
    for (const gate of ["projectName", "headless", "options?.", "options.", "req.body", "req.params"]) {
      assert.ok(!block.includes(gate), `sem gate '${gate}' no bloco do overlay`);
    }
    // o único condicional legítimo é `if (!cfg)` (gated por config), com LOG no OFF
    assert.ok(block.includes("if (!cfg)"), "o único gate é a config resolvida (com log honesto no OFF)");
  });

  it("os DOIS entrypoints funilam pelo mesmo runFullAnalysis", () => {
    // /api/analyze (headless por nome) chama runFullAnalysis
    const analyze = routes.slice(routes.indexOf('app.post("/api/analyze"'), routes.indexOf('app.post("/api/analyze"') + 2500);
    assert.ok(analyze.includes("runFullAnalysis("), "/api/analyze usa runFullAnalysis");
    // runFromProject (base de /api/projects/:id/analyze) delega ao mesmo método
    assert.ok(pipeline.includes("return this.runFullAnalysis("), "runFromProject delega a runFullAnalysis");
  });

  it("o overlay LOGA sempre — OFF nomeado e falha nomeada (nunca no-op silencioso)", () => {
    assert.ok(pipeline.includes("Runtime overlay OFF"), "loga quando desligado (cfg null)");
    assert.ok(pipeline.includes("runtime overlay falhou"), "loga quando falha (fail-soft)");
    // o catch externo deixou de ser silencioso
    assert.ok(pipeline.includes("runFullAnalysis FALHOU"), "o catch externo agora loga a falha");
  });
});

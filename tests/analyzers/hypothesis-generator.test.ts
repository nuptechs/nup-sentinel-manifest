/**
 * ADR-0020 r2 Onda 3 — IA geradora de hipótese (D3): citação obrigatória,
 * parse estrito, degradação honesta sem LLM, e o GATE matando alucinação.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHypothesisPrompt,
  generateHypotheses,
  hypothesesAsProfile,
  parseHypotheses,
  pickSampleFiles,
} from "../../server/analyzers/hypothesis-generator";
import { verifyConventionProfile } from "../../server/analyzers/convention-profile";

const javaFile = (name: string, cls: string) => ({
  filePath: `src/services/web/${name}.java`,
  content: `package x;\npublic class ${cls} {\n}\n`,
});
const FILES = [
  javaFile("FindContractHandlerBean", "FindContractHandlerBean"),
  javaFile("CreateAcceptanceHandlerBean", "CreateAcceptanceHandlerBean"),
  javaFile("DeleteSlaHandlerBean", "DeleteSlaHandlerBean"),
  { filePath: "frontend/src/app.ts", content: "export const x = 1;\n" },
];

const GOOD_RULE = {
  id: "handler-bean",
  claim: "Handlers terminam em HandlerBean",
  kind: "layer-suffix",
  pattern: "class\\s+\\w+HandlerBean",
  fileGlob: ".java",
  minSites: 3,
  cited: { file: "src/services/web/FindContractHandlerBean.java", lineStart: 1, lineEnd: 3 },
};

describe("pickSampleFiles — determinística, resíduo primeiro", () => {
  it("prioriza arquivos NÃO cobertos pela estatística; 2 por estrato; determinística", () => {
    const admitted = [{
      rule: { id: "x", claim: "c", kind: "layer-suffix", pattern: "p", minSites: 3 },
      sites: 1, distinctFiles: 1,
      sample: [{ file: "src/services/web/FindContractHandlerBean.java", line: 2, text: "t", groups: [] }],
    }] as any;
    const s1 = pickSampleFiles(FILES as any, admitted, 3);
    const s2 = pickSampleFiles(FILES as any, admitted, 3);
    assert.deepEqual(s1.map((f) => f.filePath), s2.map((f) => f.filePath), "determinística");
    // o coberto (FindContract...) só entra depois do resíduo
    assert.notEqual(s1[0].filePath, "src/services/web/FindContractHandlerBean.java");
  });
});

describe("parseHypotheses — parse estrito + citação obrigatória", () => {
  it("regra válida entra com prefixo ai-; SEM cited é descartada NOMEADA", () => {
    const raw = JSON.stringify([GOOD_RULE, { ...GOOD_RULE, id: "sem-citacao", cited: undefined }]);
    const out = parseHypotheses(raw);
    assert.equal(out.proposedByLlm, 2);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].id, "ai-handler-bean");
    assert.equal(out.dropped.length, 1);
    assert.match(out.dropped[0].reason, /citação é obrigatória/);
  });

  it("regex inválida / kind errado caem na MESMA régua fail-closed das regras manuais", () => {
    const raw = JSON.stringify([
      { ...GOOD_RULE, id: "re-quebrada", pattern: "([" },
      { ...GOOD_RULE, id: "kind-doido", kind: "vibes" },
    ]);
    const out = parseHypotheses(raw);
    assert.equal(out.candidates.length, 0);
    assert.equal(out.dropped.length, 2);
    assert.match(out.dropped[0].reason, /regex inválida/);
    assert.match(out.dropped[1].reason, /kind inválido/);
  });

  it("resposta sem JSON / não-array → inválida nomeada, nunca lança", () => {
    assert.match(parseHypotheses("desculpe, não posso").dropped[0].reason, /JSON inválido|sem array/);
    assert.match(parseHypotheses('{"nada": true}').dropped[0].reason, /JSON inválido|sem array/);
  });

  it("acima do teto de 10 → excedente descartado nomeado", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...GOOD_RULE, id: `r${i}` }));
    const out = parseHypotheses(JSON.stringify(many));
    assert.equal(out.candidates.length, 10);
    assert.ok(out.dropped.some((d) => /teto/.test(d.reason)));
  });
});

describe("generateHypotheses — degradação honesta + fluxo completo", () => {
  it("sem LLM ⇒ skipped 'llm_unconfigured' (perfil segue só-estatístico, NUNCA erro)", async () => {
    const out = await generateHypotheses(FILES as any, [], null);
    assert.equal(out.skipped, true);
    assert.equal(out.reason, "llm_unconfigured");
  });

  it("LLM que lança ⇒ skipped com a razão, nunca propaga", async () => {
    const out = await generateHypotheses(FILES as any, [], async () => { throw new Error("rate limit"); });
    assert.equal(out.skipped, true);
    assert.match(out.reason!, /llm_failed: rate limit/);
  });

  it("prompt leva o 'não repita' estatístico + amostras + as regras do jogo", async () => {
    let seen = "";
    const admitted = [{
      rule: { id: "s", claim: 'Classes terminam em "HandlerBean" (3 arquivos .java)', kind: "layer-suffix", pattern: "p", minSites: 3 },
      sites: 3, distinctFiles: 3, sample: [],
    }] as any;
    await generateHypotheses(FILES as any, admitted, async (p) => { seen = p; return "[]"; });
    assert.match(seen, /NÃO repita/);
    assert.match(seen, /HandlerBean" \(3 arquivos/);
    assert.match(seen, /FILE: src\/services\/web\//);
    assert.match(seen, /descartada mecanicamente/);
  });

  it("FIM-A-FIM: hipótese REAL passa no gate com contagens; ALUCINADA morre no gate", async () => {
    const llm = async () => JSON.stringify([
      GOOD_RULE,
      {
        ...GOOD_RULE,
        id: "alucinada",
        claim: "resolvers GraphQL",
        pattern: "class\\s+\\w+GraphQLResolver",
        cited: { file: "src/services/web/FindContractHandlerBean.java", lineStart: 1, lineEnd: 3 },
      },
    ]);
    const gen = await generateHypotheses(FILES as any, [], llm);
    assert.equal(gen.skipped, false);
    assert.equal(gen.candidates.length, 2, "as duas passam no parse (formato ok)");

    const gate = verifyConventionProfile(hypothesesAsProfile(gen.candidates), FILES as any);
    assert.deepEqual(gate.admitted.map((a) => a.rule.id), ["ai-handler-bean"]);
    assert.equal(gate.admitted[0].distinctFiles, 3);
    assert.deepEqual(gate.rejected.map((r) => r.rule.id), ["ai-alucinada"]);
    assert.match(gate.rejected[0].reason, /sites insuficientes: 0 match/);
  });

  it("citação que NÃO resolve morre no gate mesmo com pattern que casa em outro lugar", async () => {
    const llm = async () => JSON.stringify([{
      ...GOOD_RULE,
      id: "citacao-errada",
      cited: { file: "frontend/src/app.ts", lineStart: 1, lineEnd: 1 },
    }]);
    const gen = await generateHypotheses(FILES as any, [], llm);
    const gate = verifyConventionProfile(hypothesesAsProfile(gen.candidates), FILES as any);
    assert.equal(gate.admitted.length, 0);
    assert.match(gate.rejected[0].reason, /citação não resolve/);
  });
});

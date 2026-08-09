/**
 * ADR-0020 r2 Onda 1 — ConventionProfile: parser fail-closed, matcher V1,
 * GATE de verificação mecânica (≥N arquivos DISTINTOS + citação que resolve +
 * anti-superalarme) e seam aditiva no grafo (off = byte-a-byte).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseConventionProfile,
  profilerMode,
  RegexAnchoredMatcher,
  verifyConventionProfile,
  fileMatchesGlob,
} from "../../server/analyzers/convention-profile";
import {
  computeProfileEndpoints,
  augmentGraphWithProfile,
  renderPathTemplate,
} from "../../server/analyzers/profile-augment";
import { ApplicationGraph, GraphNode } from "../../server/analyzers/application-graph";

// Um repo-fake com a convenção "XyzWsV1 → /easynup/xyz.v1" espalhada em 3+
// arquivos (o cenário real que o perfil generaliza do hardcode nuptechs).
const WS_RULE = {
  id: "wsv1-endpoint",
  claim: "Serviços WsV1 expõem /easynup/<op>.v<N>",
  kind: "endpoint",
  pattern: "class\\s+(\\w+)WsV(\\d+)",
  fileGlob: ".java",
  minSites: 3,
  endpoint: { pathTemplate: "/easynup/$1.v$2", httpMethod: "POST" },
};

const javaFile = (name: string, cls: string) => ({
  filePath: `src/services/web/${name}.java`,
  content: `package x;\n// class FakeWsV9 em comentário NÃO conta\npublic class ${cls} {\n}\n`,
});

const FILES = [
  javaFile("FindContractWsV1", "FindContractWsV1"),
  javaFile("CreateAcceptanceWsV1", "CreateAcceptanceWsV1"),
  javaFile("DeleteSlaWsV2", "DeleteSlaWsV2"),
  { filePath: "src/other/Util.java", content: "public class Util {}\n" },
  { filePath: "frontend/src/a.ts", content: "export const x = 1;\n" },
];

describe("profilerMode (flag off|shadow|on)", () => {
  it("default OFF; valores explícitos respeitados; lixo vira off", () => {
    assert.equal(profilerMode({}), "off");
    assert.equal(profilerMode({ MANIFEST_CONVENTION_PROFILER: "on" }), "on");
    assert.equal(profilerMode({ MANIFEST_CONVENTION_PROFILER: "SHADOW" }), "shadow");
    assert.equal(profilerMode({ MANIFEST_CONVENTION_PROFILER: "banana" }), "off");
  });
});

describe("parseConventionProfile — fail-closed", () => {
  it("perfil válido round-trips", () => {
    const p = parseConventionProfile({ version: 1, rules: [WS_RULE] });
    assert.equal(p.rules.length, 1);
    assert.equal(p.rules[0].endpoint.pathTemplate, "/easynup/$1.v$2");
  });

  it("rejeita NOMEANDO: regex inválida, kind desconhecido, endpoint sem template, id duplicado", () => {
    assert.throws(() => parseConventionProfile({ version: 1, rules: [{ ...WS_RULE, pattern: "([" }] }), /regex inválida/);
    assert.throws(() => parseConventionProfile({ version: 1, rules: [{ ...WS_RULE, kind: "magic" }] }), /kind inválido/);
    assert.throws(
      () => parseConventionProfile({ version: 1, rules: [{ ...WS_RULE, endpoint: undefined }] }),
      /exige endpoint.pathTemplate/,
    );
    assert.throws(
      () => parseConventionProfile({ version: 1, rules: [WS_RULE, { ...WS_RULE }] }),
      /id duplicado/,
    );
    assert.throws(() => parseConventionProfile({ version: 2, rules: [] }), /version/);
  });

  // ADR-0028 P1.1 / ADR-0029: write-side do runtimeOverlay (o read-side já
  // existia; o parser descartava o bag — este é o conserto).
  it("PRESERVA runtimeOverlay (services array/CSV) e valida fail-closed", () => {
    const p = parseConventionProfile({ version: 1, rules: [], runtimeOverlay: { services: ["nupidentity"] } });
    assert.deepEqual(p.runtimeOverlay?.services, ["nupidentity"]);
    const p2 = parseConventionProfile({ version: 1, rules: [], runtimeOverlay: { services: "a,b", gatewayService: "a" } });
    assert.equal(p2.runtimeOverlay?.services, "a,b");
    // ausente ⇒ campo não existe (byte-a-byte com o comportamento anterior)
    assert.equal(parseConventionProfile({ version: 1, rules: [] }).runtimeOverlay, undefined);
    // fail-closed
    assert.throws(() => parseConventionProfile({ version: 1, rules: [], runtimeOverlay: [] as any }), /runtimeOverlay deve ser um objeto/);
    assert.throws(() => parseConventionProfile({ version: 1, rules: [], runtimeOverlay: { services: 123 } as any }), /runtimeOverlay.services/);
  });

  // Eixo de drift: sem passthrough, a URL de health seria descartada em
  // silêncio no PUT e o eixo nasceria morto — exatamente o bug que o bag
  // acima já teve uma vez.
  it("PRESERVA appInfo.healthUrl e valida fail-closed", () => {
    const p = parseConventionProfile({
      version: 1,
      rules: [],
      appInfo: { healthUrl: "https://app.exemplo/healthz" },
    });
    assert.equal(p.appInfo?.healthUrl, "https://app.exemplo/healthz");
    // ausente ⇒ campo não existe (byte-a-byte com o comportamento anterior)
    assert.equal(parseConventionProfile({ version: 1, rules: [] }).appInfo, undefined);
    // fail-closed: config errada é recusada NA HORA, não vira "não deu para
    // perguntar" para sempre.
    assert.throws(() => parseConventionProfile({ version: 1, rules: [], appInfo: [] as any }), /appInfo deve ser um objeto/);
    assert.throws(
      () => parseConventionProfile({ version: 1, rules: [], appInfo: { healthUrl: "app.exemplo/healthz" } as any }),
      /appInfo.healthUrl/,
    );
    assert.throws(
      () => parseConventionProfile({ version: 1, rules: [], appInfo: { healthUrl: 42 } as any }),
      /appInfo.healthUrl/,
    );
  });
});

describe("RegexAnchoredMatcher — anti-superalarme herdado + contagem exata", () => {
  it("casa código, IGNORA linha de comentário, respeita fileGlob; report com contagens exatas", () => {
    const r = new RegexAnchoredMatcher().match(WS_RULE, FILES);
    // 3 classes reais; o "class FakeWsV9" vive em comentário e NÃO conta.
    assert.equal(r.sites, 3);
    assert.equal(r.files.length, 3);
    assert.equal(r.matches.length, 3);
    assert.ok(r.matches.every((x: any) => x.file.endsWith(".java")));
    assert.deepEqual(r.matches[0].groups, ["FindContract", "1"]);
    assert.equal(r.citationHit, null, "regra sem citação → null");
  });

  it("contagem NUNCA trunca (furo B da auditoria): sites/files exatos mesmo além do cap de amostra", () => {
    // arquivo único com MUITAS linhas casando + 3 arquivos distintos — a
    // contagem de arquivos distintos não pode depender da ordem/cap.
    const big = {
      filePath: "src/services/web/Big.java",
      content: Array.from({ length: 500 }, (_, i) => `class Gen${i}WsV1 {}`).join("\n"),
    };
    const r = new RegexAnchoredMatcher().match(WS_RULE, [big, ...FILES]);
    assert.equal(r.sites, 503, "500 do arquivão + 3 da fleet — exato");
    assert.equal(r.files.length, 4, "4 arquivos distintos — nunca escondidos por cap");
  });

  it("fileMatchesGlob: sufixo, fragmento, ausente", () => {
    assert.equal(fileMatchesGlob("a/b/C.java", ".java"), true);
    assert.equal(fileMatchesGlob("a/b/C.java", "services/web/"), false);
    assert.equal(fileMatchesGlob("src/services/web/C.java", "services/web/"), true);
    assert.equal(fileMatchesGlob("qualquer", undefined), true);
  });
});

describe("GATE D4 — verificação mecânica (o fosso)", () => {
  it("admite regra com ≥minSites arquivos DISTINTOS e mede sites/arquivos", () => {
    const report = verifyConventionProfile({ version: 1, rules: [WS_RULE] }, FILES);
    assert.equal(report.admitted.length, 1);
    assert.equal(report.rejected.length, 0);
    assert.equal(report.admitted[0].distinctFiles, 3);
    assert.equal(report.admitted[0].sites, 3);
    assert.ok(report.admitted[0].sample.length > 0, "amostra de evidência sempre presente");
  });

  it("ALUCINAÇÃO MORRE: padrão que casa 0 sites é rejeitado com razão nomeada", () => {
    const hallucinated = { ...WS_RULE, id: "h1", pattern: "class\\s+(\\w+)GraphQLResolver" };
    const report = verifyConventionProfile({ version: 1, rules: [hallucinated] }, FILES);
    assert.equal(report.admitted.length, 0);
    assert.match(report.rejected[0].reason, /sites insuficientes: 0 match/);
  });

  it("OVER-FIT MORRE: 3 matches no MESMO arquivo ≠ 3 arquivos distintos", () => {
    const oneFile = [
      {
        filePath: "src/All.java",
        content: "class AWsV1 {}\nclass BWsV1 {}\nclass CWsV1 {}\n",
      },
    ];
    const report = verifyConventionProfile({ version: 1, rules: [WS_RULE] }, oneFile);
    assert.equal(report.admitted.length, 0);
    assert.match(report.rejected[0].reason, /1 arquivo\(s\) distintos; mínimo 3/);
  });

  it("CITAÇÃO que não resolve é rejeitada; que resolve, admitida", () => {
    const citedWrong = { ...WS_RULE, id: "c1", cited: { file: "src/other/Util.java", lineStart: 1, lineEnd: 5 } };
    const citedRight = {
      ...WS_RULE,
      id: "c2",
      cited: { file: "src/services/web/FindContractWsV1.java", lineStart: 1, lineEnd: 10 },
    };
    const report = verifyConventionProfile({ version: 1, rules: [citedWrong, citedRight] }, FILES);
    assert.deepEqual(report.rejected.map((r: any) => r.rule.id), ["c1"]);
    assert.match(report.rejected[0].reason, /citação não resolve/);
    assert.deepEqual(report.admitted.map((a: any) => a.rule.id), ["c2"]);
  });

  it("PADRÃO LARGO DEMAIS morre (superalarme): casa >80% de ≥10 candidatos", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      filePath: `src/f${i}.java`,
      content: "public class Anything {}\n",
    }));
    const broad = {
      id: "broad",
      claim: "tudo é classe",
      kind: "endpoint",
      pattern: "class\\s+(\\w+)",
      fileGlob: ".java",
      minSites: 3,
      endpoint: { pathTemplate: "/x/$1" },
    };
    const report = verifyConventionProfile({ version: 1, rules: [broad] }, files);
    assert.equal(report.admitted.length, 0);
    assert.match(report.rejected[0].reason, /largo demais/);
  });
});

describe("seam aditiva no grafo", () => {
  const admittedOf = (files: any[]) =>
    verifyConventionProfile({ version: 1, rules: [WS_RULE] }, files).admitted;

  it("computeProfileEndpoints: template $1/$2 renderizado; dedupe por método+rota", () => {
    const eps = computeProfileEndpoints(FILES, admittedOf(FILES));
    assert.equal(eps.length, 3);
    const paths = eps.map((e: any) => e.fullPath).sort();
    assert.deepEqual(paths, ["/easynup/CreateAcceptance.v1", "/easynup/DeleteSla.v2", "/easynup/FindContract.v1"]);
    assert.ok(eps.every((e: any) => e.httpMethod === "POST" && e.ruleId === "wsv1-endpoint"));
  });

  it("renderPathTemplate: grupo ausente ⇒ null (nunca inventa endpoint)", () => {
    assert.equal(renderPathTemplate("/x/$1.v$2", ["Abc"]), null);
    assert.equal(renderPathTemplate("/x/$1", ["Abc"]), "/x/Abc");
  });

  it("augment é ADITIVO e idempotente: nunca sobrescreve nó nem duplica rota existente", () => {
    const graph = new ApplicationGraph();
    // Rota já coberta pelo WsV1 hardcoded — o perfil NÃO pode competir.
    graph.addNode(
      new GraphNode("wsv1:POST:/easynup/FindContract.v1", "CONTROLLER", "FindContractWsV1", "execute", null, {
        httpMethod: "POST",
        fullPath: "/easynup/FindContract.v1",
      }),
    );
    const before = graph.getAllNodes().length;
    const eps = computeProfileEndpoints(FILES, admittedOf(FILES));
    const added = augmentGraphWithProfile(graph, eps);
    assert.equal(added, 2, "só as 2 rotas NÃO cobertas entram");
    assert.equal(graph.getAllNodes().length, before + 2);
    // idempotência: rodar de novo não adiciona nada
    assert.equal(augmentGraphWithProfile(graph, eps), 0);
    // o nó pré-existente segue INTACTO (aditivo, nunca sobrescreve)
    const existing = graph.getNode("wsv1:POST:/easynup/FindContract.v1");
    assert.equal(existing.className, "FindContractWsV1");
  });

  it("OFF byte-a-byte: sem regras admitidas ⇒ zero endpoints ⇒ grafo intocado", () => {
    const graph = new ApplicationGraph();
    const before = JSON.stringify(graph.toJSON());
    const eps = computeProfileEndpoints(FILES, []);
    assert.equal(eps.length, 0);
    assert.equal(augmentGraphWithProfile(graph, eps), 0);
    assert.equal(JSON.stringify(graph.toJSON()), before, "grafo byte-a-byte");
  });
});

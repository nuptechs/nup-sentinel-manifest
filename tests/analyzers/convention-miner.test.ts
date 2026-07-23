/**
 * ADR-0020 r2 Onda 2 — minerador estatístico (D2): layer-suffix + route-anchor,
 * TODO candidato passa pelo gate D4; merge nunca sobrescreve curadoria manual.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  camelSegments,
  mineLayerSuffixes,
  mineRouteAnchors,
  mineConventionProfile,
  mergeMinedIntoProfile,
} from "../../server/analyzers/convention-miner";
import { parseConventionProfile } from "../../server/analyzers/convention-profile";
import { computeProfileEndpoints, renderPathTemplate } from "../../server/analyzers/profile-augment";

const java = (name: string) => ({
  filePath: `src/services/web/${name}.java`,
  content: `package x;\npublic class ${name} {\n}\n`,
});

const WSV1_FLEET = [
  java("FindContractWsV1"),
  java("CreateAcceptanceWsV1"),
  java("DeleteSlaWsV1"),
  java("UpdateVendorWsV1"),
  java("FindProjectWsV1"),
];

const EXPRESS_FLEET = Array.from({ length: 5 }, (_, i) => ({
  filePath: `services/gateway/src/routes/r${i}.js`,
  content: `const router = express.Router();\nrouter.get("/api/thing${i}", h);\nrouter.post("/api/thing${i}/create", h);\n// router.get("/api/comentario") não conta\n`,
}));

describe("camelSegments", () => {
  it("divide PascalCase incl. maiúsculas consecutivas e dígitos", () => {
    assert.deepEqual(camelSegments("FindContractWsV1"), ["Find", "Contract", "Ws", "V1"]);
    assert.deepEqual(camelSegments("HTTPServer"), ["HTTP", "Server"]);
  });
});

describe("mineLayerSuffixes", () => {
  it("descobre o sufixo dominante WsV1 com contagem de arquivos DISTINTOS", () => {
    const mined = mineLayerSuffixes(WSV1_FLEET, 5);
    const wsv1 = mined.find((m) => m.rule.id === "mined-suffix-wsv1");
    assert.ok(wsv1, `esperava sufixo WsV1; got: ${mined.map((m) => m.rule.id).join(",")}`);
    assert.equal(wsv1!.distinctFiles, 5);
    assert.equal(wsv1!.rule.kind, "layer-suffix");
    assert.equal(wsv1!.rule.fileGlob, ".java");
  });

  it("sufixo-sombra com o MESMO suporte do mais longo é suprimido (V1 ⊂ WsV1)", () => {
    const mined = mineLayerSuffixes(WSV1_FLEET, 5);
    const ids = mined.map((m) => m.rule.id);
    assert.ok(!ids.includes("mined-suffix-v1"), `V1 é sombra de WsV1; got: ${ids.join(",")}`);
  });

  it("abaixo de minFiles não vira candidato; comentário não conta", () => {
    const few = WSV1_FLEET.slice(0, 2);
    assert.equal(mineLayerSuffixes(few, 5).length, 0);
    const commented = [{ filePath: "a.java", content: "// class FakeWsV1\n" }];
    assert.equal(mineLayerSuffixes(commented, 1).length, 0);
  });
});

describe("mineRouteAnchors", () => {
  it("descobre router.get/router.post com método HTTP derivado e template $1", () => {
    const mined = mineRouteAnchors(EXPRESS_FLEET, 5);
    const get = mined.find((m) => m.rule.id === "mined-route-router-get");
    const post = mined.find((m) => m.rule.id === "mined-route-router-post");
    assert.ok(get && post, `got: ${mined.map((m) => m.rule.id).join(",")}`);
    assert.equal(get!.rule.endpoint!.httpMethod, "GET");
    assert.equal(post!.rule.endpoint!.httpMethod, "POST");
    assert.equal(get!.rule.endpoint!.pathTemplate, "$1");
    assert.equal(get!.distinctFiles, 5);
  });

  it("denylist: require('/abs') e import('/x') NÃO viram âncora de rota", () => {
    const noisy = Array.from({ length: 5 }, (_, i) => ({
      filePath: `src/n${i}.ts`,
      content: `const a = require("/abs/path");\nconst b = import("/dyn");\n`,
    }));
    assert.equal(mineRouteAnchors(noisy, 3).length, 0);
  });
});

describe("mineConventionProfile — dog-food do gate D4", () => {
  it("candidatos minerados saem ADMITIDOS pelo gate com contagens reais", () => {
    const files = [...WSV1_FLEET, ...EXPRESS_FLEET];
    const { candidates, report } = mineConventionProfile(files, { minFiles: 5 });
    assert.ok(candidates.length >= 3);
    const admittedIds = report.admitted.map((a) => a.rule.id);
    assert.ok(admittedIds.includes("mined-suffix-wsv1"));
    assert.ok(admittedIds.includes("mined-route-router-get"));
    // nada admitido sem passar pelo MESMO invariante (≥minSites arquivos distintos)
    assert.ok(report.admitted.every((a) => a.distinctFiles >= (a.rule.minSites ?? 3)));
  });

  it("regra minerada é VÁLIDA no parser fail-closed (template $1 aceito) e o augment materializa a rota real", () => {
    const { report } = mineConventionProfile(EXPRESS_FLEET, { minFiles: 5 });
    const admitted = report.admitted.map((a) => a.rule);
    // parser aceita (contrato Onda 1 estendido conscientemente pra $<n>)
    const parsed = parseConventionProfile({ version: 1, rules: admitted });
    assert.equal(parsed.rules.length, admitted.length);
    // augment: o grupo capturado É a rota
    const eps = computeProfileEndpoints(EXPRESS_FLEET, report.admitted);
    assert.ok(eps.some((e) => e.fullPath === "/api/thing0" && e.httpMethod === "GET"));
    assert.ok(eps.some((e) => e.fullPath === "/api/thing0/create" && e.httpMethod === "POST"));
  });

  it("guarda do augment: template grupo-puro cujo render NÃO começa com / é descartado", () => {
    assert.equal(renderPathTemplate("$1", ["nao-rota"]), "nao-rota"); // render cru
    const fake = [{
      filePath: "src/a.ts",
      content: `oddCall("x") // não deve virar endpoint\n`,
    }];
    // regra artificial que captura algo sem "/" — computeProfileEndpoints descarta
    const eps = computeProfileEndpoints(fake, [{
      rule: {
        id: "weird", claim: "x", kind: "endpoint",
        pattern: 'oddCall\\("([^"]+)"\\)', minSites: 1,
        endpoint: { pathTemplate: "$1" },
      },
      sites: 1, distinctFiles: 1, sample: [],
    } as any]);
    assert.equal(eps.length, 0);
  });
});

describe("claim == gate (furo C da auditoria): extensão dominante conta nos DOIS", () => {
  it("fileset poliglota: claim/minSites contam SÓ a extensão dominante — o gate admite consistente", () => {
    // 5 .js + 2 .ts com o MESMO anchor: dominante .js; claim deve dizer 5 (não 7)
    const poly = [
      ...Array.from({ length: 5 }, (_, i) => ({
        filePath: `src/r${i}.js`,
        content: `router.get("/api/x${i}", h);\n`,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        filePath: `src/t${i}.ts`,
        content: `router.get("/api/y${i}", h);\n`,
      })),
    ];
    const { report } = mineConventionProfile(poly, { minFiles: 5 });
    const get = report.admitted.find((a: any) => a.rule.id === "mined-route-router-get");
    assert.ok(get, `esperava router.get admitida; rejeitadas: ${JSON.stringify(report.rejected.map((r: any) => r.reason))}`);
    assert.equal(get!.rule.fileGlob, ".js");
    assert.match(get!.rule.claim, /5 arquivos \.js/, "claim conta só a extensão dominante");
    assert.equal(get!.distinctFiles, 5, "gate mede o MESMO conjunto do claim");
  });
});

describe("mergeMinedIntoProfile — curadoria manual VENCE", () => {
  it("regra existente com o mesmo id nunca é sobrescrita; novas entram; source anotada", () => {
    const existing = {
      version: 1 as const,
      rules: [{
        id: "mined-suffix-wsv1", claim: "CURADA À MÃO", kind: "layer-suffix" as const,
        pattern: "custom", minSites: 10,
      }],
      source: "manual",
    };
    const mined = [
      { id: "mined-suffix-wsv1", claim: "minerada", kind: "layer-suffix" as const, pattern: "auto", minSites: 5 },
      { id: "mined-route-router-get", claim: "nova", kind: "endpoint" as const, pattern: "p", minSites: 5, endpoint: { pathTemplate: "$1" } },
    ];
    const merged = mergeMinedIntoProfile(existing, mined as any);
    assert.equal(merged.rules.length, 2);
    assert.equal(merged.rules[0].claim, "CURADA À MÃO", "manual vence");
    assert.equal(merged.rules[1].id, "mined-route-router-get");
    assert.equal(merged.source, "manual+statistical");
  });

  it("sem perfil existente: só os minerados, source statistical", () => {
    const merged = mergeMinedIntoProfile(null, [
      { id: "a", claim: "x", kind: "naming" as const, pattern: "p", minSites: 3 },
    ] as any);
    assert.equal(merged.rules.length, 1);
    assert.equal(merged.source, "statistical");
  });
});

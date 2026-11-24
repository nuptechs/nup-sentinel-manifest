// ─────────────────────────────────────────────
// Join real do carimbo de alvo — exercita o MESMO caminho do pipeline sobre o
// fixture MINI_EASYNUP (que tem frontend + WsV1 + gateway Express, logo
// interactions > 0: o branch de PROD, não o backend-only).
//
// Prova que o mapa route→sourceFile cobre:
//   - WsV1 chamado pelo FRONTEND (GET via useQuery): a chave GET NÃO vem de
//     endpointImpacts (que só dá POST); vem da fonte WsV1 — o buraco que o fix
//     fecha para o inquilino easynup;
//   - rota Express (inquilino Node, sem CONTROLLER): fonte Express.
// E que o emitter (flag ON) carimba esse arquivo em codeContext.sourceFiles.
//
// Guarda da fiação do pipeline por texto (o pipeline importa `storage` no topo,
// que abre conexão — mesmo motivo do git-sha-wiring.test.ts): garante que os 3
// emits recebem `...targetCtx` e que o bloco é gateado pela flag.
// ─────────────────────────────────────────────
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { MINI_EASYNUP } from "../regression/mini-easynup.fixture.ts";
import { buildApplicationGraph, analyzeGraphEndpoints } from "../../server/analyzers/java-analyzer.ts";
import { augmentGraphWithWsV1 } from "../../server/analyzers/nuptechs-conventions.ts";
import { extractExpressRoutes } from "../../server/analyzers/node-backend/express-routes.ts";
import { wsv1NodesToCatalogEntries } from "../../server/analyzers/graph-connector.ts";
import { buildRouteSourceFileMap, emitSecurityFindings } from "../../server/security/sentinel-emitter.ts";

function buildMap() {
  const prev = process.env.MANIFEST_MULTISTACK_NODE;
  process.env.MANIFEST_MULTISTACK_NODE = "1";
  try {
    const files = (MINI_EASYNUP as any[]).map((f) => ({ filePath: f.filePath, content: f.content }));
    const java = files.filter((f) => f.filePath.endsWith(".java"));
    const fe = files.filter((f) => !f.filePath.endsWith(".java"));
    const g = buildApplicationGraph(java as any);
    augmentGraphWithWsV1(g, java as any);
    const impacts = analyzeGraphEndpoints(g);
    const wsv1 = wsv1NodesToCatalogEntries(g, 1, 1).map((e) => ({ httpMethod: e.httpMethod, endpoint: e.endpoint, sourceFile: e.sourceFile }));
    const express = extractExpressRoutes(fe as any, { crossFilePrefix: true });
    return { map: buildRouteSourceFileMap({ endpointImpacts: [...impacts, ...wsv1], expressRoutes: express }), impacts };
  } finally {
    if (prev === undefined) delete process.env.MANIFEST_MULTISTACK_NODE; else process.env.MANIFEST_MULTISTACK_NODE = prev;
  }
}

describe("resolved-target join (MINI_EASYNUP, branch de prod)", () => {
  it("WsV1 chamado pelo frontend (GET) resolve pro handler WsV1 — via fonte WsV1, não impacts", () => {
    const { map, impacts } = buildMap();
    // endpointImpacts NÃO tem a chave GET (só POST) — prova que a fonte WsV1 é necessária.
    const impactKeys = new Set(impacts.map((i: any) => `${String(i.httpMethod).toUpperCase()} ${i.endpoint}`));
    assert.ok(!impactKeys.has("GET /easynup/findContracts.v1"), "impacts não deveria ter a chave GET (vem do WsV1)");
    assert.equal(map["GET /easynup/findContracts.v1"], "src/main/java/easynup/services/web/contracts/findContracts/v1/FindContractsWsV1.java");
  });

  it("rota Express (inquilino Node) resolve pro arquivo da rota", () => {
    const { map } = buildMap();
    const expressHit = Object.entries(map).find(([, f]) => (f as string).includes("services/gateway/"));
    assert.ok(expressHit, "deveria haver pelo menos uma rota Express mapeada ao arquivo gateway");
  });

  it("emitter (flag ON) carimba o handler WsV1 em codeContext.sourceFiles", async () => {
    const { map } = buildMap();
    const realFetch = globalThis.fetch;
    let ingested: any[] = [];
    process.env.SENTINEL_URL = "https://sentinel.test";
    process.env.SENTINEL_API_KEY = "k:org";
    process.env.SENTINEL_PROJECT_ID = "proj";
    process.env.MANIFEST_EMIT_RESOLVED_TARGET = "1";
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (String(url).endsWith("/api/sessions")) return { status: 201, text: async () => JSON.stringify({ data: { id: "s" } }) } as any;
      ingested = JSON.parse(init.body);
      return { status: 200, text: async () => JSON.stringify({ acceptedCount: ingested.length, rejectedCount: 0 }) } as any;
    };
    try {
      const finding = {
        id: "W", type: "MISSING_PROTECTION", severity: "high",
        title: "t", description: "d", recommendation: "",
        affectedEndpoints: ["GET /easynup/findContracts.v1"],
        evidence: { targetEntry: { endpoint: "/easynup/findContracts.v1", httpMethod: "GET", controller: "", controllerMethod: "", criticalityScore: 0, securityAnnotations: [], requiredRoles: [], entitiesTouched: [], sensitiveFields: [] } },
      };
      await emitSecurityFindings([finding as any], { manifestProjectId: "1", analysisRunId: 1, repo: "nuptechs/easynup", ref: "a".repeat(40), sourceFileByRoute: map });
    } finally {
      (globalThis as any).fetch = realFetch;
      delete process.env.SENTINEL_URL; delete process.env.SENTINEL_API_KEY; delete process.env.SENTINEL_PROJECT_ID; delete process.env.MANIFEST_EMIT_RESOLVED_TARGET;
    }
    assert.equal(ingested.length, 1);
    assert.equal(ingested[0].symbolRef.repo, "nuptechs/easynup");
    assert.deepEqual(ingested[0].codeContext, { endpoints: [{ sourceFiles: ["src/main/java/easynup/services/web/contracts/findContracts/v1/FindContractsWsV1.java"] }] });
  });
});

describe("resolved-target — fiação do pipeline (guarda por texto)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pipeline = readFileSync(resolve(here, "../../server/pipeline/analysis-pipeline.ts"), "utf8");

  it("computa targetCtx atrás da flag emitResolvedTargetEnabled()", () => {
    assert.match(pipeline, /if \(emitResolvedTargetEnabled\(\)\)/, "o bloco de alvo deve ser gateado pela flag");
  });
  it("os 3 emits recebem ...targetCtx", () => {
    const occurrences = pipeline.match(/\.\.\.targetCtx/g) || [];
    assert.ok(occurrences.length >= 3, `esperado ...targetCtx nos 3 emits, achei ${occurrences.length}`);
  });
  it("o mapa é composto de impacts + WsV1 + Express", () => {
    assert.match(pipeline, /buildRouteSourceFileMap\(/);
    assert.match(pipeline, /wsv1NodesToCatalogEntries\(appGraph/);
    assert.match(pipeline, /extractExpressRoutes\(frontendFiles/);
  });
});

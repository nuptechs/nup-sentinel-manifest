// ─────────────────────────────────────────────
// sentinel-emitter — carimbo de alvo real (flag MANIFEST_EMIT_RESOLVED_TARGET)
//
// A correção do Sentinel lê `symbolRef.repo` + `symbolRef.ref`
// (correction.service.js:_readSource) e `codeContext.endpoints[].sourceFiles`
// (correction.service.js:_extractFilePaths). Sem esses campos o patch nunca
// aplica (0 auto-PR). Este emitter passa a carimbá-los — SÓ sob a flag, e
// byte-a-byte igual à emissão de hoje quando a flag está OFF.
//
// Provas:
//   G-OFF: com a flag desligada (unset/""/"0"/"false"), a emissão é idêntica à
//          de hoje MESMO quando o contexto traz repo/ref/sourceFile — ou seja,
//          o gate é o único que liga o carimbo. Falha se o gate for removido.
//   G-ON:  com a flag ligada, um achado de ROTA carrega repo+ref no symbolRef e
//          o arquivo-fonte do handler em codeContext.endpoints[].sourceFiles.
//   resolveRepoSlug: precedência e fail-closed.
// ─────────────────────────────────────────────
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  emitSecurityFindings,
  resolveRepoSlug,
  buildRouteSourceFileMap,
} from "../../server/security/sentinel-emitter.ts";

// SecurityFinding de ROTA (tem targetEntry.endpoint+httpMethod ⇒ symbolRef kind=route).
function routeFinding() {
  return {
    id: "F1",
    type: "MISSING_PROTECTION" as const,
    severity: "high" as const,
    title: "Endpoint sem proteção",
    description: "POST /easynup/createContract.v1 não exige papel",
    recommendation: "Adicione @PreAuthorize",
    affectedEndpoints: ["POST /easynup/createContract.v1"],
    evidence: {
      targetEntry: {
        endpoint: "/easynup/createContract.v1",
        httpMethod: "POST",
        controller: "ContractController",
        controllerMethod: "create",
        criticalityScore: 60,
        securityAnnotations: [],
        requiredRoles: [],
        entitiesTouched: ["Contract"],
        sensitiveFields: [],
      },
    },
  };
}

const ROUTE_ID = "POST /easynup/createContract.v1";
const SOURCE_FILE = "src/main/java/com/easynup/contract/ContractController.java";
const REPO = "nuptechs/easynup";
const REF = "a".repeat(40);

describe("sentinel-emitter — flag MANIFEST_EMIT_RESOLVED_TARGET", () => {
  const realFetch = globalThis.fetch;
  const RealDate = Date;
  let ingested: any[] = [];
  let rawBody = "";

  beforeEach(() => {
    ingested = [];
    rawBody = "";
    process.env.SENTINEL_URL = "https://sentinel.test";
    process.env.SENTINEL_API_KEY = "k:org-uuid";
    process.env.SENTINEL_PROJECT_ID = "sentinel-uuid";
    delete process.env.MANIFEST_EMIT_RESOLVED_TARGET;
    // Relógio congelado: observedAt determinístico p/ comparação de forma estável.
    const FIXED = "2020-01-01T00:00:00.000Z";
    (globalThis as any).Date = class extends RealDate {
      constructor() { super(FIXED); }
      toISOString() { return FIXED; }
      static now() { return 0; }
    };
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (String(url).endsWith("/api/sessions")) {
        return { status: 201, text: async () => JSON.stringify({ data: { id: "sess-1" } }) } as any;
      }
      rawBody = String(init.body);
      ingested = JSON.parse(rawBody);
      return { status: 200, text: async () => JSON.stringify({ acceptedCount: ingested.length, rejectedCount: 0 }) } as any;
    };
  });

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    (globalThis as any).Date = RealDate;
    delete process.env.SENTINEL_URL;
    delete process.env.SENTINEL_API_KEY;
    delete process.env.SENTINEL_PROJECT_ID;
    delete process.env.MANIFEST_EMIT_RESOLVED_TARGET;
  });

  // Contexto COM alvo resolvido — presente nos dois casos (OFF e ON). É o que
  // prova que só o gate liga o carimbo: OFF ignora, ON consome.
  const ctxWithTarget = {
    manifestProjectId: "1",
    analysisRunId: 99,
    repo: REPO,
    ref: REF,
    sourceFileByRoute: { [ROUTE_ID]: SOURCE_FILE },
  };

  // Payload EXATO que o emitter produz hoje (golden do caminho OFF). Se o shape
  // do caminho OFF mudar, este deepEqual quebra — é o guarda do byte-a-byte.
  function goldenOff() {
    return {
      sessionId: "sess-1",
      projectId: "sentinel-uuid",
      source: "auto_manifest",
      type: "permission_drift",
      severity: "high",
      title: "Endpoint sem proteção",
      description: "POST /easynup/createContract.v1 não exige papel\n\nRecommendation: Adicione @PreAuthorize",
      subtype: "missing_protection",
      schemaVersion: "2.0.0",
      evidences: [
        {
          source: "auto_manifest",
          sourceRunId: "99",
          observation: "POST /easynup/createContract.v1 não exige papel",
          observedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      symbolRef: { kind: "route", identifier: ROUTE_ID },
      manifestProjectId: "1",
      manifestRunId: "99",
      organizationId: "org-uuid",
    };
  }

  for (const flag of [undefined, "", "0", "false", "no"]) {
    it(`G-OFF: flag=${JSON.stringify(flag)} ⇒ emissão byte-a-byte de hoje, mesmo com alvo no contexto`, async () => {
      if (flag === undefined) delete process.env.MANIFEST_EMIT_RESOLVED_TARGET;
      else process.env.MANIFEST_EMIT_RESOLVED_TARGET = flag;

      await emitSecurityFindings([routeFinding() as any], ctxWithTarget);

      assert.equal(ingested.length, 1);
      // Idêntico ao golden: sem repo/ref/codeContext.
      assert.deepEqual(ingested[0], goldenOff());
      assert.ok(!("repo" in ingested[0].symbolRef), "symbolRef.repo não deve aparecer com flag OFF");
      assert.ok(!("ref" in ingested[0].symbolRef), "symbolRef.ref não deve aparecer com flag OFF");
      assert.ok(!("codeContext" in ingested[0]), "codeContext não deve aparecer com flag OFF");
    });
  }

  for (const flag of ["1", "true", "on", "yes"]) {
    it(`G-ON: flag=${flag} ⇒ rota carrega repo+ref+sourceFiles`, async () => {
      process.env.MANIFEST_EMIT_RESOLVED_TARGET = flag;

      await emitSecurityFindings([routeFinding() as any], ctxWithTarget);

      assert.equal(ingested.length, 1);
      const p = ingested[0];
      assert.equal(p.symbolRef.kind, "route");
      assert.equal(p.symbolRef.identifier, ROUTE_ID);
      assert.equal(p.symbolRef.repo, REPO, "symbolRef.repo deve ser owner/name");
      assert.equal(p.symbolRef.ref, REF, "symbolRef.ref deve ser o gitSha");
      assert.deepEqual(
        p.codeContext,
        { endpoints: [{ sourceFiles: [SOURCE_FILE] }] },
        "codeContext.endpoints[].sourceFiles deve trazer o arquivo do handler",
      );
    });
  }

  it("G-OFF byte-a-byte (string): OFF+alvo === emissão SEM contexto de alvo", async () => {
    delete process.env.MANIFEST_EMIT_RESOLVED_TARGET;
    await emitSecurityFindings([routeFinding() as any], ctxWithTarget);
    const offWithTarget = rawBody;
    rawBody = "";
    await emitSecurityFindings([routeFinding() as any], { manifestProjectId: "1", analysisRunId: 99 });
    const plain = rawBody;
    assert.equal(offWithTarget, plain, "OFF com alvo no contexto deve ser string-idêntico à emissão sem alvo");
  });

  it("G-ON fail-closed: sem repo resolvido e sem arquivo no mapa ⇒ nada é carimbado", async () => {
    process.env.MANIFEST_EMIT_RESOLVED_TARGET = "1";
    await emitSecurityFindings([routeFinding() as any], {
      manifestProjectId: "1",
      analysisRunId: 99,
      // sem repo, sem ref, sem sourceFileByRoute
    });
    assert.equal(ingested.length, 1);
    assert.ok(!("repo" in ingested[0].symbolRef), "sem repo resolvido ⇒ sem symbolRef.repo");
    assert.ok(!("codeContext" in ingested[0]), "sem arquivo no mapa ⇒ sem codeContext");
  });

  it("G-ON sem arquivo do handler: carimba repo+ref mas NÃO inventa codeContext", async () => {
    process.env.MANIFEST_EMIT_RESOLVED_TARGET = "1";
    await emitSecurityFindings([routeFinding() as any], {
      manifestProjectId: "1",
      analysisRunId: 99,
      repo: REPO,
      ref: REF,
      sourceFileByRoute: {}, // rota não resolveu arquivo
    });
    const p = ingested[0];
    assert.equal(p.symbolRef.repo, REPO);
    assert.equal(p.symbolRef.ref, REF);
    assert.ok(!("codeContext" in p), "sem sourceFile ⇒ sem codeContext (não inventa nome de classe)");
  });
});

describe("resolveRepoSlug — precedência e fail-closed", () => {
  it("1º: optRepo explícito vence", () => {
    assert.equal(
      resolveRepoSlug({ optRepo: "nuptechs/easynup", gitRepoUrl: "https://github.com/x/y", projectName: "z-cron" }),
      "nuptechs/easynup",
    );
  });
  it("2º: gitRepoUrl (URL https) quando não há optRepo", () => {
    assert.equal(
      resolveRepoSlug({ gitRepoUrl: "https://github.com/nuptechs/identify.git", projectName: "outro-cron" }),
      "nuptechs/identify",
    );
  });
  it("3º: deriva de <name>-cron + owner default", () => {
    assert.equal(
      resolveRepoSlug({ projectName: "easynup-cron", defaultOwner: "nuptechs" }),
      "nuptechs/easynup",
    );
  });
  it("owner default via env MANIFEST_DEFAULT_REPO_OWNER", () => {
    process.env.MANIFEST_DEFAULT_REPO_OWNER = "acme";
    try {
      assert.equal(resolveRepoSlug({ projectName: "svc-cron" }), "acme/svc");
    } finally {
      delete process.env.MANIFEST_DEFAULT_REPO_OWNER;
    }
  });
  it("fail-closed: nada resolve ⇒ undefined", () => {
    assert.equal(resolveRepoSlug({ projectName: "", defaultOwner: "" }), undefined);
  });
  it("git@ SCP form parseia", () => {
    assert.equal(
      resolveRepoSlug({ gitRepoUrl: "git@github.com:nuptechs/easynup.git", projectName: "x-cron" }),
      "nuptechs/easynup",
    );
  });
  it("fail-closed: nome SEM -cron NÃO vira repo (headless/sample/ad-hoc)", () => {
    assert.equal(resolveRepoSlug({ projectName: "headless-1732000000000" }), undefined);
    assert.equal(resolveRepoSlug({ projectName: "Customer Portal (Sample)" }), undefined);
    assert.equal(resolveRepoSlug({ projectName: "easynup" }), undefined, "sem sufixo -cron não deriva");
  });
  it("fail-closed: caracteres inválidos no slug derivado ⇒ undefined", () => {
    assert.equal(resolveRepoSlug({ projectName: "Customer Portal (x)-cron" }), undefined);
  });
});

describe("buildRouteSourceFileMap — união backend + descarte de colisão", () => {
  it("endpointImpacts (CONTROLLER) viram chave MÉTODO endpoint → sourceFile", () => {
    const map = buildRouteSourceFileMap({
      endpointImpacts: [{ httpMethod: "post", endpoint: "/x", sourceFile: "a/B.java" }],
    });
    assert.equal(map["POST /x"], "a/B.java");
  });
  it("rotas Express entram (inquilino Node), união com impacts", () => {
    const map = buildRouteSourceFileMap({
      endpointImpacts: [{ httpMethod: "GET", endpoint: "/j", sourceFile: "J.java" }],
      expressRoutes: [{ method: "delete", path: "/e", sourceFile: "server/routes/e.ts" }],
    });
    assert.equal(map["GET /j"], "J.java");
    assert.equal(map["DELETE /e"], "server/routes/e.ts");
  });
  it("colisão (mesma rota, arquivos diferentes) é DESCARTADA (não aponta errado)", () => {
    const map = buildRouteSourceFileMap({
      expressRoutes: [
        { method: "DELETE", path: "/", sourceFile: "a.ts" },
        { method: "DELETE", path: "/", sourceFile: "b.ts" },
      ],
    });
    assert.ok(!("DELETE /" in map), "rota ambígua não deve carimbar arquivo");
  });
  it("mesma rota, MESMO arquivo ⇒ mantém (não é colisão)", () => {
    const map = buildRouteSourceFileMap({
      expressRoutes: [
        { method: "GET", path: "/dup", sourceFile: "x.ts" },
        { method: "GET", path: "/dup", sourceFile: "x.ts" },
      ],
    });
    assert.equal(map["GET /dup"], "x.ts");
  });
});

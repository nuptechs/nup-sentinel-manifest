// ─────────────────────────────────────────────
// frontend-backend-consistency — unit tests
//
// The detector turns the FrontendInteraction[] that analyzeFrontend already
// produces into `inconsistency` findings: an internal HTTP call with a URL but
// NO resolved backend node (mappedBackendNode == null) = a screen calling an
// endpoint the backend does not expose (a runtime 404).
//
// The three golden fixtures reproduce the real EasyNuP bugs found by hand:
//   - Users screen → POST updateUser.v1 (backend has only create/delete/find)
//   - Permissions screen → POST createPermission.v1 (backend has none)
//   - SLA Categories screen → POST createSlaCategory.v1 (only findSlaCategories)
// All three MUST be flagged; consistent calls and external/UI interactions
// MUST NOT.
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectFrontendBackendInconsistencies,
  type ConsistencyFinding,
} from "../../server/analyzers/frontend-backend-consistency.ts";
import type { FrontendInteraction } from "../../server/analyzers/frontend-analyzer.ts";

// Build a FrontendInteraction with sane defaults; override what the test needs.
// The detector only reads a handful of fields, so we fill the rest minimally.
function mk(over: Partial<FrontendInteraction>): FrontendInteraction {
  return {
    component: "SomeScreen",
    elementType: "button",
    actionName: "submit",
    httpMethod: "POST",
    url: null,
    mappedBackendNode: null,
    sourceFile: "src/pages/SomeScreen.vue",
    lineNumber: 10,
    resolutionTier: null,
    resolutionStrategy: null,
    resolutionPath: null,
    interactionCategory: "HTTP",
    confidence: 0.9,
    ...over,
  } as FrontendInteraction;
}

// A resolved backend node (only presence matters to the detector).
const FAKE_BACKEND_NODE = { id: "n1", className: "FooWsV1", methodName: "handle" } as any;

describe("detectFrontendBackendInconsistencies — golden (3 bugs reais do EasyNuP)", () => {
  it("flagra os 3: updateUser, createPermission, createSlaCategory", () => {
    const interactions = [
      mk({ component: "Users", httpMethod: "POST", url: "/easynup/updateUser.v1", sourceFile: "src/pages/Users.vue", lineNumber: 12 }),
      mk({ component: "Permissions", httpMethod: "POST", url: "/easynup/createPermission.v1", sourceFile: "src/pages/Permissions.vue", lineNumber: 8 }),
      mk({ component: "SlaCategories", httpMethod: "POST", url: "/easynup/createSlaCategory.v1", sourceFile: "src/pages/SlaCategories.vue", lineNumber: 20 }),
    ];
    const findings = detectFrontendBackendInconsistencies(interactions);
    assert.equal(findings.length, 3);
    const urls = findings.map((f) => f.url).sort();
    assert.deepEqual(urls, [
      "/easynup/createPermission.v1",
      "/easynup/createSlaCategory.v1",
      "/easynup/updateUser.v1",
    ]);
    // Escrita órfã → severity high
    assert.ok(findings.every((f) => f.severity === "high"));
    assert.ok(findings.every((f) => f.subtype === "missing_backend_endpoint"));
  });
});

describe("detectFrontendBackendInconsistencies — não-regressão", () => {
  it("NÃO flagra chamada que resolveu pro backend", () => {
    const interactions = [
      mk({ url: "/easynup/findUsers.v1", httpMethod: "GET", mappedBackendNode: FAKE_BACKEND_NODE }),
    ];
    assert.equal(detectFrontendBackendInconsistencies(interactions).length, 0);
  });

  it("NÃO flagra serviço externo / UI_ONLY / STATE_ONLY (têm url mas não são backend interno)", () => {
    const interactions = [
      mk({ interactionCategory: "EXTERNAL_SERVICE", url: "https://viacep.com.br/ws/01001000/json" }),
      mk({ interactionCategory: "UI_ONLY", url: "/easynup/whatever.v1" }),
      mk({ interactionCategory: "STATE_ONLY", url: "/easynup/whatever2.v1" }),
      mk({ interactionCategory: "SERVICE_BRIDGE", url: "/easynup/bridge.v1" }),
    ];
    assert.equal(detectFrontendBackendInconsistencies(interactions).length, 0);
  });

  it("NÃO flagra interação HTTP sem url", () => {
    assert.equal(detectFrontendBackendInconsistencies([mk({ url: null })]).length, 0);
  });

  it("ignora confiança abaixo do limiar (default 0.5)", () => {
    const low = [mk({ url: "/easynup/maybe.v1", confidence: 0.3 })];
    assert.equal(detectFrontendBackendInconsistencies(low).length, 0);
    // mas conta acima do limiar
    const high = [mk({ url: "/easynup/maybe.v1", confidence: 0.6 })];
    assert.equal(detectFrontendBackendInconsistencies(high).length, 1);
  });

  it("GET ausente é medium; escrita ausente é high", () => {
    const findings = detectFrontendBackendInconsistencies([
      mk({ url: "/easynup/findThing.v1", httpMethod: "GET" }),
      mk({ url: "/easynup/deleteThing.v1", httpMethod: "DELETE" }),
    ]);
    const byUrl = Object.fromEntries(findings.map((f) => [f.url, f.severity]));
    assert.equal(byUrl["/easynup/findThing.v1"], "medium");
    assert.equal(byUrl["/easynup/deleteThing.v1"], "high");
  });

  it("dedup: o mesmo (método,url) chamado por N componentes vira 1 finding", () => {
    const interactions = [
      mk({ component: "A", url: "/easynup/updateUser.v1", httpMethod: "POST" }),
      mk({ component: "B", url: "/easynup/updateUser.v1", httpMethod: "POST" }),
    ];
    assert.equal(detectFrontendBackendInconsistencies(interactions).length, 1);
  });

  it("entrada vazia/nula → []", () => {
    assert.deepEqual(detectFrontendBackendInconsistencies([]), [] as ConsistencyFinding[]);
    assert.deepEqual(detectFrontendBackendInconsistencies(undefined as any), [] as ConsistencyFinding[]);
  });
});

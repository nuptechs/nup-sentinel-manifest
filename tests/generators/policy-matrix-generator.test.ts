// ─────────────────────────────────────────────
// policy-matrix-generator — unit tests
//
// Generates 4 IAM-style outputs from a Manifest:
//   - universalMatrix (Resource/Action/Roles/Effect tabular)
//   - Keycloak policy bundle (resources, policies, permissions, scopes)
//   - Okta policy bundle (apps, groups, policies)
//   - AWS IAM policies (one document per role)
//
// Tests pin contract shape + sort + role aggregation. Customers import
// these JSON blobs into their IAM platforms; drift here breaks
// production policy.
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generatePolicyMatrix } from "../../server/generators/policy-matrix-generator.ts";
import { generateManifest } from "../../server/generators/manifest-generator.ts";
import { makeEntry, makeProject } from "../helpers/fixtures.ts";

function matrixFrom(entries: ReturnType<typeof makeEntry>[]) {
  return generatePolicyMatrix(generateManifest(makeProject({ name: "p1" }), entries));
}

describe("generatePolicyMatrix — top-level shape", () => {
  it("emits all 4 IAM blocks even for an empty manifest", () => {
    const r = matrixFrom([]);
    assert.ok(r.universalMatrix);
    assert.ok(r.keycloak);
    assert.ok(r.okta);
    assert.ok(r.awsIam);
    assert.equal(r.universalMatrix.length, 0);
    assert.equal(r.project, "p1");
  });

  it("generatedAt is ISO 8601", () => {
    const r = matrixFrom([]);
    assert.match(r.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe("generatePolicyMatrix — universalMatrix", () => {
  it("one entry per (method, path) endpoint", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET" }),
      makeEntry({ id: 2, endpoint: "/api/y", httpMethod: "POST" }),
    ]);
    assert.equal(r.universalMatrix.length, 2);
  });

  it("sorts by criticalityScore DESC (highest first)", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/low", httpMethod: "GET", criticalityScore: 10 }),
      makeEntry({ id: 2, endpoint: "/api/high", httpMethod: "GET", criticalityScore: 90 }),
      makeEntry({ id: 3, endpoint: "/api/med", httpMethod: "GET", criticalityScore: 50 }),
    ]);
    const scores = r.universalMatrix.map((e) => e.criticalityScore);
    assert.deepEqual(scores, [90, 50, 10]);
  });

  it("falls back to AUTHENTICATED role when endpoint has no requiredRoles", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET" }),
    ]);
    assert.deepEqual(r.universalMatrix[0].roles, ["AUTHENTICATED"]);
  });

  it("preserves explicit roles when present", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", requiredRoles: ["ADMIN", "AUDITOR"] }),
    ]);
    assert.deepEqual(r.universalMatrix[0].roles.sort(), ["ADMIN", "AUDITOR"]);
  });

  it("marks sensitiveData=true when any sensitive field is touched", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", sensitiveFieldsAccessed: ["password"] }),
      makeEntry({ id: 2, endpoint: "/api/y", httpMethod: "GET" }),
    ]);
    const x = r.universalMatrix.find((e) => e.resource === "/api/x")!;
    const y = r.universalMatrix.find((e) => e.resource === "/api/y")!;
    assert.equal(x.sensitiveData, true);
    assert.equal(y.sensitiveData, false);
  });

  it("encodes action as METHOD:operation", () => {
    const r = matrixFrom([
      makeEntry({
        id: 1,
        endpoint: "/api/x",
        httpMethod: "POST",
        technicalOperation: "CREATE_USER",
      }),
    ]);
    assert.equal(r.universalMatrix[0].action, "POST:CREATE_USER");
  });
});

describe("generatePolicyMatrix — Keycloak bundle", () => {
  it("emits one policy per unique role inside clients[0].authorizationSettings.policies", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/a", httpMethod: "GET", requiredRoles: ["ADMIN"] }),
      makeEntry({ id: 2, endpoint: "/api/b", httpMethod: "GET", requiredRoles: ["ADMIN"] }),
      makeEntry({ id: 3, endpoint: "/api/c", httpMethod: "GET", requiredRoles: ["AUDITOR"] }),
    ]);
    const auth = r.keycloak.clients[0].authorizationSettings;
    const policyNames = auth.policies.map((p: any) => p.name).sort();
    assert.deepEqual(policyNames, ["policy-admin", "policy-auditor"]);
  });

  it("each Keycloak permission links to the matching resource", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", requiredRoles: ["ADMIN"] }),
    ]);
    const auth = r.keycloak.clients[0].authorizationSettings;
    const perm = auth.permissions[0];
    assert.deepEqual(perm.resources, ["res:/api/x"]);
  });

  it("Keycloak realm slug is derived from project name (lowercase + dash)", () => {
    const r = matrixFrom([
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET" }),
    ]);
    assert.equal(r.keycloak.realm, "p1");
  });
});

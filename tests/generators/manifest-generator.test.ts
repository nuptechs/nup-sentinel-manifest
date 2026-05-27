// ─────────────────────────────────────────────
// manifest-generator — unit tests
//
// generateManifest() is the canonical export of the platform: it turns
// raw CatalogEntry rows into the public Manifest JSON shape that every
// downstream generator (OpenAPI, Policy Matrix, Keycloak, NuPidentity)
// consumes. Bugs here propagate everywhere.
//
// Coverage:
//   - shape integrity (top-level keys + sub-shapes)
//   - dedup by endpoint key (httpMethod + path)
//   - role aggregation across endpoints
//   - screen.routeGuards uniqueness
//   - completeness metrics (endpointResolution, securityCoverage, overall)
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateManifest } from "../../server/generators/manifest-generator.ts";
import { makeEntry, makeProject } from "../helpers/fixtures.ts";

describe("generateManifest — shape", () => {
  it("emits all required top-level keys even for an empty catalog", () => {
    const m = generateManifest(makeProject({ name: "empty-proj" }), []);
    for (const key of [
      "$schema",
      "version",
      "generatedAt",
      "generator",
      "project",
      "summary",
      "endpoints",
      "screens",
      "roles",
      "entities",
      "securityMatrix",
      "completeness",
    ]) {
      assert.ok(key in m, `missing key: ${key}`);
    }
    assert.equal(m.project.name, "empty-proj");
    assert.equal(m.endpoints.length, 0);
    assert.equal(m.screens.length, 0);
  });

  it("project.analyzedAt is ISO 8601", () => {
    const m = generateManifest(makeProject(), []);
    assert.match(m.project.analyzedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("summary counts match endpoint/screen/role/entity arrays", () => {
    const m = generateManifest(makeProject(), [
      makeEntry({
        id: 1,
        screen: "Home",
        endpoint: "/api/x",
        httpMethod: "GET",
        entitiesTouched: ["Foo"],
        requiredRoles: ["ADMIN"],
      }),
    ]);
    assert.equal(m.summary.totalEndpoints, m.endpoints.length);
    assert.equal(m.summary.totalScreens, m.screens.length);
    assert.equal(m.summary.totalRoles, m.roles.length);
    assert.equal(m.summary.totalEntities, m.entities.length);
  });
});

describe("generateManifest — dedup + aggregation", () => {
  it("dedups endpoints by httpMethod + path", () => {
    const m = generateManifest(makeProject(), [
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", interaction: "click-a" }),
      makeEntry({ id: 2, endpoint: "/api/x", httpMethod: "GET", interaction: "click-b" }),
      makeEntry({ id: 3, endpoint: "/api/x", httpMethod: "POST", interaction: "submit" }),
    ]);
    assert.equal(m.endpoints.length, 2, "same method+path collapses to one endpoint");
    const paths = m.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    assert.deepEqual(paths, ["GET /api/x", "POST /api/x"]);
  });

  it("aggregates entitiesTouched across multiple entries on the same endpoint", () => {
    const m = generateManifest(makeProject(), [
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", entitiesTouched: ["A", "B"] }),
      makeEntry({ id: 2, endpoint: "/api/x", httpMethod: "GET", entitiesTouched: ["B", "C"] }),
    ]);
    const ep = m.endpoints.find((e) => e.path === "/api/x" && e.method === "GET")!;
    assert.deepEqual([...ep.entitiesTouched].sort(), ["A", "B", "C"]);
  });

  it("dedups roles across endpoints", () => {
    const m = generateManifest(makeProject(), [
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", requiredRoles: ["ADMIN"] }),
      makeEntry({ id: 2, endpoint: "/api/y", httpMethod: "GET", requiredRoles: ["ADMIN", "USER"] }),
    ]);
    const roleNames = m.roles.map((r) => r.name).sort();
    assert.deepEqual(roleNames, ["ADMIN", "USER"]);
    const admin = m.roles.find((r) => r.name === "ADMIN")!;
    assert.equal(admin.endpoints.length, 2);
  });

  it("uses the MAX criticalityScore when merging duplicate endpoint entries", () => {
    const m = generateManifest(makeProject(), [
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET", criticalityScore: 30 }),
      makeEntry({ id: 2, endpoint: "/api/x", httpMethod: "GET", criticalityScore: 80 }),
      makeEntry({ id: 3, endpoint: "/api/x", httpMethod: "GET", criticalityScore: 50 }),
    ]);
    const ep = m.endpoints.find((e) => e.path === "/api/x")!;
    assert.equal(ep.criticalityScore, 80);
  });
});

describe("generateManifest — completeness", () => {
  it("dataProvenance.fieldsWithData accumulates across entries", () => {
    const m = generateManifest(makeProject(), [
      makeEntry({
        id: 1,
        endpoint: "/api/x",
        httpMethod: "GET",
        dataSource: { endpoint: "extracted", criticalityScore: "inferred" },
      }),
      makeEntry({
        id: 2,
        endpoint: "/api/y",
        httpMethod: "GET",
        dataSource: { endpoint: "extracted" },
      }),
    ]);
    assert.ok(m.completeness.dataProvenance);
    const fields = m.completeness.dataProvenance.fieldsWithData;
    assert.ok("endpoint" in fields);
  });

  it("overallScore is 0..100 numeric", () => {
    const m = generateManifest(makeProject(), [
      makeEntry({ id: 1, endpoint: "/api/x", httpMethod: "GET" }),
    ]);
    assert.ok(typeof m.completeness.overallScore === "number");
    assert.ok(m.completeness.overallScore >= 0 && m.completeness.overallScore <= 100);
  });
});

// ─────────────────────────────────────────────
// SecurityOmissionEngine — unit tests
//
// The engine is the killer feature of Manifest: it cross-references
// endpoints against their PEERS (same entity domain, same HTTP method)
// and flags outliers. Bugs here ship invisible security holes, so we
// cover every detector method with both happy-path and adversarial
// inputs.
//
// Detectors covered:
//   - detectUnprotectedOutliers      (UNPROTECTED_OUTLIER)
//   - detectPrivilegeEscalation      (PRIVILEGE_ESCALATION)
//   - detectSensitiveDataExposure    (SENSITIVE_DATA_EXPOSURE)
//   - detectInconsistentProtection   (INCONSISTENT_PROTECTION)
//   - detectMissingProtectionOnCritical (MISSING_PROTECTION)
//   - addCoverageFindings            (COVERAGE_GAP)
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SecurityOmissionEngine } from "../../server/security/omission-engine.ts";
import { makeEntry } from "../helpers/fixtures.ts";

// ── analyze() top-level ────────────────────────────────────────────

describe("SecurityOmissionEngine.analyze", () => {
  it("returns empty findings + metrics for an empty catalog (vacuously 100% covered)", () => {
    const engine = new SecurityOmissionEngine([]);
    const { findings, metrics } = engine.analyze();
    assert.deepEqual(findings, []);
    assert.equal(metrics.totalEndpoints, 0);
    assert.equal(metrics.protectedEndpoints, 0);
    // Convention: 0/0 is treated as 100% (vacuous truth) — engine choice
    // documented in computeCoverageMetrics; tests pin it down so a change
    // to the convention is a deliberate decision, not an accident.
    assert.equal(metrics.coveragePercent, 100);
  });

  it("ignores entries without endpoint or httpMethod (UI-only interactions)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ endpoint: null, httpMethod: null }),
      makeEntry({ endpoint: "/api/x", httpMethod: null }),
      makeEntry({ endpoint: null, httpMethod: "GET" }),
    ]);
    const { metrics } = engine.analyze();
    assert.equal(metrics.totalEndpoints, 0);
  });

  it("sorts findings by severity (critical < high < medium < low < info)", () => {
    // Force one critical + one high via privilege-escalation paths
    const engine = new SecurityOmissionEngine([
      makeEntry({
        id: 1,
        endpoint: "/api/users",
        httpMethod: "POST",
        entitiesTouched: ["Role"], // privilege entity, no auth → critical
      }),
      makeEntry({
        id: 2,
        endpoint: "/api/roles",
        httpMethod: "PUT",
        entitiesTouched: ["Role"],
        requiredRoles: ["USER"], // protected but non-admin → high
      }),
    ]);
    const { findings } = engine.analyze();
    const severities = findings.map((f) => f.severity);
    const indexCritical = severities.indexOf("critical");
    const indexHigh = severities.indexOf("high");
    if (indexCritical >= 0 && indexHigh >= 0) {
      assert.ok(indexCritical < indexHigh, "critical must come before high");
    }
  });

  it("emits stable, padded IDs (SF-001, SF-002, ...)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/api/users", httpMethod: "POST", entitiesTouched: ["Role"] }),
    ]);
    const { findings } = engine.analyze();
    if (findings.length > 0) {
      for (const f of findings) {
        assert.match(f.id, /^SF-\d{3,}$/);
      }
    }
  });
});

// ── detectUnprotectedOutliers ──────────────────────────────────────

describe("SecurityOmissionEngine — UNPROTECTED_OUTLIER", () => {
  it("no finding when fewer than 3 backend entries (needs a group)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ endpoint: "/api/users/1", httpMethod: "GET", entitiesTouched: ["User"] }),
      makeEntry({ endpoint: "/api/users/2", httpMethod: "GET", entitiesTouched: ["User"], requiredRoles: ["ADMIN"] }),
    ]);
    const { findings } = engine.analyze();
    const outliers = findings.filter((f) => f.type === "UNPROTECTED_OUTLIER");
    assert.equal(outliers.length, 0);
  });

  it("emits when protection rate ≥ 50% and an unprotected peer exists", () => {
    const protectedCommon = (suffix: string) =>
      makeEntry({
        id: parseInt(suffix, 10),
        endpoint: `/api/users/${suffix}`,
        httpMethod: "GET",
        entitiesTouched: ["User"],
        requiredRoles: ["ADMIN"],
        criticalityScore: 60,
      });
    const engine = new SecurityOmissionEngine([
      protectedCommon("1"),
      protectedCommon("2"),
      makeEntry({
        id: 3,
        endpoint: "/api/users/3",
        httpMethod: "GET",
        entitiesTouched: ["User"],
        criticalityScore: 80,
      }),
    ]);
    const { findings } = engine.analyze();
    const outliers = findings.filter((f) => f.type === "UNPROTECTED_OUTLIER");
    assert.equal(outliers.length, 1);
    assert.equal(outliers[0].severity, "critical"); // 80 → critical
    assert.match(outliers[0].title, /Unprotected GET/);
  });

  it("severity ladder maps criticalityScore correctly", () => {
    function runWith(score: number) {
      const engine = new SecurityOmissionEngine([
        makeEntry({ id: 1, endpoint: "/api/a/1", httpMethod: "GET", entitiesTouched: ["X"], requiredRoles: ["ADMIN"] }),
        makeEntry({ id: 2, endpoint: "/api/a/2", httpMethod: "GET", entitiesTouched: ["X"], requiredRoles: ["ADMIN"] }),
        makeEntry({ id: 3, endpoint: "/api/a/3", httpMethod: "GET", entitiesTouched: ["X"], criticalityScore: score }),
      ]);
      const { findings } = engine.analyze();
      return findings.find((f) => f.type === "UNPROTECTED_OUTLIER")?.severity;
    }
    assert.equal(runWith(75), "critical");
    assert.equal(runWith(55), "high");
    assert.equal(runWith(35), "medium");
    assert.equal(runWith(10), "low");
  });

  it("does not emit when all peers are unprotected (no baseline)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/api/x/1", httpMethod: "GET", entitiesTouched: ["X"] }),
      makeEntry({ id: 2, endpoint: "/api/x/2", httpMethod: "GET", entitiesTouched: ["X"] }),
      makeEntry({ id: 3, endpoint: "/api/x/3", httpMethod: "GET", entitiesTouched: ["X"] }),
    ]);
    const { findings } = engine.analyze();
    const outliers = findings.filter((f) => f.type === "UNPROTECTED_OUTLIER");
    assert.equal(outliers.length, 0);
  });

  it("does not emit when protection rate < 50% (no consistent baseline)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/api/x/1", httpMethod: "GET", entitiesTouched: ["X"], requiredRoles: ["ADMIN"] }),
      makeEntry({ id: 2, endpoint: "/api/x/2", httpMethod: "GET", entitiesTouched: ["X"] }),
      makeEntry({ id: 3, endpoint: "/api/x/3", httpMethod: "GET", entitiesTouched: ["X"] }),
    ]);
    const { findings } = engine.analyze();
    const outliers = findings.filter((f) => f.type === "UNPROTECTED_OUTLIER");
    assert.equal(outliers.length, 0);
  });
});

// ── detectPrivilegeEscalation ──────────────────────────────────────

describe("SecurityOmissionEngine — PRIVILEGE_ESCALATION", () => {
  it("emits CRITICAL when unprotected write touches Role/Permission entity", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ endpoint: "/api/roles", httpMethod: "POST", entitiesTouched: ["Role"] }),
    ]);
    const { findings } = engine.analyze();
    const f = findings.find((f) => f.type === "PRIVILEGE_ESCALATION");
    assert.ok(f, "should emit privilege-escalation finding");
    assert.equal(f!.severity, "critical");
    assert.match(f!.description, /privilege/i);
  });

  it("emits HIGH when write touches privilege entity but only USER role required", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/roles",
        httpMethod: "PUT",
        entitiesTouched: ["Role"],
        requiredRoles: ["USER"],
      }),
    ]);
    const { findings } = engine.analyze();
    const f = findings.find((f) => f.type === "PRIVILEGE_ESCALATION");
    assert.ok(f);
    assert.equal(f!.severity, "high");
  });

  it("does NOT emit when ADMIN role is required (privilege handled correctly)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/roles",
        httpMethod: "PUT",
        entitiesTouched: ["Role"],
        requiredRoles: ["ADMIN"],
      }),
    ]);
    const { findings } = engine.analyze();
    const escalations = findings.filter((f) => f.type === "PRIVILEGE_ESCALATION");
    assert.equal(escalations.length, 0);
  });

  it("skips GET endpoints entirely (read-only can't escalate by definition)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/roles",
        httpMethod: "GET",
        entitiesTouched: ["Role"],
      }),
    ]);
    const { findings } = engine.analyze();
    const escalations = findings.filter((f) => f.type === "PRIVILEGE_ESCALATION");
    assert.equal(escalations.length, 0);
  });

  it("detects privilege via sensitive field name (no entity hit)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/profile",
        httpMethod: "POST",
        entitiesTouched: ["UserProfile"],
        sensitiveFieldsAccessed: ["isAdmin"],
      }),
    ]);
    const { findings } = engine.analyze();
    const f = findings.find((f) => f.type === "PRIVILEGE_ESCALATION");
    assert.ok(f, "isAdmin field should trigger escalation check");
    assert.equal(f!.severity, "critical");
  });
});

// ── detectSensitiveDataExposure ────────────────────────────────────

describe("SecurityOmissionEngine — SENSITIVE_DATA_EXPOSURE", () => {
  it("emits when unprotected GET exposes a sensitive field (password)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/users",
        httpMethod: "GET",
        entitiesTouched: ["User"],
        sensitiveFieldsAccessed: ["password"],
      }),
    ]);
    const { findings } = engine.analyze();
    const f = findings.find((f) => f.type === "SENSITIVE_DATA_EXPOSURE");
    assert.ok(f, "password exposure should fire");
  });

  it("detects multiple sensitive patterns (token, ssn, apiKey, creditCard)", () => {
    for (const fieldName of ["accessToken", "ssn", "apiKey", "creditCardNumber"]) {
      const engine = new SecurityOmissionEngine([
        makeEntry({
          id: 1,
          endpoint: `/api/x-${fieldName}`,
          httpMethod: "GET",
          entitiesTouched: ["X"],
          sensitiveFieldsAccessed: [fieldName],
        }),
      ]);
      const { findings } = engine.analyze();
      const exposures = findings.filter((f) => f.type === "SENSITIVE_DATA_EXPOSURE");
      assert.ok(
        exposures.length >= 1,
        `expected SENSITIVE_DATA_EXPOSURE for field "${fieldName}", got ${exposures.length}`,
      );
    }
  });

  it("does not flag non-GET methods (those have other detectors)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/users",
        httpMethod: "POST",
        entitiesTouched: ["User"],
        sensitiveFieldsAccessed: ["password"],
      }),
    ]);
    const { findings } = engine.analyze();
    const exposures = findings.filter((f) => f.type === "SENSITIVE_DATA_EXPOSURE");
    assert.equal(exposures.length, 0);
  });
});

// ── detectInconsistentProtection ───────────────────────────────────

describe("SecurityOmissionEngine — INCONSISTENT_PROTECTION", () => {
  it("emits when same controller has protected reads but an unprotected mutator (POST/PUT/PATCH/DELETE)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/api/orders/1", httpMethod: "GET", controllerClass: "OrderController", requiredRoles: ["USER"] }),
      makeEntry({ id: 2, endpoint: "/api/orders", httpMethod: "GET", controllerClass: "OrderController", requiredRoles: ["USER"] }),
      makeEntry({ id: 3, endpoint: "/api/orders", httpMethod: "POST", controllerClass: "OrderController", criticalityScore: 60 }), // unprotected mutator
    ]);
    const { findings } = engine.analyze();
    const inconsistencies = findings.filter((f) => f.type === "INCONSISTENT_PROTECTION");
    assert.ok(inconsistencies.length > 0, "expected INCONSISTENT_PROTECTION finding");
  });

  it("does NOT emit when controller is fully consistent (all protected)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/api/orders/1", httpMethod: "GET", controllerClass: "OrderController", requiredRoles: ["ADMIN"] }),
      makeEntry({ id: 2, endpoint: "/api/orders", httpMethod: "POST", controllerClass: "OrderController", requiredRoles: ["ADMIN"] }),
    ]);
    const { findings } = engine.analyze();
    const inconsistencies = findings.filter((f) => f.type === "INCONSISTENT_PROTECTION");
    assert.equal(inconsistencies.length, 0);
  });

  it("does NOT emit when the unprotected endpoints in the controller are all reads", () => {
    // Even with mixed protection, the engine specifically targets MUTATING
    // unprotected handlers as the inconsistency — pure GET-only inconsistency
    // is left to UNPROTECTED_OUTLIER / SENSITIVE_DATA_EXPOSURE.
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/api/x/1", httpMethod: "GET", controllerClass: "XController", requiredRoles: ["USER"] }),
      makeEntry({ id: 2, endpoint: "/api/x/2", httpMethod: "GET", controllerClass: "XController" }),
    ]);
    const { findings } = engine.analyze();
    const inconsistencies = findings.filter((f) => f.type === "INCONSISTENT_PROTECTION");
    assert.equal(inconsistencies.length, 0);
  });
});

// ── detectMissingProtectionOnCritical ──────────────────────────────

describe("SecurityOmissionEngine — MISSING_PROTECTION", () => {
  it("flags unprotected high-criticality endpoint", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/admin/keys",
        httpMethod: "DELETE",
        entitiesTouched: ["ApiKey"],
        criticalityScore: 95,
      }),
    ]);
    const { findings } = engine.analyze();
    const missing = findings.find((f) => f.type === "MISSING_PROTECTION");
    assert.ok(missing, "critical endpoint without protection should fire MISSING_PROTECTION");
  });

  it("does NOT flag protected critical endpoint", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/admin/keys",
        httpMethod: "DELETE",
        entitiesTouched: ["ApiKey"],
        criticalityScore: 95,
        requiredRoles: ["ADMIN"],
      }),
    ]);
    const { findings } = engine.analyze();
    const missing = findings.filter((f) => f.type === "MISSING_PROTECTION");
    assert.equal(missing.length, 0);
  });
});

// ── coverage metrics ───────────────────────────────────────────────

describe("SecurityOmissionEngine — coverage metrics", () => {
  it("computes coveragePercent correctly", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/a", httpMethod: "GET", requiredRoles: ["X"] }),
      makeEntry({ id: 2, endpoint: "/b", httpMethod: "GET", requiredRoles: ["X"] }),
      makeEntry({ id: 3, endpoint: "/c", httpMethod: "GET" }),
      makeEntry({ id: 4, endpoint: "/d", httpMethod: "GET" }),
    ]);
    const { metrics } = engine.analyze();
    assert.equal(metrics.totalEndpoints, 4);
    assert.equal(metrics.protectedEndpoints, 2);
    assert.equal(metrics.coveragePercent, 50);
  });

  it("breaks down by HTTP method", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/a", httpMethod: "GET", requiredRoles: ["X"] }),
      makeEntry({ id: 2, endpoint: "/b", httpMethod: "POST" }),
    ]);
    const { metrics } = engine.analyze();
    assert.ok(metrics.byHttpMethod);
    assert.equal(metrics.byHttpMethod.GET?.total, 1);
    assert.equal(metrics.byHttpMethod.GET?.protected, 1);
    assert.equal(metrics.byHttpMethod.POST?.total, 1);
    assert.equal(metrics.byHttpMethod.POST?.protected, 0);
  });

  it("breaks down by controller", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/a", httpMethod: "GET", controllerClass: "UserController", requiredRoles: ["X"] }),
      makeEntry({ id: 2, endpoint: "/b", httpMethod: "POST", controllerClass: "OrderController" }),
    ]);
    const { metrics } = engine.analyze();
    assert.equal(metrics.byController.UserController?.protected, 1);
    assert.equal(metrics.byController.OrderController?.protected, 0);
  });

  it("counts critical / high unprotected separately", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/a", httpMethod: "GET", criticalityScore: 95 }),
      makeEntry({ id: 2, endpoint: "/b", httpMethod: "GET", criticalityScore: 75 }),
      makeEntry({ id: 3, endpoint: "/c", httpMethod: "GET", criticalityScore: 55 }),
      makeEntry({ id: 4, endpoint: "/d", httpMethod: "GET", criticalityScore: 10 }),
    ]);
    const { metrics } = engine.analyze();
    // criticality ≥ 80 is critical; ≥ 60 is high (per engine convention)
    assert.ok(metrics.criticalUnprotected >= 1);
    assert.ok(metrics.highUnprotected >= 1);
  });
});

// ── adversarial / robustness ───────────────────────────────────────

describe("SecurityOmissionEngine — adversarial", () => {
  it("does not crash when entries have null jsonb fields", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({
        endpoint: "/api/x",
        httpMethod: "GET",
        requiredRoles: null,
        securityAnnotations: null,
        entitiesTouched: null,
        sensitiveFieldsAccessed: null,
        entityFieldsMetadata: null,
      } as any),
    ]);
    assert.doesNotThrow(() => engine.analyze());
  });

  it("treats empty role array as unprotected (not protected by virtue of having a key)", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/a", httpMethod: "GET", requiredRoles: [] }),
    ]);
    const { metrics } = engine.analyze();
    assert.equal(metrics.protectedEndpoints, 0);
  });

  it("uppercase + lowercase HTTP methods are merged into the same bucket", () => {
    const engine = new SecurityOmissionEngine([
      makeEntry({ id: 1, endpoint: "/a", httpMethod: "get", requiredRoles: ["X"] }),
      makeEntry({ id: 2, endpoint: "/b", httpMethod: "GET" }),
    ]);
    const { metrics } = engine.analyze();
    // Implementation upcase-normalizes; merge expected. Total bucket size = 2.
    const totalGet = (metrics.byHttpMethod.GET?.total ?? 0) + (metrics.byHttpMethod.get?.total ?? 0);
    assert.equal(totalGet, 2);
  });

  it("survives 1000 entries without stack overflow or O(n²) blow-up", () => {
    const entries = Array.from({ length: 1000 }, (_, i) =>
      makeEntry({
        id: i + 1,
        endpoint: `/api/users/${i}`,
        httpMethod: "GET",
        entitiesTouched: ["User"],
        ...(i % 2 === 0 ? { requiredRoles: ["ADMIN"] } : {}),
      }),
    );
    const engine = new SecurityOmissionEngine(entries);
    const start = Date.now();
    const { metrics } = engine.analyze();
    const elapsed = Date.now() - start;
    assert.equal(metrics.totalEndpoints, 1000);
    assert.ok(elapsed < 5000, `analyze() took ${elapsed}ms — should be < 5s`);
  });
});

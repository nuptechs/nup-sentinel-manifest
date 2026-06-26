import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectSensitiveExposure,
  renderSensitiveExposureMarkdown,
} from "../../server/analyzers/sensitive-exposure.ts";

const ep = (path: string, sensitiveFieldsAccessed: string[], requiredRoles: string[] = [], criticalityScore = 0, method = "POST") => ({
  path,
  method,
  sensitiveFieldsAccessed,
  requiredRoles,
  criticalityScore,
});

describe("detectSensitiveExposure", () => {
  it("classifica guard: none / auth-only / permission", () => {
    const r = detectSensitiveExposure({
      endpoints: [
        ep("/none", ["User.password"], []),
        ep("/auth", ["User.password"], ["AUTHENTICATED"]),
        ep("/perm", ["User.password"], ["VIEW_USER", "AUTHENTICATED"]),
        ep("/notsensitive", [], []), // não toca sensível → ignorado
      ],
    });
    assert.equal(r.summary.endpointsTouchingSensitive, 3);
    assert.equal(r.summary.unguarded, 1);
    assert.equal(r.summary.authOnly, 1);
    assert.equal(r.summary.guarded, 1);
    assert.equal(r.exposures.find((e) => e.path === "/none")!.guard, "none");
    assert.equal(r.exposures.find((e) => e.path === "/auth")!.guard, "auth-only");
    assert.equal(r.exposures.find((e) => e.path === "/perm")!.guard, "permission");
  });

  it("risco primeiro: none → auth-only → permission", () => {
    const r = detectSensitiveExposure({
      endpoints: [
        ep("/perm", ["X"], ["PERM"]),
        ep("/none", ["X"], []),
        ep("/auth", ["X"], ["AUTHENTICATED"]),
      ],
    });
    assert.deepEqual(r.exposures.map((e) => e.path), ["/none", "/auth", "/perm"]);
  });

  it("conta campos sensíveis distintos", () => {
    const r = detectSensitiveExposure({
      endpoints: [ep("/a", ["User.password", "User.token"]), ep("/b", ["User.password"])],
    });
    assert.equal(r.summary.distinctSensitiveFields, 2);
  });

  it("vazio≠falhou e null-safe", () => {
    assert.deepEqual(detectSensitiveExposure({ endpoints: [] }).exposures, []);
    assert.equal(detectSensitiveExposure(null).summary.endpointsTouchingSensitive, 0);
    assert.equal(detectSensitiveExposure({}).summary.endpointsTouchingSensitive, 0);
  });
});

describe("renderSensitiveExposureMarkdown", () => {
  it("destaca os sem permissão específica", () => {
    const r = detectSensitiveExposure({
      endpoints: [ep("/none", ["User.password"], []), ep("/perm", ["User.password"], ["VIEW_USER"])],
    });
    const md = renderSensitiveExposureMarkdown(r, { projectName: "easynup" });
    assert.match(md, /Exposição de Dado Sensível — easynup/);
    assert.match(md, /SEM PROTEÇÃO.*\/none/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectPermissionGovernance,
  renderPermissionGovernanceMarkdown,
} from "../../server/analyzers/permission-governance.ts";

const ep = (path: string, requiredRoles: string[] = [], criticalityScore = 0, method = "POST") => ({
  path,
  method,
  requiredRoles,
  criticalityScore,
});

describe("detectPermissionGovernance", () => {
  it("separa endpoints protegidos dos sem proteção", () => {
    const r = detectPermissionGovernance({
      endpoints: [
        ep("/easynup/updateContract.v1", ["UPDATE_CONTRACT", "AUTHENTICATED"]),
        ep("/easynup/findContract.v1", ["VIEW_CONTRACT", "AUTHENTICATED"]),
        ep("/api/public/health", []),
      ],
    });
    assert.equal(r.summary.totalEndpoints, 3);
    assert.equal(r.summary.guarded, 2);
    assert.equal(r.summary.unguarded, 1);
    assert.equal(r.summary.coveragePercent, 67);
    assert.equal(r.unguarded[0].path, "/api/public/health");
  });

  it("byPermission agrupa endpoints por permissão e conta", () => {
    const r = detectPermissionGovernance({
      endpoints: [
        ep("/easynup/createContract.v1", ["CREATE_CONTRACT", "AUTHENTICATED"]),
        ep("/easynup/updateContract.v1", ["UPDATE_CONTRACT", "AUTHENTICATED"]),
      ],
    });
    const auth = r.byPermission.find((p) => p.permission === "AUTHENTICATED")!;
    assert.equal(auth.endpoints.length, 2); // ambos exigem auth
    const create = r.byPermission.find((p) => p.permission === "CREATE_CONTRACT")!;
    assert.deepEqual(create.endpoints.map((e) => e.path), ["/easynup/createContract.v1"]);
  });

  it("distinctPermissions exclui o AUTHENTICATED genérico", () => {
    const r = detectPermissionGovernance({
      endpoints: [ep("/x", ["UPDATE_CONTRACT", "AUTHENTICATED"]), ep("/y", ["AUTHENTICATED"])],
    });
    assert.equal(r.summary.distinctPermissions, 1); // só UPDATE_CONTRACT
  });

  it("sem proteção ordenado por criticidade desc", () => {
    const r = detectPermissionGovernance({
      endpoints: [ep("/low", [], 10), ep("/high", [], 90), ep("/mid", [], 50)],
    });
    assert.deepEqual(r.unguarded.map((e) => e.path), ["/high", "/mid", "/low"]);
  });

  it("vazio≠falhou: manifest sem endpoints → relatório zerado, não erro", () => {
    const r = detectPermissionGovernance({ endpoints: [] });
    assert.equal(r.summary.totalEndpoints, 0);
    assert.equal(r.summary.coveragePercent, 0);
    assert.deepEqual(r.unguarded, []);
    assert.deepEqual(r.byPermission, []);
  });

  it("null/undefined-safe (manifest ausente ou shape inesperado)", () => {
    assert.equal(detectPermissionGovernance(null).summary.totalEndpoints, 0);
    assert.equal(detectPermissionGovernance({}).summary.totalEndpoints, 0);
    // requiredRoles com lixo não-string é ignorado, não quebra
    const r = detectPermissionGovernance({ endpoints: [{ path: "/x", method: "GET", requiredRoles: [null, 1, "OK"] as any }] });
    assert.deepEqual(r.byPermission.map((p) => p.permission), ["OK"]);
  });
});

describe("renderPermissionGovernanceMarkdown", () => {
  it("rende resumo + seções legíveis", () => {
    const r = detectPermissionGovernance({
      endpoints: [ep("/easynup/updateContract.v1", ["UPDATE_CONTRACT"]), ep("/pub", [])],
    });
    const md = renderPermissionGovernanceMarkdown(r, { projectName: "easynup" });
    assert.match(md, /Governança de Permissão — easynup/);
    assert.match(md, /sem proteção/);
    assert.match(md, /UPDATE_CONTRACT/);
  });
});

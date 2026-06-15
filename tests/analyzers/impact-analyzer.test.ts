// ─────────────────────────────────────────────
// impact-analyzer — unit tests (ADR-070 Onda 2)
//
// Blast radius cross-stack sobre o manifest persistido: símbolo → endpoints →
// telas → entidades. Puro, determinístico, sem I/O.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeImpact } from "../../server/analyzers/impact-analyzer.ts";

const MANIFEST = {
  endpoints: [
    {
      path: "/api/contracts/{id}",
      method: "PUT",
      controller: "ContractController",
      controllerMethod: "update",
      serviceMethods: ["ContractService.update"],
      repositoryMethods: ["ContractRepository.save"],
      entitiesTouched: ["Contract", "AuditLog"],
      fullCallChain: ["ContractController.update", "ContractService.update", "ContractRepository.save"],
      sourceFile: "ContractController.java",
    },
    {
      path: "/api/users/{id}",
      method: "GET",
      controller: "UserController",
      controllerMethod: "get",
      serviceMethods: ["UserService.findById"],
      repositoryMethods: ["UserRepository.findById"],
      entitiesTouched: ["User"],
      fullCallChain: ["UserController.get", "UserService.findById"],
      sourceFile: "UserController.java",
    },
  ],
  screens: [
    {
      name: "ContractEdit",
      route: "/contracts/:id/edit",
      interactions: [{ name: "save", endpoint: "/api/contracts/{id}", httpMethod: "PUT" }],
    },
    {
      name: "UserList",
      route: "/users",
      interactions: [{ name: "load", endpoint: "/api/users/{id}", httpMethod: "GET" }],
    },
  ],
  entities: [
    { name: "Contract", accessedBy: [{ controller: "ContractController", method: "update", endpoint: "/api/contracts/{id}" }], sensitiveFields: [] },
    { name: "AuditLog", accessedBy: [{ controller: "ContractController", method: "update", endpoint: "/api/contracts/{id}" }], sensitiveFields: [] },
  ],
};

describe("computeImpact — símbolo de service", () => {
  it("ContractService → endpoint PUT contracts + tela ContractEdit + entidades", () => {
    const r = computeImpact(MANIFEST, "ContractService");
    assert.equal(r.found, true);
    assert.equal(r.summary.endpoints, 1);
    assert.equal(r.impactedEndpoints[0].path, "/api/contracts/{id}");
    assert.ok(r.impactedEndpoints[0].matchedVia.startsWith("service:"));
    assert.equal(r.summary.screens, 1);
    assert.equal(r.impactedScreens[0].name, "ContractEdit");
    assert.deepEqual(r.entitiesTouched, ["AuditLog", "Contract"]);
  });
});

describe("computeImpact — símbolo de entidade", () => {
  it("Contract → endpoints que tocam a entidade + tela", () => {
    const r = computeImpact(MANIFEST, "Contract");
    assert.equal(r.found, true);
    assert.ok(r.impactedEndpoints.some((e) => e.path === "/api/contracts/{id}"));
    assert.ok(r.entitiesTouched.includes("Contract"));
    assert.ok(r.impactedScreens.some((s) => s.name === "ContractEdit"));
  });
});

describe("computeImpact — arquivo", () => {
  it("UserController.java → endpoint GET users + tela UserList", () => {
    const r = computeImpact(MANIFEST, "UserController.java");
    assert.equal(r.summary.endpoints, 1);
    assert.equal(r.impactedEndpoints[0].path, "/api/users/{id}");
    assert.equal(r.impactedScreens[0].name, "UserList");
  });
});

describe("computeImpact — por path/rota (manifest só com lado frontend)", () => {
  it("'/api/users' → endpoint + tela UserList, mesmo sem controller/service", () => {
    // Simula manifest frontend-derivado: endpoints só com path/method.
    const frontendOnly = {
      endpoints: [{ path: "/api/users/{id}", method: "GET", controller: "", serviceMethods: [], entitiesTouched: [] }],
      screens: [{ name: "UserList", route: "/users", interactions: [{ endpoint: "/api/users/{id}", httpMethod: "GET" }] }],
      entities: [],
    };
    const r = computeImpact(frontendOnly, "/api/users");
    assert.equal(r.found, true);
    assert.equal(r.summary.endpoints, 1);
    assert.ok(r.impactedEndpoints[0].matchedVia.startsWith("path:"));
    assert.equal(r.impactedScreens[0].name, "UserList");
  });
});

describe("computeImpact — guardas", () => {
  it("símbolo curto (<3) → not found, sem ruído", () => {
    const r = computeImpact(MANIFEST, "ab");
    assert.equal(r.found, false);
    assert.equal(r.summary.endpoints, 0);
  });
  it("símbolo inexistente → found=false", () => {
    const r = computeImpact(MANIFEST, "NadaAVerService");
    assert.equal(r.found, false);
  });
  it("manifest vazio/nulo → não estoura", () => {
    assert.equal(computeImpact({}, "Contract").found, false);
    assert.equal(computeImpact(null, "Contract").found, false);
  });
  it("NÃO impacta tela/endpoint não-relacionado (sem over-match)", () => {
    const r = computeImpact(MANIFEST, "ContractService");
    assert.ok(!r.impactedScreens.some((s) => s.name === "UserList"));
    assert.ok(!r.impactedEndpoints.some((e) => e.path === "/api/users/{id}"));
  });
});

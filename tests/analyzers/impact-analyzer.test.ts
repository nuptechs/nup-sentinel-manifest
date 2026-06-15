// ─────────────────────────────────────────────
// impact-analyzer — unit tests (ADR-070 Onda 2)
//
// Blast radius cross-stack sobre o manifest persistido: símbolo → endpoints →
// telas → entidades. Puro, determinístico, sem I/O.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeImpact, computeImpactForFiles, symbolsForFile } from "../../server/analyzers/impact-analyzer.ts";

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

describe("computeImpact — prefere o espelho RICO (impactEndpoints) sobre o curado", () => {
  it("usa impactEndpoints (746 do grafo) quando o catálogo curado é raso", () => {
    // Cenário real: o `endpoints` curado perde a profundidade de backend (só os
    // endpoints alcançados por tela), mas `impactEndpoints` traz todos do grafo
    // com entitiesTouched. computeImpact deve responder pela fonte rica.
    const manifest = {
      endpoints: [
        // catálogo curado: NÃO tem o endpoint que toca Sla
        { path: "/easynup/findContract.v1", method: "POST", controller: "FindContractWsV1", entitiesTouched: ["Contract"] },
      ],
      impactEndpoints: [
        { path: "/easynup/findContract.v1", method: "POST", controller: "FindContractWsV1", controllerMethod: "handle", fullCallChain: [], entitiesTouched: ["Contract"] },
        { path: "/easynup/createSlaMeasurement.v1", method: "POST", controller: "CreateSlaMeasurementWsV1", controllerMethod: "handle", fullCallChain: [], entitiesTouched: ["SlaMeasurement"] },
        { path: "/easynup/findSla.v1", method: "POST", controller: "FindSlaWsV1", controllerMethod: "handle", fullCallChain: [], entitiesTouched: ["Sla"] },
      ],
      screens: [
        { name: "SlaPanel", route: "/sla", interactions: [{ endpoint: "/easynup/findSla.v1", httpMethod: "POST" }] },
      ],
      entities: [],
    };
    // "Sla" só existe na fonte rica → curado responderia 0; rico responde > 0.
    const r = computeImpact(manifest, "Sla");
    assert.equal(r.found, true);
    assert.ok(r.impactedEndpoints.some((e) => e.path === "/easynup/findSla.v1"), "deveria casar via fonte rica");
    assert.ok(r.entitiesTouched.includes("Sla"));
    assert.ok(r.impactedScreens.some((s) => s.name === "SlaPanel"), "tela curada casa contra endpoint rico");
  });

  it("cai no curado quando impactEndpoints ausente (compat snapshot antigo)", () => {
    const r = computeImpact(MANIFEST, "Contract");
    assert.equal(r.found, true);
    assert.ok(r.impactedEndpoints.some((e) => e.path === "/api/contracts/{id}"));
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

describe("symbolsForFile", () => {
  it("deriva basename + sem-sufixo + caminho", () => {
    const s = symbolsForFile("src/main/java/easynup/.../ContractController.java");
    assert.ok(s.includes("ContractController")); // basename
    assert.ok(s.includes("Contract")); // sem sufixo Controller
    assert.ok(s.some((x) => x.includes("ContractController"))); // caminho
  });
  it("ignora caminho vazio/curto", () => {
    assert.deepEqual(symbolsForFile(""), []);
  });
});

describe("computeImpactForFiles (impacto de um diff/entrega)", () => {
  it("agrega o blast radius de vários arquivos mudados, dedup", () => {
    const r = computeImpactForFiles(MANIFEST, [
      "src/main/java/.../ContractController.java",
      "src/main/java/.../UserController.java",
      "docs/README.md", // não casa nada
    ]);
    assert.equal(r.files, 3);
    assert.equal(r.matchedFiles, 2); // README não casa
    // agrega ambos os endpoints (contracts + users) sem duplicar
    assert.equal(r.aggregate.summary.endpoints, 2);
    assert.ok(r.aggregate.impactedScreens.some((s) => s.name === "ContractEdit"));
    assert.ok(r.aggregate.impactedScreens.some((s) => s.name === "UserList"));
    // per-file: o README tem 0
    const readme = r.perFile.find((f) => f.file.endsWith("README.md"));
    assert.equal(readme.summary.endpoints, 0);
  });
  it("lista vazia → tudo zero", () => {
    const r = computeImpactForFiles(MANIFEST, []);
    assert.equal(r.files, 0);
    assert.equal(r.aggregate.summary.endpoints, 0);
  });
});

describe("computeImpact — tela casada direto pelo símbolo (arquivo de frontend)", () => {
  it("'ContractEdit' (de ContractEdit.vue) → a tela + seus endpoints, sem cascatear", () => {
    const r = computeImpact(MANIFEST, "ContractEdit");
    assert.equal(r.found, true);
    assert.ok(r.impactedScreens.some((s) => s.name === "ContractEdit"));
    // não puxa UserList (sem cascata)
    assert.ok(!r.impactedScreens.some((s) => s.name === "UserList"));
    // a tela traz os endpoints que ELA usa
    const sc = r.impactedScreens.find((s) => s.name === "ContractEdit")!;
    assert.ok(sc.viaEndpoints.some((v) => v.includes("/api/contracts/{id}")));
  });
  it("via computeImpactForFiles: ChatIa.vue → tela ChatIa", () => {
    const m = {
      endpoints: [{ path: "/api/chat/messages", method: "POST", controller: "" }],
      screens: [{ name: "ChatIa", route: "/chat", interactions: [{ endpoint: "/api/chat/messages", httpMethod: "POST" }] }],
      entities: [],
    };
    const r = computeImpactForFiles(m, ["frontend/src/pages/ChatIa.vue"]);
    assert.equal(r.matchedFiles, 1);
    assert.ok(r.aggregate.impactedScreens.some((s) => s.name === "ChatIa"));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectCrossStackInconsistencies,
  endpointInventoryFromNodes,
  urlMatchesEndpointPath,
  type EndpointRef,
} from "../../server/analyzers/cross-stack-consistency";
import type { FrontendInteraction } from "../../server/analyzers/frontend-analyzer";

// OBS-D12 — tela→endpoint inexistente ATRAVESSANDO serviços. Cego sem inventário
// (anti-falso-positivo); acusa só o que não casa NENHUM serviço conhecido.

function interaction(p: Partial<FrontendInteraction>): FrontendInteraction {
  return {
    component: "UsersPage", elementType: "button", actionName: "save",
    httpMethod: "POST", url: "/api/users", mappedBackendNode: null,
    sourceFile: "client/pages/Users.vue", lineNumber: 10,
    resolutionTier: null, resolutionStrategy: null, resolutionPath: null,
    interactionCategory: "HTTP", confidence: 0.9, detectedRoles: [],
    ...p,
  } as FrontendInteraction;
}

const inventory: EndpointRef[] = [
  { method: "GET", path: "/api/users/:id", service: "identify" },
  { method: "POST", path: "/api/orders", service: "easynup" },
];

describe("cross-stack-consistency — cegueira honesta", () => {
  it("sem inventário → cego, zero findings", () => {
    const r = detectCrossStackInconsistencies([interaction({})], [], { fromService: "easynup" });
    assert.equal(r.inventoryPresent, false);
    assert.equal(r.findings.length, 0);
  });
});

describe("cross-stack-consistency — detecção através de serviços", () => {
  it("chamada que não casa NENHUM serviço vira finding cross-stack", () => {
    const r = detectCrossStackInconsistencies(
      [interaction({ httpMethod: "POST", url: "/api/users" })],
      inventory,
      { fromService: "easynup" },
    );
    assert.equal(r.inventoryPresent, true);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].subtype, "missing_backend_endpoint_cross_stack");
    assert.equal(r.findings[0].severity, "high", "POST = escrita = high");
    assert.deepEqual(r.findings[0].servicesSearched, ["easynup", "identify"]);
  });

  it("chamada que casa um endpoint de OUTRO serviço é consistente", () => {
    const r = detectCrossStackInconsistencies(
      [interaction({ httpMethod: "GET", url: "/api/users/42" })],
      inventory,
    );
    assert.equal(r.findings.length, 0, "casa GET /api/users/:id no identify");
  });

  it("chamada já provada por símbolo (OBS-D04) é pulada", () => {
    const r = detectCrossStackInconsistencies(
      [interaction({ httpMethod: "POST", url: "/api/users" })],
      inventory,
      { resolvedBySymbol: new Set(["POST /api/users"]) },
    );
    assert.equal(r.findings.length, 0);
    assert.equal(r.checked, 1);
  });

  it("GET inexistente é medium; dedup por (método,url)", () => {
    const r = detectCrossStackInconsistencies(
      [interaction({ httpMethod: "GET", url: "/api/ghost" }), interaction({ httpMethod: "GET", url: "/api/ghost" })],
      inventory,
    );
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].severity, "medium");
  });

  it("abaixo da confiança mínima é ignorada", () => {
    const r = detectCrossStackInconsistencies([interaction({ url: "/api/ghost", confidence: 0.3 })], inventory);
    assert.equal(r.checked, 0);
    assert.equal(r.findings.length, 0);
  });
});

describe("cross-stack-consistency — utilidades", () => {
  it("urlMatchesEndpointPath respeita :param e conta segmentos", () => {
    assert.equal(urlMatchesEndpointPath("/api/users/42", "/api/users/:id"), true);
    assert.equal(urlMatchesEndpointPath("/api/users", "/api/users/:id"), false);
    assert.equal(urlMatchesEndpointPath("/api/x?q=1", "/api/x"), true);
  });

  it("endpointInventoryFromNodes extrai só CONTROLLER/ROUTE com verbo+path", () => {
    const inv = endpointInventoryFromNodes([
      { id: "wsv1:/a", type: "CONTROLLER", service: "identify", metadata: { httpMethod: "GET", fullPath: "/a" } },
      { id: "route:POST:/b", type: "ROUTE", service: "easynup", metadata: { httpMethod: "POST", fullPath: "/b" } },
      { id: "SERVICE:x", type: "SERVICE", metadata: {} },
    ]);
    assert.equal(inv.length, 2);
    assert.ok(inv.some((e) => e.path === "/a" && e.service === "identify"));
  });
});

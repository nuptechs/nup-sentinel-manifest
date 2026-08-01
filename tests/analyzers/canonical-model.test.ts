import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNode,
  projectRoleToLegacyType,
  ACTIVE_ROLES,
  type CanonicalRole,
} from "../../server/analyzers/canonical-model";
import { shapeSystemGraph, type RawSystemNode } from "../../server/analyzers/system-graph";

// Grafo representativo cobrindo os 8 tipos ativos do parque (Spring/Vue/Express),
// com sourceFiles realistas (uns corroboram o path, outros não).
const rawNodes: RawSystemNode[] = [
  { id: "CONTROLLER:c.web.ContractWsV1", type: "CONTROLLER", className: "ContractWsV1", metadata: { sourceFile: "src/main/java/easynup/services/web/ContractWsV1.java", httpMethod: "POST", fullPath: "/easynup/createContract.v1" } },
  { id: "SERVICE:c.svc.ContractService", type: "SERVICE", className: "ContractService", metadata: { sourceFile: "src/main/java/easynup/services/common/ContractService.java" } },
  { id: "REPOSITORY:c.repo.ContractRepository", type: "REPOSITORY", className: "ContractRepository", metadata: { sourceFile: "packages/core/src/repositories/ContractRepository.java" } },
  { id: "ENTITY:c.ent.Contract", type: "ENTITY", className: "Contract", metadata: { sourceFile: "src/main/java/easynup/persistence/entities/Contract.java", sensitiveFields: ["cpf"] } },
  { id: "VIEW:f.pages.ContractsPage", type: "VIEW", className: "ContractsPage", metadata: { sourceFile: "frontend/src/pages/ContractsPage.vue" } },
  { id: "COMPONENT:f.comp.AreaCard", type: "COMPONENT", className: "AreaCard", metadata: { sourceFile: "frontend/src/components/AreaCard.vue" } },
  { id: "COMPOSABLE:f.use.useFeedback", type: "COMPOSABLE", className: "useFeedback", metadata: { sourceFile: "frontend/src/composables/useFeedback.ts" } },
  { id: "ROUTE:g.routes.contractRoutes", type: "ROUTE", className: "contractRoutes", metadata: { sourceFile: "services/gateway/src/routes/contract.routes.js" } },
];

describe("ADR-0026 CM1 — projeção byte-a-byte (a régua anti-meia-bomba)", () => {
  it("todo nó classificado projeta de volta ao TIPO legado idêntico", () => {
    for (const n of rawNodes) {
      const f = classifyNode(n);
      assert.ok(f, `nó ${n.id} deveria classificar`);
      assert.equal(projectRoleToLegacyType(f!.role), n.type, `projeção de ${f!.role} != ${n.type}`);
    }
  });

  it("via shaper (class + method): role presente e projeta === type em 100% dos nós", () => {
    for (const level of ["class", "method"] as const) {
      const g = shapeSystemGraph({ nodes: rawNodes, edges: [] }, level);
      for (const n of g.nodes) {
        assert.ok(n.role, `${level}: nó ${n.id} sem role`);
        assert.equal(projectRoleToLegacyType(n.role as CanonicalRole), n.type, `${level}: ${n.role} != ${n.type}`);
      }
    }
  });

  it("os 8 papéis ativos projetam; e a projeção é total sobre eles", () => {
    assert.equal(ACTIVE_ROLES.length, 8);
    for (const r of ACTIVE_ROLES) {
      assert.ok(projectRoleToLegacyType(r), `${r} deveria projetar`);
    }
  });
});

describe("ADR-0026 CM1 — layer canônica por papel", () => {
  const cases: Array<[string, string]> = [
    ["CONTROLLER", "api"], ["ROUTE", "api"],
    ["SERVICE", "domain"],
    ["REPOSITORY", "data"], ["ENTITY", "data"],
    ["VIEW", "presentation"], ["COMPONENT", "presentation"], ["COMPOSABLE", "presentation"],
  ];
  for (const [type, layer] of cases) {
    it(`${type} → ${layer}`, () => {
      const n = rawNodes.find((x) => x.type === type)!;
      assert.equal(classifyNode(n)!.layer, layer);
    });
  }
});

describe("ADR-0026 CM1 — stack por evidência independente", () => {
  it(".vue → vue · .java → spring · route Node → express · .ts composable → vue(por papel)", () => {
    assert.equal(classifyNode(rawNodes.find((n) => n.type === "VIEW")!)!.stack, "vue");
    assert.equal(classifyNode(rawNodes.find((n) => n.type === "ENTITY")!)!.stack, "spring");
    assert.equal(classifyNode(rawNodes.find((n) => n.type === "ROUTE")!)!.stack, "express");
    // composable .ts do frontend: o papel Composable é sempre Vue no parque
    assert.equal(classifyNode(rawNodes.find((n) => n.type === "COMPOSABLE")!)!.stack, "vue");
  });
});

describe("ADR-0026 CM1 — evidência e confiança graduadas (não-circular)", () => {
  it("endpoint HTTP corrobora Controller → high/http-endpoint", () => {
    const f = classifyNode(rawNodes.find((n) => n.type === "CONTROLLER")!)!;
    assert.equal(f.confidence, "high");
    assert.equal(f.evidence, "http-endpoint");
  });

  it("path corrobora (service em **/ContractService.java) → high/path-corroborated", () => {
    const f = classifyNode({ id: "SERVICE:x.FooService", type: "SERVICE", sourceFile: "a/service/FooService.java" })!;
    assert.equal(f.confidence, "high");
    assert.equal(f.evidence, "path-corroborated");
  });

  it("só o produtor tipou (path neutro) → medium/producer-type", () => {
    const f = classifyNode({ id: "SERVICE:x.Foo", type: "SERVICE", sourceFile: "a/misc/Foo.java" })!;
    assert.equal(f.confidence, "medium");
    assert.equal(f.evidence, "producer-type");
  });

  it("path CONFLITA (produtor=Service, path=repository) → low/path-conflict, mas papel DEFERE ao produtor (precisão>recall)", () => {
    const f = classifyNode({ id: "SERVICE:x.Foo", type: "SERVICE", sourceFile: "a/repository/FooRepository.java" })!;
    assert.equal(f.confidence, "low");
    assert.equal(f.evidence, "path-conflict");
    assert.equal(f.role, "Service"); // ainda defere ao produtor; projeta byte-a-byte
    assert.equal(projectRoleToLegacyType(f.role), "SERVICE");
  });
});

describe("ADR-0026 CM1 — degradação honesta (nunca chuta)", () => {
  it("tipo fora do vocabulário ativo (ex.: NODE_MODULE) → null, sem faceta, sem throw", () => {
    assert.equal(classifyNode({ id: "node:@easynup/core", type: "NODE_MODULE" }), null);
    const g = shapeSystemGraph({ nodes: [{ id: "node:@easynup/core", type: "NODE_MODULE" }], edges: [] }, "class");
    assert.equal(g.nodes[0].role, undefined);
    assert.equal(g.nodes[0].type, "NODE_MODULE"); // preservado byte-a-byte
  });

  it("projetar faceta FUTURA (DataCarrier) lança — honesto: CM1 não a produz", () => {
    assert.throws(() => projectRoleToLegacyType("DataCarrier" as CanonicalRole), /faceta futura/);
  });
});

describe("ADR-0026 CM1 — distribuições byLayer/byStack (atlas)", () => {
  it("acumulam e somam aos nós classificados", () => {
    const g = shapeSystemGraph({ nodes: rawNodes, edges: [] }, "class");
    assert.ok(g.byLayer && g.byStack);
    const layerSum = Object.values(g.byLayer!).reduce((a, b) => a + b, 0);
    const stackSum = Object.values(g.byStack!).reduce((a, b) => a + b, 0);
    assert.equal(layerSum, 8); // todos os 8 nós classificados
    assert.equal(stackSum, 8);
    assert.equal(g.byLayer!.api, 2);          // controller + route
    assert.equal(g.byLayer!.presentation, 3); // view + component + composable
    assert.equal(g.byStack!.spring, 4);       // controller/service/repo/entity
    assert.equal(g.byStack!.vue, 3);
    assert.equal(g.byStack!.express, 1);
  });

  it("nó não-classificado NÃO entra nas distribuições (denominador honesto)", () => {
    const g = shapeSystemGraph({ nodes: [...rawNodes, { id: "node:x", type: "NODE_MODULE" }], edges: [] }, "class");
    const layerSum = Object.values(g.byLayer!).reduce((a, b) => a + b, 0);
    assert.equal(layerSum, 8); // o NODE_MODULE não conta
    assert.equal(g.counts.nodes, 9); // mas está no grafo
  });
});

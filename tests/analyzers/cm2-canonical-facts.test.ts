import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nodeBackendType } from "../../server/analyzers/canonical-model";
import { buildFactSheet } from "../../server/analyzers/fact-sheet";
import type { RawSystemNode } from "../../server/analyzers/system-graph";

describe("ADR-0026 CM2 — regra do pack Node (nodeBackendType por path)", () => {
  it("repositório Node → REPOSITORY (tier de dados, mesmo Postgres do Java, C1)", () => {
    assert.equal(nodeBackendType("packages/core/src/repositories/ContractRepository.js"), "REPOSITORY");
    assert.equal(nodeBackendType("packages/core/src/repositories/index.js"), "REPOSITORY");
    assert.equal(nodeBackendType("src/db/user.repository.ts"), "REPOSITORY");
    assert.equal(nodeBackendType("a/b/ContractRepository.ts"), "REPOSITORY");
  });
  it("handler/serviço/módulo Node → SERVICE (não chuta REPOSITORY sem sinal)", () => {
    assert.equal(nodeBackendType("services/gateway/src/routes/contract.routes.js"), "SERVICE");
    assert.equal(nodeBackendType("services/gateway/src/services/logger.service.js"), "SERVICE");
    assert.equal(nodeBackendType("services/gateway/src/modules/legal-corpus/route.js"), "SERVICE");
    assert.equal(nodeBackendType(""), "SERVICE");
    assert.equal(nodeBackendType(null), "SERVICE");
  });
});

describe("ADR-0026 CM2 — Ficha de Fatos: camada canônica deduplicada (C2)", () => {
  // Grafo com a dupla-representação real: endpoint (wsv1:, type CONTROLLER) +
  // um controller comum + rota Node + serviço Node + repositório Node.
  const raw: { nodes: RawSystemNode[]; edges: [] } = {
    nodes: [
      { id: "wsv1:e.CreateContractWsV1", type: "CONTROLLER", className: "CreateContractWsV1", metadata: { sourceFile: "src/main/java/easynup/web/CreateContractWsV1.java", httpMethod: "POST", fullPath: "/easynup/createContract.v1" } },
      { id: "CONTROLLER:e.LegacyController", type: "CONTROLLER", className: "LegacyController", metadata: { sourceFile: "src/main/java/easynup/web/LegacyController.java" } },
      { id: "node:services/gateway/src/routes/x.routes.js", type: "SERVICE", className: "x.routes", metadata: { sourceFile: "services/gateway/src/routes/x.routes.js", runtime: "node" } },
      { id: "node:packages/core/src/repositories/FooRepository.js", type: "REPOSITORY", className: "FooRepository", metadata: { sourceFile: "packages/core/src/repositories/FooRepository.js", runtime: "node" } },
      { id: "ENTITY:e.Contract", type: "ENTITY", className: "Contract", metadata: { sourceFile: "src/main/java/easynup/persistence/entities/Contract.java" } },
    ],
    edges: [],
  };

  it("layers (view RAW por prefixo) mantém ENDPOINT e CONTROLLER DISJUNTOS", () => {
    const s = buildFactSheet(raw, {});
    assert.equal(s.layers.ENDPOINT, 1);      // o wsv1:
    assert.equal(s.layers.CONTROLLER, 1);    // o controller comum
    assert.equal(s.layers.NODE_MODULE, 2);   // os 2 node:
    assert.equal(s.layers.ENTITY, 1);
  });

  it("byLayer (canônico) CONVERGE endpoint+controller em `api` — sem dupla-representação (C2)", () => {
    const s = buildFactSheet(raw, {});
    assert.equal(s.byLayer.api, 2);          // o endpoint E o controller são a MESMA camada api
    assert.equal(s.byLayer.data, 2);         // entity Java + repositório Node (mesmo tier de dados)
  });

  it("byStack distingue spring de node (o backend Node não some no Java)", () => {
    const s = buildFactSheet(raw, {});
    assert.equal(s.byStack.spring, 3);       // 2 controllers + entity
    assert.equal(s.byStack.node, 2);         // rota + repositório Node
  });

  it("repositório Node cai no tier de DADOS canônico (C1 correto-pro-padrão)", () => {
    const s = buildFactSheet(raw, {});
    // o node: repo (type REPOSITORY) é data; o node: rota (type SERVICE) é domain
    assert.equal(s.byLayer.data, 2);
    assert.equal(s.byLayer.domain, 1);       // a rota Node materializada como SERVICE
  });
});

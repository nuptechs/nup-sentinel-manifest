// ─────────────────────────────────────────────
// nuptechs-conventions — unit tests
//
// Teaches the manifest the two endpoint inventories the generic analyzer is
// blind to on NuPtechs platforms:
//   (B) Spring WsV1 convention: .../services/web/<area>/<op>/v<N>/<Class>WsV1.java
//       → /easynup/<op>.v<N>  (or an explicit @Ws("/abs/path"))
//   (A) Node gateway mount prefixes: app.use('<prefix>', ...) → coverage
//
// Golden goals:
//   - A real /easynup/<op>.v1 call RESOLVES (no false positive).
//   - A typo'd/removed /easynup call STAYS unmapped → flagged (real "tela quebrada").
//   - A gateway-native /api/<prefix>/* call is COVERED (no false positive).
//   - A call outside every prefix and not a WsV1 STAYS flaggable.
// ─────────────────────────────────────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractWsV1Endpoints,
  extractGatewayPrefixes,
  augmentGraphWithWsV1,
  isCoveredByGatewayPrefix,
  mapInteractionsToGatewayPrefixes,
} from "../../server/analyzers/nuptechs-conventions.ts";
import { ApplicationGraph, analyzeEndpoints, GraphNode } from "../../server/analyzers/application-graph.ts";
import { matchUrlToEndpoint } from "../../server/analyzers/frontend/utils.ts";
import { detectFrontendBackendInconsistencies } from "../../server/analyzers/frontend-backend-consistency.ts";
import type { FrontendInteraction } from "../../server/analyzers/frontend-analyzer.ts";

function mkInteraction(over: Partial<FrontendInteraction>): FrontendInteraction {
  return {
    component: "SomeScreen",
    elementType: "button",
    actionName: "submit",
    httpMethod: "POST",
    url: null,
    mappedBackendNode: null,
    sourceFile: "src/pages/SomeScreen.vue",
    lineNumber: 10,
    resolutionTier: null,
    resolutionStrategy: null,
    resolutionPath: null,
    interactionCategory: "HTTP",
    confidence: 0.9,
    ...over,
  } as FrontendInteraction;
}

const javaFile = (filePath: string, content = "@Ws\npublic class X extends BaseWs {}") => ({ filePath, content });

describe("extractWsV1Endpoints (B)", () => {
  it("deriva /easynup/<op>.v<N> da convenção de path (bare @Ws)", () => {
    const eps = extractWsV1Endpoints([
      javaFile("src/main/java/easynup/services/web/acceptances/deleteAcceptance/v1/DeleteAcceptanceWsV1.java"),
      javaFile("src/main/java/easynup/services/web/snapPointsAnalyzes/findSnapPointAnalysisHistory/v2/FindSnapPointAnalysisHistoryWsV2.java"),
    ]);
    const paths = eps.map((e) => e.fullPath).sort();
    assert.deepEqual(paths, ["/easynup/deleteAcceptance.v1", "/easynup/findSnapPointAnalysisHistory.v2"]);
    assert.ok(eps.every((e) => e.httpMethod === "POST"));
    assert.ok(eps.every((e) => e.origin === "wsv1"));
  });

  it("usa o path explícito quando @Ws(\"/abs\") está presente (override da convenção)", () => {
    const eps = extractWsV1Endpoints([
      javaFile(
        "src/main/java/easynup/services/web/i18nAdmin/v1/GetI18nAdminConfigWsV1.java",
        '@Ws("/api/v1/admin/i18n/config")\npublic class GetI18nAdminConfigWsV1 extends BaseWs {}',
      ),
    ]);
    assert.equal(eps.length, 1);
    assert.equal(eps[0].fullPath, "/api/v1/admin/i18n/config");
    assert.equal(eps[0].origin, "wsv1-explicit");
  });

  it("ignora arquivos Java que não são WsV1 (sem coluna no inventário)", () => {
    const eps = extractWsV1Endpoints([
      javaFile("src/main/java/easynup/persistence/entities/Contract.java", "public class Contract {}"),
      javaFile("src/main/java/easynup/services/common/SomeHelper.java", "public class SomeHelper {}"),
    ]);
    assert.equal(eps.length, 0);
  });

  it("deduplica por fullPath", () => {
    const eps = extractWsV1Endpoints([
      javaFile("src/main/java/easynup/services/web/x/findContract/v1/FindContractWsV1.java"),
      javaFile("src/main/java/easynup/services/web/y/findContract/v1/FindContractWsV1.java"),
    ]);
    assert.equal(eps.length, 1);
  });
});

describe("extractGatewayPrefixes (A)", () => {
  const gateway = {
    filePath: "services/gateway/src/routes.js",
    content: `
      app.use('/auth', authLimiter, authRoutes);
      app.use('/api/invite', userInviteRoutes);
      app.use('/api/public-forms', publicFormRoutes);
      app.use('/easynup', proxyMiddleware);          // EXCLUÍDO — WsV1 cobre
      app.use('/api/v1/admin', adminProxy);          // EXCLUÍDO — @Ws explícito cobre
      app.use('/api/', apiLimiter);                  // EXCLUÍDO — largo demais
      const registry = [
        { path: 'routes/chat-ia.routes.js', mount: '/api/chat-ia', name: 'Chat IA' },
        { path: 'routes/audit360.js', mount: '/api/audit360', name: 'Audit 360' },
        { path: 'routes/x.js', mount: '/api', name: 'broad' },   // EXCLUÍDO — largo
      ];
    `,
  };

  it("extrai prefixos nativos e exclui proxy-cobertos e largos", () => {
    const prefixes = extractGatewayPrefixes([gateway]);
    assert.ok(prefixes.includes("/auth"));
    assert.ok(prefixes.includes("/api/invite"));
    assert.ok(prefixes.includes("/api/public-forms"));
    assert.ok(!prefixes.includes("/easynup"));
    assert.ok(!prefixes.includes("/api/v1/admin"));
    assert.ok(!prefixes.includes("/api"));
    assert.ok(!prefixes.includes("/api/"));
  });

  it("captura mounts via factory-config (mount: '<prefix>') — corrige FP do chat-ia", () => {
    const prefixes = extractGatewayPrefixes([gateway]);
    assert.ok(prefixes.includes("/api/chat-ia"), "factory mount /api/chat-ia deveria ser coberto");
    assert.ok(prefixes.includes("/api/audit360"), "factory mount /api/audit360 deveria ser coberto");
    assert.ok(!prefixes.includes("/api"), "mount factory '/api' largo continua excluído");
    // a chamada que antes era falso-positivo agora é coberta
    assert.ok(isCoveredByGatewayPrefix("/api/chat-ia/messages", prefixes));
  });

  it("ordena por comprimento decrescente (match determinístico)", () => {
    const prefixes = extractGatewayPrefixes([gateway]);
    for (let i = 1; i < prefixes.length; i++) {
      assert.ok(prefixes[i - 1].length >= prefixes[i].length);
    }
  });
});

describe("isCoveredByGatewayPrefix — segment-aware", () => {
  const prefixes = ["/api/invite", "/auth"];
  it("cobre o próprio prefixo e descendentes de segmento", () => {
    assert.ok(isCoveredByGatewayPrefix("/api/invite", prefixes));
    assert.ok(isCoveredByGatewayPrefix("/api/invite/validate/abc", prefixes));
    assert.ok(isCoveredByGatewayPrefix("/auth/refresh", prefixes));
  });
  it("NÃO cobre prefixo parcial colado (evita falso-cobre)", () => {
    assert.ok(!isCoveredByGatewayPrefix("/api/inviteother", prefixes));
    assert.ok(!isCoveredByGatewayPrefix("/api/public-forms/x", prefixes));
  });
});

describe("augmentGraphWithWsV1 + analyzeEndpoints", () => {
  it("injeta nós CONTROLLER que viram endpoints (un-gate do detector)", () => {
    const graph = new ApplicationGraph();
    assert.equal(analyzeEndpoints(graph).length, 0); // antes: zero cobertura
    const added = augmentGraphWithWsV1(graph, [
      javaFile("src/main/java/easynup/services/web/contracts/findContract/v1/FindContractWsV1.java"),
      javaFile("src/main/java/easynup/services/web/contracts/createContract/v1/CreateContractWsV1.java"),
    ]);
    assert.equal(added, 2);
    const eps = analyzeEndpoints(graph);
    assert.equal(eps.length, 2);
    assert.deepEqual(
      eps.map((e) => e.endpoint).sort(),
      ["/easynup/createContract.v1", "/easynup/findContract.v1"],
    );
  });

  it("é idempotente (re-augmentar não duplica)", () => {
    const graph = new ApplicationGraph();
    const files = [javaFile("src/main/java/easynup/services/web/x/findContract/v1/FindContractWsV1.java")];
    assert.equal(augmentGraphWithWsV1(graph, files), 1);
    assert.equal(augmentGraphWithWsV1(graph, files), 0);
    assert.equal(analyzeEndpoints(graph).length, 1);
  });
});

describe("fluxo ponta-a-ponta: WsV1 resolve real, typo é flagrado", () => {
  it("chamada real mapeia; typo fica não-mapeado → flagrado", () => {
    const graph = new ApplicationGraph();
    augmentGraphWithWsV1(graph, [
      javaFile("src/main/java/easynup/services/web/contracts/findContract/v1/FindContractWsV1.java"),
    ]);

    // real → resolve (sem falso-positivo)
    const real = matchUrlToEndpoint("POST", "/easynup/findContract.v1", graph);
    assert.ok(real, "chamada real deveria mapear para o WsV1");

    // typo → não resolve por path exato (a quebra que queremos pegar)
    const interactions = [
      mkInteraction({ url: "/easynup/findContract.v1", httpMethod: "POST", mappedBackendNode: real }),
      mkInteraction({ url: "/easynup/findContractTYPO.v1", httpMethod: "POST", mappedBackendNode: null, component: "Contracts" }),
    ];
    const findings = detectFrontendBackendInconsistencies(interactions);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].url, "/easynup/findContractTYPO.v1");
  });
});

describe("mapInteractionsToGatewayPrefixes (A) — sem falso-positivo em /api nativo", () => {
  it("cobre chamadas de gateway e deixa chamadas fora flagráveis", () => {
    const prefixes = ["/api/invite", "/auth"];
    const interactions = [
      mkInteraction({ url: "/api/invite/validate/tok", mappedBackendNode: null }),       // coberta
      mkInteraction({ url: "/auth/refresh", mappedBackendNode: null }),                    // coberta
      mkInteraction({ url: "/api/coisaInexistente/x", mappedBackendNode: null }),          // fora → flagrável
      mkInteraction({ url: "/easynup/findX.v1", mappedBackendNode: null }),                // fora do gateway (vai pro WsV1, não aqui)
    ];
    const covered = mapInteractionsToGatewayPrefixes(interactions, prefixes);
    assert.equal(covered, 2);
    assert.ok(interactions[0].mappedBackendNode);
    assert.ok(interactions[1].mappedBackendNode);
    assert.equal(interactions[2].mappedBackendNode, null);
    assert.equal(interactions[3].mappedBackendNode, null);
  });

  it("não toca interações já mapeadas nem externas", () => {
    const prefixes = ["/auth"];
    const already = { id: "x" } as any;
    const interactions = [
      mkInteraction({ url: "/auth/refresh", mappedBackendNode: already }),                 // já mapeada
      mkInteraction({ url: "/auth/login", interactionCategory: "EXTERNAL_SERVICE", mappedBackendNode: null }),
    ];
    const covered = mapInteractionsToGatewayPrefixes(interactions, prefixes);
    assert.equal(covered, 0);
    assert.equal(interactions[0].mappedBackendNode, already);
    assert.equal(interactions[1].mappedBackendNode, null);
  });
});

describe("augmentGraphWithWsV1 — conexão WsV1→entidade (profundidade de impacto)", () => {
  const java = (filePath: string) => ({ filePath, content: "@Ws\npublic class X extends BaseWs {}" });

  it("liga endpoint à entidade pela convenção verbo+entidade (find→READS, create→WRITES)", () => {
    const graph = new ApplicationGraph();
    // entidades já extraídas pelo analisador Java
    graph.addNode(new GraphNode("entity:Contract", "ENTITY", "Contract", null, null, {}));
    graph.addNode(new GraphNode("entity:Acceptance", "ENTITY", "Acceptance", null, null, {}));
    augmentGraphWithWsV1(graph, [
      java("src/main/java/easynup/services/web/contracts/findContract/v1/FindContractWsV1.java"),
      java("src/main/java/easynup/services/web/acceptances/createAcceptance/v1/CreateAcceptanceWsV1.java"),
    ]);
    const eps = analyzeEndpoints(graph);
    const find = eps.find((e) => e.endpoint === "/easynup/findContract.v1")!;
    assert.deepEqual(find.entitiesTouched, ["Contract"]); // find → Contract (READS)
    const create = eps.find((e) => e.endpoint === "/easynup/createAcceptance.v1")!;
    assert.deepEqual(create.entitiesTouched, ["Acceptance"]);
    // create = escrita
    assert.ok(create.persistenceOperations.includes("write"));
    assert.ok(find.persistenceOperations.includes("read"));
  });

  it("plural e composto casam (findContracts→Contract, findContractMilestones→ContractMilestone)", () => {
    const graph = new ApplicationGraph();
    graph.addNode(new GraphNode("e1", "ENTITY", "Contract", null, null, {}));
    graph.addNode(new GraphNode("e2", "ENTITY", "ContractMilestone", null, null, {}));
    augmentGraphWithWsV1(graph, [
      java("src/main/java/easynup/services/web/x/findContracts/v1/FindContractsWsV1.java"),
      java("src/main/java/easynup/services/web/x/findContractMilestones/v1/FindContractMilestonesWsV1.java"),
    ]);
    const eps = analyzeEndpoints(graph);
    assert.deepEqual(eps.find((e) => e.endpoint === "/easynup/findContracts.v1")!.entitiesTouched, ["Contract"]);
    assert.deepEqual(eps.find((e) => e.endpoint === "/easynup/findContractMilestones.v1")!.entitiesTouched, ["ContractMilestone"]);
  });

  it("sem entidade correspondente → endpoint sem entitiesTouched (não inventa)", () => {
    const graph = new ApplicationGraph();
    graph.addNode(new GraphNode("e1", "ENTITY", "Contract", null, null, {}));
    augmentGraphWithWsV1(graph, [java("src/main/java/easynup/services/web/x/feelEvaluate/v1/FeelEvaluateWsV1.java")]);
    const ep = analyzeEndpoints(graph).find((e) => e.endpoint === "/easynup/feelEvaluate.v1")!;
    assert.deepEqual(ep.entitiesTouched, []);
  });
});

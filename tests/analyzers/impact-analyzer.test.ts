// ─────────────────────────────────────────────
// impact-analyzer — unit tests (ADR-070 Onda 2)
//
// Blast radius cross-stack sobre o manifest persistido: símbolo → endpoints →
// telas → entidades. Puro, determinístico, sem I/O.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeImpact, computeImpactForFiles, computeImpactForDiff, symbolsForFile, renderImpactDiffMarkdown } from "../../server/analyzers/impact-analyzer.ts";

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

// ── ADR-0014 D2d — matching por nó (não inflar por substring) ──────────
describe("computeImpact — D2d matching por nó", () => {
  // Grafo com DUAS entidades onde uma é prefixo da outra: o bug clássico.
  const GRAPH = {
    endpoints: [
      {
        path: "/api/contracts/{id}", method: "GET",
        controller: "ContractController", controllerMethod: "get",
        serviceMethods: ["ContractService.get"], repositoryMethods: ["ContractRepository.find"],
        entitiesTouched: ["Contract"], fullCallChain: ["ContractController.get"],
        sourceFile: "ContractController.java",
      },
      {
        path: "/api/contract-guarantees/{id}", method: "GET",
        controller: "ContractGuaranteeController", controllerMethod: "get",
        serviceMethods: ["ContractGuaranteeService.get"], repositoryMethods: ["ContractGuaranteeRepository.find"],
        entitiesTouched: ["ContractGuarantee"], fullCallChain: ["ContractGuaranteeController.get"],
        sourceFile: "ContractGuaranteeController.java",
      },
    ],
    screens: [],
    entities: [
      { name: "Contract", accessedBy: [], sensitiveFields: [] },
      { name: "ContractGuarantee", accessedBy: [], sensitiveFields: [] },
    ],
  };

  it("Contract (nó exato) NÃO puxa ContractGuarantee — raio preciso", () => {
    const r = computeImpact(GRAPH, "Contract");
    assert.equal(r.matchMode, "exact");
    assert.equal(r.imprecise, false);
    assert.equal(r.summary.endpoints, 1);
    assert.equal(r.impactedEndpoints[0].path, "/api/contracts/{id}");
    assert.deepEqual(r.entitiesTouched, ["Contract"]);
    // A entidade prefixada NÃO entra.
    assert.ok(!r.entitiesTouched.includes("ContractGuarantee"));
    assert.ok(!r.impactedEndpoints.some((e) => e.path.includes("guarantee")));
  });

  it("ContractGuarantee (nó exato) resolve só o seu próprio endpoint", () => {
    const r = computeImpact(GRAPH, "ContractGuarantee");
    assert.equal(r.matchMode, "exact");
    assert.equal(r.summary.endpoints, 1);
    assert.equal(r.impactedEndpoints[0].path, "/api/contract-guarantees/{id}");
  });

  it("ContractService (classe exata) casa via segmento de Classe.metodo", () => {
    const r = computeImpact(GRAPH, "ContractService");
    assert.equal(r.matchMode, "exact");
    assert.equal(r.summary.endpoints, 1);
    assert.ok(r.impactedEndpoints[0].matchedVia.startsWith("service:"));
    assert.equal(r.impactedEndpoints[0].path, "/api/contracts/{id}");
  });

  it("símbolo NÃO-resolvível cai no fallback por substring e marca imprecise", () => {
    // "contrac" não é entidade/classe/tela conhecida → substring.
    const r = computeImpact(GRAPH, "contrac");
    assert.equal(r.matchMode, "substring");
    assert.equal(r.imprecise, true);
    // No fallback, ambos entram (o consumidor sabe que é aproximado).
    assert.ok(r.summary.endpoints >= 2);
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

describe("renderImpactDiffMarkdown (Propósito 2 — saída p/ documentação)", () => {
  it("renderiza resumo, telas a revalidar, tabela por arquivo e endpoints", () => {
    const r = computeImpactForFiles(MANIFEST, [
      "src/main/java/.../ContractController.java",
      "src/main/java/.../UserController.java",
    ]);
    const md = renderImpactDiffMarkdown(r, { projectName: "easynup" });
    assert.match(md, /^# Relatório de Impacto da Entrega/);
    assert.match(md, /\*\*Sistema:\*\* easynup/);
    assert.match(md, /\*\*Endpoints afetados:\*\* 2/);
    assert.match(md, /## Telas a revalidar/);
    assert.match(md, /\*\*ContractEdit\*\*/);
    assert.match(md, /\*\*UserList\*\*/);
    assert.match(md, /## Impacto por arquivo entregue/);
    assert.match(md, /\| Arquivo \| Endpoints \| Telas \| Entidades \|/);
    assert.match(md, /## Endpoints afetados/);
    assert.match(md, /`PUT \/api\/contracts\/\{id\}`/);
    // entidade aparece junto do endpoint
    assert.match(md, /_Contract/);
  });

  it("entrega sem casar → relatório honesto (não finge impacto)", () => {
    const r = computeImpactForFiles(MANIFEST, ["docs/README.md", "infra/deploy.sh"]);
    const md = renderImpactDiffMarkdown(r);
    assert.match(md, /Nenhum dos arquivos entregues casou/);
    assert.doesNotMatch(md, /## Telas a revalidar/);
  });

  it("título customizável + sem projectName não quebra", () => {
    const r = computeImpactForFiles(MANIFEST, ["src/main/java/.../ContractController.java"]);
    const md = renderImpactDiffMarkdown(r, { title: "Recebimento OS-123" });
    assert.match(md, /^# Recebimento OS-123/);
    assert.doesNotMatch(md, /\*\*Sistema:\*\*/);
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

// ── ADR-0018 Onda 1: impacto a partir do DIFF REAL (símbolo, não nome) ──

const CONTRACT_DIFF = `diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,6 +40,7 @@ public Contract update(Long id, ContractDto dto) {
         Contract existing = repo.findById(id);
+        auditLog.record(existing);
         return repo.save(existing);
`;

describe("computeImpactForDiff (ADR-0018 Onda 1)", () => {
  it("extrai o SÍMBOLO alterado do diff (update, QUALIFICADO pela classe) → impacto, symbolSource='diff'", () => {
    const r = computeImpactForDiff(MANIFEST, CONTRACT_DIFF);
    assert.equal(r.matchedFiles, 1, "casou o endpoint via ContractService.update do diff");
    assert.ok(r.aggregate.impactedEndpoints.some((e) => e.path === "/api/contracts/{id}"));
    const pf = r.perFile.find((f) => f.file.endsWith("ContractService.java"));
    assert.ok(pf);
    assert.equal(pf!.symbolSource, "diff");
    // Onda 4 anti-superalarme: símbolo de backend vem QUALIFICADO (Classe.simbolo)
    assert.ok(pf!.symbols.includes("ContractService.update"), JSON.stringify(pf!.symbols));
    assert.ok(pf!.symbols.includes("ContractService"));
    // o símbolo CRU não entra mais (era o vetor do superalarme "handle")
    assert.ok(!pf!.symbols.includes("update"));
    assert.ok(!pf!.symbols.includes("ContractService.java"));
  });

  it("ANTI-SUPERALARME universal: método 'handle' de UM WsV1 NÃO casa cadeias de OUTROS controllers", () => {
    // fixture com 2 controllers ambos com .handle nas cadeias
    const m = {
      impactEndpoints: [
        { path: "/a.v1", method: "POST", controller: "AWsV1", controllerMethod: "handle", fullCallChain: ["AWsV1.handle", "AService.run"], entitiesTouched: ["A"] },
        { path: "/b.v1", method: "POST", controller: "BWsV1", controllerMethod: "handle", fullCallChain: ["BWsV1.handle", "BService.run"], entitiesTouched: ["B"] },
      ],
      screens: [],
      entities: [],
    };
    const diff = `diff --git a/src/main/java/AWsV1.java b/src/main/java/AWsV1.java
--- a/src/main/java/AWsV1.java
+++ b/src/main/java/AWsV1.java
@@ -3,2 +3,3 @@ public class AWsV1 {
     public AReturnV1 handle(AParamsV1 p) {
+        log.info(p);
`;
    const r = computeImpactForDiff(m, diff);
    // só o endpoint do PRÓPRIO controller — o handle do B não acende
    assert.deepEqual(r.aggregate.impactedEndpoints.map((e) => e.path), ["/a.v1"]);
    assert.deepEqual(r.aggregate.entitiesTouched, ["A"]);
  });

  it("RECALL com cadeia RASA: qualificado não casa nada → degrada pro basename (nunca pro método cru)", () => {
    // snapshot com cadeia truncada: só WsV1.execute, sem o hop do ServiceV1
    const m = {
      impactEndpoints: [
        { path: "/easynup/applyX.v1", method: "POST", controller: "ApplyXWsV1", controllerMethod: "execute", fullCallChain: ["ApplyXWsV1.execute"], entitiesTouched: ["X"] },
      ],
      screens: [],
      entities: [],
    };
    const diff = `diff --git a/src/main/java/applyX/v1/ApplyXServiceV1.java b/src/main/java/applyX/v1/ApplyXServiceV1.java
--- a/src/main/java/applyX/v1/ApplyXServiceV1.java
+++ b/src/main/java/applyX/v1/ApplyXServiceV1.java
@@ -8,2 +8,3 @@ public class ApplyXServiceV1 {
     public XReturn handle(XParams p) {
+        log.info(p);
`;
    const r = computeImpactForDiff(m, diff);
    // ApplyXServiceV1.handle não está na cadeia → fallback basename (strip
    // ServiceV1 → "ApplyX") casa o controller ApplyXWsV1 por substring
    assert.deepEqual(r.aggregate.impactedEndpoints.map((e) => e.path), ["/easynup/applyX.v1"]);
  });

  it("ANTI-SUPERALARME em JS: tocar handler de UMA rota Node não acende as outras (qualificação arquivo.fn)", () => {
    const m = {
      impactEndpoints: [
        { path: "/api/a", method: "POST", controller: "a.routes", controllerMethod: "handle", fullCallChain: ["a.routes.handle", "a-service.run"], entitiesTouched: ["ta"], runtime: "node" },
        { path: "/api/b", method: "POST", controller: "b.routes", controllerMethod: "handle", fullCallChain: ["b.routes.handle", "b-service.run"], entitiesTouched: ["tb"], runtime: "node" },
      ],
      screens: [],
      entities: [],
    };
    const diff = `diff --git a/services/gateway/src/routes/a.routes.js b/services/gateway/src/routes/a.routes.js
--- a/services/gateway/src/routes/a.routes.js
+++ b/services/gateway/src/routes/a.routes.js
@@ -3,2 +3,3 @@ export function handle(req, res) {
     const x = svc.run(req);
+    log.info(x);
`;
    const r = computeImpactForDiff(m, diff);
    assert.deepEqual(r.aggregate.impactedEndpoints.map((e) => e.path), ["/api/a"]);
    assert.deepEqual(r.aggregate.entitiesTouched, ["ta"]);
  });

  it("arquivo sem símbolo no diff (.md) → CAI no basename (symbolSource='filename'), nunca pior que hoje", () => {
    const mdDiff = `diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -1,1 +1,2 @@
-# Título
+# Título novo
+linha
`;
    const r = computeImpactForDiff(MANIFEST, mdDiff);
    const pf = r.perFile.find((f) => f.file.endsWith("README.md"));
    assert.ok(pf);
    assert.equal(pf!.symbolSource, "filename");
    // fallback = exatamente o que o symbolsForFile daria (degradação honesta)
    assert.deepEqual(pf!.symbols, symbolsForFile("docs/README.md"));
  });

  it("diff vazio → relatório vazio (não quebra)", () => {
    const r = computeImpactForDiff(MANIFEST, "");
    assert.equal(r.files, 0);
    assert.equal(r.matchedFiles, 0);
    assert.deepEqual(r.perFile, []);
  });

  it("BYTE-A-BYTE: computeImpactForFiles intocado (o caminho OFF do ADR-0018)", () => {
    // o modo 'files' (sem diff) tem que continuar idêntico ao de antes do refactor.
    const r = computeImpactForFiles(MANIFEST, ["src/main/java/ContractController.java"]);
    assert.equal(r.matchedFiles, 1);
    assert.ok(r.aggregate.impactedEndpoints.some((e) => e.path === "/api/contracts/{id}"));
    // computeImpactForFiles NÃO carrega symbolSource (só o diff carrega)
    assert.equal(r.perFile[0].symbolSource, undefined);
  });
});

// ── ADR-0018 Onda 2: breaking × reachable integrado no impact-diff ──

describe("computeImpactForDiff.breaking (ADR-0018 Onda 2)", () => {
  it("chave `breaking` é ADITIVA: campos da Onda 1 idênticos + relatório de quebra presente", () => {
    const r = computeImpactForDiff(MANIFEST, CONTRACT_DIFF);
    // Onda 1 byte-a-byte (mesmos asserts do bloco acima)
    assert.equal(r.matchedFiles, 1);
    assert.ok(r.aggregate.impactedEndpoints.some((e) => e.path === "/api/contracts/{id}"));
    // Onda 2 aditiva
    assert.ok(r.breaking, "breaking presente no caminho diff");
    assert.ok(Array.isArray(r.breaking!.alerts));
    assert.ok(Array.isArray(r.breaking!.blindSpots) && r.breaking!.blindSpots.length >= 3);
    // o CONTRACT_DIFF só MODIFICA o corpo de update (não remove decl) → 0 quebra
    assert.equal(r.breaking!.summary.candidates, 0, JSON.stringify(r.breaking!.summary));
  });

  it("OFF: computeImpactForFiles NUNCA carrega `breaking` (sem conteúdo não há classificação)", () => {
    const r = computeImpactForFiles(MANIFEST, ["src/main/java/ContractService.java"]);
    assert.equal((r as any).breaking, undefined);
  });

  it("remoção ALCANÇADA no diff → alerta com consumidores; markdown ganha a seção de quebras", () => {
    const removalDiff = `diff --git a/src/main/java/ContractService.java b/src/main/java/ContractService.java
--- a/src/main/java/ContractService.java
+++ b/src/main/java/ContractService.java
@@ -40,3 +40,1 @@ public class ContractService {
-    public Contract update(Long id, ContractDto dto) {
-    }
`;
    const r = computeImpactForDiff(MANIFEST, removalDiff);
    assert.equal(r.breaking!.alerts.length, 1);
    assert.equal(r.breaking!.alerts[0].symbol, "ContractService.update");
    const md = renderImpactDiffMarkdown(r, { projectName: "fixture" });
    assert.match(md, /Quebras de contrato \(breaking × alcance\)/);
    assert.match(md, /ContractService\.update/);
    assert.match(md, /Limites desta análise/);
  });

  it("quebra MORTA no diff → 0 alerta, contada, e o markdown a lista como suprimida", () => {
    const deadDiff = `diff --git a/src/main/java/OrphanService.java b/src/main/java/OrphanService.java
--- a/src/main/java/OrphanService.java
+++ b/src/main/java/OrphanService.java
@@ -8,2 +8,0 @@ public class OrphanService {
-    public void unusedHelper(String x) {
-    }
`;
    const r = computeImpactForDiff(MANIFEST, deadDiff);
    assert.equal(r.breaking!.alerts.length, 0);
    assert.equal(r.breaking!.suppressedDead.length, 1);
    const md = renderImpactDiffMarkdown(r);
    assert.match(md, /sem consumidor no grafo conhecido/);
    assert.match(md, /OrphanService\.unusedHelper/);
  });

  it("diff SEM quebra → markdown NÃO ganha a seção (relatório limpo)", () => {
    const md = renderImpactDiffMarkdown(computeImpactForDiff(MANIFEST, CONTRACT_DIFF));
    assert.ok(!/Quebras de contrato/.test(md), md.slice(0, 300));
  });
});

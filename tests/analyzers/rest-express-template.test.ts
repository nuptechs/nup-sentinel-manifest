// ─────────────────────────────────────────────
// rest-express-template — unit tests (ADR-0015 Onda 1, D6)
//
// Captura de HTTP escondido no template rest-express: useQuery({queryKey}) e
// apiRequest(method, url), resolvidos contra o backend por matchUrlToEndpoint.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractRestExpressInteractions } from "../../server/analyzers/frontend/rest-express-template.ts";
import { ApplicationGraph } from "../../server/analyzers/application-graph.ts";

// Grafo mínimo com um CONTROLLER sintético em /easynup/findContracts.v1,
// pra exercitar a resolução (mappedBackendNode) sem subir o pipeline inteiro.
function graphWithWsV1(): ApplicationGraph {
  const g = new ApplicationGraph();
  g.addNode({
    id: "ws-find",
    type: "CONTROLLER",
    className: "FindContractsWsV1",
    methodName: "execute",
    filePath: "FindContractsWsV1.java",
    metadata: { synthetic: true, fullPath: "/easynup/findContracts.v1", httpMethod: "GET" },
  } as any);
  return g;
}

describe("extractRestExpressInteractions — queryKey como URL", () => {
  it("useQuery({queryKey:['/url']}) vira interação GET nomeada pela variável", () => {
    const file = {
      filePath: "frontend/src/pages/Contracts.vue",
      content: `const contractsQuery = useQuery({ queryKey: ["/easynup/findContracts.v1"] });`,
    };
    const out = extractRestExpressInteractions([file], graphWithWsV1());
    assert.equal(out.length, 1);
    assert.equal(out[0].actionName, "contractsQuery");
    assert.equal(out[0].httpMethod, "GET");
    assert.equal(out[0].url, "/easynup/findContracts.v1");
    assert.equal(out[0].interactionCategory, "HTTP");
    assert.ok(out[0].mappedBackendNode, "queryKey não resolveu pro WsV1");
  });

  it("queryKey sem URL (só chave lógica) é ignorado", () => {
    const file = {
      filePath: "X.vue",
      content: `useQuery({ queryKey: ["contracts", id] });`,
    };
    assert.deepEqual(extractRestExpressInteractions([file], graphWithWsV1()), []);
  });
});

describe("extractRestExpressInteractions — apiRequest(method, url)", () => {
  it("apiRequest('POST', '/url') captura método e URL", () => {
    const file = {
      filePath: "Y.vue",
      content: `await apiRequest("POST", "/easynup/createContractNote.v1");`,
    };
    const [i] = extractRestExpressInteractions([file], graphWithWsV1());
    assert.equal(i.httpMethod, "POST");
    assert.equal(i.url, "/easynup/createContractNote.v1");
    assert.equal(i.actionName, "apiRequest");
  });

  it("apiRequest('/url') sem método assume GET", () => {
    const file = { filePath: "Z.vue", content: `apiRequest("/easynup/findContracts.v1");` };
    const [i] = extractRestExpressInteractions([file], graphWithWsV1());
    assert.equal(i.httpMethod, "GET");
    assert.equal(i.url, "/easynup/findContracts.v1");
    assert.ok(i.mappedBackendNode);
  });

  it("ignora arquivos sem useQuery/apiRequest e .java", () => {
    assert.deepEqual(
      extractRestExpressInteractions([{ filePath: "a.ts", content: "const x = 1;" }], graphWithWsV1()),
      [],
    );
    assert.deepEqual(
      extractRestExpressInteractions([{ filePath: "A.java", content: `useQuery({queryKey:["/x"]})` }], graphWithWsV1()),
      [],
    );
  });
});

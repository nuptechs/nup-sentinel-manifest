// ─────────────────────────────────────────────
// reasoner/mechanism — o Sentinel orquestra o agente, ATERRADO (fecha o eixo mecanismo).
// Esqueleto determinístico (BFS forward, ordem ≈ sequência, runtime por passo) +
// narração de LLM sob gate (passo sem edgeId provado é DESCARTADO).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ShapedGraph, ShapedNode, ShapedEdge } from "../../server/analyzers/system-graph.ts";
import { buildMechanismSkeleton, traceMechanism } from "../../server/reasoner/mechanism.ts";

function node(id: string, type: string, extra: Partial<ShapedNode> = {}): ShapedNode {
  return { id, type, className: id.split(":").pop(), inDegree: 0, outDegree: 0, sensitive: false, evidence: { method: "STATIC_PROVEN", confidence: 0.7 }, ...extra } as ShapedNode;
}
function edge(from: string, to: string, rel: string, extra: Partial<ShapedEdge> = {}): ShapedEdge {
  return { fromNode: from, toNode: to, relationType: rel, evidence: { method: "STATIC_PROVEN", confidence: 0.7 }, ...extra };
}
function graph(nodes: ShapedNode[], edges: ShapedEdge[]): ShapedGraph {
  return { level: "class", truncated: false, counts: { nodes: nodes.length, edges: edges.length, byType: {} }, coverage: { edges: { byMethod: {} as any, total: edges.length, observedRatio: 0 }, nodes: { observed: 0, total: nodes.length } }, nodes, edges };
}

// Fluxo: Ctrl → Svc → Repo → Ent, com um ramo (Svc chama Logger também) e uma
// aresta runtime-observada (Svc→Repo).
function flow(): ShapedGraph {
  const nodes = [
    node("CONTROLLER:Ctrl", "CONTROLLER"),
    node("SERVICE:Svc", "SERVICE"),
    node("REPOSITORY:Repo", "REPOSITORY"),
    node("ENTITY:Ent", "ENTITY"),
    node("SERVICE:Logger", "SERVICE"),
  ];
  const edges = [
    edge("CONTROLLER:Ctrl", "SERVICE:Svc", "CALLS"),
    edge("SERVICE:Svc", "REPOSITORY:Repo", "CALLS", { observed: true, evidence: { method: "RUNTIME_OBSERVED", confidence: 0.99 } }),
    edge("SERVICE:Svc", "SERVICE:Logger", "CALLS"),
    edge("REPOSITORY:Repo", "ENTITY:Ent", "WRITES_ENTITY"),
    edge("ENTITY:Ent", "ENTITY:Ent", "EXTENDS"), // NÃO-fluxo: deve ser ignorado
  ];
  return graph(nodes, edges);
}

describe("reasoner/mechanism — buildMechanismSkeleton (determinístico, ordenado)", () => {
  it("traça o fluxo forward em ordem de alcance, só arestas de FLUXO", () => {
    const { steps } = buildMechanismSkeleton(flow(), "CONTROLLER:Ctrl");
    // Ctrl→Svc (order 1), depois Svc→Repo/Logger, depois Repo→Ent. EXTENDS ignorado.
    assert.equal(steps[0].fromLabel, "Ctrl");
    assert.equal(steps[0].toLabel, "Svc");
    assert.ok(steps.some((s) => s.fromLabel === "Svc" && s.toLabel === "Repo"));
    assert.ok(steps.some((s) => s.fromLabel === "Repo" && s.toLabel === "Ent"));
    assert.ok(!steps.some((s) => s.relationType === "EXTENDS"), "aresta estrutural (EXTENDS) não entra no mecanismo");
  });
  it("marca runtime-confirmado por passo (o que o agente cru NÃO sabe)", () => {
    const { steps } = buildMechanismSkeleton(flow(), "CONTROLLER:Ctrl");
    const svcRepo = steps.find((s) => s.fromLabel === "Svc" && s.toLabel === "Repo")!;
    assert.equal(svcRepo.runtimeConfirmed, true);
    const svcLog = steps.find((s) => s.toLabel === "Logger")!;
    assert.equal(svcLog.runtimeConfirmed, false);
  });
  it("runtime-observado ordena antes do só-estático no mesmo nó (o quente primeiro)", () => {
    const { steps } = buildMechanismSkeleton(flow(), "CONTROLLER:Ctrl");
    const fromSvc = steps.filter((s) => s.fromLabel === "Svc").map((s) => s.toLabel);
    assert.equal(fromSvc[0], "Repo", "o passo runtime-observado vem primeiro");
  });
  it("detecta ponto de decisão (fan-out > 1) — Svc tem 2 saídas", () => {
    const { branches } = buildMechanismSkeleton(flow(), "CONTROLLER:Ctrl");
    assert.ok(branches.some((b) => b.atLabel === "Svc" && b.fanOut === 2));
  });
  it("é DETERMINÍSTICO — mesma entrada, mesma ordem de edgeId", () => {
    const a = buildMechanismSkeleton(flow(), "CONTROLLER:Ctrl").steps.map((s) => s.edgeId);
    const b = buildMechanismSkeleton(flow(), "CONTROLLER:Ctrl").steps.map((s) => s.edgeId);
    assert.deepEqual(a, b);
  });
  it("nunca lança com grafo vazio", () => {
    assert.doesNotThrow(() => buildMechanismSkeleton(graph([], []), "x"));
  });
});

describe("reasoner/mechanism — traceMechanism (orquestração do agente, sob gate)", () => {
  it("resolve a entrada por substring e sem LLM usa template determinístico", async () => {
    const rep = await traceMechanism(flow(), "Ctrl", null);
    assert.equal(rep.resolvedEntryId, "CONTROLLER:Ctrl");
    assert.equal(rep.mode, "deterministic");
    assert.ok(rep.steps.length >= 3);
    assert.ok(rep.runtimeConfirmed >= 1);
    assert.match(rep.steps[0].text, /PROVADO/);
    assert.match(rep.summary, /aresta provada/);
  });
  it("entrada inexistente → nada a traçar, não lança", async () => {
    const rep = await traceMechanism(flow(), "NAO_EXISTE", null);
    assert.equal(rep.resolvedEntryId, null);
    assert.equal(rep.steps.length, 0);
  });
  it("LLM aterrado: nomeia a intenção do passo provado; CHUTE off-map é REJEITADO", async () => {
    const fakeLLM = async (_sys: string, user: string) => {
      // pega um edgeId real do prompt + injeta um chute inexistente
      const m = user.match(/"edgeId":\s*"([^"]+)"/);
      const real = m ? m[1] : "";
      return JSON.stringify([
        { edgeId: real, text: "O controller inicia o fluxo de negócio chamando o serviço." },
        { edgeId: "CHUTE|CALLS|INVENTADO", text: "alucinação de um passo que não existe" },
      ]);
    };
    const rep = await traceMechanism(flow(), "Ctrl", fakeLLM);
    assert.equal(rep.mode, "llm-grounded");
    assert.ok(rep.steps.some((s) => /fluxo de negócio/.test(s.text)), "a intenção nomeada foi acoplada ao passo provado");
    assert.equal(rep.grounding.rejected, 1, "o chute não-ancorado foi rejeitado");
    assert.equal(rep.grounding.rejectedClaims[0].anchorId, "CHUTE|CALLS|INVENTADO");
  });
});

// ─────────────────────────────────────────────
// reasoner/dead-code — TRIAGEM por CONVERGÊNCIA TRI-EIXO (net-new, above-SOTA).
//
// A pergunta que a leitura só-código não responde: "o que está MORTO?". Cruza
// ESTÁTICO (sem chamador/chamadores refutados) × RUNTIME (¬observado) × CONFIG/ROLE
// (¬ponto-de-entrada). O muro honesto: "não-alcançável-pelo-robô" = UNKNOWN, NÃO
// morto. A IA só redige a pergunta, sob o gate de grounding.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shapeSystemGraph, type ShapedGraph, type ShapedNode, type ShapedEdge } from "../../server/analyzers/system-graph.ts";
import { findDeadCodeCandidates, triageDeadCode } from "../../server/reasoner/dead-code.ts";

// Constrói um ShapedGraph direto (unit puro da lógica tri-eixo, sem depender da
// agregação class-level do shaper). Só os campos que a triagem lê.
function node(p: Partial<ShapedNode> & { id: string; type: string }): ShapedNode {
  return {
    inDegree: 0,
    outDegree: 0,
    sensitive: false,
    evidence: { method: "STATIC_PROVEN", confidence: 0.7 },
    ...p,
  } as ShapedNode;
}
function edge(fromNode: string, toNode: string, extra: Partial<ShapedEdge> = {}): ShapedEdge {
  return { fromNode, toNode, relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.7 }, ...extra };
}
function graph(nodes: ShapedNode[], edges: ShapedEdge[]): ShapedGraph {
  return {
    level: "class",
    truncated: false,
    counts: { nodes: nodes.length, edges: edges.length, byType: {} },
    coverage: { edges: { byMethod: {} as any, total: edges.length, observedRatio: 0 }, nodes: { observed: 0, total: nodes.length } },
    nodes,
    edges,
  };
}

// Cenário canônico com um representante de CADA classe de decisão.
function scenario(): ShapedGraph {
  const nodes: ShapedNode[] = [
    node({ id: "CONTROLLER:Ctrl", type: "CONTROLLER", className: "Ctrl", inDegree: 0, outDegree: 3 }),
    node({ id: "SERVICE:Live", type: "SERVICE", className: "Live", inDegree: 1, runtimeHot: true, observed: true, evidence: { method: "RUNTIME_OBSERVED", confidence: 0.99 } }),
    node({ id: "SERVICE:DeadIsolated", type: "SERVICE", className: "DeadIsolated", inDegree: 0, outDegree: 0, sourceFile: "src/DeadIsolated.java" }),
    node({ id: "SERVICE:DiSuspect", type: "SERVICE", className: "DiSuspect", inDegree: 0, outDegree: 2 }),
    node({ id: "SERVICE:ScheduledJob", type: "SERVICE", className: "ScheduledJob", inDegree: 0, entryPoint: ["@Scheduled"] }),
    node({ id: "SERVICE:ObservedOrphan", type: "SERVICE", className: "ObservedOrphan", inDegree: 0, runtimeHot: true, observed: true }),
    node({ id: "SERVICE:DeadRefuted", type: "SERVICE", className: "DeadRefuted", inDegree: 1, outDegree: 0 }),
    node({ id: "SERVICE:WallUnknown", type: "SERVICE", className: "WallUnknown", inDegree: 1 }),
    node({ id: "ENTITY:Ent", type: "ENTITY", className: "Ent", inDegree: 0 }),
  ];
  const edges: ShapedEdge[] = [
    edge("CONTROLLER:Ctrl", "SERVICE:Live"),
    edge("CONTROLLER:Ctrl", "SERVICE:DeadRefuted", { refuted: { subtype: "REFUTED_LIKELY_DEAD", attempts: 4, windows: 3 } }),
    edge("CONTROLLER:Ctrl", "SERVICE:WallUnknown", { refuted: { subtype: "REFUTED_UNREACHABLE_BY_ROBOT", reason: "auth/admin" } }),
  ];
  return graph(nodes, edges);
}

describe("reasoner/dead-code — findDeadCodeCandidates (determinístico, tri-eixo)", () => {
  it("marca ISOLATED (forte): sem chamador E sem chamadas ∧ ¬runtime ∧ ¬entrada", () => {
    const { candidates } = findDeadCodeCandidates(scenario());
    const iso = candidates.find((c) => c.node.id === "SERVICE:DeadIsolated");
    assert.ok(iso, "DeadIsolated deve ser candidato");
    assert.equal(iso!.tier, "isolated");
    assert.equal(iso!.confidence, 0.75);
  });

  it("marca NO-PROVEN-CALLER (advisory): sem entrada mas COM saída = suspeita de DI", () => {
    const { candidates } = findDeadCodeCandidates(scenario());
    const di = candidates.find((c) => c.node.id === "SERVICE:DiSuspect");
    assert.ok(di, "DiSuspect deve ser candidato advisory");
    assert.equal(di!.tier, "no-proven-caller");
    assert.equal(di!.confidence, 0.4);
    assert.ok(di!.reasons.some((r) => /injeção de dependência|reflexão/i.test(r)), "ressalva de DI na cara");
  });

  it("marca RUNTIME-REFUTED: chamadores existem mas TODOS refutados como likely-dead", () => {
    const { candidates } = findDeadCodeCandidates(scenario());
    const ref = candidates.find((c) => c.node.id === "SERVICE:DeadRefuted");
    assert.ok(ref, "DeadRefuted deve ser candidato");
    assert.equal(ref!.tier, "runtime-refuted");
  });

  it("ROLLUP: módulo com inDegree 0 mas função `::fn` chamada NÃO é isolado (mata FP)", () => {
    // Reproduz o FP real do identify: o serviço (MÓDULO) não recebe aresta direta,
    // mas a agregação scip resolve a chamada em granularidade de FUNÇÃO — a aresta
    // aterrissa em `node:...svc.ts::verifyAuditChain`. Sem o rollup, o módulo parece
    // isolado. Com o rollup, deixa de ser candidato.
    const nodes: ShapedNode[] = [
      node({ id: "node:server/routes/audit.routes.ts", type: "MODULE", inDegree: 0, outDegree: 1 }),
      node({ id: "node:server/services/audit-verify.service.ts", type: "SERVICE", inDegree: 0, outDegree: 0, sourceFile: "server/services/audit-verify.service.ts" }),
    ];
    const edges: ShapedEdge[] = [
      // aresta file-scoped: chamador (arquivo) → SUB-NÓ de função do serviço
      edge("node:server/routes/audit.routes.ts::<module>", "node:server/services/audit-verify.service.ts::verifyAuditChain", { resolution: "compiler" }),
    ];
    const { candidates } = findDeadCodeCandidates(graph(nodes, edges));
    assert.ok(
      !candidates.some((c) => c.node.id === "node:server/services/audit-verify.service.ts"),
      "serviço com função chamada NÃO deve ser candidato a dead-code",
    );
  });

  it("ROLLUP não mascara morto de verdade: módulo SEM função chamada segue isolado", () => {
    const nodes: ShapedNode[] = [
      node({ id: "node:server/services/orphan.service.ts", type: "SERVICE", inDegree: 0, outDegree: 0, sourceFile: "server/services/orphan.service.ts" }),
      node({ id: "node:server/services/other.service.ts", type: "SERVICE", inDegree: 0, outDegree: 0, sourceFile: "server/services/other.service.ts" }),
    ];
    // aresta entra num sub-nó de OUTRO módulo — não credita o orphan.
    const edges: ShapedEdge[] = [edge("X::<module>", "node:server/services/other.service.ts::used")];
    const { candidates } = findDeadCodeCandidates(graph(nodes, edges));
    assert.ok(candidates.some((c) => c.node.id === "node:server/services/orphan.service.ts" && c.tier === "isolated"), "orphan continua isolado");
  });

  it("IMPORT-REACHABILITY: arquivo IMPORTADO por outro (barril/tipos/DI) NÃO é morto", () => {
    // Modelo Knip: um arquivo referenciado por outro arquivo do projeto está em uso,
    // mesmo sem chamada de função resolvida (re-export puro, namespace-import, tipos).
    const nodes: ShapedNode[] = [
      node({ id: "node:server/services/permission.service.ts", type: "SERVICE", inDegree: 0, outDegree: 0, sourceFile: "server/services/permission.service.ts" }),
      node({ id: "node:server/services/really-dead.service.ts", type: "SERVICE", inDegree: 0, outDegree: 0, sourceFile: "server/services/really-dead.service.ts" }),
    ];
    const importReach = new Set(["server/services/permission.service.ts"]); // barril importado
    const { candidates, excluded } = findDeadCodeCandidates(graph(nodes, []), importReach);
    assert.ok(!candidates.some((c) => c.node.id === "node:server/services/permission.service.ts"), "barril importado NÃO é candidato");
    assert.equal(excluded.importReachable, 1);
    // o que NÃO é importado segue morto (não mascara morto de verdade)
    assert.ok(candidates.some((c) => c.node.id === "node:server/services/really-dead.service.ts" && c.tier === "isolated"), "arquivo não-importado continua isolado");
  });

  it("import-reachability sem o set (retrocompat) NÃO exclui nada", () => {
    const nodes: ShapedNode[] = [node({ id: "node:x.service.ts", type: "SERVICE", inDegree: 0, outDegree: 0, sourceFile: "x.service.ts" })];
    const { candidates, excluded } = findDeadCodeCandidates(graph(nodes, [])); // sem 2º arg
    assert.equal(excluded.importReachable, 0);
    assert.ok(candidates.some((c) => c.node.id === "node:x.service.ts"), "sem sinal de import, comportamento antigo");
  });

  it("EXCLUI gatilho @Scheduled (root legítimo) e superfície CONTROLLER — nenhum é morto", () => {
    const { candidates, excluded } = findDeadCodeCandidates(scenario());
    assert.ok(!candidates.some((c) => c.node.id === "SERVICE:ScheduledJob"));
    assert.ok(!candidates.some((c) => c.node.id === "CONTROLLER:Ctrl"));
    assert.equal(excluded.entryPoints, 1); // ScheduledJob (gatilho explícito)
    assert.equal(excluded.entrySurfaces, 1); // Ctrl (superfície HTTP por tipo)
  });

  it("EXCLUI nó observado em runtime — vivo de fato", () => {
    const { candidates, excluded } = findDeadCodeCandidates(scenario());
    assert.ok(!candidates.some((c) => c.node.id === "SERVICE:ObservedOrphan"));
    assert.equal(excluded.runtimeObserved, 1);
  });

  it("O MURO: 'não-alcançável-pelo-robô' é UNKNOWN, NÃO morto (exclui honesto)", () => {
    const { candidates, excluded } = findDeadCodeCandidates(scenario());
    assert.ok(!candidates.some((c) => c.node.id === "SERVICE:WallUnknown"), "não pode virar candidato a morto");
    assert.equal(excluded.unreachableByRobot, 1);
  });

  it("IGNORA tipos estruturais (ENTITY) — dado, não código a remover", () => {
    const { candidates } = findDeadCodeCandidates(scenario());
    assert.ok(!candidates.some((c) => c.node.id === "ENTITY:Ent"));
  });

  it("3 candidatos, ordenados por confiança (isolated > refuted > di-suspect)", () => {
    const { candidates } = findDeadCodeCandidates(scenario());
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].node.id, "SERVICE:DeadIsolated"); // 0.75
    assert.equal(candidates[1].node.id, "SERVICE:DeadRefuted"); // 0.70
    assert.equal(candidates[2].node.id, "SERVICE:DiSuspect"); // 0.40
  });

  it("grafo sem mortos → zero candidatos, nunca lança", () => {
    const g = graph([node({ id: "SERVICE:A", type: "SERVICE", inDegree: 1, runtimeHot: true, observed: true })], []);
    assert.doesNotThrow(() => findDeadCodeCandidates(g));
    assert.equal(findDeadCodeCandidates(g).candidates.length, 0);
  });
});

describe("reasoner/dead-code — triageDeadCode (camada de IA sob gate)", () => {
  it("sem LLM → modo determinístico, pergunta-template, livro-razão vazio", async () => {
    const rep = await triageDeadCode(scenario(), null);
    assert.equal(rep.mode, "deterministic");
    assert.equal(rep.candidates.length, 3);
    assert.match(rep.candidates[0].question, /Vale investigar a remoção\?/);
    assert.equal(rep.grounding.proposed, 0);
    assert.equal(rep.grounding.groundingRate, 1);
    assert.match(rep.summary, /candidato\(s\) a código morto/);
  });

  it("LLM grounded: pergunta ancorada FICA, claim off-map é REJEITADO e contado", async () => {
    const fakeLLM = async () =>
      JSON.stringify([
        { nodeId: "SERVICE:DeadIsolated", text: "DeadStrong é usado por reflexão em algum ponto? Confirmar antes de remover." },
        { nodeId: "SERVICE:NAO_EXISTE", text: "alucinação sobre um nó inventado" },
      ]);
    const rep = await triageDeadCode(scenario(), fakeLLM);
    assert.equal(rep.mode, "llm-grounded");
    const strong = rep.candidates.find((c) => c.nodeId === "SERVICE:DeadIsolated")!;
    assert.match(strong.question, /reflexão/); // a pergunta da IA foi acoplada ao candidato certo
    // o claim off-map foi BLOQUEADO e MEDIDO
    assert.equal(rep.grounding.rejected, 1);
    assert.equal(rep.grounding.rejectedClaims[0].anchorId, "SERVICE:NAO_EXISTE");
    assert.equal(rep.grounding.rejectedClaims[0].reason, "off-map");
    assert.equal(rep.grounding.groundingRate, 0.5);
  });

  it("LLM que devolve lixo → fail-soft para template determinístico", async () => {
    const rep = await triageDeadCode(scenario(), async () => "isto não é JSON");
    // nada sobreviveu ao parse → cai no template, mas não quebra
    assert.equal(rep.candidates.length, 3);
    assert.ok(rep.candidates.every((c) => typeof c.question === "string" && c.question.length > 0));
  });
});

describe("reasoner/dead-code — integração pelo shaper real (Furo 3/4 no caminho)", () => {
  it("shapeSystemGraph → strong/entrypoint/observed classificados corretamente", () => {
    const raw = {
      nodes: [
        { id: "CONTROLLER:d.Ctrl", type: "CONTROLLER", className: "Ctrl" },
        { id: "SERVICE:d.Used", type: "SERVICE", className: "Used" },
        { id: "SERVICE:d.Orphan", type: "SERVICE", className: "Orphan" },
        { id: "SERVICE:d.Job", type: "SERVICE", className: "Job", metadata: { entryPoint: "@Scheduled" } },
      ],
      edges: [{ fromNode: "CONTROLLER:d.Ctrl", toNode: "SERVICE:d.Used", relationType: "CALLS", metadata: { resolution: "compiler" } }],
    };
    const shaped = shapeSystemGraph(raw as any, "class");
    const { candidates, excluded } = findDeadCodeCandidates(shaped);
    // Orphan: SERVICE sem inbound, sem entrada, sem runtime → isolated
    assert.ok(candidates.some((c) => c.node.id.includes("Orphan") && c.tier === "isolated"));
    // Job = gatilho @Scheduled → excluído; Ctrl = superfície HTTP → excluído
    assert.ok(!candidates.some((c) => c.node.id.includes("Job")));
    assert.ok(!candidates.some((c) => c.node.id.includes("Ctrl")));
    assert.equal(excluded.entryPoints, 1); // Job
    assert.equal(excluded.entrySurfaces, 1); // Ctrl
    // Used tem chamador → não é candidato
    assert.ok(!candidates.some((c) => c.node.id.includes("Used")));
  });
});

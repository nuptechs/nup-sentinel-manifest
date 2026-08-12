// ─────────────────────────────────────────────────────────────────────────
// Gerador de diagrama de sequência — domínio puro (mapeamento + renderer) +
// catálogo. Prova: confiança por seta, fonte honesta (runtime/static/none),
// db read/write, escape Mermaid, dedup de rota (prefere observada).
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mechanismToSequence, type MechReportLike } from "../../server/reasoner/sequence/sequence-model.ts";
import { toMermaid } from "../../server/reasoner/sequence/sequence-render.ts";
import { graphEntryCatalog } from "../../server/reasoner/adapters/entry-catalog.adapter.ts";

function report(steps: MechReportLike["steps"], extra: Partial<MechReportLike> = {}): MechReportLike {
  return { entry: "e", resolvedEntryId: "route:GET:/x", steps, ...extra };
}

describe("sequence — mechanismToSequence (mapeamento puro)", () => {
  it("runtime-confirmado → confiança 'observed' e fonte 'runtime'", () => {
    const m = mechanismToSequence(report([
      { order: 1, fromLabel: "Route", toLabel: "UserService", method: "RUNTIME_OBSERVED", runtimeConfirmed: true },
      { order: 2, fromLabel: "UserService", toLabel: "UserRepository", relationType: "CALLS", method: "STATIC_PROVEN" },
    ], { runtimeConfirmed: 1, runtimeOrderedSteps: 2, orderSource: "runtime-partial" }));
    assert.equal(m.messages[0].confidence, "observed");
    assert.equal(m.messages[1].confidence, "proven");
    assert.ok(m.source === "runtime" || m.source === "runtime-partial");
    assert.equal(m.stats.steps, 2);
  });

  it("só estático provado → fonte 'static' e setas 'proven'", () => {
    const m = mechanismToSequence(report([
      { order: 1, fromLabel: "Route", toLabel: "Svc", relationType: "CALLS", method: "STATIC_PROVEN", resolution: "compiler" },
    ]));
    assert.equal(m.source, "static");
    assert.equal(m.messages[0].confidence, "proven");
    assert.ok(m.notes.some((n) => /topologia|ordem real/i.test(n)));
  });

  it("heurístico (não provado) → 'inferred'", () => {
    const m = mechanismToSequence(report([{ order: 1, fromLabel: "A", toLabel: "B", relationType: "CALLS", method: "STATIC_UNRESOLVED" }]));
    assert.equal(m.messages[0].confidence, "inferred");
  });

  it("READS/WRITES_ENTITY viram db-read/db-write; auto-chamada é colapsada", () => {
    const m = mechanismToSequence(report([
      { order: 1, fromLabel: "Svc", toLabel: "users", relationType: "READS_ENTITY", method: "STATIC_PROVEN" },
      { order: 2, fromLabel: "Svc", toLabel: "audit", relationType: "WRITES_ENTITY", method: "STATIC_PROVEN" },
      { order: 3, fromLabel: "Svc", toLabel: "Svc", relationType: "CALLS", method: "STATIC_PROVEN" }, // auto → colapsa
    ]));
    assert.equal(m.messages.length, 2);
    assert.equal(m.messages[0].kind, "db-read");
    assert.equal(m.messages[1].kind, "db-write");
  });

  it("alvo tipado ENTITY (tabela) → lifeline 'db' + mensagem db-read com verbo 'lê'", () => {
    const m = mechanismToSequence(
      report([{ order: 1, fromLabel: "Route", toLabel: "users", relationType: "CALLS", method: "RUNTIME_OBSERVED", runtimeConfirmed: true }]),
      { labelType: new Map([["users", "ENTITY"]]) },
    );
    const usersP = m.participants.find((p) => p.label === "users");
    assert.equal(usersP?.kind, "db", "tabela vira lifeline db");
    assert.equal(m.messages[0].kind, "db-read", "toque de runtime numa tabela = leitura");
    assert.match(toMermaid(m), /lê users/);
  });

  it("sem passos → fonte 'none' com nota honesta (não finge)", () => {
    const m = mechanismToSequence(report([]));
    assert.equal(m.source, "none");
    assert.equal(m.messages.length, 0);
    assert.ok(m.notes.some((n) => /sem sequência|exercite/i.test(n)));
  });

  it("ramos detectados viram nota (caminho principal)", () => {
    const m = mechanismToSequence(report([{ order: 1, fromLabel: "A", toLabel: "B", method: "STATIC_PROVEN" }], { branches: [{ atLabel: "A", fanOut: 3 }] }));
    assert.ok(m.notes.some((n) => /ramo|decisão/i.test(n)));
    assert.equal(m.stats.branches, 1);
  });
});

describe("sequence — toMermaid (renderer)", () => {
  it("gera sequenceDiagram com participantes e mensagens; inferido = tracejado", () => {
    const m = mechanismToSequence(report([
      { order: 1, fromLabel: "Route", toLabel: "Svc", method: "RUNTIME_OBSERVED", runtimeConfirmed: true },
      { order: 2, fromLabel: "Svc", toLabel: "Guess", relationType: "CALLS", method: "STATIC_UNRESOLVED" },
    ]));
    const mm = toMermaid(m);
    assert.match(mm, /^sequenceDiagram/);
    assert.match(mm, /participant \w+ as Route/);
    assert.match(mm, /Route->>Svc:/); // observado = seta cheia
    assert.match(mm, /Svc-->>\w+:/); // inferido = seta tracejada
    assert.match(mm, /note over .*Fonte/); // legenda de honestidade
    assert.match(mm, /setas ---> são inferidas/); // aviso de inferência
  });

  it("db-read/write ganham verbo; rótulos com ':'/';' são escapados (não quebram o parser)", () => {
    const m = mechanismToSequence(report([{ order: 1, fromLabel: "Svc", toLabel: "SELECT: users; join", relationType: "READS_ENTITY", method: "STATIC_PROVEN" }]));
    const mm = toMermaid(m);
    assert.match(mm, /lê /);
    assert.ok(!/: SELECT: users; join/.test(mm), "sem ':'/';' cru no rótulo");
  });

  it("fonte 'runtime-partial' → legenda OBSERVADO (não 'sem dados')", () => {
    const m = mechanismToSequence(report([
      { order: 1, fromLabel: "Route", toLabel: "Svc", method: "RUNTIME_OBSERVED", runtimeConfirmed: true },
    ], { runtimeConfirmed: 1, runtimeOrderedSteps: 1, orderSource: "runtime-partial" }));
    const mm = toMermaid(m);
    assert.match(mm, /Fonte — OBSERVADO/);
    assert.ok(!/Fonte — sem dados/.test(mm), "não deve dizer 'sem dados' quando há execução observada");
  });

  it("modelo vazio → diagrama honesto sem passos (não lança)", () => {
    const mm = toMermaid(mechanismToSequence(report([])));
    assert.match(mm, /^sequenceDiagram/);
    assert.match(mm, /sem passos resolvidos/);
  });
});

describe("sequence — graphEntryCatalog", () => {
  const graph = {
    nodes: [
      { id: "route:runtime:GET:/api/users", type: "ROUTE", observed: true },
      { id: "route:GET:/api/users", type: "ROUTE", observed: false }, // duplicata estática
      { id: "CONTROLLER:AuthController", type: "CONTROLLER", className: "AuthController", httpMethod: "POST", endpoint: "/login" },
      { id: "SERVICE:ReconcileJob", type: "SERVICE", className: "ReconcileJob", entryPoint: ["@Scheduled"] },
      { id: "SERVICE:Plain", type: "SERVICE", className: "Plain" }, // nem rota nem batch → fora
    ],
  };
  it("enumera rotas + batch; dedup rota runtime×estática prefere a OBSERVADA", () => {
    const cat = graphEntryCatalog(graph).list();
    const users = cat.filter((e) => e.httpPath === "/api/users");
    assert.equal(users.length, 1, "rota dedupada");
    assert.equal(users[0].id, "route:runtime:GET:/api/users", "prefere a observada/runtime");
    assert.ok(cat.some((e) => e.kind === "batch" && /ReconcileJob/.test(e.label)));
    assert.ok(!cat.some((e) => e.id === "SERVICE:Plain"), "serviço sem rota/gatilho fica fora");
  });
  it("resolve por id, rótulo e substring", () => {
    const cat = graphEntryCatalog(graph);
    assert.equal(cat.resolve("route:runtime:GET:/api/users")?.httpPath, "/api/users");
    assert.equal(cat.resolve("POST /login")?.id, "CONTROLLER:AuthController");
    assert.equal(cat.resolve("reconcile")?.kind, "batch");
    assert.equal(cat.resolve("nada-existe"), null);
  });
});

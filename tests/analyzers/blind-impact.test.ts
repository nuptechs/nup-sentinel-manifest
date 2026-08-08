import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBimr, isLikelyInfrastructureTable } from "../../server/analyzers/blind-impact";

// ─────────────────────────────────────────────────────────────────────────
// BIMR — o número que prova o ponto cego do leitor SÓ-estático.
// Fixture espelha a forma REAL que o `runtime-overlay` produz (verificada no
// projeto 27, 2026-08-08): entidade resolvida ganha `runtimeHot`; tabela sem
// entidade vira nó `table:<nome>` com `synthetic + runtimeOnly`; a fonte de
// runtime é o nó sintético `runtime:db:<serviço>` (tipo ROUTE).
// ─────────────────────────────────────────────────────────────────────────

const entity = (fqn: string, className: string, hot?: number) => ({
  id: `ENTITY:${fqn}`,
  type: "ENTITY",
  className,
  metadata: hot ? { runtimeHot: true, runtimeCount: hot } : {},
});
const minted = (table: string, hot = 3) => ({
  id: `table:${table}`,
  type: "ENTITY",
  className: table,
  metadata: { runtimeOnly: true, observed: true, synthetic: true, runtimeHot: true, runtimeCount: hot },
});
const runtimeSource = {
  id: "runtime:db:easynup-backend",
  type: "ROUTE",
  className: "db@easynup-backend",
  metadata: { runtimeOnly: true, observed: true, synthetic: true, runtimeHot: true },
};
const rtEdge = (to: string) => ({
  fromNode: "runtime:db:easynup-backend",
  toNode: to,
  relationType: "RUNTIME_OBSERVED",
  metadata: { observed: true, source: "jaeger", count: 4 },
});
const staticEdge = (from: string, to: string) => ({
  fromNode: from,
  toNode: to,
  relationType: "WRITES",
  metadata: { resolution: "compiler" },
});

describe("computeBimr — a taxa do que a leitura estática não vê", () => {
  it("separa observado em resolvido × mintado e calcula a taxa", () => {
    const graph = {
      nodes: [
        runtimeSource,
        entity("d.SlaIndicator", "SlaIndicator", 10),
        entity("d.AuditLog", "AuditLog", 5),
        entity("d.Frio", "Frio"), // existe no código, sem tráfego → fora da conta
        minted("legacy_ledger", 7),
      ],
      edges: [
        rtEdge("ENTITY:d.SlaIndicator"),
        rtEdge("ENTITY:d.AuditLog"),
        rtEdge("table:legacy_ledger"),
        staticEdge("REPOSITORY:d.SlaRepo", "ENTITY:d.SlaIndicator"),
        staticEdge("REPOSITORY:d.AuditRepo", "ENTITY:d.AuditLog"),
      ],
    };
    const r = computeBimr(graph);
    assert.equal(r.measurable, true);
    assert.equal(r.tablesObservedRuntime, 3); // Frio NÃO entra (sem tráfego)
    assert.equal(r.tablesResolvedStatic, 2);
    assert.equal(r.tablesMintedRuntimeOnly, 1);
    assert.equal(r.mintedRatio, round(1 / 3));
    assert.deepEqual(r.minted.map((m) => m.table), ["legacy_ledger"]);
    assert.equal(r.minted[0].runtimeCount, 7);
    assert.equal(r.minted[0].likelyInfrastructure, false);
  });

  it("mintado é SÓ pelo metadata — id `table:` sem flags é entidade REAL do modelo (caso NuPIdentify)", () => {
    // Dogfood 2º sistema (2026-08-08): o analyzer TS modela entidades Drizzle
    // com id `table:<nome>` — MESMO namespace do mint do overlay. O antigo
    // fallback por prefixo classificava as 53 entidades REAIS do identify como
    // "invisíveis ao estático" → BIMR 100% FALSO. Prefixo NUNCA decide.
    const entidadeRealDrizzle = { id: "table:identity_users", type: "ENTITY", className: "identity_users", metadata: { runtimeHot: true } };
    const r = computeBimr({ nodes: [entidadeRealDrizzle], edges: [] });
    assert.equal(r.tablesMintedRuntimeOnly, 0);
    assert.equal(r.tablesResolvedStatic, 1); // observada em runtime E existe no modelo
    assert.equal(r.mintedRatio, 0);
  });

  it("mintado de verdade (synthetic+runtimeOnly) segue mintado, mesmo shape de id", () => {
    const mintadoReal = { id: "table:orfa", type: "ENTITY", className: "orfa", metadata: { runtimeHot: true, synthetic: true, runtimeOnly: true } };
    const r = computeBimr({ nodes: [mintadoReal], edges: [] });
    assert.equal(r.tablesMintedRuntimeOnly, 1);
    assert.equal(r.tablesResolvedStatic, 0);
  });

  it("entidade quente por ARESTA de runtime conta mesmo sem `runtimeHot` no nó", () => {
    const graph = {
      nodes: [runtimeSource, entity("d.SemFlag", "SemFlag")],
      edges: [rtEdge("ENTITY:d.SemFlag")],
    };
    const r = computeBimr(graph);
    assert.equal(r.tablesObservedRuntime, 1);
    assert.equal(r.tablesResolvedStatic, 1);
  });

  it("infraestrutura é MARCADA e descontada na 2ª taxa — nunca apagada em silêncio", () => {
    const graph = {
      nodes: [
        runtimeSource,
        entity("d.SlaIndicator", "SlaIndicator", 10),
        minted("databasechangelog"),
        minted("legacy_ledger"),
      ],
      edges: [rtEdge("ENTITY:d.SlaIndicator"), rtEdge("table:databasechangelog"), rtEdge("table:legacy_ledger")],
    };
    const r = computeBimr(graph);
    assert.equal(r.tablesMintedRuntimeOnly, 2);
    assert.equal(r.mintedRatio, round(2 / 3)); // taxa crua mantém as duas
    // sem infra: 1 mintada de domínio sobre 2 observadas
    assert.equal(r.observedExcludingInfrastructure, 2);
    assert.equal(r.mintedRatioExcludingInfrastructure, 0.5);
    // a de infra continua LISTADA, só marcada
    const infra = r.minted.find((m) => m.table === "databasechangelog")!;
    assert.equal(infra.likelyInfrastructure, true);
    assert.ok(r.caveats.some((c) => /INFRAESTRUTURA/i.test(c)));
  });

  it("entidade quente SEM aresta estática entrante é o 2º sinal de cegueira", () => {
    const graph = {
      nodes: [
        runtimeSource,
        entity("d.Ligada", "Ligada", 3),
        entity("d.Orfa", "Orfa", 9), // roda, existe no código, ninguém a alcança
        minted("legacy_ledger"),
      ],
      edges: [
        rtEdge("ENTITY:d.Ligada"),
        rtEdge("ENTITY:d.Orfa"),
        rtEdge("table:legacy_ledger"),
        staticEdge("REPOSITORY:d.Repo", "ENTITY:d.Ligada"),
      ],
    };
    const r = computeBimr(graph);
    assert.equal(r.entitiesHotWithoutStaticInbound.count, 1);
    assert.equal(r.entitiesHotWithoutStaticInbound.nodes[0].label, "Orfa");
    assert.equal(r.entitiesHotWithoutStaticInbound.nodes[0].runtimeCount, 9);
    // mintada NÃO entra aqui — seria contar o mesmo furo duas vezes
    assert.ok(!r.entitiesHotWithoutStaticInbound.nodes.some((n) => n.id.startsWith("table:")));
  });

  it("aresta de runtime NÃO conta como inbound estático (o teste que pega o bug)", () => {
    // Se o filtro de "inbound estático" esquecesse de excluir as arestas de
    // runtime, TODA entidade quente teria inbound (a própria aresta que a marcou)
    // e o 2º sinal ficaria sempre 0 — silenciosamente inútil.
    const graph = {
      nodes: [runtimeSource, entity("d.So", "So", 2)],
      edges: [rtEdge("ENTITY:d.So")],
    };
    assert.equal(computeBimr(graph).entitiesHotWithoutStaticInbound.count, 1);
  });

  it("sem runtime: NÃO mensurável (0% seria mentira) — e não lança", () => {
    const r = computeBimr({
      nodes: [entity("d.A", "A"), entity("d.B", "B")],
      edges: [staticEdge("REPOSITORY:d.R", "ENTITY:d.A")],
    });
    assert.equal(r.measurable, false);
    assert.match(r.reason || "", /não é mensurável/i);
    assert.equal(r.tablesObservedRuntime, 0);
    assert.equal(r.mintedRatio, 0);
    assert.deepEqual(r.caveats, []);
  });

  it("entrada malformada degrada sem lançar", () => {
    for (const bad of [null, undefined, {} as never, { nodes: null, edges: null } as never]) {
      const r = computeBimr(bad as never);
      assert.equal(r.measurable, false);
      assert.equal(r.tablesObservedRuntime, 0);
    }
  });

  it("caveat do denominador é SEMPRE dito quando há medida", () => {
    const graph = { nodes: [runtimeSource, minted("x")], edges: [rtEdge("table:x")] };
    const r = computeBimr(graph);
    assert.ok(r.caveats.some((c) => /JANELA observada/i.test(c)));
    assert.ok(r.caveats.some((c) => /@Table/.test(c)), "avisa do falso ponto cego por @Table divergente");
  });
});

describe("isLikelyInfrastructureTable — conservador de propósito", () => {
  it("reconhece migração/lock/sessão", () => {
    for (const t of ["databasechangelog", "DATABASECHANGELOGLOCK", "flyway_schema_history", "shedlock", "qrtz_triggers", "scheduled_job_lock", "spring_session_attributes"]) {
      assert.equal(isLikelyInfrastructureTable(t), true, t);
    }
  });
  it("NÃO marca tabela de domínio (na dúvida, expõe o ponto cego)", () => {
    for (const t of ["contract", "audit_log", "legacy_ledger", "sla_indicator", "user"]) {
      assert.equal(isLikelyInfrastructureTable(t), false, t);
    }
  });
});

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

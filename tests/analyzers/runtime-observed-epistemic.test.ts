import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractRuntimePairs,
  applyRuntimeOverlay,
  type JaegerTrace,
} from "../../server/analyzers/runtime-overlay";
import { ApplicationGraph, GraphNode } from "../../server/analyzers/application-graph";
import { shapeSystemGraph } from "../../server/analyzers/system-graph";

// ── ADR-0028 P1.1 — a PROVA de ponta a ponta ──
// Arestas observadas em traço → `observed:true` no grafo → sobrevivem à
// serialização do snapshot (`toJSON`) → viram `evidence.method=RUNTIME_OBSERVED`
// e `coverage.observedRatio>0` no `shapeSystemGraph` (o que o `/graph` serve e o
// ledger de recall P0.2b lê). É o caminho inteiro que estava com observedRatio=0.

const tag = (key: string, value: unknown) => ({ key, value });
function trace(traceID: string, spans: Array<{ svc: string; id?: string; parent?: string; tags?: Record<string, unknown> }>): JaegerTrace {
  const processes: Record<string, { serviceName: string }> = {};
  const jspans = spans.map((s, i) => {
    const pid = `p_${s.svc}`;
    processes[pid] = { serviceName: s.svc };
    return {
      spanID: s.id || `s${i}`,
      operationName: "",
      processID: pid,
      references: s.parent ? [{ refType: "CHILD_OF", traceID, spanID: s.parent }] : [],
      tags: Object.entries(s.tags || {}).map(([k, v]) => tag(k, v)),
    };
  });
  return { traceID, spans: jspans, processes };
}

/** Grafo ESTÁTICO mínimo: 1 rota + 1 entidade, ligadas por uma aresta estática. */
function staticGraph() {
  const g = new ApplicationGraph();
  g.addNode(new GraphNode("route:GET:/api/users/:id", "ROUTE", "/api/users/:id", null, null, {
    httpMethod: "GET", fullPath: "/api/users/:id",
  }));
  g.addNode(new GraphNode("entity:User", "ENTITY", "User", null, null, {}));
  return g;
}

describe("ADR-0028 P1.1 — observedRatio flui do traço ao grafo servido", () => {
  it("serviço NÃO-easynup (NuPIdentify) acende observedRatio>0 quando o gateway service casa", () => {
    // Um traço do PRÓPRIO NuPIdentify: http de entrada + JDBC no MESMO serviço.
    const t = trace("t-id-1", [
      { svc: "nupidentify", id: "http", tags: { "url.path": "/api/users/7?x=1", "http.request.method": "GET" } },
      { svc: "nupidentify", id: "jdbc", parent: "http", tags: { "db.sql.table": "user", "db.operation": "SELECT" } },
    ]);

    // extração mira o serviço do PROJETO (o que a config por-projeto resolve).
    const pairs = extractRuntimePairs([t], { gatewayServices: ["nupidentify"] });
    assert.equal(pairs.length, 1);

    const g = staticGraph();
    const ov = applyRuntimeOverlay(g, pairs);
    assert.equal(ov.routesMatched, 1);       // casou a rota estática :id
    assert.equal(ov.entityEdges, 1);         // rota→entidade OBSERVADA
    assert.equal(ov.tablesResolved, 1);      // tabela `user` → ENTITY `User`

    // Serialização do snapshot (idêntica ao pipeline: appGraph.toJSON()).
    const serialized = g.toJSON();
    // A aresta observada e o nó hot sobrevivem ao JSON:
    const obsEdge = serialized.edges.find((e) => e.relationType === "RUNTIME_OBSERVED");
    assert.ok(obsEdge, "aresta RUNTIME_OBSERVED deve estar no snapshot");
    assert.equal((obsEdge!.metadata as Record<string, unknown>).observed, true);

    // O que o /graph serve: shapeSystemGraph deriva o censo epistêmico.
    const shaped = shapeSystemGraph(serialized, "method");
    assert.ok(shaped.coverage.edges.observedRatio > 0, "observedRatio DEVE ser > 0");
    assert.equal(shaped.coverage.edges.byMethod.RUNTIME_OBSERVED, 1);
    assert.ok(shaped.coverage.nodes.observed >= 1, "≥1 nó observado (runtimeHot)");
    // a própria aresta shaped carrega a evidência mais forte:
    const shapedObs = shaped.edges.find((e) => e.relationType === "RUNTIME_OBSERVED");
    assert.equal(shapedObs!.evidence.method, "RUNTIME_OBSERVED");
    assert.equal(shapedObs!.evidence.confidence, 0.95);
  });

  it("sem overlay aplicado → observedRatio=0 (byte-a-byte; a costura é o que acende)", () => {
    const shaped = shapeSystemGraph(staticGraph().toJSON(), "method");
    assert.equal(shaped.coverage.edges.byMethod.RUNTIME_OBSERVED, 0);
    assert.equal(shaped.coverage.edges.observedRatio, 0);
  });
});

// ── Correção do RUNTIME_OBSERVED:0 (o cenário AO VIVO) ──
// O hub tinha traços `easynup-backend` COM spans de DB, mas a análise passava só
// `[cfg.gatewayService]` (= 'easynup-gateway') como raiz. Um traço rooteado no
// BACKEND (Java recebendo `/easynup/op.v1` + JDBC) não era minerado → 0 aresta,
// mesmo com o hub cheio. Este teste PROVA a regressão e o conserto.
describe("RUNTIME_OBSERVED:0 — traço rooteado no BACKEND é minerado quando o serviço é raiz", () => {
  // Um traço 100% no easynup-backend: SERVER span Java (http de entrada) + JDBC.
  const backendTrace = () =>
    trace("t-be-1", [
      { svc: "easynup-backend", id: "srv", tags: { "url.path": "/api/users/7", "http.route": "/api/users/:id", "http.request.method": "GET" } },
      { svc: "easynup-backend", id: "jdbc", parent: "srv", tags: { "db.sql.table": "user", "db.operation": "SELECT" } },
    ]);

  it("SÓ o gateway como raiz (o bug) → 0 pares, 0 aresta observada", () => {
    const pairs = extractRuntimePairs([backendTrace()], { gatewayServices: ["easynup-gateway"] });
    assert.equal(pairs.length, 0, "backend-rooted trace descartado quando só o gateway é raiz");
    const ov = applyRuntimeOverlay(staticGraph(), pairs);
    assert.equal(ov.entityEdges, 0);
  });

  it("backend na lista de raízes (o conserto) → mina o traço e produz RUNTIME_OBSERVED", () => {
    // = o que o pipeline agora passa: cfg.gatewayServices (gateway + backend).
    const pairs = extractRuntimePairs([backendTrace()], { gatewayServices: ["easynup-gateway", "easynup-backend"] });
    assert.equal(pairs.length, 1);

    const g = staticGraph();
    const ov = applyRuntimeOverlay(g, pairs);
    assert.equal(ov.routesMatched, 1);   // casou a rota estática :id
    assert.equal(ov.entityEdges, 1);     // rota→entidade OBSERVADA
    assert.equal(ov.tablesResolved, 1);  // tabela `user` → ENTITY `User`

    const shaped = shapeSystemGraph(g.toJSON(), "method");
    assert.equal(shaped.coverage.edges.byMethod.RUNTIME_OBSERVED, 1);
    assert.ok(shaped.coverage.edges.observedRatio > 0);
  });
});

// ── Mapeamento DIRETO tabela→ENTITY (o TRAÇO FRAGMENTO — achado ao vivo 2026-08-07) ──
// O hub tem traços `easynup-backend` que são FRAGMENTOS: spans de DB com
// db.sql.table MAS SEM span de rota (o Gateway roda deploy antigo e não exporta).
// O par rota→tabela acha 0. O mapeamento direto marca a ENTIDADE como
// RUNTIME_OBSERVED mesmo assim — a evidência que o mapa quer.
import {
  extractRuntimeTableHits,
  applyRuntimeTableObservations,
  normalizeTableName,
  runRuntimeOverlay,
  type ResolvedRuntimeOverlayConfig,
} from "../../server/analyzers/runtime-overlay";

/** Grafo com uma ENTITY no shape REAL do java-analyzer (id=ENTITY:<FQN>, className simples). */
function entityGraph() {
  const g = new ApplicationGraph();
  g.addNode(new GraphNode("ENTITY:easynup.persistence.entities.AuditLog", "ENTITY", "AuditLog", null, null, {
    sourceFile: "src/main/java/easynup/persistence/entities/AuditLog.java",
  }));
  g.addNode(new GraphNode("ENTITY:easynup.persistence.entities.SlaIndicator", "ENTITY", "SlaIndicator", null, null, {
    sourceFile: "src/main/java/easynup/persistence/entities/SlaIndicator.java",
  }));
  return g;
}

describe("normalizeTableName — schema-strip + snake", () => {
  it("tira o schema/db e normaliza (railway.audit_log → audit_log)", () => {
    assert.equal(normalizeTableName("railway.audit_log"), "audit_log");
    assert.equal(normalizeTableName("audit_log"), "audit_log");
    assert.equal(normalizeTableName('"public"."sla_indicator"'), "sla_indicator");
    assert.equal(normalizeTableName(""), "");
  });
});

describe("traço FRAGMENTO (só span de DB, sem rota) → RUNTIME_OBSERVED na entidade", () => {
  // Um traço `easynup-backend` como o hub REALMENTE tem: NENHUM span de rota,
  // só spans de DB (schema `railway` no nome, como visto ao vivo).
  const fragment = () =>
    trace("t-frag-1", [
      { svc: "easynup-backend", id: "jdbc1", tags: { "db.sql.table": "railway.audit_log", "db.operation": "SELECT" } },
      { svc: "easynup-backend", id: "jdbc2", tags: { "db.statement": "SELECT id FROM sla_indicator WHERE x=?", "db.operation": "SELECT" } },
    ]);

  it("o par rota→tabela acha 0 (sem span de rota) — o bug", () => {
    const pairs = extractRuntimePairs([fragment()], { gatewayServices: ["easynup-gateway", "easynup-backend"] });
    assert.equal(pairs.length, 0, "sem span de rota, o caminho rota→tabela é 0 (por isso RUNTIME_OBSERVED=0 antes)");
  });

  it("tabela→ENTITY direto casa snake↔Camel e marca a entidade RUNTIME_OBSERVED", () => {
    const hits = extractRuntimeTableHits([fragment()]);
    const tables = hits.map((h) => h.table).sort();
    assert.deepEqual(tables, ["audit_log", "sla_indicator"], "achou as 2 tabelas, schema-stripped");

    const g = entityGraph();
    const res = applyRuntimeTableObservations(g, hits);
    assert.equal(res.entitiesResolved, 2, "audit_log→AuditLog e sla_indicator→SlaIndicator casaram");
    assert.equal(res.tablesMinted, 0);
    assert.equal(res.nodesMarked, 2);
    assert.ok(res.edges >= 2, "arestas RUNTIME_OBSERVED fonte→entidade emitidas");

    // o que o /graph serve: censo de NÓS e de ARESTAS acende
    const shaped = shapeSystemGraph(g.toJSON(), "method");
    assert.ok(shaped.coverage.nodes.observed >= 2, "≥2 nós de entidade observados (runtimeHot)");
    assert.ok(shaped.coverage.edges.byMethod.RUNTIME_OBSERVED >= 2, "≥2 arestas RUNTIME_OBSERVED no censo");
    // a entidade AuditLog carrega evidência RUNTIME_OBSERVED
    const auditNode = shaped.nodes.find((n) => n.id === "ENTITY:easynup.persistence.entities.AuditLog");
    assert.equal(auditNode!.evidence.method, "RUNTIME_OBSERVED");
  });

  it("@Table(name=) divergente: hit de tabela casa a ENTITY pelo metadata.tableName (mata o falso ponto cego)", () => {
    const hits = extractRuntimeTableHits([
      trace("t-frag-tn", [{ svc: "easynup-backend", id: "j", tags: { "db.sql.table": "railway.tb_usuario_legado", "db.operation": "SELECT" } }]),
    ]);
    const g = entityGraph();
    g.addNode(new GraphNode("ENTITY:easynup.persistence.entities.LegacyUser", "ENTITY", "LegacyUser", null, null, {
      tableName: "TB_USUARIO_LEGADO", // emitido pelo engine Java a partir do literal @Table(name=)
    }));
    const res = applyRuntimeTableObservations(g, hits);
    assert.equal(res.entitiesResolved, 1, "tb_usuario_legado→LegacyUser casou pelo tableName explícito");
    assert.equal(res.tablesMinted, 0, "não mintou table:tb_usuario_legado (antes era o falso ponto cego)");
    const md = g.getNode("ENTITY:easynup.persistence.entities.LegacyUser")!.metadata as Record<string, unknown>;
    assert.equal(md.runtimeHot, true);
  });

  it("tabela sem ENTITY correspondente → minta table:<n> observada (nunca some em silêncio)", () => {
    const hits = extractRuntimeTableHits([
      trace("t-frag-2", [{ svc: "easynup-backend", id: "j", tags: { "db.sql.table": "orphan_table", "db.operation": "INSERT" } }]),
    ]);
    const g = entityGraph();
    const res = applyRuntimeTableObservations(g, hits);
    assert.equal(res.tablesMinted, 1);
    assert.ok(g.getNode("table:orphan_table"), "nó table:<n> mintado");
  });
});

describe("runRuntimeOverlay — orquestrador (o caminho que o pipeline invoca) LOGA e mescla", () => {
  const cfg: ResolvedRuntimeOverlayConfig = {
    jaegerUrl: "http://hub", apiKey: null,
    services: ["easynup-gateway", "easynup-backend"],
    gatewayService: "easynup-gateway",
    gatewayServices: ["easynup-gateway", "easynup-backend"],
    lookbackMs: 86400000, limit: 400,
  };
  // fetch fake: devolve o traço FRAGMENTO para qualquer serviço.
  const fakeFetch = (() =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        data: [trace("t-frag-3", [{ svc: "easynup-backend", id: "j", tags: { "db.sql.table": "railway.audit_log", "db.operation": "SELECT" } }])],
      }),
    })) as unknown as typeof fetch;

  it("busca traços, mescla tabela→ENTITY, e emite log honesto SEMPRE", async () => {
    const g = entityGraph();
    const logs: string[] = [];
    const summary = await runRuntimeOverlay(g, cfg, { onLog: (m) => logs.push(m), fetchFn: fakeFetch });

    // LOG honesto sempre (config + traços + spans-DB + arestas por caminho)
    assert.ok(logs.some((l) => l.includes("Runtime overlay ON")), "loga a config ON");
    assert.ok(logs.some((l) => l.includes("spans-DB=")), "loga nº de spans de DB");
    assert.ok(logs.some((l) => l.includes("TABELA→ENTIDADE")), "loga o caminho tabela→entidade");
    assert.ok(logs.some((l) => l.includes("FRAGMENTO")), "explica o caso fragmento");

    // resultado: a entidade foi observada mesmo sem rota
    assert.ok(summary.tablesObserved >= 1);
    assert.ok(summary.entitiesResolved >= 1);
    assert.equal(summary.routePairs, 0);
    const shaped = shapeSystemGraph(g.toJSON(), "method");
    assert.ok(shaped.coverage.nodes.observed >= 1);
    assert.ok(shaped.coverage.edges.byMethod.RUNTIME_OBSERVED >= 1);
  });

  it("fail-soft: fetch que rejeita → 0, nunca lança, e ainda loga a config", async () => {
    const g = entityGraph();
    const logs: string[] = [];
    const badFetch = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    const summary = await runRuntimeOverlay(g, cfg, { onLog: (m) => logs.push(m), fetchFn: badFetch });
    assert.equal(summary.traces, 0);
    assert.equal(summary.tablesObserved, 0);
    assert.ok(logs.some((l) => l.includes("Runtime overlay ON")), "loga config mesmo com fetch falho");
  });
});

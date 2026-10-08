import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confirmTripleOrphan,
  suspectsFromOrphanSurface,
  suspectsFromDeadCode,
  type StaticSuspect,
  type TripleOrphanAxes,
} from "../../server/analyzers/triple-orphan";
import { findOrphanSurfaces } from "../../server/analyzers/orphan-surface";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// OBS-E06 — convergência tri-eixo. O ponto crítico: morte só é CONFIRMADA quando
// estático+runtime+config concordam; sem cobertura de runtime o veredito é UNKNOWN,
// nunca "morto" (ausência ≠ morte). IA nunca entra — 100% determinístico.

const suspect = (nodeId: string, over: Partial<StaticSuspect> = {}): StaticSuspect => ({
  nodeId,
  type: "SERVICE",
  label: nodeId.split(":").pop() || nodeId,
  staticConfidence: 0.75,
  staticReasons: ["sem chamador provado"],
  staticSource: "dead-code",
  ...over,
});

describe("confirmTripleOrphan — fail-closed sem runtime", () => {
  it("sem cobertura de runtime → UNKNOWN, nenhum confirmado (honesto)", () => {
    const r = confirmTripleOrphan([suspect("svc:Dead")], { runtimeCoveragePresent: false });
    assert.equal(r.confirmed.length, 0);
    assert.equal(r.unknownNoRuntime.length, 1);
    assert.equal(r.unknownNoRuntime[0].state, "unknown-no-runtime");
    assert.match(r.summary, /UNKNOWN/);
  });
});

describe("confirmTripleOrphan — 3 eixos concordam → confirmado", () => {
  const axes: TripleOrphanAxes = {
    runtimeCoveragePresent: true,
    observedNodeIds: new Set<string>(),
    entryPointIds: new Set<string>(),
    importReachableIds: new Set<string>(),
    configEntryIds: new Set<string>(),
  };

  it("estático suspeito + runtime observando-e-nunca-viu + config limpo → confirmed, confiança <1", () => {
    const r = confirmTripleOrphan([suspect("svc:Dead")], axes);
    assert.equal(r.confirmed.length, 1);
    const v = r.confirmed[0];
    assert.equal(v.state, "confirmed");
    assert.ok(v.confidence! > 0.75 && v.confidence! < 1, `confiança sobe mas < 1: ${v.confidence}`);
    assert.equal(v.axes.runtime.coveragePresent, true);
    assert.equal(v.axes.runtime.observed, false);
  });
});

describe("confirmTripleOrphan — qualquer eixo refuta", () => {
  const base: TripleOrphanAxes = { runtimeCoveragePresent: true };

  it("observado em runtime → refuted por runtime-observed", () => {
    const r = confirmTripleOrphan([suspect("svc:Live")], { ...base, observedNodeIds: new Set(["svc:Live"]) });
    assert.equal(r.confirmed.length, 0);
    assert.equal(r.refuted[0].refutedBy?.[0], "runtime-observed");
  });

  it("ponto de entrada → refuted", () => {
    const r = confirmTripleOrphan([suspect("svc:Cron")], { ...base, entryPointIds: new Set(["svc:Cron"]) });
    assert.deepEqual(r.refuted[0].refutedBy, ["config-entry-point"]);
  });

  it("import-reachable por sourceFile → refuted", () => {
    const s = suspect("svc:Barrel", { sourceFile: "server/util/index.ts" });
    const r = confirmTripleOrphan([s], { ...base, importReachableIds: new Set(["server/util/index.ts"]) });
    assert.deepEqual(r.refuted[0].refutedBy, ["import-reachable"]);
  });

  it("vários eixos refutam → refutedBy lista TODOS (transparência)", () => {
    const s = suspect("svc:Multi", { sourceFile: "f.ts" });
    const r = confirmTripleOrphan([s], {
      ...base,
      observedNodeIds: new Set(["svc:Multi"]),
      configEntryIds: new Set(["f.ts"]),
    });
    assert.deepEqual(r.refuted[0].refutedBy, ["runtime-observed", "config-entry"]);
  });
});

describe("confirmTripleOrphan — compõe as saídas da leva 1", () => {
  it("suspectsFromOrphanSurface converte candidatos (E01) em suspeitos estáticos", () => {
    const raw: RawSystemGraph = {
      nodes: [
        { id: "ROUTER:app", type: "SERVICE", className: "appRouter", metadata: {} },
        { id: "ROUTE:/mounted", type: "ROUTE", className: "mounted", metadata: {} },
        { id: "ROUTE:/orphan", type: "ROUTE", className: "orphan", metadata: {} },
      ],
      edges: [{ fromNode: "ROUTER:app", toNode: "ROUTE:/mounted", relationType: "HANDLES_ROUTE", metadata: {} }],
    };
    const report = findOrphanSurfaces(shapeSystemGraph(raw, "method"));
    const suspects = suspectsFromOrphanSurface(report);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].nodeId, "ROUTE:/orphan");
    assert.equal(suspects[0].staticSource, "orphan-surface");

    // com runtime cobrindo e nada refutando → o órfão de rota vira morto confirmado
    const r = confirmTripleOrphan(suspects, { runtimeCoveragePresent: true });
    assert.equal(r.confirmed.length, 1);
    assert.equal(r.confirmed[0].nodeId, "ROUTE:/orphan");
  });

  it("suspectsFromOrphanSurface é VAZIO quando o detector está cego (sem wiring)", () => {
    const raw: RawSystemGraph = {
      nodes: [{ id: "ROUTE:/x", type: "ROUTE", className: "x", metadata: {} }],
      edges: [],
    };
    const report = findOrphanSurfaces(shapeSystemGraph(raw, "method"));
    assert.equal(report.wiringPresent, false);
    assert.equal(suspectsFromOrphanSurface(report).length, 0);
  });

  it("suspectsFromDeadCode mapeia candidatos de dead-code", () => {
    const s = suspectsFromDeadCode([{ nodeId: "svc:X", type: "SERVICE", label: "X", confidence: 0.7, reasons: ["isolado"] }]);
    assert.equal(s[0].staticSource, "dead-code");
    assert.equal(s[0].staticConfidence, 0.7);
  });
});

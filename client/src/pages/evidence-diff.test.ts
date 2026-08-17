import { describe, it, expect } from "vitest";
import { buildAndon, computeDiff, isValidPoint, type EvidenceHistory, type HistoryPoint } from "./evidence-diff";

function pt(runId: number, over: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    runId,
    gitSha: `sha${runId}0000`,
    completedAt: `2026-08-${String(runId).padStart(2, "0")}T12:00:00Z`,
    coverage: {
      edges: { total: 100, byMethod: { STATIC_PROVEN: 60, RUNTIME_OBSERVED: 20 }, observedRatio: 0.2 },
      nodes: { observed: 10, total: 100 },
    },
    ...over,
  };
}

describe("isValidPoint", () => {
  it("null coverage = inválido (buraco, não zero)", () => {
    expect(isValidPoint(pt(1, { coverage: null }))).toBe(false);
  });
  it("failed = inválido", () => {
    expect(isValidPoint(pt(1, { failed: true }))).toBe(false);
  });
  it("com coverage e sem falha = válido", () => {
    expect(isValidPoint(pt(1))).toBe(true);
  });
});

describe("computeDiff", () => {
  it("pega os 2 últimos pontos VÁLIDOS, pulando buracos", () => {
    const history: EvidenceHistory = {
      points: [
        pt(1),
        pt(2, { coverage: null }), // buraco
        pt(3, { coverage: { edges: { total: 120, byMethod: { STATIC_PROVEN: 70, RUNTIME_OBSERVED: 30 }, observedRatio: 0.25 }, nodes: { observed: 12, total: 120 } } }),
      ],
    };
    const diff = computeDiff(history);
    expect(diff.current?.runId).toBe(3);
    expect(diff.previous?.runId).toBe(1);
    expect(diff.holes).toBe(1);
  });

  it("delta por método reflete a diferença; observedRatioDelta calculado", () => {
    const history: EvidenceHistory = {
      points: [
        pt(1),
        pt(2, { coverage: { edges: { total: 120, byMethod: { STATIC_PROVEN: 70, RUNTIME_OBSERVED: 30 }, observedRatio: 0.25 }, nodes: { observed: 12, total: 120 } } }),
      ],
    };
    const diff = computeDiff(history);
    const runtime = diff.deltas.find((d) => d.method === "RUNTIME_OBSERVED")!;
    expect(runtime.before).toBe(20);
    expect(runtime.after).toBe(30);
    expect(runtime.delta).toBe(10);
    expect(diff.observedRatioDelta).toBeCloseTo(0.05, 3);
  });

  it("um único ponto válido → current sem previous (buraco honesto)", () => {
    const diff = computeDiff({ points: [pt(1)] });
    expect(diff.current).toBeTruthy();
    expect(diff.previous).toBeNull();
    expect(diff.observedRatioDelta).toBeNull();
  });

  it("sem pontos → current null", () => {
    expect(computeDiff({ points: [] }).current).toBeNull();
  });
});

describe("buildAndon", () => {
  const emptyDiff = computeDiff({ points: [pt(1)] });

  it("culprit absent vira crit; stale vira warn", () => {
    const items = buildAndon(
      { culprits: [{ axis: "runtime", status: "absent", reason: "24h sem traço" }, { axis: "static", status: "stale" }] },
      null,
      emptyDiff,
    );
    expect(items.find((i) => i.level === "crit")).toBeTruthy();
    expect(items.find((i) => i.level === "warn")).toBeTruthy();
  });

  it("novo ciclo de serviço vira crit", () => {
    const items = buildAndon(null, { newServiceCycles: [["A", "B"]] }, emptyDiff);
    expect(items.some((i) => i.level === "crit" && /ciclo/i.test(i.title))).toBe(true);
  });

  it("queda de observedRatio ≥3pts acende warn a partir do diff", () => {
    const drop = computeDiff({
      points: [
        pt(1, { coverage: { edges: { total: 100, byMethod: { RUNTIME_OBSERVED: 40 }, observedRatio: 0.4 }, nodes: { observed: 40, total: 100 } } }),
        pt(2, { coverage: { edges: { total: 100, byMethod: { RUNTIME_OBSERVED: 30 }, observedRatio: 0.3 }, nodes: { observed: 30, total: 100 } } }),
      ],
    });
    const items = buildAndon(null, null, drop);
    expect(items.some((i) => /cobertura de runtime caiu/i.test(i.title))).toBe(true);
  });

  it("nada errado → item 'good' (nunca lista vazia)", () => {
    const items = buildAndon({ culprits: [] }, { edges: { added: 0, removed: 0 }, newServiceCycles: [] }, emptyDiff);
    expect(items).toHaveLength(1);
    expect(items[0].level).toBe("good");
  });
});

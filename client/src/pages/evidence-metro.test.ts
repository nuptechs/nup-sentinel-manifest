import { describe, it, expect } from "vitest";
import { buildMetroLayout, type MetroLineInput, type SequenceModel } from "./evidence-metro";

function model(participants: string[], msgs: Array<[string, string, string?, string?]>): SequenceModel {
  return {
    source: "static",
    participants: participants.map((id) => ({ id, label: id })),
    messages: msgs.map(([from, to, conf, kind], order) => ({
      from,
      to,
      confidence: (conf as SequenceModel["messages"][number]["confidence"]) ?? "inferred",
      kind: kind as SequenceModel["messages"][number]["kind"],
      order,
    })),
  };
}

describe("buildMetroLayout", () => {
  it("cada rota vira uma linha com y distinto", () => {
    const inputs: MetroLineInput[] = [
      { routeLabel: "GET /a", model: model(["Route", "SvcA", "TblA"], [["Route", "SvcA"], ["SvcA", "TblA"]]) },
      { routeLabel: "GET /b", model: model(["Route", "SvcB"], [["Route", "SvcB"]]) },
    ];
    const layout = buildMetroLayout(inputs);
    expect(layout.lines).toHaveLength(2);
    expect(layout.lines[0].y).not.toBe(layout.lines[1].y);
    expect(layout.lines[0].routeLabel).toBe("GET /a");
  });

  it("participante compartilhado entre 2 linhas vira baldeação (interchange>=2, mesma coluna)", () => {
    const inputs: MetroLineInput[] = [
      { routeLabel: "L1", model: model(["Route", "Shared", "TblA"], [["Route", "Shared"], ["Shared", "TblA"]]) },
      { routeLabel: "L2", model: model(["Route", "Shared", "TblB"], [["Route", "Shared"], ["Shared", "TblB"]]) },
    ];
    const layout = buildMetroLayout(inputs);
    const shared = layout.columnLabels.find((c) => c.id === "Shared");
    expect(shared).toBeTruthy();
    expect(shared!.interchange).toBe(2);
    // a estação Shared ocupa a MESMA coluna x nas 2 linhas
    const xL1 = layout.lines[0].stations.find((s) => s.id === "Shared")!.x;
    const xL2 = layout.lines[1].stations.find((s) => s.id === "Shared")!.x;
    expect(xL1).toBe(xL2);
  });

  it("db-write vira estação-tabela (isDb)", () => {
    const inputs: MetroLineInput[] = [
      { routeLabel: "L1", model: model(["Route", "Svc", "contract"], [["Route", "Svc"], ["Svc", "contract", "observed", "db-write"]]) },
    ];
    const layout = buildMetroLayout(inputs);
    const tbl = layout.columnLabels.find((c) => c.id === "contract");
    expect(tbl?.isDb).toBe(true);
  });

  it("o pior elo manda na confiança do trecho (inferred < proven < observed)", () => {
    const inputs: MetroLineInput[] = [
      { routeLabel: "L1", model: model(["A", "B"], [["A", "B", "inferred"]]) },
    ];
    const layout = buildMetroLayout(inputs);
    expect(layout.lines[0].segments[0].confidence).toBe("inferred");
  });

  it("modelo source:none marca a linha como vazia (não inventa estações)", () => {
    const inputs: MetroLineInput[] = [{ routeLabel: "L1", model: { source: "none", participants: [], messages: [] } }];
    const layout = buildMetroLayout(inputs);
    expect(layout.lines[0].empty).toBe(true);
    expect(layout.lines[0].stations).toHaveLength(0);
  });

  it("lista vazia não quebra (largura mínima, sem linhas)", () => {
    const layout = buildMetroLayout([]);
    expect(layout.lines).toHaveLength(0);
    expect(layout.width).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
// system-map-narrative — unit tests (ADR-0033 P4.4/P4.5, frontend)
//
// Surfaça as PERSPECTIVAS e a NARRATIVA no /system-map. Aqui provamos os
// helpers puros + os componentes PRESENTACIONAIS (props, sem fetch): a lente
// mostra arestas verificadas E as REFUTADAS (nomeadas, nunca como fato); a
// lente vazia ≠ falhou (nota honesta); a prosa lista os statements com tom.
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  PERSONA_OPTIONS,
  pickPerspective,
  statementMeta,
  refutedMeta,
  PerspectivePanel,
  NarrativeProse,
  type PerspectiveDTO,
  type NarrativeDTO,
} from "./system-map-narrative";

afterEach(cleanup);

// ── Helpers puros ─────────────────────────────────────────────────────
describe("helpers puros", () => {
  it("PERSONA_OPTIONS cobre as 6 lentes, impacto primeiro", () => {
    expect(PERSONA_OPTIONS.map((p) => p.value)).toEqual(["impact", "dev", "security", "data", "architect", "business"]);
  });

  it("pickPerspective é defensivo (chave ausente / payload nulo → null)", () => {
    const v = { persona: "dev", label: "Desenvolvedor", focus: "x", edges: [], empty: true } as PerspectiveDTO;
    expect(pickPerspective({ dev: v }, "dev")).toBe(v);
    expect(pickPerspective({ dev: v }, "security")).toBeNull();
    expect(pickPerspective(null, "dev")).toBeNull();
    expect(pickPerspective(undefined, "dev")).toBeNull();
  });

  it("statementMeta distingue fato × ponto-cego × refutada × abstenção", () => {
    expect(statementMeta("edge").label).toBe("Fato");
    expect(statementMeta("blindspot").label).toBe("Ponto-cego");
    expect(statementMeta("refuted").label).toBe("Refutada");
    expect(statementMeta("abstain").label).toBe("Abstenção");
    expect(statementMeta("coverage").label).toBe("Censo");
    expect(statementMeta("qualquer-coisa").label).toBe("Censo"); // default seguro
  });

  it("refutedMeta grada honesto: morta-provável × UNKNOWN honesto", () => {
    expect(refutedMeta("REFUTED_LIKELY_DEAD").label).toMatch(/morta|falso-positivo/);
    expect(refutedMeta("REFUTED_UNREACHABLE_BY_ROBOT").label).toMatch(/não-confirmada|UNKNOWN honesto/);
    expect(refutedMeta("qualquer").label).toMatch(/não-confirmada/); // default seguro (não acusa morta)
  });
});

// ── PerspectivePanel — a lente mostra o verificado E o refutado ───────
describe("PerspectivePanel — perspectiva com arestas verificadas e REFUTADAS", () => {
  const view: PerspectiveDTO = {
    persona: "security",
    label: "Segurança",
    focus: "arestas tocando nós sensíveis",
    edges: [
      { edgeId: "a|b|CALLS", fromLabel: "AuthService", toLabel: "ContractService", relationType: "CALLS", method: "RUNTIME_OBSERVED", provenance: "observada em 5 traço(s) de runtime" },
    ],
    refutedEdges: [
      { edgeId: "leg|svc|CALLS", fromLabel: "LegacyAuth", toLabel: "ContractService", relationType: "CALLS", method: "STATIC_PROVEN", subtype: "REFUTED_LIKELY_DEAD", attempts: 3, provenance: "refutada pelo laço ativo (provável falso-positivo/código morto)" },
    ],
    empty: false,
  };

  it("renderiza a aresta verificada com o chip de método (runtime)", () => {
    render(<PerspectivePanel view={view} />);
    expect(screen.getByTestId("perspective-edges")).toBeTruthy();
    expect(screen.getByText("AuthService")).toBeTruthy();
    expect(screen.getByTestId("method-chip-RUNTIME_OBSERVED")).toBeTruthy();
  });

  it("REFUTA visivelmente: seção própria, grau honesto, NÃO afirmada como fato", () => {
    render(<PerspectivePanel view={view} />);
    const sec = screen.getByTestId("perspective-refuted");
    expect(sec).toBeTruthy();
    expect(screen.getByText(/Refutadas pelo laço ativo/)).toBeTruthy();
    // "falso-positivo" aparece no chip de grau E na proveniência — ambos dentro da seção refutada.
    expect(sec.textContent).toContain("falso-positivo");
    expect(screen.getByTestId("perspective-refuted-edge")).toBeTruthy();
    // a refutada NÃO aparece na seção de arestas verificadas.
    const verified = screen.getByTestId("perspective-edges");
    expect(verified.textContent).not.toContain("LegacyAuth");
  });
});

describe("PerspectivePanel — vazio ≠ falhou (lente sem casamento)", () => {
  it("lente vazia mostra nota honesta, não erro", () => {
    const empty: PerspectiveDTO = {
      persona: "security",
      label: "Segurança",
      focus: "x",
      edges: [],
      refutedEdges: [],
      blindSpots: [],
      empty: true,
      note: 'Nada verificado sob a lente "Segurança" para "Foo" (≠ falhou).',
    };
    render(<PerspectivePanel view={empty} />);
    expect(screen.getByTestId("perspective-empty")).toBeTruthy();
    expect(screen.getByText(/Nada verificado sob a lente/)).toBeTruthy();
  });

  it("lente com SÓ refutada NÃO é tratada como vazia (empty=false → mostra a refutada)", () => {
    const onlyRefuted: PerspectiveDTO = {
      persona: "data",
      label: "Dados",
      focus: "x",
      edges: [],
      refutedEdges: [
        { edgeId: "a|b|WRITES_ENTITY", fromLabel: "A", toLabel: "B", relationType: "WRITES_ENTITY", method: "STATIC_PROVEN", subtype: "REFUTED_UNREACHABLE_BY_ROBOT", provenance: "não-confirmada pelo robô — UNKNOWN honesto" },
      ],
      empty: false,
    };
    render(<PerspectivePanel view={onlyRefuted} />);
    expect(screen.queryByTestId("perspective-empty")).toBeNull();
    const sec = screen.getByTestId("perspective-refuted");
    expect(sec).toBeTruthy();
    expect(sec.textContent).toContain("UNKNOWN honesto");
  });
});

// ── NarrativeProse — a prosa travada ao grafo (statements) ────────────
describe("NarrativeProse — statements com tom (fato × cego × refutada)", () => {
  it("lista as frases com o rótulo de tom correto", () => {
    const narrative: NarrativeDTO = {
      symbol: "Contract",
      abstained: false,
      mode: "deterministic",
      overallConfidence: 0.9,
      overallMethod: "STATIC_PROVEN",
      prose: "…",
      statements: [
        { kind: "partition", text: "PROVADO afetado: 2 · POSSÍVEL: 1 · PONTO-CEGO: 1." },
        { kind: "edge", text: "PROVADO (runtime): X chama Y — observada.", edgeId: "x|y|CALLS", method: "RUNTIME_OBSERVED", origin: "deterministic" },
        { kind: "refuted", text: "O laço ativo REFUTOU 1 aresta… NÃO as afirmo.", origin: "deterministic" },
      ],
    };
    render(<NarrativeProse narrative={narrative} />);
    expect(screen.getByTestId("narrative-statement-partition")).toBeTruthy();
    expect(screen.getByTestId("narrative-statement-edge")).toBeTruthy();
    expect(screen.getByTestId("narrative-statement-refuted")).toBeTruthy();
    expect(screen.getByText("Fato")).toBeTruthy();
    expect(screen.getByText("Refutada")).toBeTruthy();
    expect(screen.getByText(/NÃO as afirmo/)).toBeTruthy();
  });
});

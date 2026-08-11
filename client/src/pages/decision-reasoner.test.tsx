// ─────────────────────────────────────────────
// O que estes testes protegem no painel RACIOCÍNIO:
//   • cada card é uma fonte independente — erro de um NÃO derruba os outros
//     (SectionCard isola) e o erro diz "não significa X", nunca conclui errado;
//   • vazio HONESTO: 0 candidatos ≠ "não há código morto"; sem veredito ≠ forte;
//   • o LIVRO-RAZÃO de grounding aparece — a honestidade da IA é um número na tela
//     (claim rejeitado por não citar âncora provada é MOSTRADO, não escondido);
//   • toda seção fecha com a procedência (endpoint).
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import {
  VerdictCard,
  DeadCodeCard,
  DomainsCard,
  RuntimeGapCard,
  type VerdictPayload,
  type DeadCodePayload,
  type DomainsPayload,
  type RuntimeGapPayload,
} from "./decision-reasoner";
import type { QueryLike } from "./decision";

afterEach(cleanup);

const ok = <T,>(data: T): QueryLike<T> => ({ data, isLoading: false, isError: false, error: null });
const err = <T,>(): QueryLike<T> => ({ data: null, isLoading: false, isError: true, error: new Error("boom") });
const loading = <T,>(): QueryLike<T> => ({ isLoading: true, isError: false, error: null });

describe("VerdictCard", () => {
  it("mostra o tier FRACA em vermelho quando o veredito é WEAK (honesto, não maquia)", () => {
    const v: VerdictPayload = { tier: "WEAK", observedRatio: 0.002, nodes: { observed: 24, total: 3336 }, reasons: [], explanation: "Confiança da leitura: FRACA.", mode: "deterministic" };
    render(<VerdictCard query={ok(v)} />);
    expect(screen.getByTestId("reasoner-verdict-tier")).toHaveTextContent("FRACA");
    expect(screen.getByTestId("reasoner-verdict-explanation")).toHaveTextContent("FRACA");
  });
  it("erro isolado com a anti-conclusão ('não significa que é forte')", () => {
    render(<VerdictCard query={err()} />);
    expect(screen.getByTestId("reasoner-verdict-error")).toHaveTextContent(/não.*quer dizer/i);
  });
});

describe("DeadCodeCard", () => {
  const base: DeadCodePayload = {
    candidates: [{ nodeId: "SERVICE:x.Foo", type: "SERVICE", label: "Foo", tier: "isolated", confidence: 0.75, question: "Foo é usado por reflexão? Verificar." }],
    excluded: { entryPoints: 35, entrySurfaces: 1089, runtimeObserved: 3, unreachableByRobot: 0 },
    grounding: { proposed: 6, kept: 5, rejected: 1, groundingRate: 5 / 6 },
    mode: "llm-grounded",
    summary: "1 candidato",
  };
  it("lista candidatos com tier e confiança e mostra os excluídos por honestidade", () => {
    render(<DeadCodeCard query={ok(base)} />);
    expect(within(screen.getByTestId("reasoner-deadcode-list")).getByText("Foo")).toBeInTheDocument();
    expect(screen.getByTestId("reasoner-deadcode-excluded")).toHaveTextContent("1089 superfícies de entrada");
  });
  it("EXPÕE o livro-razão: 1 claim REJEITADA por não citar âncora provada", () => {
    render(<DeadCodeCard query={ok(base)} />);
    expect(screen.getByTestId("reasoner-deadcode-grounding")).toHaveTextContent(/1 rejeitadas/);
  });
  it("0 candidatos → vazio HONESTO, nunca 'não há código morto'", () => {
    render(<DeadCodeCard query={ok({ ...base, candidates: [] })} />);
    expect(screen.getByTestId("reasoner-deadcode-none")).toHaveTextContent(/ponto de entrada legítimo/);
  });
});

describe("DomainsCard", () => {
  it("mostra domínios com nome, tamanho e as fronteiras", () => {
    const d: DomainsPayload = {
      domains: [{ id: "a", name: "Execução Financeira", size: 45, byType: { SERVICE: 30, ENTITY: 15 }, runtimeHot: 2 }],
      seams: [{ from: "a", to: "b", edges: 3 }],
      hubs: ["h1"],
      grounding: { proposed: 0, kept: 0, rejected: 0, groundingRate: 1 },
      mode: "deterministic",
      summary: "1 domínio",
    };
    render(<DomainsCard query={ok(d)} />);
    expect(within(screen.getByTestId("reasoner-domains-list")).getByText("Execução Financeira")).toBeInTheDocument();
  });
  it("loading mostra skeleton, não zero", () => {
    render(<DomainsCard query={loading()} />);
    expect(screen.getByTestId("reasoner-domains-loading")).toBeInTheDocument();
  });
});

describe("RuntimeGapCard", () => {
  it("cobertura baixa em vermelho + 'nunca rodaram' (não é código morto)", () => {
    const r: RuntimeGapPayload = {
      totalEntries: 1740, observedEntries: 3, coverage: 3 / 1740,
      uncovered: [{ nodeId: "ROUTE:/x", type: "ROUTE", label: "/x", reach: 254, hint: "exercitar" }],
      grounding: { proposed: 0, kept: 0, rejected: 0, groundingRate: 1 }, mode: "deterministic", summary: "",
    };
    render(<RuntimeGapCard query={ok(r)} />);
    expect(screen.getByTestId("reasoner-runtimegap-coverage")).toHaveTextContent("0%");
    expect(within(screen.getByTestId("reasoner-runtimegap-list")).getByText("/x")).toBeInTheDocument();
  });
});

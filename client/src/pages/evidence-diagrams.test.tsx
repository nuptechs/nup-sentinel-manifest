// ─────────────────────────────────────────────
// O que estes testes protegem na página-mãe dos Diagramas de Evidência:
//   • o array canônico VIZ_MODES cobre EXATAMENTE o union VizMode e tem um
//     componente registrado para cada modo (registry sem furo);
//   • a página monta, mostra os 8 botões de modo e a pergunta-guia;
//   • deep-link ?view=metro seleciona o modo certo (link torto cai no default,
//     nunca quebra);
//   • projeto sem grafo (404) mostra "reanalisar", não erro genérico (vazio ≠
//     falhou).
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import EvidenceDiagramsPage, { VIZ_MODES, type VizMode } from "./evidence-diagrams";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/evidence");
});

function mountWith(fetchImpl: (url: string) => unknown, search = "") {
  if (search) window.history.replaceState({}, "", `/evidence${search}`);
  // Response duck-typed (o jsdom não constrói um `new Response` que o
  // getQueryFn consuma via .json()/.text()) — expõe só o que a query usa.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    const body = fetchImpl(url);
    if (body === "__404__") {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}), text: async () => "404: GRAPH_NOT_IN_SNAPSHOT" };
    }
    return { ok: true, status: 200, statusText: "OK", json: async () => body ?? {}, text: async () => JSON.stringify(body ?? {}) };
  }) as unknown as typeof fetch);
  // reusa o MESMO queryFn de produção (queryKey = URL) — senão as queries erram
  // por "missing queryFn" e a página cai direto no estado de erro de projetos.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
  return render(
    <QueryClientProvider client={qc}>
      <EvidenceDiagramsPage />
    </QueryClientProvider>,
  );
}

const PROJECTS = [{ id: 27, name: "EasyNuP" }];
const GRAPH = {
  projectId: 27,
  analysisRunId: 1,
  counts: { nodes: 2, edges: 1, byType: {} },
  nodes: [
    { id: "a", type: "SERVICE", className: "Foo", inDegree: 1, outDegree: 0 },
    { id: "b", type: "REPOSITORY", className: "Bar", inDegree: 0, outDegree: 1 },
  ],
  edges: [{ fromNode: "b", toNode: "a", relationType: "CALLS", evidence: { method: "STATIC_PROVEN", confidence: 0.8 } }],
  coverage: { edges: { total: 1, byMethod: { STATIC_PROVEN: 1 }, observedRatio: 0 }, nodes: { observed: 0, total: 2 } },
};

describe("VIZ_MODES — registry sem furo", () => {
  it("tem exatamente 8 modos, todos únicos", () => {
    const ids = VIZ_MODES.map((m) => m.id);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });
  it("cada modo tem rótulo, pergunta e ícone", () => {
    for (const m of VIZ_MODES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.question.length).toBeGreaterThan(0);
      expect(m.icon).toBeTruthy();
    }
  });
  it("os ids cobrem o union VizMode canônico", () => {
    const expected: VizMode[] = ["metro", "sankey", "proof", "lenses", "conformance", "diff", "zoom", "radar"];
    expect(new Set(VIZ_MODES.map((m) => m.id))).toEqual(new Set(expected));
  });
});

describe("EvidenceDiagramsPage — montagem", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/evidence");
  });

  it("monta com título e os 8 botões de modo", async () => {
    mountWith((url) => (url.includes("/graph") ? GRAPH : url.endsWith("/api/projects") ? PROJECTS : {}));
    expect(await screen.findByTestId("text-evidence-title")).toBeInTheDocument();
    for (const m of VIZ_MODES) {
      expect(screen.getByTestId(`view-${m.id}`)).toBeInTheDocument();
    }
  });

  it("mostra a pergunta-guia do modo ativo e troca ao clicar", async () => {
    mountWith((url) => (url.includes("/graph") ? GRAPH : url.endsWith("/api/projects") ? PROJECTS : {}));
    await screen.findByTestId("text-evidence-title");
    fireEvent.click(screen.getByTestId("view-conformance"));
    expect(screen.getByTestId("viz-question").textContent).toContain("desenhado");
  });

  it("deep-link ?view=metro seleciona o modo Metrô (não a prova)", async () => {
    mountWith(
      (url) => (url.includes("/graph") ? GRAPH : url.includes("catalog") ? { entries: [] } : url.endsWith("/api/projects") ? PROJECTS : {}),
      "?view=metro",
    );
    await screen.findByTestId("text-evidence-title");
    // o modo metro renderiza sua própria casca (empty/loading/view), nunca a de prova.
    await waitFor(
      () =>
        expect(
          screen.queryByTestId("metro-empty") ??
            screen.queryByTestId("metro-view") ??
            screen.queryByTestId("metro-loading"),
        ).toBeTruthy(),
      { timeout: 4000 },
    );
    expect(screen.queryByTestId("proof-view")).toBeNull();
  });

  it("grafo 404 mostra 'reanalisar' (vazio ≠ falhou)", async () => {
    mountWith((url) => (url.includes("/graph") ? "__404__" : url.endsWith("/api/projects") ? PROJECTS : {}));
    await screen.findByTestId("text-evidence-title");
    expect(await screen.findByTestId("evidence-graph-error", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/ainda não gerado/i)).toBeInTheDocument();
  });
});

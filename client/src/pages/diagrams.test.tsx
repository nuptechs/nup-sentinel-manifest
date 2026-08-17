// ─────────────────────────────────────────────
// O que estes testes protegem na página Diagramas (UML + C4):
//   • REGRA PURA de endpoint: C4 → /reasoner/c4/:view, UML → /reasoner/uml/:type,
//     e o rótulo interno "uml_component" mapeia p/ "component" SEM colidir com a
//     view C4 "component" (o /reasoner/uml/uml_component seria o bug — travado);
//   • entry vira ?entry= (needsEntry) ou ?focus= (needsFocus);
//   • a página lê o shape do C4 (mermaid+dsl+stats+notes no TOP-LEVEL), mostra as
//     stats e o botão "Copiar DSL" só quando a resposta traz DSL.
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import DiagramsPage, { buildDiagramUrl, TYPES, type TypeMeta } from "./diagrams";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const metaOf = (t: string) => TYPES.find((x) => x.type === t) as TypeMeta;

describe("buildDiagramUrl — regra pura de endpoint", () => {
  it("família C4 vai p/ /reasoner/c4/:view", () => {
    expect(buildDiagramUrl(27, metaOf("container"), "")).toBe("/api/projects/27/reasoner/c4/container");
    expect(buildDiagramUrl(27, metaOf("context"), "")).toBe("/api/projects/27/reasoner/c4/context");
  });
  it("C4 component leva o contêiner como ?focus=", () => {
    expect(buildDiagramUrl(27, metaOf("component"), "backend")).toBe("/api/projects/27/reasoner/c4/component?focus=backend");
  });
  it("UML vai p/ /reasoner/uml/:type; 'uml_component' NÃO vira uml_component (mapeia p/ component)", () => {
    expect(buildDiagramUrl(27, metaOf("uml_component"), "")).toBe("/api/projects/27/reasoner/uml/component");
    expect(buildDiagramUrl(27, metaOf("uml_component"), "")).not.toContain("uml_component");
  });
  it("UML sequence/activity levam a funcionalidade como ?entry=", () => {
    expect(buildDiagramUrl(27, metaOf("sequence"), "GET /x")).toBe("/api/projects/27/reasoner/uml/sequence?entry=GET+%2Fx");
    expect(buildDiagramUrl(27, metaOf("class"), "Contract")).toBe("/api/projects/27/reasoner/uml/class?focus=Contract");
  });
  it("as 4 views C4 e os 8 UML estão no catálogo (registry sem furo)", () => {
    const c4 = TYPES.filter((t) => t.family === "c4").map((t) => t.type).sort();
    expect(c4).toEqual(["component", "container", "context", "landscape"]);
    const uml = TYPES.filter((t) => t.family !== "c4").map((t) => t.type);
    expect(uml.length).toBe(8);
    expect(uml).toContain("uml_component");
  });
});

describe("Diagramas — lê o shape C4 (top-level) e mostra DSL", () => {
  const PROJECTS = [{ id: 27, name: "EasyNuP" }];
  const C4 = {
    view: "container",
    mermaid: "C4Container\n  Person(user, \"Usuário\")",
    dsl: "workspace \"EasyNuP\" { model { } }",
    stats: { conteineres: 4, componentes: 36, relacoes: 50 },
    notes: ["Modelo C4 derivado do grafo PROVADO."],
  };
  function mount(byUrl: (u: string) => unknown) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      const body = byUrl(url);
      return { ok: true, status: 200, statusText: "OK", json: async () => body ?? {}, text: async () => JSON.stringify(body ?? {}) };
    }) as unknown as typeof fetch);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: getQueryFn({ on401: "throw" }) } } });
    return render(<QueryClientProvider client={qc}><DiagramsPage /></QueryClientProvider>);
  }
  it("default container: stats e notes do TOP-LEVEL aparecem; botão Copiar DSL existe", async () => {
    mount((u) => (u.includes("/api/projects") && !u.includes("reasoner") ? PROJECTS : u.includes("/reasoner/c4/container") ? C4 : {}));
    await waitFor(() => expect(screen.getByText(/conteineres: 4/)).toBeTruthy());
    expect(screen.getByText(/Modelo C4 derivado do grafo PROVADO/)).toBeTruthy();
    expect(screen.getByTestId("button-copy-dsl")).toBeTruthy();
  });
});

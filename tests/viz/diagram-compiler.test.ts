/**
 * Testes PUROS do compilador spec→Mermaid/C4 (OBS-I09). Sem motor de render:
 * só a geração de texto e o contrato valida→fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compileDiagram, diagramFallbackText } from "../../shared/viz/diagram-compiler.ts";
import type { DiagramSpec } from "../../shared/viz/visual-spec.ts";

describe("diagram-compiler — flowchart", () => {
  const spec: DiagramSpec = {
    family: "diagram",
    kind: "flowchart",
    title: "Fluxo",
    direction: "LR",
    nodes: [
      { id: "api.ctrl", label: "Controller", shape: "stadium" },
      { id: "svc", label: "Service", shape: "round" },
      { id: "repo", label: "Repo", shape: "cylinder" },
    ],
    edges: [
      { from: "api.ctrl", to: "svc", label: "chama" },
      { from: "svc", to: "repo", dashed: true },
    ],
    source: "graph",
  };

  it("gera flowchart com direção, nós saneados e arestas", () => {
    const res = compileDiagram(spec);
    assert.equal(res.ok, true);
    const m = res.mermaid as string;
    assert.match(m, /flowchart LR/);
    assert.match(m, /api_ctrl\(\["Controller"\]\)/); // id saneado + shape stadium
    assert.match(m, /api_ctrl -->\|"chama"\| svc/);
    assert.match(m, /svc -\.-> repo/); // aresta tracejada
  });

  it("escapa aspas no rótulo", () => {
    const res = compileDiagram({ ...spec, nodes: [{ id: "a", label: 'tem "aspas"', shape: "box" }], edges: [] });
    assert.doesNotMatch(res.mermaid as string, /"aspas"/);
    assert.match(res.mermaid as string, /tem 'aspas'/);
  });
});

describe("diagram-compiler — C4", () => {
  it("c4Context usa idioma Person/System/Rel", () => {
    const res = compileDiagram({
      family: "diagram",
      kind: "c4Context",
      title: "Sistema X",
      people: [{ id: "u", name: "Usuário" }],
      systems: [{ id: "sys", name: "Sistema X", tag: "SPA" }],
      rels: [{ from: "u", to: "sys", label: "usa" }],
      source: "graph",
    });
    assert.equal(res.ok, true);
    const m = res.mermaid as string;
    assert.match(m, /^C4Context/);
    assert.match(m, /Person\(u, "Usuário"\)/);
    assert.match(m, /System\(sys, "Sistema X", "SPA"\)/);
    assert.match(m, /Rel\(u, sys, "usa"\)/);
  });

  it("c4Container usa Container()", () => {
    const res = compileDiagram({
      family: "diagram",
      kind: "c4Container",
      title: "Y",
      containers: [{ id: "web", name: "Web", technology: "React" }],
      rels: [],
      source: "g",
    });
    assert.match(res.mermaid as string, /Container\(web, "Web", "React"\)/);
  });
});

describe("diagram-compiler — sequence", () => {
  it("gera sequenceDiagram com participantes e mensagens", () => {
    const res = compileDiagram({
      family: "diagram",
      kind: "sequence",
      participants: [{ id: "a", label: "Cliente" }, { id: "b", label: "API" }],
      messages: [{ from: "a", to: "b", text: "GET /x" }, { from: "b", to: "a", text: "200", async: true }],
      source: "trace",
    });
    const m = res.mermaid as string;
    assert.match(m, /sequenceDiagram/);
    assert.match(m, /participant a as Cliente/);
    assert.match(m, /a->>b: GET \/x/);
    assert.match(m, /b-->>a: 200/);
  });
});

describe("diagram-compiler — contrato valida→fallback", () => {
  it("kind desconhecido → ok:false + fallback presente", () => {
    const res = compileDiagram({ kind: "pizza" }, "alt");
    assert.equal(res.ok, false);
    assert.equal(res.fallback, "alt");
    assert.ok(res.reason && res.reason.length > 0);
  });

  it("flowchart sem nós → inválido (min 1)", () => {
    const res = compileDiagram({ kind: "flowchart", nodes: [], source: "g" });
    assert.equal(res.ok, false);
  });

  it("fallback vazio vira marcador", () => {
    const res = compileDiagram({ kind: "pizza" }, "");
    assert.equal(res.fallback, "(sem diagrama)");
  });

  it("fallback textual derivado quando ok e não passado", () => {
    const res = compileDiagram({ kind: "flowchart", nodes: [{ id: "a", label: "A" }], edges: [], source: "g" });
    assert.match(res.fallback, /1 nós/);
  });

  it("diagramFallbackText resume c4Container", () => {
    const txt = diagramFallbackText({ family: "diagram", kind: "c4Container", title: "Z", people: [], containers: [{ id: "a", name: "A" }], rels: [], source: "g" });
    assert.match(txt, /contêiner/);
  });
});

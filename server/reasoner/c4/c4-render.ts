// ─────────────────────────────────────────────────────────────────────────
// Reasoner — RENDER do modelo C4: Structurizr DSL (versionável) + Mermaid C4.
// Puro, determinístico, nunca lança. UM modelo → N views.
// ─────────────────────────────────────────────────────────────────────────

import type { C4Model, C4Element, C4Rel } from "./c4-model";

export type C4View = "context" | "container" | "component" | "landscape";
const VIEWS: C4View[] = ["context", "container", "component", "landscape"];

const esc = (s: string) => String(s ?? "").replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();
// tag de confiança visível (mantém a disciplina "inferido é marcado").
const relLabel = (r: C4Rel) => (r.confidence === "inferred" ? `${r.description} [inferido]` : r.description);
const confTag = (c: C4Element["confidence"]) => (c === "observed" ? "Observado" : c === "inferred" ? "Inferido" : "Provado");

// ── Structurizr DSL ───────────────────────────────────────────────────────
// workspace { model { ... } views { ... } } — o formato dominante 2025-26.
export function toStructurizrDsl(m: C4Model): string {
  const L: string[] = [];
  L.push(`workspace "${esc(m.system.name)}" "Modelo C4 derivado do grafo provado (Sentinel)" {`);
  L.push(`  model {`);
  L.push(`    user = person "${esc(m.people[0]?.name || "Usuário")}"`);
  L.push(`    sys = softwareSystem "${esc(m.system.name)}" {`);
  const compsByCont = new Map<string, C4Element[]>();
  for (const c of m.components) (compsByCont.get(c.parent!) ?? compsByCont.set(c.parent!, []).get(c.parent!)!).push(c);
  for (const cont of m.containers) {
    const tech = cont.technology ? `, "${esc(cont.technology)}"` : "";
    L.push(`      ${cont.id} = container "${esc(cont.name)}"${tech ? `, ""${tech}` : ""} {`);
    L.push(`        tags "${confTag(cont.confidence)}"`);
    for (const comp of compsByCont.get(cont.id) || []) {
      L.push(`        ${comp.id.replace(/[^a-zA-Z0-9_]/g, "_")} = component "${esc(comp.name)}"`);
    }
    L.push(`      }`);
  }
  L.push(`    }`);
  const idOf = (raw: string) => (raw === "user" ? "user" : raw === "sys" ? "sys" : m.containers.some((c) => c.id === raw) ? raw : raw.replace(/[^a-zA-Z0-9_]/g, "_"));
  for (const r of m.rels) {
    L.push(`    ${idOf(r.from)} -> ${idOf(r.to)} "${esc(relLabel(r))}"`);
  }
  L.push(`  }`);
  L.push(`  views {`);
  L.push(`    systemContext sys "Contexto" { include * autolayout lr }`);
  L.push(`    container sys "Conteineres" { include * autolayout lr }`);
  for (const cont of m.containers.filter((c) => (compsByCont.get(c.id) || []).length)) {
    L.push(`    component ${cont.id} "Comp_${cont.id}" { include * autolayout lr }`);
  }
  L.push(`    theme default`);
  L.push(`  }`);
  L.push(`}`);
  return L.join("\n");
}

// ── Mermaid C4 nativo ───────────────────────────────────────────────────────
export function toMermaidC4(m: C4Model, view: C4View, focus?: string): string {
  if (view === "context") return contextMermaid(m);
  if (view === "container") return containerMermaid(m);
  if (view === "component") return componentMermaid(m, focus);
  return landscapeMermaid(m);
}

function contextMermaid(m: C4Model): string {
  const L = ["C4Context", `  title Contexto — ${esc(m.system.name)}`];
  L.push(`  Person(user, "${esc(m.people[0]?.name || "Usuário")}")`);
  L.push(`  System(sys, "${esc(m.system.name)}", "${confTag(m.system.confidence)}")`);
  const obs = m.containers.some((c) => c.confidence === "observed");
  L.push(`  Rel(user, sys, "usa${obs ? "" : " [inferido]"}")`);
  return L.join("\n");
}

function containerMermaid(m: C4Model): string {
  const L = ["C4Container", `  title Contêineres — ${esc(m.system.name)}`];
  L.push(`  Person(user, "${esc(m.people[0]?.name || "Usuário")}")`);
  L.push(`  System_Boundary(sys, "${esc(m.system.name)}") {`);
  for (const c of m.containers) {
    const fn = c.id === "db" ? "ContainerDb" : "Container";
    L.push(`    ${fn}(${c.id}, "${esc(c.name)}", "${esc(c.technology || "")}", "${confTag(c.confidence)}")`);
  }
  L.push(`  }`);
  for (const r of m.rels.filter((x) => (x.from === "user" || m.containers.some((c) => c.id === x.from)) && m.containers.some((c) => c.id === x.to))) {
    L.push(`  Rel(${r.from}, ${r.to}, "${esc(relLabel(r))}")`);
  }
  return L.join("\n");
}

function componentMermaid(m: C4Model, focus?: string): string {
  const target = m.containers.find((c) => c.id === focus) || m.containers.find((c) => m.components.some((k) => k.parent === c.id));
  if (!target) return "C4Component\n  title Componentes\n  Boundary(empty, \"sem componentes\") {}";
  const comps = m.components.filter((k) => k.parent === target.id);
  const ids = new Set(comps.map((c) => c.id));
  const L = ["C4Component", `  title Componentes — ${esc(target.name)}`];
  L.push(`  Container_Boundary(${target.id}, "${esc(target.name)}") {`);
  for (const c of comps) L.push(`    Component(${safe(c.id)}, "${esc(c.name)}", "${esc(c.description || "")}")`);
  L.push(`  }`);
  for (const r of m.rels.filter((x) => ids.has(x.from) && ids.has(x.to))) {
    L.push(`  Rel(${safe(r.from)}, ${safe(r.to)}, "${esc(relLabel(r))}")`);
  }
  return L.join("\n");
}

// landscape = paisagem completa (contêiner + componentes, um flowchart legível)
function landscapeMermaid(m: C4Model): string {
  const L = ["flowchart LR", `  %% Paisagem C4 — ${esc(m.system.name)}`, "  user([Usuário])"];
  const compsByCont = new Map<string, C4Element[]>();
  for (const c of m.components) (compsByCont.get(c.parent!) ?? compsByCont.set(c.parent!, []).get(c.parent!)!).push(c);
  for (const cont of m.containers) {
    L.push(`  subgraph ${cont.id}["${esc(cont.name)} · ${esc(cont.technology || "")}"]`);
    for (const comp of compsByCont.get(cont.id) || []) L.push(`    ${safe(comp.id)}["${esc(comp.name)}"]`);
    if (!(compsByCont.get(cont.id) || []).length) L.push(`    ${cont.id}_x[" "]`);
    L.push(`  end`);
  }
  for (const r of m.rels) {
    const from = r.from === "user" ? "user" : m.containers.some((c) => c.id === r.from) ? r.from : safe(r.from);
    const to = m.containers.some((c) => c.id === r.to) ? r.to : safe(r.to);
    const arrow = r.confidence === "inferred" ? "-.->" : "-->";
    L.push(`  ${from} ${arrow}|${esc(relLabel(r))}| ${to}`);
  }
  return L.join("\n");
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");

export function c4Catalog() {
  return VIEWS.map((v) => ({
    view: v,
    label: { context: "Contexto (C4)", container: "Contêineres (C4)", component: "Componentes (C4)", landscape: "Paisagem" }[v],
    needsFocus: v === "component",
  }));
}

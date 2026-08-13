// ─────────────────────────────────────────────────────────────────────────
// Reasoner — RENDERER da suíte UML → Mermaid (puro, nunca lança).
// Um dialeto Mermaid por tipo: classDiagram, stateDiagram-v2 e flowchart. A
// CONFIANÇA vira estilo de aresta (cheia = observado/provado, tracejada =
// inferido) + legenda. Rótulos escapados p/ não quebrar o parser.
// ─────────────────────────────────────────────────────────────────────────

import { type UmlModel, type UmlRel, safeId } from "./uml-model";

function esc(s: string): string {
  return String(s || "").replace(/[\r\n]+/g, " ").replace(/["`]/g, "'").replace(/[[\]{}|]/g, " ").replace(/\s+/g, " ").trim();
}
const dotted = (r: UmlRel) => r.confidence === "inferred";

function legend(model: UmlModel): string[] {
  const out: string[] = [];
  if (model.notes[0]) out.push(`%% ${esc(model.notes[0])}`);
  return out;
}

// ── flowchart genérico (component/package/deployment/usecase/activity) ──────
function flowchart(model: UmlModel, dir: "LR" | "TD" | "TB"): string {
  const lines = [`flowchart ${dir}`, ...legend(model)];
  const nid = (id: string) => safeId(id);
  // agrupa por subgraph quando há groups
  const shape = (kind: string, label: string) => {
    if (kind === "actor") return `(["${label}"])`;
    if (kind === "usecase") return `("${label}")`;
    if (kind === "db") return `[("${label}")]`;
    if (kind === "decision") return `{"${label}"}`;
    if (kind === "start" || kind === "end") return `(["${label}"])`;
    if (kind === "node") return `["${label}"]`;
    if (kind === "component" || kind === "package") return `[/"${label}"/]`;
    return `["${label}"]`;
  };
  const byGroup = new Map<string, typeof model.nodes>();
  for (const n of model.nodes) {
    const g = n.group || "";
    (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(n);
  }
  const groupLabel = new Map(model.groups.map((g) => [g.id, g.label]));
  for (const [g, ns] of byGroup) {
    if (g && groupLabel.has(g)) lines.push(`  subgraph ${nid(g)}["${esc(groupLabel.get(g)!)}"]`);
    for (const n of ns) lines.push(`  ${g && groupLabel.has(g) ? "  " : ""}${nid(n.id)}${shape(n.kind, esc(n.label))}`);
    if (g && groupLabel.has(g)) lines.push("  end");
  }
  for (const r of [...model.rels].sort((a, b) => ((a as UmlRel & { order?: number }).order ?? 0) - ((b as UmlRel & { order?: number }).order ?? 0))) {
    const arrow = dotted(r) ? "-.->" : "-->";
    const lbl = r.label ? `|"${esc(r.label)}"|` : "";
    lines.push(`  ${nid(r.from)} ${arrow}${lbl} ${nid(r.to)}`);
  }
  return lines.join("\n");
}

// ── classDiagram ────────────────────────────────────────────────────────────
function classDiagram(model: UmlModel): string {
  const lines = ["classDiagram", ...legend(model)];
  const nid = (id: string) => safeId(id);
  for (const n of model.nodes) {
    lines.push(`  class ${nid(n.id)}["${esc(n.label)}"]`);
    if (n.stereotype) lines.push(`  <<${esc(n.stereotype)}>> ${nid(n.id)}`);
  }
  for (const r of model.rels) {
    // herança A --|> B ; realização A ..|> B ; associação A --> B
    const op = r.kind === "inheritance" ? "--|>" : r.kind === "realization" ? "..|>" : dotted(r) ? "..>" : "-->";
    const lbl = r.kind === "association" ? " : usa" : "";
    lines.push(`  ${nid(r.from)} ${op} ${nid(r.to)}${lbl}`);
  }
  return lines.join("\n");
}

// ── stateDiagram-v2 ──────────────────────────────────────────────────────────
function stateDiagram(model: UmlModel): string {
  const lines = ["stateDiagram-v2", ...legend(model)];
  const nid = (id: string) => safeId(id);
  for (const n of model.nodes) lines.push(`  state "${esc(n.label)}" as ${nid(n.id)}`);
  if (model.nodes.length) lines.push(`  [*] --> ${nid(model.nodes[0].id)}`);
  for (const r of model.rels) lines.push(`  ${nid(r.from)} --> ${nid(r.to)}${r.label ? ` : ${esc(r.label)}` : ""}`);
  if (!model.rels.length && model.nodes.length) lines.push(`  %% (estados sem transição provada no grafo — ver nota)`);
  return lines.join("\n");
}

/** dispatcher: UmlModel → Mermaid do dialeto certo. */
export function umlToMermaid(model: UmlModel): string {
  if (!model.nodes.length) {
    return `flowchart TD\n  vazio["${esc(model.notes[0] || "sem dados")}"]`;
  }
  switch (model.type) {
    case "class":
      return classDiagram(model);
    case "state":
      return stateDiagram(model);
    case "activity":
      return flowchart(model, "TD");
    case "usecase":
    case "component":
    case "deployment":
      return flowchart(model, "LR");
    case "package":
      return flowchart(model, "TB");
    default:
      return flowchart(model, "LR");
  }
}

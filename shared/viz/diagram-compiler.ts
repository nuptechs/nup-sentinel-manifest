/**
 * diagram-compiler.ts — compilador PURO `spec → Mermaid/C4` (OBS-I09).
 *
 * Diagramação DECLARATIVA: recebe uma `DiagramSpec` (visual-spec.ts), valida com
 * zod e devolve texto Mermaid — flowchart, C4 (context/container) e
 * sequenceDiagram — SEM motor de render, SEM DOM. Função pura, server-safe.
 *
 * Contrato da gramática: NUNCA lança; spec inválida → `{ ok:false }` com
 * `fallback` textual SEMPRE presente. O idioma C4 espelha o gerador server-side
 * a partir do grafo (server/reasoner/c4/c4-render.ts:toMermaidC4), mas aqui a
 * entrada é uma spec declarativa validável, não o grafo.
 */
import {
  diagramSpecSchema,
  type C4ContainerSpec,
  type C4ContextSpec,
  type DiagramSpec,
  type FlowchartSpec,
  type SequenceSpec,
} from "./visual-spec";

export interface DiagramCompilation {
  ok: boolean;
  kind?: string;
  /** texto Mermaid pronto para render quando ok. */
  mermaid?: string;
  /** texto alternativo SEMPRE presente. */
  fallback: string;
  reason?: string;
}

/** Escapa aspas em rótulos (Mermaid usa aspas para delimitar). */
function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();
}

/** id Mermaid-seguro: alfanumérico + underscore, nunca vazio. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  return cleaned.length > 0 ? cleaned : "n_" + Math.abs(hashStr(id)).toString(36);
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const SHAPE_WRAP: Record<string, [string, string]> = {
  box: ["[", "]"],
  round: ["(", ")"],
  stadium: ["([", "])"],
  cylinder: ["[(", ")]"],
  diamond: ["{", "}"],
};

function renderFlowchart(spec: FlowchartSpec): string {
  const lines: string[] = [];
  if (spec.title) lines.push(`---\ntitle: ${esc(spec.title)}\n---`);
  lines.push(`flowchart ${spec.direction}`);
  for (const n of spec.nodes) {
    const [open, close] = SHAPE_WRAP[n.shape] ?? SHAPE_WRAP.box;
    lines.push(`  ${safeId(n.id)}${open}"${esc(n.label)}"${close}`);
  }
  for (const e of spec.edges) {
    const arrow = e.dashed ? "-.->" : "-->";
    const label = e.label ? `|"${esc(e.label)}"|` : "";
    lines.push(`  ${safeId(e.from)} ${arrow}${label} ${safeId(e.to)}`);
  }
  return lines.join("\n");
}

function renderC4Context(spec: C4ContextSpec): string {
  const L = ["C4Context", `  title ${esc(spec.title)}`];
  for (const p of spec.people) L.push(`  Person(${safeId(p.id)}, "${esc(p.name)}")`);
  for (const s of spec.systems) L.push(`  System(${safeId(s.id)}, "${esc(s.name)}"${s.tag ? `, "${esc(s.tag)}"` : ""})`);
  for (const r of spec.rels) L.push(`  Rel(${safeId(r.from)}, ${safeId(r.to)}, "${esc(r.label)}")`);
  return L.join("\n");
}

function renderC4Container(spec: C4ContainerSpec): string {
  const L = ["C4Container", `  title ${esc(spec.title)}`];
  for (const p of spec.people) L.push(`  Person(${safeId(p.id)}, "${esc(p.name)}")`);
  for (const c of spec.containers)
    L.push(`  Container(${safeId(c.id)}, "${esc(c.name)}"${c.technology ? `, "${esc(c.technology)}"` : ""})`);
  for (const r of spec.rels) L.push(`  Rel(${safeId(r.from)}, ${safeId(r.to)}, "${esc(r.label)}")`);
  return L.join("\n");
}

function renderSequence(spec: SequenceSpec): string {
  const L = ["sequenceDiagram"];
  if (spec.title) L.push(`  title ${esc(spec.title)}`);
  for (const p of spec.participants) L.push(`  participant ${safeId(p.id)} as ${esc(p.label)}`);
  for (const m of spec.messages) {
    const arrow = m.async ? "-->>" : "->>";
    L.push(`  ${safeId(m.from)}${arrow}${safeId(m.to)}: ${esc(m.text)}`);
  }
  return L.join("\n");
}

export function diagramFallbackText(spec: DiagramSpec): string {
  switch (spec.kind) {
    case "flowchart":
      return `${spec.title ?? "Fluxograma"} — ${spec.nodes.length} nós, ${spec.edges.length} arestas. Fonte: ${spec.source}.`;
    case "c4Context":
      return `${spec.title} — C4 contexto: ${spec.systems.length} sistema(s), ${spec.people.length} ator(es), ${spec.rels.length} relação(ões). Fonte: ${spec.source}.`;
    case "c4Container":
      return `${spec.title} — C4 contêineres: ${spec.containers.length} contêiner(es), ${spec.rels.length} relação(ões). Fonte: ${spec.source}.`;
    case "sequence":
      return `${spec.title ?? "Sequência"} — ${spec.participants.length} participantes, ${spec.messages.length} mensagens. Fonte: ${spec.source}.`;
  }
}

function renderDiagram(spec: DiagramSpec): string {
  switch (spec.kind) {
    case "flowchart":
      return renderFlowchart(spec);
    case "c4Context":
      return renderC4Context(spec);
    case "c4Container":
      return renderC4Container(spec);
    case "sequence":
      return renderSequence(spec);
  }
}

/**
 * Compila uma DiagramSpec em texto Mermaid/C4. Valida com zod; spec inválida (ou
 * erro de render) → `{ ok:false }` com `fallback` SEMPRE preenchido. Nunca lança.
 */
export function compileDiagram(raw: unknown, fallback?: string): DiagramCompilation {
  const parsed = diagramSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ok: false, fallback: ensureFallback(fallback), reason };
  }
  const spec = parsed.data;
  try {
    const mermaid = renderDiagram(spec);
    return { ok: true, kind: spec.kind, mermaid, fallback: ensureFallback(fallback ?? diagramFallbackText(spec)) };
  } catch (err) {
    return {
      ok: false,
      kind: spec.kind,
      fallback: ensureFallback(fallback ?? diagramFallbackText(spec)),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function ensureFallback(fallback?: string): string {
  return typeof fallback === "string" && fallback.length > 0 ? fallback : "(sem diagrama)";
}

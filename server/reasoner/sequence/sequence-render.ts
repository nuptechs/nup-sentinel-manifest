// ─────────────────────────────────────────────────────────────────────────
// Reasoner — RENDERER de SequenceModel → Mermaid `sequenceDiagram` (puro).
//
// Mermaid renderiza nativo no navegador/artefato (portável, sem dependência). A
// CONFIANÇA vira estilo de seta — o diagrama nunca finge certeza:
//   observed/proven → seta CHEIA  (`->>`)      · fato observado ou provado
//   inferred        → seta TRACEJADA (`-->>`)  · topologia não-provada (verificar)
// Banco vira participante próprio; leitura/escrita anotadas. Legenda no rodapé.
// Saída SEGURA: rótulos escapados (sem `;`/`\n`/`:` que quebram o parser Mermaid).
// ─────────────────────────────────────────────────────────────────────────

import type { SequenceModel, SeqMessage } from "./sequence-model";

/** escapa um rótulo para caber num texto de mensagem Mermaid (1 linha, sem meta). */
function esc(s: string): string {
  return String(s || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[;:#]/g, " ") // caracteres que confundem o parser de sequenceDiagram
    .replace(/["`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** arrow token por confiança: cheia (observado/provado) × tracejada (inferido). */
function arrow(m: SeqMessage): string {
  return m.confidence === "inferred" ? "-->>" : "->>";
}

/** sufixo textual honesto do tipo/verbo da mensagem. */
function verb(m: SeqMessage): string {
  if (m.kind === "db-read") return "lê ";
  if (m.kind === "db-write") return "grava ";
  if (m.kind === "async") return "(assíncrono) ";
  return "";
}

/**
 * PURO: SequenceModel → texto Mermaid `sequenceDiagram`. Determinístico. Nunca
 * lança. Modelo vazio → um diagrama honesto com nota "sem passos".
 */
export function toMermaid(model: SequenceModel): string {
  const lines: string[] = ["sequenceDiagram", "  autonumber"];
  // participantes (declarados na ordem de 1ª aparição p/ layout estável)
  for (const p of model.participants) {
    lines.push(`  participant ${p.id} as ${esc(p.label)}`);
  }
  if (!model.messages.length) {
    lines.push(`  note over ${model.participants[0]?.id || "sistema"}: sem passos resolvidos para esta funcionalidade`);
  }
  const sorted = [...model.messages].sort((a, b) => a.order - b.order);
  for (const m of sorted) {
    lines.push(`  ${m.from}${arrow(m)}${m.to}: ${esc(verb(m) + m.label)}`);
  }
  // legenda de honestidade (o diferencial: cada seta diz sua confiança)
  const hasInferred = model.messages.some((m) => m.confidence === "inferred");
  const src =
    model.source === "runtime"
      ? "OBSERVADO em execução real (alta confiança)"
      : model.source === "runtime-partial"
        ? "OBSERVADO em parte (ordem real onde houve tráfego; resto por alcance)"
        : model.source === "static"
          ? "TOPOLOGIA provada pelo compilador (ordem não é a real)"
          : "sem dados";
  lines.push(`  note over ${model.participants[0]?.id || "sistema"}: Fonte — ${esc(src)}`);
  if (hasInferred) lines.push(`  note over ${model.participants[0]?.id || "sistema"}: setas ---> são inferidas (verificar)`);
  return lines.join("\n");
}

/** empacota o diagrama com o markdown de fence (pronto p/ colar/renderizar). */
export function toMermaidFenced(model: SequenceModel): string {
  return "```mermaid\n" + toMermaid(model) + "\n```\n";
}

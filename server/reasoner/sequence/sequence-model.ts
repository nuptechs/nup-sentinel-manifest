// ─────────────────────────────────────────────────────────────────────────
// Reasoner — DOMÍNIO de diagrama de sequência (puro, sem I/O, nunca lança).
//
// REUSO-PRIMEIRO (§2.5): NÃO re-deriva BFS/runtime. Consome o `MechanismReport`
// do motor `traceMechanism` já endurecido (BFS forward sobre arestas de FLUXO
// PROVADAS + gate "sem edgeId provado → descartado" + ordem REAL do OTel quando
// há tráfego). Este módulo só MAPEIA os passos → um modelo de sequência e o
// RENDERER (sequence-render) o desenha.
//
// Modelo híbrido SOTA (Briand et al.): a ordem vem do runtime quando observada,
// senão do alcance estático; a CONFIANÇA é POR MENSAGEM — o diagrama nunca finge:
//   observed (runtime confirmou) > proven (compilador) > inferred (heurística).
// ─────────────────────────────────────────────────────────────────────────

export type SeqConfidence = "observed" | "proven" | "inferred";
export type SeqSource = "runtime" | "runtime-partial" | "static" | "none";
export type SeqParticipantKind = "route" | "service" | "repository" | "db" | "external" | "component" | "module";
export type SeqMessageKind = "call" | "db-read" | "db-write" | "async" | "return";

export interface SeqParticipant {
  id: string;
  label: string;
  kind: SeqParticipantKind;
}
export interface SeqMessage {
  from: string; // participant id
  to: string; // participant id
  label: string;
  kind: SeqMessageKind;
  confidence: SeqConfidence;
  order: number;
}
export interface SequenceModel {
  entry: string;
  title: string;
  source: SeqSource;
  participants: SeqParticipant[];
  messages: SeqMessage[];
  notes: string[];
  stats: { steps?: number; runtimeConfirmed?: number; runtimeOrdered?: number; branches?: number };
}

/** id de participante seguro para Mermaid (alfanumérico + underscore). */
export function safeId(raw: string): string {
  const s = String(raw || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "p";
}

const MAX_LABEL = 48;
const clampLabel = (s: string) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > MAX_LABEL ? t.slice(0, MAX_LABEL - 1) + "…" : t;
};

// ── entrada: um passo do MechanismReport (só os campos que usamos) ──────────

export interface MechStepLike {
  order: number;
  fromLabel: string;
  toLabel: string;
  relationType?: string;
  method?: string; // RUNTIME_OBSERVED / STATIC_PROVEN / CONFIG_PROVEN / …
  runtimeConfirmed?: boolean;
  resolution?: string;
}
export interface MechReportLike {
  entry?: string;
  resolvedEntryId?: string | null;
  steps: MechStepLike[];
  runtimeConfirmed?: number;
  runtimeOrderedSteps?: number;
  orderSource?: "reachability" | "runtime-partial";
  branches?: Array<{ atLabel: string; fanOut: number }>;
}

function confidenceOf(s: MechStepLike): SeqConfidence {
  if (s.runtimeConfirmed || s.method === "RUNTIME_OBSERVED") return "observed";
  if (s.method === "STATIC_PROVEN" || s.method === "CONFIG_PROVEN" || s.resolution === "compiler") return "proven";
  return "inferred";
}
function kindOf(rel: string | undefined): SeqMessageKind {
  if (rel === "READS_ENTITY") return "db-read";
  if (rel === "WRITES_ENTITY") return "db-write";
  return "call";
}
/** papel do participante a partir do NOME (fallback) e do tipo do nó (quando dado). */
function participantKind(label: string, type?: string): SeqParticipantKind {
  const t = String(type || "").toUpperCase();
  if (t.includes("REPOSITOR")) return "repository";
  if (t === "ENTITY" || t.startsWith("TABLE")) return "db";
  if (t === "CONTROLLER" || t === "ROUTE") return "route";
  if (t === "SERVICE") return "service";
  const l = label.toLowerCase();
  if (/repositor|\brepo\b|dao\b/.test(l)) return "repository";
  if (/^table:|entity$/.test(l)) return "db";
  if (/route|controller|handler/.test(l)) return "route";
  if (/service|usecase|service_v1|servicev1/.test(l)) return "service";
  return "component";
}

/**
 * PURO: MechanismReport → SequenceModel. Participante = rótulo de componente (o
 * `fromLabel`/`toLabel` do passo, já em granularidade de classe/serviço). Confiança
 * por passo. Ordem = a do próprio report (runtime quando observada). Ramos → nota.
 * `labelType` (opcional) mapeia rótulo→tipo-de-nó para papel mais preciso do lifeline.
 */
export function mechanismToSequence(
  report: MechReportLike,
  opts: { entryLabel?: string; labelType?: Map<string, string> } = {},
): SequenceModel {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const labelType = opts.labelType ?? new Map<string, string>();
  const parts = new Map<string, SeqParticipant>();
  const ensure = (label: string): string => {
    const pid = safeId(label);
    if (!parts.has(pid)) parts.set(pid, { id: pid, label: clampLabel(label), kind: participantKind(label, labelType.get(label)) });
    return pid;
  };

  const messages: SeqMessage[] = [];
  const sorted = [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let order = 0;
  for (const s of sorted) {
    if (!s.fromLabel || !s.toLabel) continue;
    const from = ensure(s.fromLabel);
    const to = ensure(s.toLabel);
    if (from === to) continue; // auto-chamada no mesmo componente → ruído
    let kind = kindOf(s.relationType);
    // alvo é uma TABELA/entidade (lifeline `db`) mas a aresta veio como CALL (overlay
    // de runtime não tipa READS/WRITES) → trata como toque de leitura (direção
    // desconhecida ⇒ leitura por padrão, honesto). Não rebaixa um WRITE já tipado.
    if (kind === "call" && parts.get(to)?.kind === "db") kind = "db-read";
    messages.push({ from, to, label: clampLabel(s.toLabel), kind, confidence: confidenceOf(s), order: order++ });
  }

  const runtimeConfirmed = report.runtimeConfirmed ?? messages.filter((m) => m.confidence === "observed").length;
  const source: SeqSource =
    !messages.length ? "none" : report.orderSource === "runtime-partial" ? "runtime-partial" : runtimeConfirmed > 0 ? "runtime" : "static";

  const notes: string[] = [];
  if (source === "none") {
    notes.push("Sem sequência: o nó de entrada não tem chamadas provadas nem tráfego. Exercite a funcionalidade (ou rode o robô).");
  } else if (source === "runtime" || source === "runtime-partial") {
    notes.push(`Ordem REAL do OTel em ${report.runtimeOrderedSteps ?? runtimeConfirmed} passo(s); ${runtimeConfirmed} confirmado(s) por tráfego.`);
    if (source === "runtime-partial") notes.push("Parte dos passos não teve tráfego — ordem desses é por alcance estático (setas inferidas marcadas).");
  } else {
    notes.push("Sequência ESTÁTICA (topologia provada pelo compilador — ordem por alcance, NÃO a ordem real). Exercite a funcionalidade para a ordem real.");
  }
  const branches = report.branches?.length ?? 0;
  if (branches) notes.push(`${branches} ponto(s) de decisão/ramo detectado(s) — o diagrama mostra o caminho principal.`);

  const entryLabel = opts.entryLabel || report.resolvedEntryId || report.entry || "funcionalidade";
  return {
    entry: report.resolvedEntryId || report.entry || entryLabel,
    title: entryLabel,
    source,
    participants: [...parts.values()],
    messages,
    notes,
    stats: { steps: messages.length, runtimeConfirmed, runtimeOrdered: report.runtimeOrderedSteps ?? 0, branches },
  };
}

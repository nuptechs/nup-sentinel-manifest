// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Metro Map de Requisições" (lógica PURA).
//
// Cada rota vira uma LINHA (faixa horizontal); os participantes da sequência
// viram ESTAÇÕES; participante compartilhado entre 2+ linhas vira BALDEAÇÃO
// (mesma coluna x nas linhas envolvidas). O selo de cada trecho é a confiança
// da mensagem (observed → pulso · proven → sólido · inferred → tracejado).
// Zero dado inventado: consome só o /reasoner/sequence real por rota.
// ─────────────────────────────────────────────

export type SeqConfidence = "observed" | "proven" | "inferred";
export type SeqMsgKind = "call" | "db-read" | "db-write" | "async" | "return";

export interface SeqParticipant {
  id: string;
  label: string;
  kind?: string;
}
export interface SeqMessage {
  from: string;
  to: string;
  label?: string;
  kind?: SeqMsgKind;
  confidence?: SeqConfidence;
  order?: number;
}
export interface SequenceModel {
  entry?: string;
  title?: string;
  source?: "runtime" | "runtime-partial" | "static" | "none";
  participants?: SeqParticipant[];
  messages?: SeqMessage[];
  notes?: string[];
}
export interface MetroLineInput {
  routeLabel: string;
  model: SequenceModel | null | undefined;
}

export interface MetroStation {
  id: string;
  label: string;
  x: number;
  col: number;
  isDb: boolean;
  interchange: number; // em quantas linhas esta estação aparece (≥2 = baldeação)
}
export interface MetroSegment {
  x1: number;
  x2: number;
  confidence: SeqConfidence;
  isDb: boolean;
}
export interface MetroLine {
  routeLabel: string;
  y: number;
  color: string;
  source: SequenceModel["source"];
  stations: MetroStation[];
  segments: MetroSegment[];
  empty: boolean; // model.source === "none" ou sem mensagens
}
export interface MetroLayout {
  lines: MetroLine[];
  columnLabels: { id: string; label: string; x: number; interchange: number; isDb: boolean }[];
  width: number;
  height: number;
  colXs: number[];
}

// Paleta de linhas (fixa, funciona nos 2 temas — como o resto do repo).
export const METRO_LINE_COLORS = ["#8b7cf6", "#2dd4bf", "#fbbf24", "#34d399", "#f472b6", "#60a5fa"];

const COL_W = 150;
const COL_X0 = 150;
const LINE_Y0 = 70;
const LINE_GAP = 78;
const PAD_RIGHT = 60;

function isDbKind(k?: string): boolean {
  return k === "db-read" || k === "db-write";
}

/** Ordem canônica dos participantes de UMA linha (por 1ª aparição nas mensagens). */
function orderedParticipants(model: SequenceModel): SeqParticipant[] {
  const seen = new Map<string, SeqParticipant>();
  const byId = new Map<string, SeqParticipant>();
  for (const p of model.participants || []) if (p && typeof p.id === "string") byId.set(p.id, p);
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.set(id, byId.get(id) || { id, label: id });
  };
  const msgs = [...(model.messages || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const m of msgs) {
    if (m.kind === "return") continue;
    push(m.from);
    push(m.to);
  }
  // participantes declarados que não apareceram em nenhuma mensagem — ao fim.
  for (const p of model.participants || []) push(p.id);
  return Array.from(seen.values());
}

/**
 * Constrói o layout octilinear. As colunas são GLOBAIS: um participante presente
 * em várias linhas ocupa a MESMA coluna (é a baldeação). A ordem das colunas
 * segue a maior posição observada do participante entre as linhas — mantém o
 * fluxo esquerda→direita coerente.
 */
export function buildMetroLayout(inputs: MetroLineInput[]): MetroLayout {
  const perLine = inputs.map((inp) => {
    const model = inp.model || {};
    const parts = orderedParticipants(model);
    return { routeLabel: inp.routeLabel, model, parts };
  });

  // posição preferida de cada participante = média das posições-índice nas linhas.
  const posSum = new Map<string, number>();
  const posCount = new Map<string, number>();
  const isDb = new Map<string, boolean>();
  const labelOf = new Map<string, string>();
  const lineCount = new Map<string, number>();
  for (const pl of perLine) {
    pl.parts.forEach((p, idx) => {
      posSum.set(p.id, (posSum.get(p.id) || 0) + idx);
      posCount.set(p.id, (posCount.get(p.id) || 0) + 1);
      lineCount.set(p.id, (lineCount.get(p.id) || 0) + 1);
      if (!labelOf.has(p.id)) labelOf.set(p.id, p.label || p.id);
      const db = isDbKind(p.kind) || pl.model.messages?.some((m) => m.to === p.id && isDbKind(m.kind));
      if (db) isDb.set(p.id, true);
    });
  }
  const ids = Array.from(posSum.keys());
  ids.sort((a, b) => {
    const pa = posSum.get(a)! / posCount.get(a)!;
    const pb = posSum.get(b)! / posCount.get(b)!;
    if (pa !== pb) return pa - pb;
    return (labelOf.get(a) || a).localeCompare(labelOf.get(b) || b);
  });
  const colOf = new Map<string, number>();
  ids.forEach((id, i) => colOf.set(id, i));
  const colXs = ids.map((_, i) => COL_X0 + i * COL_W);
  const width = COL_X0 + Math.max(1, ids.length) * COL_W + PAD_RIGHT;

  const lines: MetroLine[] = perLine.map((pl, li) => {
    const y = LINE_Y0 + li * LINE_GAP;
    const color = METRO_LINE_COLORS[li % METRO_LINE_COLORS.length];
    const stationsRaw = pl.parts
      .map((p) => ({
        id: p.id,
        label: labelOf.get(p.id) || p.label || p.id,
        col: colOf.get(p.id) ?? 0,
        x: colXs[colOf.get(p.id) ?? 0] ?? COL_X0,
        isDb: !!isDb.get(p.id),
        interchange: lineCount.get(p.id) || 1,
      }))
      // desenha na ordem das colunas (esquerda→direita) para os segmentos ficarem retos.
      .sort((a, b) => a.col - b.col);
    const empty = pl.model.source === "none" || (pl.model.messages || []).length === 0;
    const segments: MetroSegment[] = [];
    // confiança do trecho entre estações consecutivas = pior confiança das
    // mensagens que ligam esse par (honesto: o elo mais fraco manda).
    for (let i = 0; i < stationsRaw.length - 1; i++) {
      const a = stationsRaw[i];
      const b = stationsRaw[i + 1];
      const conf = segmentConfidence(pl.model, a.id, b.id);
      segments.push({ x1: a.x, x2: b.x, confidence: conf, isDb: b.isDb });
    }
    return { routeLabel: pl.routeLabel, y, color, source: pl.model.source, stations: stationsRaw, segments, empty };
  });

  const columnLabels = ids.map((id) => ({
    id,
    label: labelOf.get(id) || id,
    x: colXs[colOf.get(id)!],
    interchange: lineCount.get(id) || 1,
    isDb: !!isDb.get(id),
  }));

  const height = LINE_Y0 + Math.max(1, perLine.length) * LINE_GAP;
  return { lines, columnLabels, width, height, colXs };
}

const CONF_RANK: Record<SeqConfidence, number> = { observed: 3, proven: 2, inferred: 1 };
function segmentConfidence(model: SequenceModel, aId: string, bId: string): SeqConfidence {
  let worst: SeqConfidence | null = null;
  for (const m of model.messages || []) {
    const touches = (m.from === aId && m.to === bId) || (m.from === bId && m.to === aId);
    if (!touches) continue;
    const c = (m.confidence || "inferred") as SeqConfidence;
    if (worst == null || CONF_RANK[c] < CONF_RANK[worst]) worst = c;
  }
  return worst ?? "inferred";
}

/** Cor do trecho por confiança (reaproveita a paleta de tiers do sistema). */
export const METRO_CONF_STYLE: Record<SeqConfidence, { label: string; dash?: string; pulse?: boolean }> = {
  observed: { label: "observado em runtime", pulse: true },
  proven: { label: "provado (estático/config)" },
  inferred: { label: "inferido — o compilador não confirmou", dash: "6 5" },
};

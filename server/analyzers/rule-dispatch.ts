// ─────────────────────────────────────────────
// rule-dispatch — resolve o dispatch do motor de regras (Fase 3, determinístico)
//
// Ponto cego que nenhuma análise estática de chamada resolve: no motor,
// `RuleEngine.findExecutor(actionType)` chama `executor.execute()` sobre a
// INTERFACE ActionExecutor — um leitor estático vê a interface, não QUAL
// executor roda. 0/1330 cadeias mencionavam um executor.
//
// Descoberta (prudência): este dispatch é DETERMINÍSTICO — cada executor
// declara `getActionType()` retornando seu RuleActionType. Logo resolve-se por
// PARSING (sem LLM, sem alucinação, sem custo), no mesmo espírito Models-as-Data
// da Fase 1. O agente-LLM fica para dispatch genuinamente não-parseável.
//
// Bônus de governança: cruza com o enum RuleActionType → lista os tipos
// DECLARADOS sem executor (ex.: enum órfão). Puro, vazio≠falhou.
// ─────────────────────────────────────────────

interface SrcFile {
  filePath: string;
  content: string;
}

export interface RuleDispatchReport {
  summary: { totalActionTypes: number; mapped: number; unmapped: number; executors: number };
  /** RuleActionType → executor concreto que o trata (com file:line do getActionType). */
  dispatch: { actionType: string; executor: string; sourceFile: string; line: number }[];
  /** Enum declarado mas sem executor — possível tipo órfão/removido. */
  unmappedActionTypes: string[];
}

const GET_ACTION_TYPE_RE =
  /getActionType\s*\(\s*\)\s*\{[\s\S]*?return\s+(?:RuleActionType\.)?([A-Z][A-Z0-9_]+)\s*;/;
const IMPLEMENTS_RE = /\bclass\s+\w+[\s\S]*?\bimplements\b[^{]*\bActionExecutor\b/;

function classOf(filePath: string): string {
  return filePath.split("/").pop()?.replace(/\.java$/, "") || filePath;
}
function lineOf(content: string, needle: string): number {
  const i = content.indexOf(needle);
  return i < 0 ? 0 : content.slice(0, i).split("\n").length;
}

/** Extrai as constantes do enum RuleActionType (corpo até o primeiro `;`). */
export function parseRuleActionTypeEnum(files: SrcFile[]): string[] {
  const f = files.find((x) => x.filePath.endsWith("RuleActionType.java"));
  if (!f) return [];
  const body = f.content.slice(f.content.indexOf("{") + 1);
  const end = body.indexOf(";");
  const region = end >= 0 ? body.slice(0, end) : body;
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\b([A-Z][A-Z0-9_]+)\s*(?:\([^)]*\))?\s*(?:,|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

export function resolveRuleDispatch(files: SrcFile[]): RuleDispatchReport {
  const src = Array.isArray(files) ? files.filter((f) => f && typeof f.content === "string" && f.filePath?.endsWith(".java")) : [];

  const byActionType = new Map<string, { executor: string; sourceFile: string; line: number }>();
  let executors = 0;
  for (const f of src) {
    const cls = classOf(f.filePath);
    if (cls === "ActionExecutor") continue; // a própria interface
    if (!IMPLEMENTS_RE.test(f.content)) continue;
    const m = f.content.match(GET_ACTION_TYPE_RE);
    if (!m) continue;
    executors++;
    const actionType = m[1];
    if (!byActionType.has(actionType)) {
      byActionType.set(actionType, { executor: cls, sourceFile: f.filePath, line: lineOf(f.content, m[0].slice(0, 20)) });
    }
  }

  const dispatch = Array.from(byActionType.entries())
    .map(([actionType, v]) => ({ actionType, ...v }))
    .sort((a, b) => a.actionType.localeCompare(b.actionType));

  const enumValues = parseRuleActionTypeEnum(src);
  const mappedSet = new Set(dispatch.map((d) => d.actionType));
  const unmappedActionTypes = enumValues.filter((v) => !mappedSet.has(v)).sort();

  return {
    summary: {
      totalActionTypes: enumValues.length,
      mapped: dispatch.length,
      unmapped: unmappedActionTypes.length,
      executors,
    },
    dispatch,
    unmappedActionTypes,
  };
}

export function renderRuleDispatchMarkdown(report: RuleDispatchReport, opts: { projectName?: string } = {}): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Dispatch do Motor de Regras${opts.projectName ? ` — ${opts.projectName}` : ""}`);
  lines.push("");
  lines.push(`**${s.mapped} tipos de ação → executor** · ${s.executors} executores · ${s.unmapped} tipo(s) sem executor`);
  lines.push("");
  lines.push("## Tipo de ação → executor");
  for (const d of report.dispatch) {
    lines.push(`- \`${d.actionType}\` → **${d.executor}** (\`${d.sourceFile}:${d.line}\`)`);
  }
  if (report.unmappedActionTypes.length) {
    lines.push("");
    lines.push("## Declarados sem executor (revisar)");
    for (const a of report.unmappedActionTypes) lines.push(`- \`${a}\``);
  }
  return lines.join("\n");
}

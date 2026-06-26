// ─────────────────────────────────────────────
// event-wiring — resolve o wiring de eventos Spring (Fase 3, determinístico)
//
// Ponto cego: aprovação→glosa (e outros) liga-se por EVENTO Spring, não por
// chamada — `publishEvent(RuleEvent)` → `@TransactionalEventListener` reagindo.
// Análise de chamada não conecta (0/1330 cadeias mencionavam listener).
//
// Confirmado parseável (sondagem easynup):
//   - publishers setam `.triggerType(RuleTriggerType.X)` num ponto fixo;
//   - listeners filtram por `getTriggerType() != X` / `getEntityType() != Y`
//     num padrão uniforme.
// Caveat honesto: listeners SEM guard estático (catch-all: roteiam por motor de
// regras ou JSONB no banco) são marcados `routing:"dynamic"` — não se inventa o
// destino (nem o LLM resolveria: é runtime/DB).
//
// Determinístico (sem LLM). Puro, vazio≠falhou.
// ─────────────────────────────────────────────

interface SrcFile {
  filePath: string;
  content: string;
}

type Routing = "guarded" | "dynamic";

export interface EventWiringReport {
  summary: { listeners: number; publishers: number; triggerTypesEmitted: number };
  /** Listeners de evento: tipo de evento + (se houver) o triggerType/entityType que filtram. */
  listeners: {
    class: string;
    method: string;
    eventType: string;
    triggerType: string | null;
    entityType: string | null;
    routing: Routing;
    sourceFile: string;
    line: number;
  }[];
  /** Métodos publisher → triggerType que emitem. */
  publishers: { class: string; method: string; triggerType: string; sourceFile: string; line: number }[];
}

const LISTENER_ANNOT = /@(?:Transactional)?EventListener\b/;
const METHOD_DECL = /\b(?:public|protected|private)\s+(?:void|[\w.<>,]+)\s+(\w+)\s*\(\s*(?:final\s+)?([\w.]+)\s+\w+/;
const TRIGGER_GUARD = /getTriggerType\(\)\s*!=\s*(?:RuleTriggerType\.)?(\w+)/;
const TRIGGER_GUARD_STR = /"(\w+)"\.equals\(\s*\w+\.getTriggerType\(\)\.name\(\)\)/;
const ENTITY_GUARD = /getEntityType\(\)\s*!=\s*(?:RuleEntityType\.)?(\w+)/;
const PUBLISH_TRIGGER = /\.triggerType\(\s*(?:RuleTriggerType\.)?(\w+)\s*\)/;

function classOf(filePath: string): string {
  return filePath.split("/").pop()?.replace(/\.java$/, "") || filePath;
}
function simpleType(t: string): string {
  return t.split(".").pop() || t;
}

export function resolveEventWiring(files: SrcFile[]): EventWiringReport {
  const src = Array.isArray(files) ? files.filter((f) => f && typeof f.content === "string" && f.filePath?.endsWith(".java")) : [];

  const listeners: EventWiringReport["listeners"] = [];
  const publishers: EventWiringReport["publishers"] = [];

  for (const f of src) {
    const cls = classOf(f.filePath);
    const lines = f.content.split("\n");

    // ── Listeners: anotação → próxima declaração de método → janela de guards
    for (let i = 0; i < lines.length; i++) {
      if (!LISTENER_ANNOT.test(lines[i])) continue;
      // acha a declaração de método nas próximas linhas (pula outras anotações)
      let decl: RegExpMatchArray | null = null;
      let declLine = i;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const m = lines[j].match(METHOD_DECL);
        if (m) {
          decl = m;
          declLine = j;
          break;
        }
      }
      if (!decl) continue;
      const eventType = simpleType(decl[2]);
      // só nos interessam listeners de evento de domínio (ignora ApplicationReadyEvent etc.)
      if (/ReadyEvent$/.test(eventType)) continue;

      // janela do corpo (próximas ~30 linhas) p/ extrair guards
      const windowEnd = Math.min(declLine + 30, lines.length);
      let triggerType: string | null = null;
      let entityType: string | null = null;
      for (let j = declLine; j < windowEnd; j++) {
        if (!triggerType) {
          const t = lines[j].match(TRIGGER_GUARD) || lines[j].match(TRIGGER_GUARD_STR);
          if (t) triggerType = t[1];
        }
        if (!entityType) {
          const e = lines[j].match(ENTITY_GUARD);
          if (e) entityType = e[1];
        }
      }
      listeners.push({
        class: cls,
        method: decl[1],
        eventType,
        triggerType,
        entityType,
        routing: triggerType || entityType ? "guarded" : "dynamic",
        sourceFile: f.filePath,
        line: declLine + 1,
      });
    }

    // ── Publishers: método corrente + `.triggerType(RuleTriggerType.X)`
    if (f.content.includes(".triggerType(")) {
      let currentMethod = "";
      for (let i = 0; i < lines.length; i++) {
        const md = lines[i].match(METHOD_DECL);
        if (md) currentMethod = md[1];
        const pt = lines[i].match(PUBLISH_TRIGGER);
        if (pt && currentMethod) {
          publishers.push({ class: cls, method: currentMethod, triggerType: pt[1], sourceFile: f.filePath, line: i + 1 });
        }
      }
    }
  }

  // dedup publishers por (class, method, triggerType)
  const seen = new Set<string>();
  const dedupPublishers = publishers.filter((p) => {
    const k = `${p.class}.${p.method}:${p.triggerType}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  listeners.sort((a, b) => a.class.localeCompare(b.class) || a.method.localeCompare(b.method));
  dedupPublishers.sort((a, b) => a.triggerType.localeCompare(b.triggerType) || a.method.localeCompare(b.method));

  return {
    summary: {
      listeners: listeners.length,
      publishers: dedupPublishers.length,
      triggerTypesEmitted: new Set(dedupPublishers.map((p) => p.triggerType)).size,
    },
    listeners,
    publishers: dedupPublishers,
  };
}

export function renderEventWiringMarkdown(report: EventWiringReport, opts: { projectName?: string } = {}): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Wiring de Eventos${opts.projectName ? ` — ${opts.projectName}` : ""}`);
  lines.push("");
  lines.push(`**${report.listeners.length} listeners** · **${s.triggerTypesEmitted} triggerTypes emitidos** por ${s.publishers} métodos publisher.`);
  lines.push("");
  lines.push("## Listeners");
  for (const l of report.listeners) {
    const filt = l.triggerType || l.entityType
      ? `${[l.triggerType, l.entityType].filter(Boolean).join(" / ")}`
      : "catch-all (roteia em runtime: motor de regras / DB)";
    lines.push(`- **${l.class}.${l.method}**(${l.eventType}) → ${filt}${l.routing === "dynamic" ? " ⚠️" : ""}`);
  }
  lines.push("");
  lines.push("## Publishers (triggerType emitido)");
  for (const p of report.publishers) {
    lines.push(`- \`${p.triggerType}\` ← ${p.class}.${p.method} (\`${p.sourceFile}:${p.line}\`)`);
  }
  return lines.join("\n");
}

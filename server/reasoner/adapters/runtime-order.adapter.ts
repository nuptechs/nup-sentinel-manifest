// ─────────────────────────────────────────────
// Reasoner — adapter de ORDEM DE RUNTIME (OTel/Jaeger), casamento SÃO por rota.
//
// Implementa a `RuntimeOrderPort`. A ordem SÓ é aplicada quando a entrada é uma
// ROTA runtime (`route:runtime:MÉTODO:/path`) — assim a sequência devolvida é a
// execução REAL DAQUELA rota, nunca de outra (correção > demo). Reusa o fetch e o
// casamento rota↔span PROVADOS do `runtime-overlay.ts` (os mesmos que fizeram as
// 88 arestas runtime do NuPIdentify). GATED + FAIL-SOFT: sem jaegerUrl/erro → [].
// Parte PURA (`extractRuntimeOrder`, `extractRuntimeOrderForRoute`) testável sem rede.
// ─────────────────────────────────────────────

import {
  normalizeTableName,
  tablesFromDbSpan,
  extractRuntimePairs,
  fetchRecentTracesWithReport,
  type JaegerTrace,
  type JaegerSpan,
} from "../../analyzers/runtime-overlay";
import type { RuntimeOp, RuntimeOrderPort } from "../mechanism-ports";

function spanTagMap(s: JaegerSpan): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of s.tags || []) {
    if (t && typeof t.key === "string") m[t.key] = String((t as { value?: unknown }).value ?? "");
  }
  return m;
}
function opOfStatement(tg: Record<string, string>): "read" | "write" | "touch" {
  const stmt = (tg["db.statement"] || tg["db.query.text"] || "").trim().toLowerCase();
  if (/^select|^with\b/.test(stmt)) return "read";
  if (/^insert|^update|^delete|^upsert|^merge/.test(stmt)) return "write";
  return "touch";
}
const normPath = (p: string) => String(p || "").replace(/\/+$/, "").toLowerCase();

/**
 * PURO: extrai a ordem REAL de operações de um CONJUNTO de traços (já filtrado por
 * rota). Escolhe o traço com mais spans DB (a requisição mais completa; empate →
 * menor traceID), ordena por `startTime`, tabelas na ordem de execução (1ª vence).
 */
export function extractRuntimeOrder(traces: JaegerTrace[]): RuntimeOp[] {
  const list = Array.isArray(traces) ? traces : [];
  let best: { traceID: string; dbSpans: JaegerSpan[] } | null = null;
  for (const t of list) {
    const spans = Array.isArray(t?.spans) ? t.spans : [];
    const dbSpans = spans.filter((s) => tablesFromDbSpan(spanTagMap(s)).length > 0);
    if (dbSpans.length === 0) continue;
    const traceID = String(t.traceID ?? "");
    if (!best || dbSpans.length > best.dbSpans.length || (dbSpans.length === best.dbSpans.length && traceID < best.traceID)) {
      best = { traceID, dbSpans };
    }
  }
  if (!best) return [];
  const ordered = best.dbSpans.slice().sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0) || String(a.spanID).localeCompare(String(b.spanID)));
  const ops: RuntimeOp[] = [];
  const seen = new Set<string>();
  let rank = 0;
  for (const s of ordered) {
    const tg = spanTagMap(s);
    const op = opOfStatement(tg);
    for (const raw of tablesFromDbSpan(tg)) {
      const table = normalizeTableName(raw);
      if (!table || seen.has(table)) continue;
      seen.add(table);
      ops.push({ table, op, rank: rank++ });
    }
  }
  return ops;
}

/**
 * PURO + SÃO: agrupa os traços por ROTA (via o `extractRuntimePairs` provado), acha
 * a rota que casa `targetPath`, e extrai a ordem SÓ dos traços daquela rota. Sem
 * match → [] (nunca aplica ordem de outra rota). Nunca lança.
 */
export function extractRuntimeOrderForRoute(
  traces: JaegerTrace[],
  targetPath: string,
  opts: { gatewayServices?: string[]; opPathPattern?: RegExp } = {},
): RuntimeOp[] {
  const list = Array.isArray(traces) ? traces : [];
  const target = normPath(targetPath);
  if (!target) return [];
  const pairs = extractRuntimePairs(list, opts);
  const pair =
    pairs.find((p) => normPath(p.path) === target) ||
    pairs.find((p) => normPath(p.path).endsWith(target) || target.endsWith(normPath(p.path)));
  if (!pair) return [];
  const ids = new Set(pair.traceIds);
  const matching = list.filter((t) => t.traceID && ids.has(t.traceID));
  return extractRuntimeOrder(matching);
}

interface JaegerOrderDeps {
  jaegerUrl?: string;
  services?: string[];
  gatewayServices?: string[];
  opPathPattern?: RegExp;
  lookbackMs?: number;
  limit?: number;
  fetchFn?: typeof fetch;
}

/**
 * Adapter Jaeger da `RuntimeOrderPort` (config resolvida por projeto). Só dispara
 * quando o `entryHint` é uma ROTA runtime `route:runtime:MÉTODO:/path`. GATED por
 * jaegerUrl; FAIL-SOFT total (qualquer erro → []).
 */
export function jaegerRuntimeOrderPort(deps: JaegerOrderDeps = {}): RuntimeOrderPort {
  return {
    async orderedOpsFor(entryHint: string): Promise<RuntimeOp[]> {
      try {
        const m = /^route:runtime:[A-Z]+:(\/.*)$/.exec(String(entryHint));
        if (!m) return []; // só rotas runtime têm um "request" cuja ordem faz sentido
        const path = m[1];
        if (!deps.jaegerUrl) return [];
        const { traces } = await fetchRecentTracesWithReport({
          baseUrl: deps.jaegerUrl,
          services: deps.services,
          lookbackMs: deps.lookbackMs ?? 24 * 3600 * 1000,
          limit: deps.limit ?? 200,
          fetchFn: deps.fetchFn,
        });
        return extractRuntimeOrderForRoute(traces, path, { gatewayServices: deps.gatewayServices, opPathPattern: deps.opPathPattern });
      } catch {
        return [];
      }
    },
  };
}

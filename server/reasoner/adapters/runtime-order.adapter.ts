// ─────────────────────────────────────────────
// Reasoner — adapter de ORDEM DE RUNTIME (OTel/Jaeger).
//
// Implementa a `RuntimeOrderPort` extraindo a ORDEM REAL de execução dos spans do
// Jaeger (que o overlay de runtime achata em aresta, perdendo a ordem). Reusa os
// tipos e normalizadores de `runtime-overlay.ts` (§2.5). GATED + FAIL-SOFT: sem
// `JAEGER_QUERY_URL` ou erro de rede → `[]`. A parte PURA (`extractRuntimeOrder`) é
// testável sem rede.
// ─────────────────────────────────────────────

import { normalizeTableName, tablesFromDbSpan, type JaegerTrace, type JaegerSpan } from "../../analyzers/runtime-overlay";
import type { RuntimeOp, RuntimeOrderPort } from "../mechanism-ports";

function spanTagMap(s: JaegerSpan): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of s.tags || []) {
    if (t && typeof t.key === "string") m[t.key] = String((t as { value?: unknown }).value ?? "");
  }
  return m;
}

/** read vs write pela 1ª palavra do db.statement (SELECT=read; INSERT/UPDATE/DELETE=write). */
function opOfStatement(tg: Record<string, string>): "read" | "write" | "touch" {
  const stmt = (tg["db.statement"] || tg["db.query.text"] || "").trim().toLowerCase();
  if (/^select|^with\b/.test(stmt)) return "read";
  if (/^insert|^update|^delete|^upsert|^merge/.test(stmt)) return "write";
  return "touch";
}

/**
 * PURO: extrai a ordem REAL de operações. Escolhe o traço com MAIS spans de DB (a
 * requisição mais completa; empate → menor traceID = determinístico), ordena seus
 * spans DB por `startTime`, e devolve as tabelas na ordem de execução (1ª ocorrência
 * de cada tabela vence). Nunca lança.
 */
export function extractRuntimeOrder(traces: JaegerTrace[]): RuntimeOp[] {
  const list = Array.isArray(traces) ? traces : [];
  let best: { traceID: string; dbSpans: JaegerSpan[] } | null = null;
  for (const t of list) {
    const spans = Array.isArray(t?.spans) ? t.spans : [];
    const dbSpans = spans.filter((s) => {
      const tg = spanTagMap(s);
      return tablesFromDbSpan(tg).length > 0;
    });
    if (dbSpans.length === 0) continue;
    const traceID = String(t.traceID ?? "");
    if (!best || dbSpans.length > best.dbSpans.length || (dbSpans.length === best.dbSpans.length && traceID < best.traceID)) {
      best = { traceID, dbSpans };
    }
  }
  if (!best) return [];

  const ordered = best.dbSpans
    .slice()
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0) || String(a.spanID).localeCompare(String(b.spanID)));

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

interface JaegerEnv {
  queryUrl?: string;
  service?: string;
  fetchImpl?: typeof fetch;
  lookbackHours?: number;
  limit?: number;
}

/**
 * Adapter Jaeger da `RuntimeOrderPort`. GATED por `JAEGER_QUERY_URL`; FAIL-SOFT
 * (qualquer erro → `[]`). Busca traços recentes do serviço e extrai a ordem pura.
 */
export function jaegerRuntimeOrderPort(env: JaegerEnv = {}): RuntimeOrderPort {
  const queryUrl = env.queryUrl ?? process.env.JAEGER_QUERY_URL;
  const doFetch = env.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  return {
    async orderedOpsFor(entryHint: string): Promise<RuntimeOp[]> {
      if (!queryUrl || !doFetch) return [];
      try {
        const service = env.service ?? process.env.JAEGER_SERVICE ?? "";
        const limit = env.limit ?? 30;
        const lookbackMicros = (env.lookbackHours ?? 24) * 3600 * 1_000_000;
        const params = new URLSearchParams();
        if (service) params.set("service", service);
        params.set("limit", String(limit));
        params.set("lookback", `${env.lookbackHours ?? 24}h`);
        // filtro best-effort pela rota (o Jaeger casa por operation/tag; sem match, cai vazio)
        if (entryHint) params.set("operation", entryHint);
        const url = `${queryUrl.replace(/\/$/, "")}/api/traces?${params.toString()}`;
        const resp = await doFetch(url, { signal: AbortSignal.timeout(6000) });
        if (!resp.ok) return [];
        const body = (await resp.json()) as { data?: JaegerTrace[] };
        return extractRuntimeOrder(Array.isArray(body?.data) ? body.data : []);
      } catch {
        return [];
      }
    },
  };
}

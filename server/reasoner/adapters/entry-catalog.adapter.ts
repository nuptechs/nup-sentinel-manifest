// ─────────────────────────────────────────────────────────────────────────
// Reasoner — adapter do CATÁLOGO de funcionalidades a partir do grafo shaped.
//
// Enumera as ENTRADAS que merecem diagrama de sequência: rotas do front
// (CONTROLLER/ROUTE e nós `route:…`) + batch/agendados (nós com `entryPoint`
// @Scheduled/listener). Dedup rota runtime×estática (prefere a observada). PURO.
// ─────────────────────────────────────────────────────────────────────────

import type { EntryPoint, EntryPointCatalog } from "../sequence/sequence-ports";

interface GNode {
  id: string;
  type?: string;
  label?: string;
  className?: string;
  httpMethod?: string;
  endpoint?: string;
  observed?: boolean;
  runtimeHot?: boolean;
  entryPoint?: unknown[];
}
interface GGraph {
  nodes?: GNode[];
}

const ROUTE_TYPES = new Set(["CONTROLLER", "ROUTE"]);

/** parseia `route:runtime:GET:/api/x` ou `route:GET:/api/x` → método/caminho. */
function parseRouteId(id: string): { method?: string; path?: string } {
  const m = id.match(/^route:(?:runtime:)?([A-Z]+):(.+)$/);
  if (m) return { method: m[1], path: m[2] };
  return {};
}

function isObserved(n: GNode): boolean {
  return n.observed === true || n.runtimeHot === true;
}

/** cria o catálogo a partir do grafo shaped. */
export function graphEntryCatalog(graph: GGraph): EntryPointCatalog {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const entries: EntryPoint[] = [];
  // dedup de rota por "MÉTODO PATH" — prefere a variante OBSERVADA (runtime).
  const routeByKey = new Map<string, EntryPoint>();

  for (const n of nodes) {
    if (!n || typeof n.id !== "string") continue;
    const type = String(n.type || "").toUpperCase();
    const isRouteId = n.id.startsWith("route:");
    const parsed = isRouteId ? parseRouteId(n.id) : {};
    const method = n.httpMethod || parsed.method;
    const path = n.endpoint || parsed.path;

    if (ROUTE_TYPES.has(type) || isRouteId) {
      const label = method && path ? `${method} ${path}` : n.label || n.className || n.id;
      const key = method && path ? `${method} ${path}` : n.id;
      const ep: EntryPoint = { id: n.id, label, kind: "route", httpMethod: method, httpPath: path, observed: isObserved(n) };
      const prev = routeByKey.get(key);
      // prefere a entrada OBSERVADA; entre iguais, prefere o id runtime (mais específico p/ ordem real).
      if (!prev || (ep.observed && !prev.observed) || (ep.observed === prev.observed && n.id.includes(":runtime:"))) {
        routeByKey.set(key, ep);
      }
      continue;
    }

    // batch / agendado / listener: nó com ponto de entrada declarado.
    if (Array.isArray(n.entryPoint) && n.entryPoint.length > 0) {
      const trigger = String(n.entryPoint[0] || "");
      const kind: EntryPoint["kind"] = /schedul|cron|job/i.test(trigger) ? "batch" : "job";
      entries.push({ id: n.id, label: `${trigger} ${n.className || n.label || n.id}`.trim(), kind, observed: isObserved(n) });
    }
  }
  entries.push(...routeByKey.values());
  // ordena: observadas primeiro, depois por rótulo (estável).
  entries.sort((a, b) => Number(b.observed) - Number(a.observed) || a.label.localeCompare(b.label));

  return {
    list: () => entries,
    resolve: (q: string) => {
      const query = String(q || "").trim();
      if (!query) return null;
      const byId = entries.find((e) => e.id === query);
      if (byId) return byId;
      const low = query.toLowerCase();
      return (
        entries.find((e) => e.label.toLowerCase() === low) ||
        entries.find((e) => e.label.toLowerCase().includes(low) || e.id.toLowerCase().includes(low)) ||
        null
      );
    },
  };
}

// ─────────────────────────────────────────────
// Diagramas de Evidência — vista "Sankey de Autorização" (lógica PURA).
//
// Colunas REAIS (não há "papel" no Manifest): Guarda → Permissão → Rota →
// Tabela. A largura de cada fluxo = nº de endpoints (dado ESTÁTICO honesto — o
// Manifest não conta tráfego por rota, então não fingimos volume de runtime).
// Fantasma = rota presente no catálogo mas `observed:false` (permitida, nunca
// vista pelo robô). Sem-guarda = crítico. Agregação "outras (K)" respeita um
// teto por coluna — truncar em silêncio é proibido.
// ─────────────────────────────────────────────

export type GuardClass = "none" | "auth-only" | "permission";

export interface GovEndpoint {
  path?: string;
  method?: string;
}
export interface GovernanceReport {
  summary?: { totalEndpoints?: number; guarded?: number; unguarded?: number };
  unguarded?: GovEndpoint[];
  byPermission?: Array<{ permission?: string; endpoints?: GovEndpoint[] }>;
}
export interface ExposureReport {
  exposures?: Array<{ path?: string; method?: string; guard?: GuardClass }>;
}
export interface EntityAccessReport {
  entities?: Array<{ entity?: string; readBy?: GovEndpoint[]; writtenBy?: GovEndpoint[] }>;
}
export interface CatalogLite {
  entries?: Array<{ httpMethod?: string; httpPath?: string; observed?: boolean; kind?: string }>;
}

interface FlowUnit {
  key: string; // `${method} ${path}`
  guard: GuardClass;
  permission: string; // "(sem permissão)" quando nenhuma
  route: string; // rótulo "GET /x"
  observed: boolean; // rota vista em runtime?
  table: string | null;
}

const NO_PERM = "(sem permissão)";
const NO_TABLE = "(nenhuma tabela)";

function ep(method?: string, path?: string): string {
  return `${(method || "").toUpperCase()} ${path || ""}`.trim();
}

/** Junta os 4 relatórios num conjunto de endpoints-fluxo. Puro. */
export function buildFlowUnits(
  gov: GovernanceReport | null | undefined,
  exposure: ExposureReport | null | undefined,
  entityAccess: EntityAccessReport | null | undefined,
  catalog: CatalogLite | null | undefined,
): FlowUnit[] {
  const guardOf = new Map<string, GuardClass>();
  for (const e of exposure?.exposures || []) {
    if (e?.guard) guardOf.set(ep(e.method, e.path), e.guard);
  }

  const observedOf = new Map<string, boolean>();
  for (const c of catalog?.entries || []) {
    if (c?.kind === "route" || c?.httpPath) observedOf.set(ep(c.httpMethod, c.httpPath), c.observed === true);
  }

  const tableOf = new Map<string, string>();
  for (const en of entityAccess?.entities || []) {
    const label = en?.entity || "";
    if (!label) continue;
    for (const r of [...(en.readBy || []), ...(en.writtenBy || [])]) {
      const k = ep(r.method, r.path);
      if (!tableOf.has(k)) tableOf.set(k, label); // 1ª tabela por endpoint (nota de multiplicidade fica na UI)
    }
  }

  const units = new Map<string, FlowUnit>();
  const add = (method: string | undefined, path: string | undefined, permission: string) => {
    const key = ep(method, path);
    if (!key) return;
    const existing = units.get(key);
    const guard = guardOf.get(key) ?? (permission === NO_PERM ? "none" : "permission");
    const unit: FlowUnit = existing || {
      key,
      guard,
      permission,
      route: key,
      observed: observedOf.get(key) ?? false,
      table: tableOf.get(key) ?? null,
    };
    // se veio de uma permissão real, promove sobre "(sem permissão)".
    if (permission !== NO_PERM) unit.permission = permission;
    unit.guard = guard;
    units.set(key, unit);
  };

  for (const bp of gov?.byPermission || []) {
    const perm = bp?.permission || NO_PERM;
    for (const e of bp.endpoints || []) add(e.method, e.path, perm);
  }
  for (const e of gov?.unguarded || []) add(e.method, e.path, NO_PERM);

  return Array.from(units.values());
}

// ── Layout de fluxo em camadas (Sankey) ────────────────────────────────
export interface SankeyNode {
  id: string;
  col: number;
  label: string;
  count: number;
  x: number;
  y0: number;
  y1: number;
  kind: "guard" | "permission" | "route" | "table";
  guard?: GuardClass;
  ghost?: boolean; // rota permitida, nunca observada
  aggregated?: number; // quando é o nó "outras (K)"
}
export interface SankeyLink {
  from: string;
  to: string;
  count: number;
  ghost: boolean;
  critical: boolean; // fluxo sem guarda
  sy0: number;
  sy1: number;
  ty0: number;
  ty1: number;
  sx: number;
  tx: number;
}
export interface SankeyModel {
  nodes: SankeyNode[];
  links: SankeyLink[];
  width: number;
  height: number;
  empty: boolean;
  stats: { endpoints: number; unguarded: number; ghost: number; tables: number };
}

const GUARD_LABEL: Record<GuardClass, string> = {
  none: "Sem guarda",
  "auth-only": "Autenticado",
  permission: "Permissão",
};
const GUARD_ORDER: GuardClass[] = ["none", "auth-only", "permission"];

const COL_X = [70, 340, 640, 940];
const NODE_W = 14;
const GAP = 6;
const TOP = 40;
const HEIGHT = 560;

interface ColGroup {
  id: string;
  label: string;
  count: number;
  kind: SankeyNode["kind"];
  guard?: GuardClass;
  ghost?: boolean;
  aggregated?: number;
}

function groupBy(
  units: FlowUnit[],
  keyer: (u: FlowUnit) => string,
  labeler: (k: string) => string,
  kind: SankeyNode["kind"],
  cap: number,
  extra?: (k: string, us: FlowUnit[]) => Partial<ColGroup>,
): ColGroup[] {
  const buckets = new Map<string, FlowUnit[]>();
  for (const u of units) {
    const k = keyer(u);
    (buckets.get(k) || buckets.set(k, []).get(k)!).push(u);
  }
  let groups: ColGroup[] = Array.from(buckets.entries()).map(([k, us]) => ({
    id: `${kind}:${k}`,
    label: labeler(k),
    count: us.length,
    kind,
    ...(extra ? extra(k, us) : {}),
  }));
  groups.sort((a, b) => b.count - a.count);
  if (groups.length > cap) {
    const keep = groups.slice(0, cap - 1);
    const rest = groups.slice(cap - 1);
    const restCount = rest.reduce((s, g) => s + g.count, 0);
    keep.push({
      id: `${kind}:__other__`,
      label: `outras (${rest.length})`,
      count: restCount,
      kind,
      aggregated: rest.length,
    });
    groups = keep;
  }
  return groups;
}

/** Constrói o modelo Sankey (4 colunas) a partir dos endpoints-fluxo. Puro. */
export function buildSankeyModel(units: FlowUnit[], caps = { perm: 7, route: 9, table: 8 }): SankeyModel {
  const width = COL_X[3] + 80;
  if (units.length === 0) {
    return { nodes: [], links: [], width, height: HEIGHT + TOP, empty: true, stats: { endpoints: 0, unguarded: 0, ghost: 0, tables: 0 } };
  }

  const guardGroups = GUARD_ORDER.map((g) => ({
    g,
    us: units.filter((u) => u.guard === g),
  })).filter((x) => x.us.length > 0);

  const colGuard: ColGroup[] = guardGroups.map((x) => ({
    id: `guard:${x.g}`,
    label: GUARD_LABEL[x.g],
    count: x.us.length,
    kind: "guard" as const,
    guard: x.g,
  }));
  const colPerm = groupBy(units, (u) => u.permission, (k) => k, "permission", caps.perm);
  const colRoute = groupBy(
    units,
    (u) => u.route,
    (k) => k,
    "route",
    caps.route,
    (k, us) => ({ ghost: us.every((u) => !u.observed) }),
  );
  const colTable = groupBy(units, (u) => u.table || NO_TABLE, (k) => k, "table", caps.table);

  const columns = [colGuard, colPerm, colRoute, colTable];

  // posiciona nós por coluna (altura ∝ count).
  const nodes: SankeyNode[] = [];
  const nodeById = new Map<string, SankeyNode>();
  columns.forEach((groups, col) => {
    const total = groups.reduce((s, g) => s + g.count, 0) || 1;
    const usable = HEIGHT - GAP * Math.max(0, groups.length - 1);
    let y = TOP;
    for (const g of groups) {
      const h = Math.max(8, (g.count / total) * usable);
      const n: SankeyNode = {
        id: g.id,
        col,
        label: g.label,
        count: g.count,
        x: COL_X[col],
        y0: y,
        y1: y + h,
        kind: g.kind,
        guard: g.guard,
        ghost: g.ghost,
        aggregated: g.aggregated,
      };
      nodes.push(n);
      nodeById.set(g.id, n);
      y += h + GAP;
    }
  });

  // resolve, para cada unidade, o id do nó em cada coluna (com fallback ao "outras").
  const routeIds = new Set(colRoute.map((g) => g.id));
  const permIds = new Set(colPerm.map((g) => g.id));
  const tableIds = new Set(colTable.map((g) => g.id));
  const resolve = (base: string, present: Set<string>, kind: string) =>
    present.has(base) ? base : `${kind}:__other__`;

  // agrega links por par (from,to).
  const linkAgg = new Map<string, { count: number; ghost: boolean; critical: boolean }>();
  const bump = (from: string, to: string, ghost: boolean, critical: boolean) => {
    const k = `${from}=>${to}`;
    const cur = linkAgg.get(k) || { count: 0, ghost: false, critical: false };
    cur.count += 1;
    cur.ghost = cur.ghost || ghost;
    cur.critical = cur.critical || critical;
    linkAgg.set(k, cur);
  };
  for (const u of units) {
    const gId = `guard:${u.guard}`;
    const pId = resolve(`permission:${u.permission}`, permIds, "permission");
    const rId = resolve(`route:${u.route}`, routeIds, "route");
    const tId = resolve(`table:${u.table || NO_TABLE}`, tableIds, "table");
    const critical = u.guard === "none";
    bump(gId, pId, false, critical);
    bump(pId, rId, !u.observed, critical);
    bump(rId, tId, !u.observed, false);
  }

  // distribui as bordas verticalmente dentro de cada nó (offsets acumulados).
  const outOff = new Map<string, number>();
  const inOff = new Map<string, number>();
  const links: SankeyLink[] = [];
  // ordena para desenho estável
  const entries = Array.from(linkAgg.entries()).sort();
  for (const [k, v] of entries) {
    const [from, to] = k.split("=>");
    const s = nodeById.get(from);
    const t = nodeById.get(to);
    if (!s || !t) continue;
    const sTotalOut = outTotal(nodeById, linkAgg, from);
    const tTotalIn = inTotal(nodeById, linkAgg, to);
    const sH = s.y1 - s.y0;
    const tH = t.y1 - t.y0;
    const so = outOff.get(from) || 0;
    const to0 = inOff.get(to) || 0;
    const sy0 = s.y0 + (sTotalOut ? (so / sTotalOut) * sH : 0);
    const sy1 = s.y0 + (sTotalOut ? ((so + v.count) / sTotalOut) * sH : sH);
    const ty0 = t.y0 + (tTotalIn ? (to0 / tTotalIn) * tH : 0);
    const ty1 = t.y0 + (tTotalIn ? ((to0 + v.count) / tTotalIn) * tH : tH);
    outOff.set(from, so + v.count);
    inOff.set(to, to0 + v.count);
    links.push({
      from,
      to,
      count: v.count,
      ghost: v.ghost,
      critical: v.critical,
      sy0,
      sy1,
      ty0,
      ty1,
      sx: s.x + NODE_W,
      tx: t.x,
    });
  }

  const ghost = units.filter((u) => !u.observed).length;
  const tables = new Set(units.map((u) => u.table).filter(Boolean)).size;
  const unguarded = units.filter((u) => u.guard === "none").length;
  return {
    nodes,
    links,
    width,
    height: HEIGHT + TOP,
    empty: false,
    stats: { endpoints: units.length, unguarded, ghost, tables },
  };
}

function outTotal(byId: Map<string, SankeyNode>, agg: Map<string, { count: number }>, from: string): number {
  let s = 0;
  for (const [k, v] of agg) if (k.startsWith(`${from}=>`)) s += v.count;
  return s;
}
function inTotal(byId: Map<string, SankeyNode>, agg: Map<string, { count: number }>, to: string): number {
  let s = 0;
  for (const [k, v] of agg) if (k.endsWith(`=>${to}`)) s += v.count;
  return s;
}

export const SANKEY_COLS = ["Guarda", "Permissão", "Rota", "Tabela"];
export const SANKEY_NODE_W = NODE_W;

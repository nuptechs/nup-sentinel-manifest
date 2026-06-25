// ─────────────────────────────────────────────
// entity-access — consulta "onde a entidade X é lida/escrita"
//
// Responde, para cada entidade, QUAIS endpoints a leem e quais a escrevem —
// a partir de manifest.endpoints[].entitiesTouched + persistenceOperations.
//
// Granularidade: ENTIDADE (não coluna). Lineage por COLUNA exige data-flow e
// fica para a Fase 5 — aqui não se promete o que o dado não suporta.
//
// Não duplica /completeness (que aponta lifecycle: escrito-mas-não-lido); esta
// é uma CONSULTA de acesso (lookup), não um achado. Puro, vazio≠falhou.
// ─────────────────────────────────────────────

interface EndpointLike {
  path?: string;
  method?: string;
  entitiesTouched?: unknown;
  persistenceOperations?: unknown;
}
interface ManifestLike {
  endpoints?: EndpointLike[];
}

type Ref = { path: string; method: string };

export interface EntityAccessReport {
  summary: { totalEntities: number; totalEndpointsWithEntity: number };
  entities: { entity: string; readBy: Ref[]; writtenBy: Ref[] }[];
}

const WRITE_OPS = new Set(["write", "save", "create", "update", "delete", "insert", "persist", "merge", "remove"]);
const READ_OPS = new Set(["read", "find", "get", "list", "select", "query", "fetch"]);

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export function detectEntityAccess(manifest: ManifestLike | null | undefined): EntityAccessReport {
  const eps = Array.isArray(manifest?.endpoints) ? manifest!.endpoints! : [];
  const map = new Map<string, { readBy: Ref[]; writtenBy: Ref[] }>();
  let endpointsWithEntity = 0;

  for (const e of eps) {
    const entities = strs(e?.entitiesTouched);
    if (entities.length === 0) continue;
    endpointsWithEntity++;
    const ops = strs(e?.persistenceOperations).map((o) => o.toLowerCase());
    const isWrite = ops.some((o) => WRITE_OPS.has(o));
    const isRead = ops.some((o) => READ_OPS.has(o));
    const ref: Ref = { path: typeof e?.path === "string" ? e.path : "", method: (typeof e?.method === "string" ? e.method : "").toUpperCase() };

    for (const ent of entities) {
      if (!map.has(ent)) map.set(ent, { readBy: [], writtenBy: [] });
      const slot = map.get(ent)!;
      if (isWrite) slot.writtenBy.push(ref);
      if (isRead) slot.readBy.push(ref);
      // op desconhecida (nem read nem write) → não classifica (conservador)
    }
  }

  const byPath = (a: Ref, b: Ref) => a.path.localeCompare(b.path);
  const entities = Array.from(map.entries())
    .map(([entity, v]) => ({ entity, readBy: v.readBy.sort(byPath), writtenBy: v.writtenBy.sort(byPath) }))
    .sort((a, b) => b.readBy.length + b.writtenBy.length - (a.readBy.length + a.writtenBy.length) || a.entity.localeCompare(b.entity));

  return {
    summary: { totalEntities: entities.length, totalEndpointsWithEntity: endpointsWithEntity },
    entities,
  };
}

export function renderEntityAccessMarkdown(report: EntityAccessReport, opts: { projectName?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`# Acesso por Entidade${opts.projectName ? ` — ${opts.projectName}` : ""}`);
  lines.push("");
  lines.push(`**${report.summary.totalEntities} entidades** acessadas por **${report.summary.totalEndpointsWithEntity} endpoints** (granularidade: entidade).`);
  lines.push("");
  for (const e of report.entities.slice(0, 100)) {
    lines.push(`## ${e.entity} — ${e.writtenBy.length} escrita(s) · ${e.readBy.length} leitura(s)`);
    for (const w of e.writtenBy) lines.push(`- ✏️ \`${w.method} ${w.path}\``);
    for (const r of e.readBy) lines.push(`- 👁️ \`${r.method} ${r.path}\``);
    lines.push("");
  }
  return lines.join("\n");
}

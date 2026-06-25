// ─────────────────────────────────────────────
// permission-governance — consulta de governança de permissão
//
// Pergunta que a extração de permissão (requiredRoles nos endpoints WsV1)
// destravou e que nenhum relatório existente responde:
//   - "quais endpoints NÃO têm proteção?" (risco de governança)
//   - "quais endpoints exigem a permissão P?" (o inverso, para auditoria)
//   - cobertura de proteção da superfície da API.
//
// Puro: opera só sobre o manifest.endpoints (com requiredRoles), sem I/O.
// vazio≠falhou: manifest sem endpoints → relatório zerado, não erro.
// ─────────────────────────────────────────────

interface EndpointLike {
  path?: string;
  method?: string;
  requiredRoles?: unknown;
  criticalityScore?: number;
}
interface ManifestLike {
  endpoints?: EndpointLike[];
}

export interface PermissionGovernanceReport {
  summary: {
    totalEndpoints: number;
    guarded: number;
    unguarded: number;
    coveragePercent: number;
    distinctPermissions: number;
  };
  /** Endpoints sem nenhuma permissão/auth — ordenados por criticidade desc. */
  unguarded: { path: string; method: string; criticalityScore: number }[];
  /** Permissão → endpoints que a exigem (inclui AUTHENTICATED). */
  byPermission: { permission: string; endpoints: { path: string; method: string }[] }[];
}

const AUTH = "AUTHENTICATED";

export function detectPermissionGovernance(manifest: ManifestLike | null | undefined): PermissionGovernanceReport {
  const eps = Array.isArray(manifest?.endpoints) ? manifest!.endpoints! : [];
  const unguarded: PermissionGovernanceReport["unguarded"] = [];
  const byPerm = new Map<string, { path: string; method: string }[]>();
  let guarded = 0;

  for (const e of eps) {
    const path = typeof e?.path === "string" ? e.path : "";
    const method = (typeof e?.method === "string" ? e.method : "").toUpperCase();
    const roles = Array.isArray(e?.requiredRoles)
      ? (e.requiredRoles as unknown[]).filter((r): r is string => typeof r === "string" && r.length > 0)
      : [];

    if (roles.length === 0) {
      unguarded.push({ path, method, criticalityScore: typeof e?.criticalityScore === "number" ? e.criticalityScore : 0 });
      continue;
    }
    guarded++;
    for (const r of roles) {
      if (!byPerm.has(r)) byPerm.set(r, []);
      byPerm.get(r)!.push({ path, method });
    }
  }

  unguarded.sort((a, b) => b.criticalityScore - a.criticalityScore || a.path.localeCompare(b.path));

  const byPermission = Array.from(byPerm.entries())
    .map(([permission, endpoints]) => ({
      permission,
      endpoints: endpoints.sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => b.endpoints.length - a.endpoints.length || a.permission.localeCompare(b.permission));

  const total = eps.length;
  // "permissões" de negócio = exclui o AUTHENTICATED genérico.
  const distinctPermissions = Array.from(byPerm.keys()).filter((p) => p !== AUTH).length;

  return {
    summary: {
      totalEndpoints: total,
      guarded,
      unguarded: unguarded.length,
      coveragePercent: total ? Math.round((guarded / total) * 100) : 0,
      distinctPermissions,
    },
    unguarded,
    byPermission,
  };
}

export function renderPermissionGovernanceMarkdown(
  report: PermissionGovernanceReport,
  opts: { projectName?: string } = {},
): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Governança de Permissão${opts.projectName ? ` — ${opts.projectName}` : ""}`);
  lines.push("");
  lines.push(
    `**${s.guarded}/${s.totalEndpoints} endpoints protegidos (${s.coveragePercent}%)** · ` +
      `${s.unguarded} sem proteção · ${s.distinctPermissions} permissões distintas`,
  );
  lines.push("");
  if (report.unguarded.length) {
    lines.push("## Endpoints sem proteção (por criticidade)");
    for (const e of report.unguarded.slice(0, 100)) {
      lines.push(`- \`${e.method} ${e.path}\`${e.criticalityScore ? ` (crit ${e.criticalityScore})` : ""}`);
    }
    if (report.unguarded.length > 100) lines.push(`- … +${report.unguarded.length - 100}`);
    lines.push("");
  } else {
    lines.push("## Endpoints sem proteção");
    lines.push("Nenhum — todos os endpoints exigem alguma permissão/auth.");
    lines.push("");
  }
  lines.push("## Endpoints por permissão");
  for (const p of report.byPermission) {
    lines.push(`- **${p.permission}** — ${p.endpoints.length} endpoint(s)`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────
// sensitive-exposure — consulta "quem toca dado sensível e está protegido?"
//
// Cruza os campos marcados sensíveis (manifest.endpoints[].sensitiveFieldsAccessed)
// com a proteção do endpoint (requiredRoles). Sinal de governança/LGPD: endpoint
// que toca dado sensível SEM proteção (ou só com auth genérica) é o risco.
//
// "Sensível" = o que o analisador marcou (campo @Convert/PII, relação de tenant
// etc.) — reporta-se o que está marcado, sem inventar classificação. Puro,
// vazio≠falhou.
// ─────────────────────────────────────────────

interface EndpointLike {
  path?: string;
  method?: string;
  requiredRoles?: unknown;
  sensitiveFieldsAccessed?: unknown;
  criticalityScore?: number;
}
interface ManifestLike {
  endpoints?: EndpointLike[];
}

type Guard = "none" | "auth-only" | "permission";

export interface SensitiveExposureReport {
  summary: {
    endpointsTouchingSensitive: number;
    unguarded: number; // toca sensível e NÃO exige nada
    authOnly: number; // só AUTHENTICATED, sem permissão específica
    guarded: number; // tem permissão específica
    distinctSensitiveFields: number;
  };
  exposures: {
    path: string;
    method: string;
    guard: Guard;
    requiredRoles: string[];
    sensitiveFields: string[];
    criticalityScore: number;
  }[];
}

const AUTH = "AUTHENTICATED";

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

const GUARD_RANK: Record<Guard, number> = { none: 0, "auth-only": 1, permission: 2 };

export function detectSensitiveExposure(manifest: ManifestLike | null | undefined): SensitiveExposureReport {
  const eps = Array.isArray(manifest?.endpoints) ? manifest!.endpoints! : [];
  const exposures: SensitiveExposureReport["exposures"] = [];
  const distinctFields = new Set<string>();
  let unguarded = 0;
  let authOnly = 0;
  let guarded = 0;

  for (const e of eps) {
    const sensitiveFields = strs(e?.sensitiveFieldsAccessed);
    if (sensitiveFields.length === 0) continue;
    sensitiveFields.forEach((f) => distinctFields.add(f));

    const roles = strs(e?.requiredRoles);
    const hasPermission = roles.some((r) => r !== AUTH);
    let guard: Guard;
    if (roles.length === 0) {
      guard = "none";
      unguarded++;
    } else if (!hasPermission) {
      guard = "auth-only";
      authOnly++;
    } else {
      guard = "permission";
      guarded++;
    }

    exposures.push({
      path: typeof e?.path === "string" ? e.path : "",
      method: (typeof e?.method === "string" ? e.method : "").toUpperCase(),
      guard,
      requiredRoles: roles,
      sensitiveFields,
      criticalityScore: typeof e?.criticalityScore === "number" ? e.criticalityScore : 0,
    });
  }

  // Risco primeiro: sem proteção → só-auth → com permissão; depois criticidade desc.
  exposures.sort(
    (a, b) =>
      GUARD_RANK[a.guard] - GUARD_RANK[b.guard] ||
      b.criticalityScore - a.criticalityScore ||
      a.path.localeCompare(b.path),
  );

  return {
    summary: {
      endpointsTouchingSensitive: exposures.length,
      unguarded,
      authOnly,
      guarded,
      distinctSensitiveFields: distinctFields.size,
    },
    exposures,
  };
}

export function renderSensitiveExposureMarkdown(
  report: SensitiveExposureReport,
  opts: { projectName?: string } = {},
): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`# Exposição de Dado Sensível${opts.projectName ? ` — ${opts.projectName}` : ""}`);
  lines.push("");
  lines.push(
    `**${s.endpointsTouchingSensitive} endpoints** tocam dado sensível · ` +
      `🔴 ${s.unguarded} sem proteção · 🟠 ${s.authOnly} só-auth · 🟢 ${s.guarded} com permissão · ` +
      `${s.distinctSensitiveFields} campos sensíveis distintos`,
  );
  lines.push("");
  const risk = report.exposures.filter((e) => e.guard !== "permission");
  lines.push(`## A revisar (${risk.length} sem permissão específica)`);
  for (const e of risk.slice(0, 100)) {
    const tag = e.guard === "none" ? "🔴 SEM PROTEÇÃO" : "🟠 só-auth";
    lines.push(`- ${tag} \`${e.method} ${e.path}\` — ${e.sensitiveFields.join(", ")}`);
  }
  if (risk.length > 100) lines.push(`- … +${risk.length - 100}`);
  return lines.join("\n");
}

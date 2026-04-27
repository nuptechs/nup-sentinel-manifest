import type { ManifestData } from "./manifest-generator";

export interface OpaBundle {
  policies: { path: string; content: string }[];
  data: object;
}

export function generateOpaRego(manifest: ManifestData): { policy: string; bundle: OpaBundle } {
  const packageName = `manifest.${sanitizeName(manifest.project.name)}`;
  const lines: string[] = [];

  lines.push(`package ${packageName}`);
  lines.push("");
  lines.push("import future.keywords.in");
  lines.push("");
  lines.push("default allow := false");
  lines.push("");

  lines.push("role_match(user_roles, required_roles) if {");
  lines.push("  some role in user_roles");
  lines.push("  role in required_roles");
  lines.push("}");
  lines.push("");

  const endpointsByController = new Map<string, typeof manifest.endpoints>();
  for (const ep of manifest.endpoints) {
    const ctrl = ep.controller || "default";
    if (!endpointsByController.has(ctrl)) endpointsByController.set(ctrl, []);
    endpointsByController.get(ctrl)!.push(ep);
  }

  for (const ep of manifest.endpoints) {
    const roles = ep.requiredRoles.length > 0 ? ep.requiredRoles : ["AUTHENTICATED"];
    const rolesSet = `{${roles.map(r => `"${r}"`).join(", ")}}`;

    lines.push(`# Controller: ${ep.controller || "unknown"}`);
    lines.push(`# Criticality: ${ep.criticalityScore}`);
    lines.push(`# Entities: ${ep.entitiesTouched.length > 0 ? ep.entitiesTouched.join(", ") : "none"}`);
    lines.push(`allow if {`);
    lines.push(`  input.method == "${ep.method}"`);
    lines.push(`  input.path == "${ep.path}"`);
    lines.push(`  role_match(input.user.roles, ${rolesSet})`);
    lines.push(`}`);
    lines.push("");
  }

  const sensitiveEndpoints = manifest.endpoints.filter(ep => ep.sensitiveFieldsAccessed.length > 0);
  if (sensitiveEndpoints.length > 0) {
    lines.push("# --- Sensitive Data Access Rules ---");
    lines.push("");
    lines.push("sensitive_data_access if {");
    const sensitivePatterns = sensitiveEndpoints.map(ep => `  input.path == "${ep.path}"`);
    lines.push(sensitivePatterns.join("\n} else if {\n"));
    lines.push("}");
    lines.push("");

    lines.push("deny_sensitive_without_admin if {");
    lines.push("  sensitive_data_access");
    lines.push(`  not role_match(input.user.roles, {"ADMIN"})`);
    lines.push("}");
    lines.push("");

    for (const ep of sensitiveEndpoints) {
      lines.push(`# Sensitive fields at ${ep.method} ${ep.path}: ${ep.sensitiveFieldsAccessed.join(", ")}`);
    }
    lines.push("");
  }

  const criticalEndpoints = manifest.endpoints.filter(ep => ep.criticalityScore >= 80);
  if (criticalEndpoints.length > 0) {
    lines.push("# --- Critical Operation Rules ---");
    lines.push("");
    lines.push("critical_operation if {");
    const critPatterns = criticalEndpoints.map(ep => `  input.method == "${ep.method}"; input.path == "${ep.path}"`);
    lines.push(critPatterns.join("\n} else if {\n"));
    lines.push("}");
    lines.push("");

    lines.push("deny_critical_without_elevated_role if {");
    lines.push("  critical_operation");
    lines.push(`  not role_match(input.user.roles, {"ADMIN", "SUPER_ADMIN"})`);
    lines.push("}");
    lines.push("");
  }

  const policy = lines.join("\n");

  const controllerPolicies: { path: string; content: string }[] = [];
  for (const [controller, endpoints] of Array.from(endpointsByController.entries())) {
    const ctrlName = sanitizeName(controller);
    const ctrlLines: string[] = [];
    ctrlLines.push(`package ${packageName}.${ctrlName}`);
    ctrlLines.push("");
    ctrlLines.push("import future.keywords.in");
    ctrlLines.push("");
    ctrlLines.push("default allow := false");
    ctrlLines.push("");

    ctrlLines.push("role_match(user_roles, required_roles) if {");
    ctrlLines.push("  some role in user_roles");
    ctrlLines.push("  role in required_roles");
    ctrlLines.push("}");
    ctrlLines.push("");

    for (const ep of endpoints) {
      const roles = ep.requiredRoles.length > 0 ? ep.requiredRoles : ["AUTHENTICATED"];
      const rolesSet = `{${roles.map(r => `"${r}"`).join(", ")}}`;
      ctrlLines.push(`# Criticality: ${ep.criticalityScore}`);
      ctrlLines.push(`# Entities: ${ep.entitiesTouched.length > 0 ? ep.entitiesTouched.join(", ") : "none"}`);
      ctrlLines.push(`allow if {`);
      ctrlLines.push(`  input.method == "${ep.method}"`);
      ctrlLines.push(`  input.path == "${ep.path}"`);
      ctrlLines.push(`  role_match(input.user.roles, ${rolesSet})`);
      ctrlLines.push(`}`);
      ctrlLines.push("");
    }

    controllerPolicies.push({
      path: `${packageName.replace(/\./g, "/")}/${ctrlName}/policy.rego`,
      content: ctrlLines.join("\n"),
    });
  }

  const dataDocument: Record<string, unknown> = {
    project: manifest.project.name,
    generatedAt: new Date().toISOString(),
    endpoints: manifest.endpoints.map(ep => ({
      path: ep.path,
      method: ep.method,
      roles: ep.requiredRoles.length > 0 ? ep.requiredRoles : ["AUTHENTICATED"],
      criticality: ep.criticalityScore,
      sensitiveFields: ep.sensitiveFieldsAccessed,
      controller: ep.controller,
    })),
    roles: manifest.roles.map(r => ({
      name: r.name,
      endpointCount: r.endpoints.length,
    })),
  };

  const bundle: OpaBundle = {
    policies: [
      { path: `${packageName.replace(/\./g, "/")}/policy.rego`, content: policy },
      ...controllerPolicies,
    ],
    data: dataDocument,
  };

  return { policy, bundle };
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

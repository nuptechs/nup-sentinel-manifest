import type { PermaCatManifest } from "./manifest-generator";

interface PolicyEntry {
  resource: string;
  action: string;
  roles: string[];
  conditions: string[];
  effect: "ALLOW";
  criticalityScore: number;
  sensitiveData: boolean;
}

interface KeycloakPolicy {
  realm: string;
  clients: {
    clientId: string;
    authorizationSettings: {
      resources: { name: string; uris: string[]; scopes: { name: string }[] }[];
      policies: { name: string; type: string; logic: string; roles: { id: string; required: boolean }[] }[];
      permissions: { name: string; type: string; resources: string[]; policies: string[]; scopes: string[] }[];
    };
  }[];
}

interface OktaPolicy {
  label: string;
  description: string;
  rules: {
    name: string;
    actions: { appSignOn: { access: string; verificationMethod: { type: string } } };
    conditions: { expression: { value: string } };
  }[];
  groups: { name: string; description: string; endpoints: string[] }[];
}

interface AWSIAMPolicy {
  Version: string;
  Statement: {
    Sid: string;
    Effect: string;
    Action: string[];
    Resource: string[];
    Condition?: Record<string, Record<string, string>>;
  }[];
}

export interface PolicyMatrixOutput {
  generatedAt: string;
  project: string;
  universalMatrix: PolicyEntry[];
  keycloak: KeycloakPolicy;
  okta: OktaPolicy;
  awsIam: Record<string, AWSIAMPolicy>;
}

export function generatePolicyMatrix(manifest: PermaCatManifest): PolicyMatrixOutput {
  const universalMatrix = buildUniversalMatrix(manifest);

  return {
    generatedAt: new Date().toISOString(),
    project: manifest.project.name,
    universalMatrix,
    keycloak: buildKeycloakPolicy(manifest, universalMatrix),
    okta: buildOktaPolicy(manifest, universalMatrix),
    awsIam: buildAWSIAMPolicies(manifest, universalMatrix),
  };
}

function buildUniversalMatrix(manifest: PermaCatManifest): PolicyEntry[] {
  const entries: PolicyEntry[] = [];

  for (const ep of manifest.endpoints) {
    const conditions: string[] = [];
    for (const ann of ep.securityAnnotations) {
      if (ann.expression) conditions.push(ann.expression);
    }

    entries.push({
      resource: ep.path,
      action: `${ep.method}:${ep.technicalOperation}`,
      roles: ep.requiredRoles.length > 0 ? ep.requiredRoles : ["AUTHENTICATED"],
      conditions,
      effect: "ALLOW",
      criticalityScore: ep.criticalityScore,
      sensitiveData: ep.sensitiveFieldsAccessed.length > 0,
    });
  }

  return entries.sort((a, b) => b.criticalityScore - a.criticalityScore);
}

function buildKeycloakPolicy(manifest: PermaCatManifest, matrix: PolicyEntry[]): KeycloakPolicy {
  const resources = matrix.map(entry => ({
    name: `res:${entry.resource}`,
    uris: [entry.resource],
    scopes: [{ name: entry.action.split(":")[0] }],
  }));

  const roleSet = new Set<string>();
  for (const entry of matrix) {
    for (const role of entry.roles) roleSet.add(role);
  }

  const policies = Array.from(roleSet).map(role => ({
    name: `policy-${role.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    type: "role",
    logic: "POSITIVE",
    roles: [{ id: role, required: true }],
  }));

  const permissions = matrix.map((entry, idx) => ({
    name: `perm-${idx}-${entry.resource.replace(/[^a-zA-Z0-9]/g, "-")}`,
    type: "resource",
    resources: [`res:${entry.resource}`],
    policies: entry.roles.map(r => `policy-${r.toLowerCase().replace(/[^a-z0-9]/g, "-")}`),
    scopes: [entry.action.split(":")[0]],
  }));

  return {
    realm: manifest.project.name.toLowerCase().replace(/\s+/g, "-"),
    clients: [{
      clientId: `${manifest.project.name.toLowerCase().replace(/\s+/g, "-")}-app`,
      authorizationSettings: { resources, policies, permissions },
    }],
  };
}

function buildOktaPolicy(manifest: PermaCatManifest, matrix: PolicyEntry[]): OktaPolicy {
  const roleGroups = new Map<string, string[]>();
  for (const entry of matrix) {
    for (const role of entry.roles) {
      if (!roleGroups.has(role)) roleGroups.set(role, []);
      roleGroups.get(role)!.push(`${entry.action} ${entry.resource}`);
    }
  }

  const groups = Array.from(roleGroups.entries()).map(([role, endpoints]) => ({
    name: role,
    description: `Auto-generated group for role ${role} — ${endpoints.length} permissions`,
    endpoints,
  }));

  const rules = matrix
    .filter(e => e.criticalityScore >= 50)
    .map((entry, idx) => ({
      name: `rule-${idx}-${entry.resource.replace(/[^a-zA-Z0-9]/g, "-")}`,
      actions: {
        appSignOn: {
          access: "ALLOW",
          verificationMethod: {
            type: entry.criticalityScore >= 80 ? "ASSURANCE_MEDIUM" : "ASSURANCE_LOW",
          },
        },
      },
      conditions: {
        expression: {
          value: entry.roles.length > 0
            ? `user.isMemberOfGroupName("${entry.roles.join('") OR user.isMemberOfGroupName("')}")`
            : 'user.isAuthenticated',
        },
      },
    }));

  return {
    label: `${manifest.project.name} Access Policy`,
    description: `Auto-generated by PermaCat — ${matrix.length} resource policies`,
    rules,
    groups,
  };
}

function buildAWSIAMPolicies(manifest: PermaCatManifest, matrix: PolicyEntry[]): Record<string, AWSIAMPolicy> {
  const roleGroups = new Map<string, PolicyEntry[]>();
  for (const entry of matrix) {
    for (const role of entry.roles) {
      if (!roleGroups.has(role)) roleGroups.set(role, []);
      roleGroups.get(role)!.push(entry);
    }
  }

  const policies: Record<string, AWSIAMPolicy> = {};

  for (const [role, entries] of Array.from(roleGroups.entries())) {
    const policyName = `${manifest.project.name.replace(/\s+/g, "")}-${role.replace(/[^a-zA-Z0-9]/g, "")}`;

    const actionMap = new Map<string, string[]>();
    for (const entry of entries) {
      const action = httpMethodToIAMAction(entry.action.split(":")[0]);
      if (!actionMap.has(action)) actionMap.set(action, []);
      actionMap.get(action)!.push(apiResourceToARN(manifest.project.name, entry.resource));
    }

    const statements = Array.from(actionMap.entries()).map(([action, resources], idx) => {
      const stmt: any = {
        Sid: `Stmt${idx}${action.replace(":", "")}`,
        Effect: "Allow",
        Action: [action],
        Resource: Array.from(new Set(resources)),
      };

      const sensitiveEntries = entries.filter(e => e.sensitiveData);
      if (sensitiveEntries.length > 0) {
        stmt.Condition = {
          Bool: { "aws:SecureTransport": "true" },
        };
      }

      return stmt;
    });

    policies[policyName] = {
      Version: "2012-10-17",
      Statement: statements,
    };
  }

  return policies;
}

function httpMethodToIAMAction(method: string): string {
  const map: Record<string, string> = {
    GET: "execute-api:GET",
    POST: "execute-api:POST",
    PUT: "execute-api:PUT",
    PATCH: "execute-api:PATCH",
    DELETE: "execute-api:DELETE",
  };
  return map[method.toUpperCase()] || "execute-api:Invoke";
}

function apiResourceToARN(projectName: string, path: string): string {
  const sanitized = path.replace(/^\//, "").replace(/\{[^}]+\}/g, "*");
  return `arn:aws:execute-api:*:*:${projectName.toLowerCase().replace(/\s+/g, "-")}/*/${sanitized}`;
}

import type { ManifestData } from "./manifest-generator";
import type { SecurityFindingRecord } from "@shared/schema";

interface KeycloakRole {
  id: string;
  name: string;
  description: string;
  composite: boolean;
  clientRole: boolean;
  containerId: string;
}

interface KeycloakResourceScope {
  name: string;
}

interface KeycloakResource {
  name: string;
  type: string;
  uris: string[];
  scopes: KeycloakResourceScope[];
  ownerManagedAccess: boolean;
}

interface KeycloakRolePolicy {
  id: string;
  name: string;
  description: string;
  type: "role";
  logic: "POSITIVE" | "NEGATIVE";
  decisionStrategy: "UNANIMOUS" | "AFFIRMATIVE" | "CONSENSUS";
  roles: { id: string; required: boolean }[];
}

interface KeycloakResourcePermission {
  id: string;
  name: string;
  description: string;
  type: "resource";
  decisionStrategy: "UNANIMOUS" | "AFFIRMATIVE" | "CONSENSUS";
  resources: string[];
  policies: string[];
  scopes: string[];
}

interface KeycloakAuthorizationSettings {
  allowRemoteResourceManagement: boolean;
  policyEnforcementMode: "ENFORCING" | "PERMISSIVE" | "DISABLED";
  decisionStrategy: "UNANIMOUS" | "AFFIRMATIVE" | "CONSENSUS";
  resources: KeycloakResource[];
  policies: KeycloakRolePolicy[];
  permissions: KeycloakResourcePermission[];
  scopes: KeycloakResourceScope[];
}

interface KeycloakClient {
  clientId: string;
  name: string;
  description: string;
  enabled: boolean;
  bearerOnly: boolean;
  consentRequired: boolean;
  standardFlowEnabled: boolean;
  directAccessGrantsEnabled: boolean;
  serviceAccountsEnabled: boolean;
  authorizationServicesEnabled: boolean;
  protocol: string;
  publicClient: boolean;
  redirectUris: string[];
  webOrigins: string[];
  authorizationSettings: KeycloakAuthorizationSettings;
}

interface KeycloakClientScope {
  name: string;
  description: string;
  protocol: string;
  attributes: Record<string, string>;
}

export interface KeycloakRealmExport {
  id: string;
  realm: string;
  displayName: string;
  enabled: boolean;
  sslRequired: string;
  registrationAllowed: boolean;
  loginWithEmailAllowed: boolean;
  duplicateEmailsAllowed: boolean;
  resetPasswordAllowed: boolean;
  editUsernameAllowed: boolean;
  bruteForceProtected: boolean;
  roles: {
    realm: KeycloakRole[];
  };
  clients: KeycloakClient[];
  clientScopes: KeycloakClientScope[];
  defaultDefaultClientScopes: string[];
  defaultOptionalClientScopes: string[];
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function generateId(prefix: string, name: string): string {
  const hash = Array.from(`${prefix}-${name}`).reduce((acc, c) => ((acc << 5) - acc + c.charCodeAt(0)) | 0, 0);
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-a${hex.slice(1, 4)}-${hex.padEnd(12, "0").slice(0, 12)}`;
}

export function generateKeycloakRealm(
  manifest: ManifestData,
  securityFindings?: SecurityFindingRecord[]
): KeycloakRealmExport {
  const realmName = sanitize(manifest.project.name);
  const clientId = `${realmName}-app`;

  const roleSet = new Set<string>(["AUTHENTICATED"]);
  for (const role of manifest.roles) {
    roleSet.add(role.name);
  }

  const realmRoles: KeycloakRole[] = Array.from(roleSet).map((roleName) => ({
    id: generateId("role", roleName),
    name: roleName,
    description: `Auto-generated role from Manifest analysis: ${roleName}`,
    composite: false,
    clientRole: false,
    containerId: realmName,
  }));

  const httpMethods = new Set<string>();
  for (const ep of manifest.endpoints) {
    httpMethods.add(ep.method.toUpperCase());
  }
  const allScopes: KeycloakResourceScope[] = Array.from(httpMethods).map((m) => ({ name: m }));

  const resources: KeycloakResource[] = manifest.endpoints.map((ep) => ({
    name: `${ep.method.toUpperCase()}:${ep.path}`,
    type: "urn:resource",
    uris: [ep.path],
    scopes: [{ name: ep.method.toUpperCase() }],
    ownerManagedAccess: false,
  }));

  const rolePolicies: KeycloakRolePolicy[] = Array.from(roleSet).map((roleName) => ({
    id: generateId("policy", roleName),
    name: `policy-${sanitize(roleName)}`,
    description: `Role-based policy for ${roleName}`,
    type: "role" as const,
    logic: "POSITIVE" as const,
    decisionStrategy: "UNANIMOUS" as const,
    roles: [{ id: generateId("role", roleName), required: true }],
  }));

  const permissions: KeycloakResourcePermission[] = manifest.endpoints.map((ep, idx) => {
    const roles = ep.requiredRoles.length > 0 ? ep.requiredRoles : ["AUTHENTICATED"];
    const linkedPolicies = roles.map((r) => `policy-${sanitize(r)}`);

    return {
      id: generateId("perm", `${ep.method}-${ep.path}-${idx}`),
      name: `perm-${idx}-${sanitize(ep.method)}-${sanitize(ep.path)}`,
      description: `Permission for ${ep.method.toUpperCase()} ${ep.path}`,
      type: "resource" as const,
      decisionStrategy: "AFFIRMATIVE" as const,
      resources: [`${ep.method.toUpperCase()}:${ep.path}`],
      policies: linkedPolicies,
      scopes: [ep.method.toUpperCase()],
    };
  });

  const authorizationSettings: KeycloakAuthorizationSettings = {
    allowRemoteResourceManagement: true,
    policyEnforcementMode: "ENFORCING",
    decisionStrategy: "UNANIMOUS",
    resources,
    policies: rolePolicies,
    permissions,
    scopes: allScopes,
  };

  const client: KeycloakClient = {
    clientId,
    name: manifest.project.name,
    description: `Auto-generated client for ${manifest.project.name} by Manifest`,
    enabled: true,
    bearerOnly: false,
    consentRequired: false,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: true,
    serviceAccountsEnabled: true,
    authorizationServicesEnabled: true,
    protocol: "openid-connect",
    publicClient: false,
    redirectUris: ["/*"],
    webOrigins: ["*"],
    authorizationSettings,
  };

  const clientScopes: KeycloakClientScope[] = [
    {
      name: "openid",
      description: "OpenID Connect scope",
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "true" },
    },
    {
      name: "email",
      description: "OpenID Connect built-in scope: email",
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "true" },
    },
    {
      name: "profile",
      description: "OpenID Connect built-in scope: profile",
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "true" },
    },
    {
      name: "roles",
      description: "OpenID Connect scope for user roles",
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true", "display.on.consent.screen": "false" },
    },
  ];

  return {
    id: realmName,
    realm: realmName,
    displayName: manifest.project.name,
    enabled: true,
    sslRequired: "external",
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: true,
    editUsernameAllowed: false,
    bruteForceProtected: true,
    roles: {
      realm: realmRoles,
    },
    clients: [client],
    clientScopes,
    defaultDefaultClientScopes: ["openid", "email", "profile", "roles"],
    defaultOptionalClientScopes: [],
  };
}

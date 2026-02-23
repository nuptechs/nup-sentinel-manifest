import type { CatalogEntry, Project } from "@shared/schema";

interface ManifestEndpoint {
  path: string;
  method: string;
  controller: string;
  controllerMethod: string;
  serviceMethods: string[];
  repositoryMethods: string[];
  entitiesTouched: string[];
  persistenceOperations: string[];
  requiredRoles: string[];
  securityAnnotations: { type: string; expression: string; roles: string[] }[];
  sensitiveFieldsAccessed: string[];
  criticalityScore: number;
  technicalOperation: string;
}

interface ManifestScreen {
  name: string;
  route: string | null;
  routeGuards: string[];
  interactions: {
    name: string;
    type: string;
    endpoint: string | null;
    httpMethod: string | null;
    technicalOperation: string;
    criticalityScore: number;
    confidence: number;
    resolutionPath: { tier: string; file: string; function: string | null; detail: string | null }[];
  }[];
}

interface ManifestRole {
  name: string;
  endpoints: { path: string; method: string; controller: string }[];
  criticalityRange: [number, number];
}

interface ManifestEntity {
  name: string;
  operations: string[];
  accessedBy: { controller: string; method: string; endpoint: string }[];
  sensitiveFields: string[];
  fieldMetadata: { name: string; type: string; isId: boolean; isSensitive: boolean; validations?: string[] }[];
}

export interface PermaCatManifest {
  $schema: string;
  version: string;
  generatedAt: string;
  generator: { name: string; version: string };
  project: {
    name: string;
    description: string | null;
    analyzedAt: string;
  };
  summary: {
    totalScreens: number;
    totalInteractions: number;
    totalEndpoints: number;
    totalEntities: number;
    totalRoles: number;
    averageCriticality: number;
    securityCoverage: number;
  };
  endpoints: ManifestEndpoint[];
  screens: ManifestScreen[];
  roles: ManifestRole[];
  entities: ManifestEntity[];
  securityMatrix: {
    endpoint: string;
    method: string;
    roles: string[];
    guards: string[];
    criticalityScore: number;
    sensitiveData: boolean;
  }[];
}

export function generateManifest(project: Project, entries: CatalogEntry[]): PermaCatManifest {
  const endpointMap = new Map<string, ManifestEndpoint>();
  const screenMap = new Map<string, ManifestScreen>();
  const roleMap = new Map<string, ManifestRole>();
  const entityMap = new Map<string, ManifestEntity>();

  for (const entry of entries) {
    if (entry.endpoint && entry.httpMethod) {
      const key = `${entry.httpMethod}:${entry.endpoint}`;
      if (!endpointMap.has(key)) {
        endpointMap.set(key, {
          path: entry.endpoint,
          method: entry.httpMethod,
          controller: entry.controllerClass || "",
          controllerMethod: entry.controllerMethod || "",
          serviceMethods: [],
          repositoryMethods: [],
          entitiesTouched: [],
          persistenceOperations: [],
          requiredRoles: [],
          securityAnnotations: [],
          sensitiveFieldsAccessed: [],
          criticalityScore: entry.criticalityScore || 0,
          technicalOperation: entry.technicalOperation || "UNKNOWN",
        });
      }
      const ep = endpointMap.get(key)!;
      mergeArrays(ep.serviceMethods, entry.serviceMethods as string[] || []);
      mergeArrays(ep.repositoryMethods, entry.repositoryMethods as string[] || []);
      mergeArrays(ep.entitiesTouched, entry.entitiesTouched as string[] || []);
      mergeArrays(ep.persistenceOperations, entry.persistenceOperations as string[] || []);
      mergeArrays(ep.requiredRoles, entry.requiredRoles as string[] || []);
      mergeArrays(ep.sensitiveFieldsAccessed, entry.sensitiveFieldsAccessed as string[] || []);
      if (entry.securityAnnotations) {
        for (const ann of entry.securityAnnotations as { type: string; expression: string; roles: string[] }[]) {
          if (!ep.securityAnnotations.find(a => a.type === ann.type && a.expression === ann.expression)) {
            ep.securityAnnotations.push(ann);
          }
        }
      }
      if ((entry.criticalityScore || 0) > ep.criticalityScore) {
        ep.criticalityScore = entry.criticalityScore || 0;
      }
    }

    const screenName = entry.screen;
    if (!screenMap.has(screenName)) {
      screenMap.set(screenName, {
        name: screenName,
        route: entry.frontendRoute || null,
        routeGuards: [],
        interactions: [],
      });
    }
    const screen = screenMap.get(screenName)!;
    if (entry.frontendRoute && !screen.route) screen.route = entry.frontendRoute;
    mergeArrays(screen.routeGuards, entry.routeGuards as string[] || []);
    screen.interactions.push({
      name: entry.interaction,
      type: entry.interactionType,
      endpoint: entry.endpoint || null,
      httpMethod: entry.httpMethod || null,
      technicalOperation: entry.technicalOperation || "UNKNOWN",
      criticalityScore: entry.criticalityScore || 0,
      confidence: entry.confidence || 0,
      resolutionPath: (entry.resolutionPath as any[]) || [],
    });

    const roles = (entry.requiredRoles as string[]) || [];
    for (const role of roles) {
      if (!roleMap.has(role)) {
        roleMap.set(role, { name: role, endpoints: [], criticalityRange: [100, 0] });
      }
      const r = roleMap.get(role)!;
      if (entry.endpoint && entry.httpMethod) {
        const epRef = { path: entry.endpoint, method: entry.httpMethod, controller: entry.controllerClass || "" };
        if (!r.endpoints.find(e => e.path === epRef.path && e.method === epRef.method)) {
          r.endpoints.push(epRef);
        }
      }
      const score = entry.criticalityScore || 0;
      if (score < r.criticalityRange[0]) r.criticalityRange[0] = score;
      if (score > r.criticalityRange[1]) r.criticalityRange[1] = score;
    }

    const entities = (entry.entitiesTouched as string[]) || [];
    for (const entityName of entities) {
      if (!entityMap.has(entityName)) {
        entityMap.set(entityName, {
          name: entityName,
          operations: [],
          accessedBy: [],
          sensitiveFields: [],
          fieldMetadata: [],
        });
      }
      const ent = entityMap.get(entityName)!;
      mergeArrays(ent.operations, entry.persistenceOperations as string[] || []);
      mergeArrays(ent.sensitiveFields, (entry.sensitiveFieldsAccessed as string[] || []).filter(f => f.startsWith(entityName + ".")));
      if (entry.endpoint && entry.httpMethod) {
        const ref = { controller: entry.controllerClass || "", method: entry.controllerMethod || "", endpoint: entry.endpoint };
        if (!ent.accessedBy.find(a => a.endpoint === ref.endpoint && a.controller === ref.controller)) {
          ent.accessedBy.push(ref);
        }
      }
      const fieldsMeta = (entry.entityFieldsMetadata as any[]) || [];
      const entityMeta = fieldsMeta.find((m: any) => m.entity === entityName);
      if (entityMeta && entityMeta.fields && ent.fieldMetadata.length === 0) {
        ent.fieldMetadata = entityMeta.fields;
      }
    }
  }

  const allEndpoints = Array.from(endpointMap.values());
  const allScreens = Array.from(screenMap.values());
  const allRoles = Array.from(roleMap.values());
  const allEntities = Array.from(entityMap.values());

  const totalCriticality = entries.reduce((sum, e) => sum + (e.criticalityScore || 0), 0);
  const avgCriticality = entries.length > 0 ? Math.round(totalCriticality / entries.length) : 0;
  const endpointsWithSecurity = allEndpoints.filter(e => e.requiredRoles.length > 0 || e.securityAnnotations.length > 0).length;
  const securityCoverage = allEndpoints.length > 0 ? Math.round((endpointsWithSecurity / allEndpoints.length) * 100) : 0;

  const securityMatrix = allEndpoints.map(ep => {
    const screenGuards: string[] = [];
    for (const screen of allScreens) {
      for (const interaction of screen.interactions) {
        if (interaction.endpoint === ep.path && interaction.httpMethod === ep.method) {
          mergeArrays(screenGuards, screen.routeGuards);
        }
      }
    }
    return {
      endpoint: ep.path,
      method: ep.method,
      roles: ep.requiredRoles,
      guards: screenGuards,
      criticalityScore: ep.criticalityScore,
      sensitiveData: ep.sensitiveFieldsAccessed.length > 0,
    };
  });

  return {
    $schema: "https://permacat.dev/schemas/manifest-v1.json",
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    generator: { name: "PermaCat", version: "1.0.0" },
    project: {
      name: project.name,
      description: project.description || null,
      analyzedAt: project.createdAt?.toISOString() || new Date().toISOString(),
    },
    summary: {
      totalScreens: allScreens.length,
      totalInteractions: entries.length,
      totalEndpoints: allEndpoints.length,
      totalEntities: allEntities.length,
      totalRoles: allRoles.length,
      averageCriticality: avgCriticality,
      securityCoverage,
    },
    endpoints: allEndpoints,
    screens: allScreens,
    roles: allRoles,
    entities: allEntities,
    securityMatrix,
  };
}

function mergeArrays(target: string[], source: string[]) {
  for (const item of source) {
    if (!target.includes(item)) target.push(item);
  }
}

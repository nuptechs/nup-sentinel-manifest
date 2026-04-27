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
  dataSource: Record<string, "extracted" | "inferred">;
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
    dataSource: Record<string, "extracted" | "inferred">;
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

export interface ManifestData {
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
  completeness: {
    endpointResolution: number;
    routeCoverage: number;
    securityCoverage: number;
    entityCoverage: number;
    controllerCoverage: number;
    overallScore: number;
    dataProvenance: {
      fieldsWithData: Record<string, { total: number; extracted: number; inferred: number }>;
      overallExtractedPct: number;
      overallInferredPct: number;
    };
    interactionBreakdown: {
      total: number;
      withEndpoint: number;
      uiOnly: number;
      httpRelevant: number;
      httpRelevantResolved: number;
    };
  };
}

export function generateManifest(project: Project, entries: CatalogEntry[]): ManifestData {
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
          dataSource: (entry.dataSource as Record<string, "extracted" | "inferred">) || {},
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
      dataSource: (entry.dataSource as Record<string, "extracted" | "inferred">) || {},
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

  const UI_STATE_SETTER = /^set[A-Z]/;
  const UI_ONLY_EXACT = new Set([
    "stopPropagation", "preventDefault", "onChange", "onClose", "onBlur", "onFocus",
    "cancelSelection", "formatDate", "getSortIcon", "onCancel", "handleCancel",
    "copyToClipboard", "copyJsonToClipboard", "toggleRegistration", "handleDismiss",
    "handlePrev", "handleNext", "handleSkip", "handleSort", "handleReset",
    "handleCapture", "startCamera", "exportToCSV", "onBackToLogin",
    "toggleExtractedFields", "handleDataManagerOpen", "handleCancelEdit",
    "handleSelectAllProcesses", "onClick",
  ]);
  const UI_ONLY_PATTERNS = [
    /^toggle[A-Z]/,
    /^on(Close|Cancel|Blur|Focus|Back|Dismiss)/,
    /^copy\w*ToClipboard$/,
    /^(show|hide|open|close)[A-Z]/,
    /^handle(Cancel|Close|Dismiss|Back|Reset|Clear|Toggle)$/,
  ];
  const isUiOnly = (entry: CatalogEntry): boolean => {
    if (entry.endpoint) return false;
    if (entry.interactionCategory === "UI_ONLY" || entry.interactionCategory === "STATE_ONLY") return true;
    const handlerName = entry.interaction.replace(/^(button|input|element|link): /, "");
    if (UI_STATE_SETTER.test(handlerName)) return true;
    if (UI_ONLY_EXACT.has(handlerName)) return true;
    if (UI_ONLY_PATTERNS.some(p => p.test(handlerName))) return true;
    return false;
  };
  const httpRelevantEntries = entries.filter(e => !isUiOnly(e));
  const httpRelevantWithEndpoint = httpRelevantEntries.filter(e => e.endpoint).length;
  const endpointResolution = httpRelevantEntries.length > 0 ? Math.round((httpRelevantWithEndpoint / httpRelevantEntries.length) * 100) : 0;

  const screensWithRoutes = allScreens.filter(s => s.route !== null && s.route !== undefined && s.route !== "").length;
  const routeCoverage = allScreens.length > 0 ? Math.round((screensWithRoutes / allScreens.length) * 100) : 0;

  const endpointsWithEntity = allEndpoints.filter(e => e.entitiesTouched.length > 0).length;
  const entityCoverage = allEndpoints.length > 0 ? Math.round((endpointsWithEntity / allEndpoints.length) * 100) : 0;

  const endpointsWithController = allEndpoints.filter(e => e.controller).length;
  const controllerCoverage = allEndpoints.length > 0 ? Math.round((endpointsWithController / allEndpoints.length) * 100) : 0;

  const overallScore = Math.round(
    (endpointResolution * 0.30 + routeCoverage * 0.15 + securityCoverage * 0.25 + entityCoverage * 0.15 + controllerCoverage * 0.15)
  );

  return {
    $schema: "https://nuptechs.com/schemas/manifest-v1.json",
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    generator: { name: "Manifest", version: "1.0.0" },
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
    completeness: {
      endpointResolution,
      routeCoverage,
      securityCoverage,
      entityCoverage,
      controllerCoverage,
      overallScore,
      interactionBreakdown: {
        total: entries.length,
        withEndpoint: entries.filter(e => e.endpoint).length,
        uiOnly: entries.length - httpRelevantEntries.length,
        httpRelevant: httpRelevantEntries.length,
        httpRelevantResolved: httpRelevantWithEndpoint,
      },
      dataProvenance: computeDataProvenance(entries),
    },
  };
}

function computeDataProvenance(entries: CatalogEntry[]): {
  fieldsWithData: Record<string, { total: number; extracted: number; inferred: number }>;
  overallExtractedPct: number;
  overallInferredPct: number;
} {
  const fields = ["endpoint", "httpMethod", "controllerClass", "entitiesTouched", "requiredRoles", "securityAnnotations", "frontendRoute", "routeGuards"];
  const result: Record<string, { total: number; extracted: number; inferred: number }> = {};
  for (const field of fields) {
    result[field] = { total: 0, extracted: 0, inferred: 0 };
  }
  let totalExtracted = 0;
  let totalInferred = 0;
  let totalPopulated = 0;

  for (const entry of entries) {
    const ds = (entry.dataSource as Record<string, "extracted" | "inferred">) || {};
    for (const field of fields) {
      if (ds[field]) {
        result[field].total++;
        if (ds[field] === "extracted") {
          result[field].extracted++;
          totalExtracted++;
        } else {
          result[field].inferred++;
          totalInferred++;
        }
        totalPopulated++;
      }
    }
  }

  return {
    fieldsWithData: result,
    overallExtractedPct: totalPopulated > 0 ? Math.round((totalExtracted / totalPopulated) * 100) : 0,
    overallInferredPct: totalPopulated > 0 ? Math.round((totalInferred / totalPopulated) * 100) : 0,
  };
}

function mergeArrays(target: string[], source: string[]) {
  for (const item of source) {
    if (!target.includes(item)) target.push(item);
  }
}

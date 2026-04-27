import type { ManifestData } from "../generators/manifest-generator";

export interface EndpointChange {
  path: string;
  method: string;
  changeType: "added" | "removed" | "modified";
  before?: {
    requiredRoles: string[];
    criticalityScore: number;
    entitiesTouched: string[];
    technicalOperation: string;
    sensitiveFieldsAccessed: string[];
  };
  after?: {
    requiredRoles: string[];
    criticalityScore: number;
    entitiesTouched: string[];
    technicalOperation: string;
    sensitiveFieldsAccessed: string[];
  };
  modifications?: string[];
}

export interface ScreenChange {
  name: string;
  changeType: "added" | "removed" | "modified";
  interactionsAdded?: number;
  interactionsRemoved?: number;
  routeGuardChanges?: string[];
  modifications?: string[];
}

export interface RoleChange {
  name: string;
  changeType: "added" | "removed" | "modified";
  endpointsAdded?: { path: string; method: string }[];
  endpointsRemoved?: { path: string; method: string }[];
}

export interface EntityChange {
  name: string;
  changeType: "added" | "removed" | "modified";
  sensitiveFieldsAdded?: string[];
  sensitiveFieldsRemoved?: string[];
  operationsChanged?: string[];
}

export interface SecurityImpact {
  newUnprotectedEndpoints: { path: string; method: string; criticalityScore: number }[];
  removedProtections: { path: string; method: string; rolesBefore: string[]; rolesAfter: string[] }[];
  criticalityIncreases: { path: string; method: string; before: number; after: number }[];
  coverageBefore: number;
  coverageAfter: number;
  coverageDelta: number;
}

export interface ManifestDiff {
  runA: number;
  runB: number;
  generatedAt: string;
  summary: {
    endpointsAdded: number;
    endpointsRemoved: number;
    endpointsModified: number;
    screensAdded: number;
    screensRemoved: number;
    screensModified: number;
    rolesAdded: number;
    rolesRemoved: number;
    entitiesAdded: number;
    entitiesRemoved: number;
    securityImpactLevel: "none" | "low" | "medium" | "high" | "critical";
  };
  endpoints: EndpointChange[];
  screens: ScreenChange[];
  roles: RoleChange[];
  entities: EntityChange[];
  security: SecurityImpact;
}

function endpointKey(path: string, method: string): string {
  return `${method.toUpperCase()}:${path}`;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function arrayDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter(x => !beforeSet.has(x)),
    removed: before.filter(x => !afterSet.has(x)),
  };
}

function epSnapshot(ep: any) {
  return {
    requiredRoles: ep.requiredRoles,
    criticalityScore: ep.criticalityScore,
    entitiesTouched: ep.entitiesTouched,
    technicalOperation: ep.technicalOperation,
    sensitiveFieldsAccessed: ep.sensitiveFieldsAccessed,
  };
}

function diffEndpoints(a: ManifestData, b: ManifestData): EndpointChange[] {
  const changes: EndpointChange[] = [];
  const aMap = new Map<string, (typeof a.endpoints)[0]>();
  const bMap = new Map<string, (typeof b.endpoints)[0]>();
  a.endpoints.forEach(e => aMap.set(endpointKey(e.path, e.method), e));
  b.endpoints.forEach(e => bMap.set(endpointKey(e.path, e.method), e));

  bMap.forEach((ep, key) => {
    if (!aMap.has(key)) {
      changes.push({ path: ep.path, method: ep.method, changeType: "added", after: epSnapshot(ep) });
    }
  });

  aMap.forEach((ep, key) => {
    if (!bMap.has(key)) {
      changes.push({ path: ep.path, method: ep.method, changeType: "removed", before: epSnapshot(ep) });
    }
  });

  aMap.forEach((epA, key) => {
    const epB = bMap.get(key);
    if (!epB) return;
    const mods: string[] = [];
    if (!arraysEqual(epA.requiredRoles, epB.requiredRoles)) {
      mods.push(`roles: [${epA.requiredRoles.join(",")}] → [${epB.requiredRoles.join(",")}]`);
    }
    if (epA.criticalityScore !== epB.criticalityScore) {
      mods.push(`criticality: ${epA.criticalityScore} → ${epB.criticalityScore}`);
    }
    if (!arraysEqual(epA.entitiesTouched, epB.entitiesTouched)) {
      mods.push(`entities: [${epA.entitiesTouched.join(",")}] → [${epB.entitiesTouched.join(",")}]`);
    }
    if (epA.technicalOperation !== epB.technicalOperation) {
      mods.push(`operation: ${epA.technicalOperation} → ${epB.technicalOperation}`);
    }
    if (!arraysEqual(epA.sensitiveFieldsAccessed, epB.sensitiveFieldsAccessed)) {
      mods.push(`sensitiveFields changed`);
    }
    if (mods.length > 0) {
      changes.push({
        path: epA.path,
        method: epA.method,
        changeType: "modified",
        before: epSnapshot(epA),
        after: epSnapshot(epB),
        modifications: mods,
      });
    }
  });

  return changes;
}

function diffScreens(a: ManifestData, b: ManifestData): ScreenChange[] {
  const changes: ScreenChange[] = [];
  const aMap = new Map<string, (typeof a.screens)[0]>();
  const bMap = new Map<string, (typeof b.screens)[0]>();
  a.screens.forEach(s => aMap.set(s.name, s));
  b.screens.forEach(s => bMap.set(s.name, s));

  bMap.forEach((screen, name) => {
    if (!aMap.has(name)) {
      changes.push({ name, changeType: "added", interactionsAdded: screen.interactions.length });
    }
  });

  aMap.forEach((_, name) => {
    if (!bMap.has(name)) {
      changes.push({ name, changeType: "removed" });
    }
  });

  aMap.forEach((screenA, name) => {
    const screenB = bMap.get(name);
    if (!screenB) return;
    const mods: string[] = [];
    const interactionNamesA = new Set(screenA.interactions.map(i => i.name));
    const interactionNamesB = new Set(screenB.interactions.map(i => i.name));
    const added = Array.from(interactionNamesB).filter(n => !interactionNamesA.has(n));
    const removed = Array.from(interactionNamesA).filter(n => !interactionNamesB.has(n));
    if (added.length > 0) mods.push(`+${added.length} interactions`);
    if (removed.length > 0) mods.push(`-${removed.length} interactions`);
    const guardDiff = arrayDiff(screenA.routeGuards || [], screenB.routeGuards || []);
    const guardChanges: string[] = [];
    if (guardDiff.added.length > 0) guardChanges.push(...guardDiff.added.map(g => `+guard:${g}`));
    if (guardDiff.removed.length > 0) guardChanges.push(...guardDiff.removed.map(g => `-guard:${g}`));
    if (guardChanges.length > 0) mods.push(`guards changed`);

    if (mods.length > 0) {
      changes.push({
        name,
        changeType: "modified",
        interactionsAdded: added.length,
        interactionsRemoved: removed.length,
        routeGuardChanges: guardChanges.length > 0 ? guardChanges : undefined,
        modifications: mods,
      });
    }
  });

  return changes;
}

function diffRoles(a: ManifestData, b: ManifestData): RoleChange[] {
  const changes: RoleChange[] = [];
  const aMap = new Map<string, (typeof a.roles)[0]>();
  const bMap = new Map<string, (typeof b.roles)[0]>();
  a.roles.forEach(r => aMap.set(r.name, r));
  b.roles.forEach(r => bMap.set(r.name, r));

  bMap.forEach((_, name) => {
    if (!aMap.has(name)) changes.push({ name, changeType: "added" });
  });
  aMap.forEach((_, name) => {
    if (!bMap.has(name)) changes.push({ name, changeType: "removed" });
  });

  aMap.forEach((roleA, name) => {
    const roleB = bMap.get(name);
    if (!roleB) return;
    const epKeysA = new Set(roleA.endpoints.map(e => endpointKey(e.path, e.method)));
    const epKeysB = new Set(roleB.endpoints.map(e => endpointKey(e.path, e.method)));
    const added = roleB.endpoints.filter(e => !epKeysA.has(endpointKey(e.path, e.method)));
    const removed = roleA.endpoints.filter(e => !epKeysB.has(endpointKey(e.path, e.method)));
    if (added.length > 0 || removed.length > 0) {
      changes.push({
        name,
        changeType: "modified",
        endpointsAdded: added.length > 0 ? added.map(e => ({ path: e.path, method: e.method })) : undefined,
        endpointsRemoved: removed.length > 0 ? removed.map(e => ({ path: e.path, method: e.method })) : undefined,
      });
    }
  });

  return changes;
}

function diffEntities(a: ManifestData, b: ManifestData): EntityChange[] {
  const changes: EntityChange[] = [];
  const aMap = new Map<string, (typeof a.entities)[0]>();
  const bMap = new Map<string, (typeof b.entities)[0]>();
  a.entities.forEach(e => aMap.set(e.name, e));
  b.entities.forEach(e => bMap.set(e.name, e));

  bMap.forEach((_, name) => {
    if (!aMap.has(name)) changes.push({ name, changeType: "added" });
  });
  aMap.forEach((_, name) => {
    if (!bMap.has(name)) changes.push({ name, changeType: "removed" });
  });

  aMap.forEach((entityA, name) => {
    const entityB = bMap.get(name);
    if (!entityB) return;
    const sfDiff = arrayDiff(entityA.sensitiveFields, entityB.sensitiveFields);
    const opsDiff = !arraysEqual(entityA.operations, entityB.operations);
    if (sfDiff.added.length > 0 || sfDiff.removed.length > 0 || opsDiff) {
      changes.push({
        name,
        changeType: "modified",
        sensitiveFieldsAdded: sfDiff.added.length > 0 ? sfDiff.added : undefined,
        sensitiveFieldsRemoved: sfDiff.removed.length > 0 ? sfDiff.removed : undefined,
        operationsChanged: opsDiff ? entityB.operations : undefined,
      });
    }
  });

  return changes;
}

function computeSecurityImpact(
  a: ManifestData, b: ManifestData, endpointChanges: EndpointChange[]
): SecurityImpact {
  const newUnprotected: SecurityImpact["newUnprotectedEndpoints"] = [];
  const removedProtections: SecurityImpact["removedProtections"] = [];
  const criticalityIncreases: SecurityImpact["criticalityIncreases"] = [];

  for (const change of endpointChanges) {
    if (change.changeType === "added" && change.after) {
      if (change.after.requiredRoles.length === 0) {
        newUnprotected.push({
          path: change.path,
          method: change.method,
          criticalityScore: change.after.criticalityScore,
        });
      }
    }
    if (change.changeType === "modified" && change.before && change.after) {
      if (change.before.requiredRoles.length > 0 && change.after.requiredRoles.length === 0) {
        removedProtections.push({
          path: change.path,
          method: change.method,
          rolesBefore: change.before.requiredRoles,
          rolesAfter: change.after.requiredRoles,
        });
      }
      if (change.after.criticalityScore > change.before.criticalityScore) {
        criticalityIncreases.push({
          path: change.path,
          method: change.method,
          before: change.before.criticalityScore,
          after: change.after.criticalityScore,
        });
      }
    }
  }

  return {
    newUnprotectedEndpoints: newUnprotected,
    removedProtections,
    criticalityIncreases,
    coverageBefore: a.summary.securityCoverage,
    coverageAfter: b.summary.securityCoverage,
    coverageDelta: b.summary.securityCoverage - a.summary.securityCoverage,
  };
}

function computeImpactLevel(security: SecurityImpact, endpointChanges: EndpointChange[]): ManifestDiff["summary"]["securityImpactLevel"] {
  if (security.removedProtections.length > 0) return "critical";
  const highCritUnprotected = security.newUnprotectedEndpoints.filter(e => e.criticalityScore >= 70);
  if (highCritUnprotected.length > 0) return "high";
  if (security.newUnprotectedEndpoints.length > 0) return "medium";
  if (security.criticalityIncreases.length > 0 || security.coverageDelta < -5) return "low";
  if (endpointChanges.length === 0) return "none";
  return "low";
}

export function diffManifests(
  manifestA: ManifestData,
  manifestB: ManifestData,
  runA: number,
  runB: number
): ManifestDiff {
  const endpoints = diffEndpoints(manifestA, manifestB);
  const screens = diffScreens(manifestA, manifestB);
  const roles = diffRoles(manifestA, manifestB);
  const entities = diffEntities(manifestA, manifestB);
  const security = computeSecurityImpact(manifestA, manifestB, endpoints);

  return {
    runA,
    runB,
    generatedAt: new Date().toISOString(),
    summary: {
      endpointsAdded: endpoints.filter(e => e.changeType === "added").length,
      endpointsRemoved: endpoints.filter(e => e.changeType === "removed").length,
      endpointsModified: endpoints.filter(e => e.changeType === "modified").length,
      screensAdded: screens.filter(s => s.changeType === "added").length,
      screensRemoved: screens.filter(s => s.changeType === "removed").length,
      screensModified: screens.filter(s => s.changeType === "modified").length,
      rolesAdded: roles.filter(r => r.changeType === "added").length,
      rolesRemoved: roles.filter(r => r.changeType === "removed").length,
      entitiesAdded: entities.filter(e => e.changeType === "added").length,
      entitiesRemoved: entities.filter(e => e.changeType === "removed").length,
      securityImpactLevel: computeImpactLevel(security, endpoints),
    },
    endpoints,
    screens,
    roles,
    entities,
    security,
  };
}

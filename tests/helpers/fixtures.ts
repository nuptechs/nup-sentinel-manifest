// ─────────────────────────────────────────────
// Test fixtures — shared CatalogEntry / Project builders so test files
// don't drown in default-field noise. Each builder returns a fully-
// typed value with sensible defaults; callers override only what
// matters for the scenario.
// ─────────────────────────────────────────────

import type { CatalogEntry, Project } from "../../shared/schema.ts";

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "test-project",
    description: null,
    status: "ready",
    fileCount: 0,
    gitProvider: null,
    gitRepoUrl: null,
    gitDefaultBranch: null,
    gitTokenRef: null,
    webhookSecret: null,
    webhookEnabled: false,
    createdAt: new Date("2026-05-27T00:00:00Z"),
    ...overrides,
  };
}

export function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 1,
    analysisRunId: 1,
    projectId: 1,
    screen: "TestScreen",
    interaction: "click",
    interactionType: "click",
    endpoint: "/api/test",
    httpMethod: "GET",
    controllerClass: "TestController",
    controllerMethod: "test",
    serviceMethods: [],
    repositoryMethods: [],
    entitiesTouched: [],
    fullCallChain: [],
    persistenceOperations: [],
    technicalOperation: null,
    criticalityScore: 0,
    suggestedMeaning: null,
    humanClassification: null,
    sourceFile: null,
    lineNumber: null,
    resolutionPath: null,
    architectureType: null,
    interactionCategory: null,
    confidence: 1.0,
    requiredRoles: [],
    securityAnnotations: [],
    entityFieldsMetadata: [],
    sensitiveFieldsAccessed: [],
    frontendRoute: null,
    routeGuards: [],
    duplicateCount: 1,
    operationHint: null,
    dataSource: {},
    createdAt: new Date("2026-05-27T00:00:00Z"),
    ...overrides,
  };
}

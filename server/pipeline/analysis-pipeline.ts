import { storage } from "../storage";
import { analyzeFrontend } from "../analyzers/frontend-analyzer";
import { buildApplicationGraph, analyzeGraphEndpoints, reconstructGraph } from "../analyzers/backend-java-client";
import { interactionsToCatalogEntries, endpointImpactsToCatalogEntries } from "../analyzers/graph-connector";
import { classifyEntriesDeterministic } from "../analyzers/deterministic-classifier";
import { detectArchitecture } from "../analyzers/architecture-detector";
import { generateManifest } from "../generators/manifest-generator";
import { computeFileHashes, detectChanges } from "./change-detector";
import type { FileHash } from "./change-detector";
import type { InsertCatalogEntry } from "@shared/schema";
import { analyzeSecurityOmissions, type SecurityFinding, type SecurityCoverageMetrics } from "../security/omission-engine";
import { emitSecurityFindings } from "../security/sentinel-emitter";
import { enrichCatalogEntriesWithInference } from "../analyzers/frontend-inference-engine";

export interface FileData {
  filePath: string;
  content: string;
}

export interface PipelineProgress {
  step: string;
  detail: string;
}

export type ProgressCallback = (progress: PipelineProgress) => void;

export interface AnalysisResult {
  analysisRunId: number;
  projectId: number;
  totalInteractions: number;
  totalEndpoints: number;
  totalEntities: number;
  catalogEntries: number;
  graph: {
    totalNodes: number;
    totalEdges: number;
    nodesByType: {
      controllers: number;
      services: number;
      repositories: number;
      entities: number;
    };
  };
  endpointImpacts: {
    endpoint: string;
    httpMethod: string;
    controllerClass: string;
    controllerMethod: string;
    callDepth: number;
    entitiesTouched: string[];
    fullCallChain: string[];
    persistenceOperations: string[];
  }[];
  resolutionErrors?: string[];
  cacheStatus?: string;
  securityFindings?: SecurityFinding[];
  securityMetrics?: SecurityCoverageMetrics;
}

interface GraphCache {
  graphJson: any;
  endpointImpacts: any[];
  archType: string;
  resolutionErrors: string[];
  fileHashes: FileHash[];
  timestamp: number;
}

interface FrontendCache {
  interactions: any[];
  fileHashes: FileHash[];
  timestamp: number;
}

const graphCacheStore = new Map<number, GraphCache>();
const frontendCacheStore = new Map<number, FrontendCache>();

const CACHE_TTL_MS = 30 * 60 * 1000;

function isCacheValid(timestamp: number): boolean {
  return Date.now() - timestamp < CACHE_TTL_MS;
}

export class AnalysisPipeline {
  private onProgress: ProgressCallback;

  constructor(onProgress?: ProgressCallback) {
    this.onProgress = onProgress || ((p) => console.log(`[analysis] ${p.step}: ${p.detail}`));
  }

  private progress(step: string, detail: string) {
    this.onProgress({ step, detail });
  }

  async runFullAnalysis(projectId: number, fileData: FileData[]): Promise<AnalysisResult> {
    const analysisRun = await storage.createAnalysisRun({ projectId });

    try {
      await storage.updateProjectStatus(projectId, "analyzing");
      await storage.updateAnalysisRun(analysisRun.id, { status: "analyzing" });

      const javaFiles = fileData.filter(f => f.filePath.endsWith(".java"));
      const frontendFiles = fileData.filter(f => !f.filePath.endsWith(".java"));

      const cachedGraph = graphCacheStore.get(projectId);
      const cachedFrontend = frontendCacheStore.get(projectId);

      let backendReused = false;
      let frontendReused = false;
      let appGraph: any;
      let resolutionErrors: string[] = [];
      let archType: string = "UNKNOWN";
      let endpointImpacts: any[] = [];
      let frontendInteractions: any[] = [];

      if (cachedGraph && isCacheValid(cachedGraph.timestamp)) {
        const javaHashes = computeFileHashes(javaFiles);
        const changes = detectChanges(cachedGraph.fileHashes, javaFiles);
        if (changes.noChanges || (!changes.backendChanged && javaFiles.length > 0)) {
          this.progress("Step 1/4", `Backend graph cache HIT — ${cachedGraph.graphJson.nodes.length} nodes, ${cachedGraph.graphJson.edges.length} edges (no Java changes)`);
          appGraph = reconstructGraph(cachedGraph.graphJson);
          resolutionErrors = cachedGraph.resolutionErrors;
          archType = cachedGraph.archType;
          endpointImpacts = cachedGraph.endpointImpacts;
          backendReused = true;
        }
      }

      if (!backendReused) {
        const result = await this.buildGraph(fileData);
        appGraph = result.appGraph;
        resolutionErrors = result.resolutionErrors;
        archType = result.archResult.type;
        endpointImpacts = this.analyzeEndpoints(appGraph);

        const graphJson = appGraph.toJSON();
        graphCacheStore.set(projectId, {
          graphJson,
          endpointImpacts,
          archType,
          resolutionErrors,
          fileHashes: computeFileHashes(javaFiles),
          timestamp: Date.now(),
        });
      }

      if (cachedFrontend && isCacheValid(cachedFrontend.timestamp)) {
        const feChanges = detectChanges(cachedFrontend.fileHashes, frontendFiles);
        if (feChanges.noChanges && !feChanges.frontendChanged) {
          this.progress("Step 3/4", `Frontend cache HIT — ${cachedFrontend.interactions.length} interactions (no frontend changes)`);
          frontendInteractions = cachedFrontend.interactions;
          frontendReused = true;
        }
      }

      if (!frontendReused) {
        frontendInteractions = this.analyzeFrontendInteractions(fileData, appGraph);

        frontendCacheStore.set(projectId, {
          interactions: frontendInteractions,
          fileHashes: computeFileHashes(frontendFiles),
          timestamp: Date.now(),
        });
      }

      let catalogEntryData = this.connectGraph(
        frontendInteractions, endpointImpacts, appGraph, analysisRun.id, projectId, archType
      );
      catalogEntryData = this.classify(catalogEntryData);

      this.progress("Inference", "Enriching entries with inferred backend structure...");
      catalogEntryData = enrichCatalogEntriesWithInference(catalogEntryData);

      if (catalogEntryData.length > 0) {
        await storage.deleteCatalogEntriesByProject(projectId);
      }
      const created = await this.persist(catalogEntryData);

      this.progress("Security", "Running security omission analysis...");
      const { findings: securityFindings, metrics: securityMetrics } = analyzeSecurityOmissions(created);
      if (securityFindings.length > 0) {
        const findingRecords = securityFindings.map(f => ({
          analysisRunId: analysisRun.id,
          projectId,
          findingId: f.id,
          findingType: f.type,
          severity: f.severity,
          title: f.title,
          description: f.description,
          evidence: f.evidence,
          recommendation: f.recommendation,
          affectedEndpoints: f.affectedEndpoints,
        }));
        await storage.createSecurityFindings(findingRecords);
      }
      const criticalCount = securityFindings.filter(f => f.severity === "critical").length;
      const highCount = securityFindings.filter(f => f.severity === "high").length;
      this.progress("Security", `Found ${securityFindings.length} findings (${criticalCount} critical, ${highCount} high). Coverage: ${securityMetrics.coveragePercent}%`);

      const emitResult = await emitSecurityFindings(securityFindings, {
        manifestProjectId: projectId,
        analysisRunId: analysisRun.id,
      });
      if (emitResult.skipped) {
        this.progress("Sentinel", `emitter skipped: ${emitResult.reason}`);
      } else {
        this.progress(
          "Sentinel",
          `emitted ${emitResult.emitted} permission_drift findings (session=${emitResult.sessionId})`
        );
      }

      const graphSummary = appGraph.toJSON();
      await this.finalize(analysisRun.id, projectId, frontendInteractions.length, endpointImpacts.length, appGraph, catalogEntryData);
      await this.saveSnapshot(analysisRun.id, projectId, created, appGraph);

      let cacheStatus = "full analysis";
      if (backendReused && frontendReused) cacheStatus = "fully cached (no changes)";
      else if (backendReused) cacheStatus = "backend cached, frontend re-analyzed";
      else if (frontendReused) cacheStatus = "frontend cached, backend re-analyzed";

      this.progress("Cache", cacheStatus);

      const result = this.buildResult(
        analysisRun.id, projectId, frontendInteractions.length, endpointImpacts.length,
        appGraph, graphSummary, created.length, endpointImpacts, resolutionErrors, catalogEntryData
      );
      return { ...result, cacheStatus, securityFindings, securityMetrics };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Analysis failed";
      await storage.updateAnalysisRun(analysisRun.id, {
        status: "failed",
        completedAt: new Date(),
        errorMessage: errorMsg,
      });
      await storage.updateProjectStatus(projectId, "failed");
      throw error;
    }
  }

  async runFromProject(projectId: number): Promise<AnalysisResult> {
    const sourceFiles = await storage.getSourceFiles(projectId);
    const fileData = sourceFiles.map((f) => ({
      filePath: f.filePath,
      content: f.content,
    }));
    return this.runFullAnalysis(projectId, fileData);
  }

  private async buildGraph(fileData: FileData[]) {
    const javaCount = fileData.filter(f => f.filePath.endsWith(".java")).length;
    const frontendCount = fileData.length - javaCount;
    const javaContentKB = fileData.filter(f => f.filePath.endsWith(".java")).reduce((sum, f) => sum + f.content.length, 0) / 1024;

    this.progress("Step 1/4", `Building application graph (${javaCount} Java files — ${javaContentKB.toFixed(0)} KB, ${frontendCount} frontend files)...`);
    const start = Date.now();
    const buildResult = await buildApplicationGraph(fileData);
    const appGraph = buildResult.graph;
    const resolutionErrors = buildResult.resolutionErrors;
    this.progress("Step 1/4", `Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${appGraph.toJSON().nodes.length} nodes, ${appGraph.toJSON().edges.length} edges`);

    const archResult = detectArchitecture(appGraph, fileData);
    this.progress("Architecture", `Detected: ${archResult.type} (confidence: ${archResult.confidence.toFixed(2)})`);

    return { appGraph, resolutionErrors, archResult };
  }

  private analyzeEndpoints(appGraph: any) {
    this.progress("Step 2/4", "Analyzing graph endpoints...");
    const endpointImpacts = analyzeGraphEndpoints(appGraph);
    this.progress("Step 2/4", `Done — ${endpointImpacts.length} endpoints found`);
    return endpointImpacts;
  }

  private analyzeFrontendInteractions(fileData: FileData[], appGraph: any) {
    const frontendCount = fileData.filter(f => !f.filePath.endsWith(".java")).length;
    this.progress("Step 3/4", `Analyzing frontend interactions (${frontendCount} files)...`);
    const start = Date.now();
    const frontendInteractions = analyzeFrontend(fileData, appGraph);
    this.progress("Step 3/4", `Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${frontendInteractions.length} frontend interactions found`);
    return frontendInteractions;
  }

  private connectGraph(
    frontendInteractions: any[], endpointImpacts: any[],
    appGraph: any, analysisRunId: number, projectId: number, archType: string
  ): InsertCatalogEntry[] {
    let catalogEntryData = interactionsToCatalogEntries(
      frontendInteractions, appGraph, analysisRunId, projectId, archType as any
    );

    if (catalogEntryData.length === 0 && endpointImpacts.length > 0) {
      catalogEntryData = endpointImpactsToCatalogEntries(
        endpointImpacts, appGraph, analysisRunId, projectId
      );
    }

    return catalogEntryData;
  }

  private classify(entries: InsertCatalogEntry[]): InsertCatalogEntry[] {
    this.progress("Step 4/4", `Deterministic classification of ${entries.length} entries...`);
    const classified = classifyEntriesDeterministic(entries);
    this.progress("Step 4/4", "Deterministic classification complete");
    return classified;
  }

  private async persist(entries: InsertCatalogEntry[]) {
    return storage.createCatalogEntries(entries);
  }

  private async saveSnapshot(
    analysisRunId: number,
    projectId: number,
    entries: any[],
    appGraph?: any,
  ) {
    try {
      const project = await storage.getProject(projectId);
      if (!project) return;
      const manifest = generateManifest(project, entries);

      // Capture entities directly from the application graph as a fallback
      // for downstream consumers (notably Sentinel's Field Death detector).
      // `manifest.entities` only includes entities reached by some endpoint;
      // when the analyzer produces ENTITY nodes that no endpoint touches,
      // they vanish from the catalog. This shadow copy preserves them so
      // /api/projects/:id/schema-fields can fall back when the curated list
      // is empty. Additive — never removed entries from the regular
      // `entities` shape, never breaks legacy consumers.
      const allEntitiesFromGraph: Array<{
        name: string;
        sourceFile?: string;
        fields: Array<{
          name: string;
          type: string;
          isId: boolean;
          isSensitive: boolean;
          validations?: string[];
        }>;
      }> = [];
      if (appGraph && typeof appGraph.getNodesByType === "function") {
        const entityNodes: any[] = appGraph.getNodesByType("ENTITY");
        for (const node of entityNodes) {
          const meta = (node.metadata || {}) as Record<string, unknown>;
          const enriched = Array.isArray(meta.enrichedFields)
            ? (meta.enrichedFields as any[])
            : [];
          allEntitiesFromGraph.push({
            name: node.className || String(node.id || "<unknown>"),
            ...(typeof meta.sourceFile === "string" ? { sourceFile: meta.sourceFile } : {}),
            fields: enriched.map((f) => ({
              name: String(f?.name || ""),
              type: String(f?.type || "unknown"),
              isId: !!f?.isId,
              isSensitive: !!f?.isSensitive,
              ...(Array.isArray(f?.validations) && f.validations.length > 0
                ? { validations: f.validations }
                : {}),
            })),
          });
        }
      }

      const enrichedManifest = {
        ...manifest,
        ...(allEntitiesFromGraph.length > 0 ? { allEntitiesFromGraph } : {}),
      };

      await storage.createAnalysisSnapshot({
        analysisRunId,
        projectId,
        manifestJson: enrichedManifest,
      });
      this.progress(
        "Snapshot",
        `Manifest snapshot saved for run #${analysisRunId} (graphEntities=${allEntitiesFromGraph.length})`,
      );
    } catch (err) {
      console.error(`[pipeline] Failed to save snapshot: ${err}`);
    }
  }

  private countTotalEntities(appGraph: any, catalogEntries: InsertCatalogEntry[]): number {
    const extractedEntities = appGraph.getNodesByType("ENTITY").length;
    if (extractedEntities > 0) return extractedEntities;
    const inferredEntityNames = new Set<string>();
    for (const entry of catalogEntries) {
      if (entry.entitiesTouched && Array.isArray(entry.entitiesTouched)) {
        for (const e of entry.entitiesTouched) inferredEntityNames.add(e);
      }
    }
    return inferredEntityNames.size;
  }

  private async finalize(
    analysisRunId: number, projectId: number,
    totalInteractions: number, totalEndpoints: number, appGraph: any,
    catalogEntries: InsertCatalogEntry[]
  ) {
    await storage.updateAnalysisRun(analysisRunId, {
      status: "completed",
      completedAt: new Date(),
      totalInteractions,
      totalEndpoints,
      totalEntities: this.countTotalEntities(appGraph, catalogEntries),
    });
    await storage.updateProjectStatus(projectId, "completed");
  }

  private buildResult(
    analysisRunId: number, projectId: number,
    totalInteractions: number, totalEndpoints: number,
    appGraph: any, graphSummary: any, catalogEntries: number,
    endpointImpacts: any[], resolutionErrors: string[],
    catalogEntryData: InsertCatalogEntry[]
  ): AnalysisResult {
    const totalEntities = this.countTotalEntities(appGraph, catalogEntryData);
    return {
      analysisRunId,
      projectId,
      totalInteractions,
      totalEndpoints,
      totalEntities,
      catalogEntries,
      graph: {
        totalNodes: graphSummary.nodes.length,
        totalEdges: graphSummary.edges.length,
        nodesByType: {
          controllers: appGraph.getNodesByType("CONTROLLER").length,
          services: appGraph.getNodesByType("SERVICE").length,
          repositories: appGraph.getNodesByType("REPOSITORY").length,
          entities: totalEntities,
        },
      },
      endpointImpacts: endpointImpacts.map((ei) => ({
        endpoint: ei.endpoint,
        httpMethod: ei.httpMethod,
        controllerClass: ei.controllerClass,
        controllerMethod: ei.controllerMethod,
        callDepth: ei.callDepth,
        entitiesTouched: ei.entitiesTouched,
        fullCallChain: ei.fullCallChain,
        persistenceOperations: ei.persistenceOperations,
      })),
      resolutionErrors: resolutionErrors.length > 0 ? resolutionErrors : undefined,
    };
  }
}

export function clearProjectCache(projectId: number): void {
  graphCacheStore.delete(projectId);
  frontendCacheStore.delete(projectId);
}

export function getCacheStats(): { graphCacheSize: number; frontendCacheSize: number; projects: number[] } {
  const projects = new Set<number>();
  graphCacheStore.forEach((_, k) => projects.add(k));
  frontendCacheStore.forEach((_, k) => projects.add(k));
  return {
    graphCacheSize: graphCacheStore.size,
    frontendCacheSize: frontendCacheStore.size,
    projects: Array.from(projects),
  };
}

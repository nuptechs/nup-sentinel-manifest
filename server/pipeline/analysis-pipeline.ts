import { storage } from "../storage";
import { analyzeFrontend } from "../analyzers/frontend-analyzer";
import { buildApplicationGraph, analyzeGraphEndpoints } from "../analyzers/backend-java-client";
import { interactionsToCatalogEntries, endpointImpactsToCatalogEntries } from "../analyzers/graph-connector";
import { classifyEntriesDeterministic } from "../analyzers/deterministic-classifier";
import { detectArchitecture } from "../analyzers/architecture-detector";
import type { InsertCatalogEntry } from "@shared/schema";

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
      await storage.deleteCatalogEntriesByProject(projectId);

      const { appGraph, resolutionErrors, archResult } = await this.buildGraph(fileData);
      const endpointImpacts = this.analyzeEndpoints(appGraph);
      const frontendInteractions = this.analyzeFrontendInteractions(fileData, appGraph);
      let catalogEntryData = this.connectGraph(
        frontendInteractions, endpointImpacts, appGraph, analysisRun.id, projectId, archResult.type
      );
      catalogEntryData = this.classify(catalogEntryData);
      const created = await this.persist(catalogEntryData);

      const graphSummary = appGraph.toJSON();
      await this.finalize(analysisRun.id, projectId, frontendInteractions.length, endpointImpacts.length, appGraph);

      return this.buildResult(
        analysisRun.id, projectId, frontendInteractions.length, endpointImpacts.length,
        appGraph, graphSummary, created.length, endpointImpacts, resolutionErrors
      );
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
      frontendInteractions, appGraph, analysisRunId, projectId, archType
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

  private async finalize(
    analysisRunId: number, projectId: number,
    totalInteractions: number, totalEndpoints: number, appGraph: any
  ) {
    await storage.updateAnalysisRun(analysisRunId, {
      status: "completed",
      completedAt: new Date(),
      totalInteractions,
      totalEndpoints,
      totalEntities: appGraph.getNodesByType("ENTITY").length,
    });
    await storage.updateProjectStatus(projectId, "completed");
  }

  private buildResult(
    analysisRunId: number, projectId: number,
    totalInteractions: number, totalEndpoints: number,
    appGraph: any, graphSummary: any, catalogEntries: number,
    endpointImpacts: any[], resolutionErrors: string[]
  ): AnalysisResult {
    return {
      analysisRunId,
      projectId,
      totalInteractions,
      totalEndpoints,
      totalEntities: appGraph.getNodesByType("ENTITY").length,
      catalogEntries,
      graph: {
        totalNodes: graphSummary.nodes.length,
        totalEdges: graphSummary.edges.length,
        nodesByType: {
          controllers: appGraph.getNodesByType("CONTROLLER").length,
          services: appGraph.getNodesByType("SERVICE").length,
          repositories: appGraph.getNodesByType("REPOSITORY").length,
          entities: appGraph.getNodesByType("ENTITY").length,
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

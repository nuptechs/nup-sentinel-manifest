import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { analyzeFrontend } from "./analyzers/frontend-analyzer";
import { buildApplicationGraph, analyzeGraphEndpoints } from "./analyzers/backend-java-client";
import { interactionsToCatalogEntries, endpointImpactsToCatalogEntries } from "./analyzers/graph-connector";
import { classifyEntries } from "./analyzers/semantic-engine";
import { z } from "zod";

const createProjectSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  description: z.string().optional().nullable(),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string().min(1),
    type: z.string().optional(),
  })).min(1, "At least one file is required"),
});

const updateCatalogEntrySchema = z.object({
  humanClassification: z.string().optional().nullable(),
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/stats", async (_req, res) => {
    try {
      const stats = await storage.getStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  app.get("/api/projects", async (_req, res) => {
    try {
      const projects = await storage.getProjects();
      res.json(projects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ message: "Failed to fetch projects" });
    }
  });

  app.get("/api/projects/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid project ID" });
      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }
      res.json(project);
    } catch (error) {
      console.error("Error fetching project:", error);
      res.status(500).json({ message: "Failed to fetch project" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const parsed = createProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => i.message),
        });
      }

      const { name, description, files } = parsed.data;
      const project = await storage.createProject({ name, description: description || null });

      for (const file of files) {
        const ext = file.path.split(".").pop()?.toLowerCase() || "";
        const typeMap: Record<string, string> = {
          java: "java", vue: "vue", jsx: "react", tsx: "react",
          ts: "typescript", js: "javascript", html: "html", xml: "xml",
        };
        await storage.createSourceFile({
          projectId: project.id,
          filePath: file.path,
          fileType: file.type || typeMap[ext] || "other",
          content: file.content,
        });
      }

      await storage.updateProjectStatus(project.id, "uploaded", files.length);

      res.status(201).json(project);
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ message: "Failed to create project" });
    }
  });

  app.delete("/api/projects/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid project ID" });
      await storage.deleteProject(id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  app.post("/api/projects/:id/analyze", async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: "Project not found" });
      }

      const analysisRun = await storage.createAnalysisRun({ projectId });

      try {
        await storage.updateProjectStatus(projectId, "analyzing");
        await storage.updateAnalysisRun(analysisRun.id, { status: "analyzing" });
        await storage.deleteCatalogEntriesByProject(projectId);

        const sourceFiles = await storage.getSourceFiles(projectId);
        const fileData = sourceFiles.map((f) => ({
          filePath: f.filePath,
          content: f.content,
        }));

        const buildResult = await buildApplicationGraph(fileData);
        const appGraph = buildResult.graph;
        const resolutionErrors = buildResult.resolutionErrors;
        const endpointImpacts = analyzeGraphEndpoints(appGraph);

        const frontendInteractions = analyzeFrontend(fileData, appGraph);

        let catalogEntryData = interactionsToCatalogEntries(
          frontendInteractions, appGraph, analysisRun.id, projectId
        );

        if (catalogEntryData.length === 0 && endpointImpacts.length > 0) {
          catalogEntryData = endpointImpactsToCatalogEntries(
            endpointImpacts, analysisRun.id, projectId
          );
        }

        try {
          catalogEntryData = await classifyEntries(catalogEntryData);
        } catch (llmError) {
          console.error("LLM classification failed, using inferred values:", llmError);
        }

        const created = await storage.createCatalogEntries(catalogEntryData);

        const graphSummary = appGraph.toJSON();

        await storage.updateAnalysisRun(analysisRun.id, {
          status: "completed",
          completedAt: new Date(),
          totalInteractions: frontendInteractions.length,
          totalEndpoints: endpointImpacts.length,
          totalEntities: appGraph.getNodesByType("ENTITY").length,
        });

        await storage.updateProjectStatus(projectId, "completed");

        res.json({
          analysisRunId: analysisRun.id,
          totalInteractions: frontendInteractions.length,
          totalEndpoints: endpointImpacts.length,
          totalEntities: appGraph.getNodesByType("ENTITY").length,
          catalogEntries: created.length,
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
            involvedNodeCount: ei.involvedNodes.length,
            fullCallChain: ei.fullCallChain,
            persistenceOperations: ei.persistenceOperations,
          })),
          resolutionErrors: resolutionErrors.length > 0 ? resolutionErrors : undefined,
        });
      } catch (analysisError) {
        const errorMsg = analysisError instanceof Error ? analysisError.message : "Analysis failed";
        await storage.updateAnalysisRun(analysisRun.id, {
          status: "failed",
          completedAt: new Date(),
          errorMessage: errorMsg,
        });
        await storage.updateProjectStatus(projectId, "failed");
        throw analysisError;
      }
    } catch (error) {
      console.error("Error analyzing project:", error);
      const msg = error instanceof Error ? error.message : "Analysis failed";
      res.status(500).json({ message: msg });
    }
  });

  app.get("/api/analysis-runs/recent", async (_req, res) => {
    try {
      const runs = await storage.getRecentAnalysisRuns();
      res.json(runs);
    } catch (error) {
      console.error("Error fetching runs:", error);
      res.status(500).json({ message: "Failed to fetch analysis runs" });
    }
  });

  app.get("/api/analysis-runs/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid run ID" });
      const runs = await storage.getRecentAnalysisRuns();
      const run = runs.find((r) => r.id === id);
      if (!run) return res.status(404).json({ message: "Analysis run not found" });
      res.json(run);
    } catch (error) {
      console.error("Error fetching analysis run:", error);
      res.status(500).json({ message: "Failed to fetch analysis run" });
    }
  });

  app.get("/api/catalog-entries/:projectId", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });
      const entries = await storage.getCatalogEntries(projectId);
      res.json(entries);
    } catch (error) {
      console.error("Error fetching catalog entries:", error);
      res.status(500).json({ message: "Failed to fetch catalog entries" });
    }
  });

  app.patch("/api/catalog-entries/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid entry ID" });

      const parsed = updateCatalogEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          message: "Validation failed",
          errors: parsed.error.issues.map((i) => i.message),
        });
      }

      await storage.updateCatalogEntry(id, parsed.data);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating catalog entry:", error);
      res.status(500).json({ message: "Failed to update catalog entry" });
    }
  });

  app.get("/api/catalog-entries/:projectId/export", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });
      const entries = await storage.getCatalogEntries(projectId);
      const project = await storage.getProject(projectId);

      const exportData = {
        project: project?.name || `Project ${projectId}`,
        exportedAt: new Date().toISOString(),
        totalEntries: entries.length,
        catalog: entries.map((e) => ({
          screen: e.screen,
          interaction: e.interaction,
          interactionType: e.interactionType,
          endpoint: e.endpoint,
          httpMethod: e.httpMethod,
          controllerClass: e.controllerClass,
          controllerMethod: e.controllerMethod,
          fullCallChain: e.fullCallChain,
          serviceMethods: e.serviceMethods,
          repositoryMethods: e.repositoryMethods,
          entitiesTouched: e.entitiesTouched,
          persistenceOperations: e.persistenceOperations,
          technicalOperation: e.technicalOperation,
          criticalityScore: e.criticalityScore,
          suggestedMeaning: e.suggestedMeaning,
          humanClassification: e.humanClassification,
          sourceFile: e.sourceFile,
          lineNumber: e.lineNumber,
        })),
      };

      res.json(exportData);
    } catch (error) {
      console.error("Error exporting catalog:", error);
      res.status(500).json({ message: "Failed to export catalog" });
    }
  });

  return httpServer;
}

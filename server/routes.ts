import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { storage } from "./storage";
import { analyzeFrontend } from "./analyzers/frontend-analyzer";
import { buildApplicationGraph, analyzeGraphEndpoints } from "./analyzers/backend-java-client";
import { interactionsToCatalogEntries, endpointImpactsToCatalogEntries } from "./analyzers/graph-connector";
import { classifyEntries } from "./analyzers/semantic-engine";
import { extractAndScanZip, getFileType } from "./analyzers/repository-scanner";
import { z } from "zod";

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => {
      const uniqueName = `permacat-upload-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`;
      cb(null, uniqueName);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) => {
      const uniqueName = `permacat-chunk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      cb(null, uniqueName);
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
});

interface ChunkedUploadSession {
  uploadId: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: Set<number>;
  tempFilePath: string;
  createdAt: number;
  projectName: string;
  projectDescription: string | null;
}

const chunkedUploads = new Map<string, ChunkedUploadSession>();

setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000;
  chunkedUploads.forEach((session, id) => {
    if (now - session.createdAt > maxAge) {
      try {
        if (fs.existsSync(session.tempFilePath)) fs.unlinkSync(session.tempFilePath);
      } catch {}
      chunkedUploads.delete(id);
      console.log(`[chunked-upload] Expired session ${id} cleaned up`);
    }
  });
}, 5 * 60 * 1000);

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

        const javaCount2 = fileData.filter(f => f.filePath.endsWith(".java")).length;
        const frontendCount2 = fileData.length - javaCount2;
        console.log(`[analysis] Step 1/4: Building application graph (${javaCount2} Java files, ${frontendCount2} frontend files)...`);
        const graphStart2 = Date.now();
        const buildResult = await buildApplicationGraph(fileData);
        const appGraph = buildResult.graph;
        const resolutionErrors = buildResult.resolutionErrors;
        console.log(`[analysis] Step 1/4 done in ${((Date.now() - graphStart2) / 1000).toFixed(1)}s — ${appGraph.toJSON().nodes.length} nodes, ${appGraph.toJSON().edges.length} edges`);

        console.log(`[analysis] Step 2/4: Analyzing graph endpoints...`);
        const endpointImpacts = analyzeGraphEndpoints(appGraph);
        console.log(`[analysis] Step 2/4 done — ${endpointImpacts.length} endpoints found`);

        console.log(`[analysis] Step 3/4: Analyzing frontend interactions...`);
        const frontendInteractions = analyzeFrontend(fileData, appGraph);
        console.log(`[analysis] Step 3/4 done — ${frontendInteractions.length} frontend interactions found`);

        let catalogEntryData = interactionsToCatalogEntries(
          frontendInteractions, appGraph, analysisRun.id, projectId
        );

        if (catalogEntryData.length === 0 && endpointImpacts.length > 0) {
          catalogEntryData = endpointImpactsToCatalogEntries(
            endpointImpacts, analysisRun.id, projectId
          );
        }

        console.log(`[analysis] Step 4/4: LLM classification of ${catalogEntryData.length} entries...`);
        try {
          catalogEntryData = await classifyEntries(catalogEntryData);
          console.log(`[analysis] Step 4/4 done — LLM classification complete`);
        } catch (llmError) {
          console.error("[analysis] Step 4/4 — LLM classification failed, using inferred values:", llmError);
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

  function logMemory(label: string) {
    const mem = process.memoryUsage();
    console.log(`[memory:${label}] RSS=${(mem.rss / 1024 / 1024).toFixed(0)}MB Heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB External=${(mem.external / 1024 / 1024).toFixed(0)}MB`);
  }

  app.post("/api/uploads/init", async (req, res) => {
    try {
      const schema = z.object({
        fileName: z.string().min(1),
        totalSize: z.number().positive(),
        totalChunks: z.number().int().positive(),
        projectName: z.string().min(1),
        projectDescription: z.string().optional().nullable(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Validation failed", errors: parsed.error.issues.map(i => i.message) });
      }
      const { fileName, totalSize, totalChunks, projectName, projectDescription } = parsed.data;
      const uploadId = crypto.randomUUID();
      const tempFilePath = path.join(os.tmpdir(), `permacat-chunked-${uploadId}.zip`);
      const fd = fs.openSync(tempFilePath, "w");
      fs.closeSync(fd);

      const session: ChunkedUploadSession = {
        uploadId,
        fileName,
        totalSize,
        totalChunks,
        receivedChunks: new Set(),
        tempFilePath,
        createdAt: Date.now(),
        projectName,
        projectDescription: projectDescription || null,
      };
      chunkedUploads.set(uploadId, session);
      console.log(`[chunked-upload] Init session ${uploadId} — ${fileName} — ${(totalSize / (1024 * 1024)).toFixed(1)} MB — ${totalChunks} chunks`);
      res.json({ uploadId, totalChunks });
    } catch (error) {
      console.error("[chunked-upload] Init error:", error);
      res.status(500).json({ message: "Failed to initialize upload" });
    }
  });

  app.post("/api/uploads/:uploadId/chunk", (req, res, next) => {
    const uploadHandler = chunkUpload.single("chunk");
    uploadHandler(req, res, (err) => {
      if (err) {
        console.error(`[chunked-upload] Chunk upload error: ${err.message}`);
        return res.status(400).json({ message: `Chunk upload error: ${err.message}` });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const { uploadId } = req.params;
      const chunkIndex = parseInt(req.body.chunkIndex);
      const session = chunkedUploads.get(uploadId);

      if (!session) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(404).json({ message: "Upload session not found or expired" });
      }
      if (isNaN(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
        return res.status(400).json({ message: "Invalid chunk index" });
      }
      if (!req.file) {
        return res.status(400).json({ message: "No chunk data received" });
      }

      if (session.receivedChunks.has(chunkIndex)) {
        try { fs.unlinkSync(req.file.path); } catch {}
        const received = session.receivedChunks.size;
        console.log(`[chunked-upload] ${uploadId} — chunk ${chunkIndex + 1} already received, skipping`);
        return res.json({ received, total: session.totalChunks, complete: received === session.totalChunks });
      }

      const chunkData = fs.readFileSync(req.file.path);
      const chunkSize = 50 * 1024 * 1024;
      const offset = chunkIndex * chunkSize;
      const fd = fs.openSync(session.tempFilePath, "r+");
      fs.writeSync(fd, chunkData, 0, chunkData.length, offset);
      fs.closeSync(fd);

      try { fs.unlinkSync(req.file.path); } catch {}

      session.receivedChunks.add(chunkIndex);
      const received = session.receivedChunks.size;
      const pct = ((received / session.totalChunks) * 100).toFixed(0);
      console.log(`[chunked-upload] ${uploadId} — chunk ${chunkIndex + 1}/${session.totalChunks} (${pct}%) — ${(chunkData.length / (1024 * 1024)).toFixed(1)} MB`);

      res.json({
        received,
        total: session.totalChunks,
        complete: received === session.totalChunks,
      });
    } catch (error) {
      if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
      console.error("[chunked-upload] Chunk error:", error);
      res.status(500).json({ message: "Failed to process chunk" });
    }
  });

  app.post("/api/uploads/:uploadId/complete", async (req, res) => {
    const { uploadId } = req.params;
    const session = chunkedUploads.get(uploadId);

    if (!session) {
      return res.status(404).json({ message: "Upload session not found or expired" });
    }
    if (session.receivedChunks.size !== session.totalChunks) {
      return res.status(400).json({
        message: `Upload incomplete: received ${session.receivedChunks.size}/${session.totalChunks} chunks`,
      });
    }

    const actualSize = fs.statSync(session.tempFilePath).size;
    if (actualSize < session.totalSize * 0.95) {
      console.error(`[chunked-upload] File size mismatch: expected ~${session.totalSize}, got ${actualSize}`);
      return res.status(400).json({
        message: `Assembled file appears incomplete (${(actualSize / (1024 * 1024)).toFixed(1)} MB vs expected ${(session.totalSize / (1024 * 1024)).toFixed(1)} MB). Please try uploading again.`,
      });
    }

    const uploadStartTime = Date.now();
    const useSSE = req.headers.accept === "text/event-stream";
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    function sendProgress(step: string, detail: string) {
      const elapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
      if (useSSE) {
        try { res.write(`data: ${JSON.stringify({ type: "progress", step, detail })}\n\n`); } catch {}
      }
      console.log(`[chunked-upload][+${elapsed}s] ${step}: ${detail}`);
    }

    if (useSSE) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      heartbeatInterval = setInterval(() => {
        try { res.write(`: heartbeat\n\n`); } catch {}
      }, 15000);
    }

    const cleanupSession = () => {
      try {
        if (fs.existsSync(session.tempFilePath)) {
          fs.unlinkSync(session.tempFilePath);
          console.log(`[chunked-upload] Cleaned up temp file: ${session.tempFilePath}`);
        }
      } catch {}
      chunkedUploads.delete(uploadId);
    };

    try {
      const fileSizeMB = (fs.statSync(session.tempFilePath).size / (1024 * 1024)).toFixed(1);
      logMemory("chunked-before-scan");
      sendProgress("upload", `File assembled: ${session.fileName} (${fileSizeMB} MB)`);

      sendProgress("scan", "Extracting and scanning ZIP for source files...");
      const scanStart = Date.now();
      const scannedFiles = extractAndScanZip(session.tempFilePath);
      const scanElapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
      logMemory("chunked-after-scan");

      const totalContentKB = scannedFiles.reduce((sum, f) => sum + f.content.length, 0) / 1024;
      console.log(`[chunked-upload] ZIP scan done in ${scanElapsed}s — ${scannedFiles.length} files, ${totalContentKB.toFixed(0)} KB total content`);

      if (scannedFiles.length > 0) {
        const exts = new Map<string, number>();
        for (const f of scannedFiles) {
          const ext = f.filePath.split(".").pop() || "?";
          exts.set(ext, (exts.get(ext) || 0) + 1);
        }
        const typeStr = Array.from(exts.entries()).map(([e, c]) => `${e}:${c}`).join(", ");
        sendProgress("scan", `Found ${scannedFiles.length} files (${typeStr}) — ${totalContentKB.toFixed(0)} KB source code — scan took ${scanElapsed}s`);
      }
      if (scannedFiles.length === 0) {
        const msg = "No supported source files found in the ZIP. Supported extensions: .java, .ts, .tsx, .js, .jsx, .vue, .py, .cs";
        if (useSSE) {
          res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
          if (heartbeatInterval) clearInterval(heartbeatInterval);
          cleanupSession();
          return res.end();
        }
        cleanupSession();
        return res.status(400).json({ message: msg });
      }

      sendProgress("save", `Saving ${scannedFiles.length} files to database...`);
      const saveStart = Date.now();
      const project = await storage.createProject({
        name: session.projectName,
        description: session.projectDescription,
      });

      let savedCount = 0;
      for (const sf of scannedFiles) {
        await storage.createSourceFile({
          projectId: project.id,
          filePath: sf.filePath,
          fileType: getFileType(sf.filePath),
          content: sf.content,
        });
        savedCount++;
        if (savedCount % 100 === 0) {
          sendProgress("save", `Saved ${savedCount}/${scannedFiles.length} files to database...`);
        }
      }
      const saveElapsed = ((Date.now() - saveStart) / 1000).toFixed(1);
      sendProgress("save", `All ${scannedFiles.length} files saved in ${saveElapsed}s`);
      logMemory("chunked-after-save");

      await storage.updateProjectStatus(project.id, "uploaded", scannedFiles.length);

      const analysisRun = await storage.createAnalysisRun({ projectId: project.id });

      try {
        await storage.updateProjectStatus(project.id, "analyzing");
        await storage.updateAnalysisRun(analysisRun.id, { status: "analyzing" });

        const fileData = scannedFiles.map((f) => ({
          filePath: f.filePath,
          content: f.content,
        }));

        const javaCount = fileData.filter(f => f.filePath.endsWith(".java")).length;
        const frontendCount = fileData.length - javaCount;
        const javaContentKB = fileData.filter(f => f.filePath.endsWith(".java")).reduce((sum, f) => sum + f.content.length, 0) / 1024;
        sendProgress("Step 1/4", `Building application graph (${javaCount} Java files — ${javaContentKB.toFixed(0)} KB, ${frontendCount} frontend files)...`);
        const graphStart = Date.now();
        logMemory("chunked-before-java-engine");
        const buildResult = await buildApplicationGraph(fileData);
        const appGraph = buildResult.graph;
        const resolutionErrors = buildResult.resolutionErrors;
        logMemory("chunked-after-java-engine");
        sendProgress("Step 1/4", `Done in ${((Date.now() - graphStart) / 1000).toFixed(1)}s — ${appGraph.toJSON().nodes.length} nodes, ${appGraph.toJSON().edges.length} edges`);

        sendProgress("Step 2/4", "Analyzing graph endpoints...");
        const endpointImpacts = analyzeGraphEndpoints(appGraph);
        sendProgress("Step 2/4", `Done — ${endpointImpacts.length} endpoints found`);

        sendProgress("Step 3/4", `Analyzing frontend interactions (${frontendCount} files)...`);
        const feStart = Date.now();
        const frontendInteractions = analyzeFrontend(fileData, appGraph);
        sendProgress("Step 3/4", `Done in ${((Date.now() - feStart) / 1000).toFixed(1)}s — ${frontendInteractions.length} frontend interactions found`);

        let catalogEntryData = interactionsToCatalogEntries(
          frontendInteractions, appGraph, analysisRun.id, project.id
        );

        if (catalogEntryData.length === 0 && endpointImpacts.length > 0) {
          catalogEntryData = endpointImpactsToCatalogEntries(
            endpointImpacts, analysisRun.id, project.id
          );
        }

        sendProgress("Step 4/4", `LLM classification of ${catalogEntryData.length} entries...`);
        try {
          catalogEntryData = await classifyEntries(catalogEntryData);
          sendProgress("Step 4/4", "LLM classification complete");
        } catch (llmError) {
          console.error("[chunked-upload] Step 4/4 — LLM classification failed, using inferred values:", llmError);
          sendProgress("Step 4/4", "LLM classification failed, using inferred values");
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

        await storage.updateProjectStatus(project.id, "completed");

        const totalElapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
        console.log(`[chunked-upload] COMPLETE — Project "${session.projectName}" — ${scannedFiles.length} files, ${created.length} catalog entries, ${endpointImpacts.length} endpoints — total ${totalElapsed}s`);
        logMemory("chunked-complete");

        const result = {
          projectId: project.id,
          projectName: session.projectName,
          filesScanned: scannedFiles.length,
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
            fullCallChain: ei.fullCallChain,
            persistenceOperations: ei.persistenceOperations,
          })),
          resolutionErrors: resolutionErrors.length > 0 ? resolutionErrors : undefined,
        };

        if (heartbeatInterval) clearInterval(heartbeatInterval);
        cleanupSession();

        if (useSSE) {
          res.write(`data: ${JSON.stringify({ type: "complete", result })}\n\n`);
          res.end();
        } else {
          res.status(201).json(result);
        }
      } catch (analysisError) {
        const errorMsg = analysisError instanceof Error ? analysisError.message : "Analysis failed";
        console.error(`[chunked-upload] ANALYSIS FAILED: ${errorMsg}`, analysisError instanceof Error ? analysisError.stack : "");
        await storage.updateAnalysisRun(analysisRun.id, {
          status: "failed",
          completedAt: new Date(),
          errorMessage: errorMsg,
        });
        await storage.updateProjectStatus(project.id, "failed");
        throw analysisError;
      }
    } catch (error) {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      cleanupSession();
      const elapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
      const msg = error instanceof Error ? error.message : "Failed to process ZIP";
      console.error(`[chunked-upload] ERROR after ${elapsed}s: ${msg}`, error instanceof Error ? error.stack : "");
      logMemory("chunked-error");
      if (useSSE) {
        try {
          res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
          res.end();
        } catch {}
      } else {
        if (!res.headersSent) {
          res.status(500).json({ message: msg });
        }
      }
    }
  });

  app.post("/api/projects/upload-zip", (req, res, next) => {
    console.log(`[upload] Incoming ZIP upload request — Content-Length: ${req.headers['content-length'] || 'unknown'}`);
    logMemory("before-upload");

    const uploadHandler = upload.single("zipFile");
    uploadHandler(req, res, (err) => {
      if (err) {
        const isMulterError = err instanceof multer.MulterError;
        if (isMulterError && err.code === "LIMIT_FILE_SIZE") {
          const limitMB = 2048;
          console.error(`[upload] MULTER ERROR: File too large (limit: ${limitMB}MB). Code: ${err.code}`);
          return res.status(413).json({
            message: `File too large. Maximum allowed size is ${limitMB}MB. Please reduce your ZIP file size by excluding build artifacts, dependencies, and binary files.`,
          });
        }
        console.error(`[upload] MULTER ERROR: ${isMulterError ? err.code : "UNKNOWN"} — ${err.message}`);
        return res.status(400).json({ message: `Upload error: ${err.message}` });
      }
      logMemory("after-multer");
      next();
    });
  }, async (req, res) => {
    const uploadStartTime = Date.now();
    const useSSE = req.headers.accept === "text/event-stream";

    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    function sendProgress(step: string, detail: string) {
      const elapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
      if (useSSE) {
        try {
          res.write(`data: ${JSON.stringify({ type: "progress", step, detail })}\n\n`);
        } catch (writeErr) {
          console.error(`[upload] SSE write failed: ${writeErr}`);
        }
      }
      console.log(`[upload][+${elapsed}s] ${step}: ${detail}`);
    }

    if (useSSE) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      heartbeatInterval = setInterval(() => {
        try {
          res.write(`: heartbeat\n\n`);
        } catch {}
      }, 15000);
    }

    let tempFilePath: string | null = null;
    const cleanupTempFile = () => {
      try {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
          console.log(`[upload] Cleaned up temp file: ${tempFilePath}`);
        }
      } catch (e) {
        console.error(`[upload] Failed to clean up temp file ${tempFilePath}:`, e);
      }
    };

    try {
      const file = req.file;
      if (!file) {
        console.error("[upload] No file received in request body. Headers:", JSON.stringify(req.headers));
        if (useSSE) {
          res.write(`data: ${JSON.stringify({ type: "error", message: "No ZIP file uploaded. Make sure the file field is named 'zipFile'." })}\n\n`);
          return res.end();
        }
        return res.status(400).json({ message: "No ZIP file uploaded" });
      }

      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
      tempFilePath = file.path;
      console.log(`[upload] Received file "${file.originalname}" — ${fileSizeMB} MB (${file.size} bytes) — stored at ${tempFilePath}`);
      sendProgress("upload", `Received ${file.originalname} (${fileSizeMB} MB)`);
      logMemory("after-receive");

      const projectName = req.body.name || "Uploaded Repository";
      const projectDescription = req.body.description || null;

      sendProgress("scan", "Extracting and scanning ZIP for source files...");
      const scanStart = Date.now();
      const scannedFiles = extractAndScanZip(tempFilePath);
      const scanElapsed = ((Date.now() - scanStart) / 1000).toFixed(1);
      logMemory("after-scan");

      const totalContentKB = scannedFiles.reduce((sum, f) => sum + f.content.length, 0) / 1024;
      console.log(`[upload] ZIP scan done in ${scanElapsed}s — ${scannedFiles.length} files, ${totalContentKB.toFixed(0)} KB total content`);

      if (scannedFiles.length > 0) {
        const exts = new Map<string, number>();
        for (const f of scannedFiles) {
          const ext = f.filePath.split(".").pop() || "?";
          exts.set(ext, (exts.get(ext) || 0) + 1);
        }
        const typeStr = Array.from(exts.entries()).map(([e, c]) => `${e}:${c}`).join(", ");
        sendProgress("scan", `Found ${scannedFiles.length} files (${typeStr}) — ${totalContentKB.toFixed(0)} KB source code — scan took ${scanElapsed}s`);
      }
      if (scannedFiles.length === 0) {
        const msg = "No supported source files found in the ZIP. Supported extensions: .java, .ts, .tsx, .js, .jsx, .vue, .py, .cs";
        if (useSSE) {
          res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
          return res.end();
        }
        return res.status(400).json({ message: msg });
      }

      sendProgress("save", `Saving ${scannedFiles.length} files to database...`);
      const saveStart = Date.now();
      const project = await storage.createProject({
        name: projectName,
        description: projectDescription,
      });

      let savedCount = 0;
      for (const sf of scannedFiles) {
        await storage.createSourceFile({
          projectId: project.id,
          filePath: sf.filePath,
          fileType: getFileType(sf.filePath),
          content: sf.content,
        });
        savedCount++;
        if (savedCount % 100 === 0) {
          sendProgress("save", `Saved ${savedCount}/${scannedFiles.length} files to database...`);
        }
      }
      const saveElapsed = ((Date.now() - saveStart) / 1000).toFixed(1);
      sendProgress("save", `All ${scannedFiles.length} files saved in ${saveElapsed}s`);
      logMemory("after-save");

      await storage.updateProjectStatus(project.id, "uploaded", scannedFiles.length);

      const analysisRun = await storage.createAnalysisRun({ projectId: project.id });

      try {
        await storage.updateProjectStatus(project.id, "analyzing");
        await storage.updateAnalysisRun(analysisRun.id, { status: "analyzing" });

        const fileData = scannedFiles.map((f) => ({
          filePath: f.filePath,
          content: f.content,
        }));

        const javaCount = fileData.filter(f => f.filePath.endsWith(".java")).length;
        const frontendCount = fileData.length - javaCount;
        const javaContentKB = fileData.filter(f => f.filePath.endsWith(".java")).reduce((sum, f) => sum + f.content.length, 0) / 1024;
        sendProgress("Step 1/4", `Building application graph (${javaCount} Java files — ${javaContentKB.toFixed(0)} KB, ${frontendCount} frontend files)...`);
        const graphStart = Date.now();
        logMemory("before-java-engine");
        const buildResult = await buildApplicationGraph(fileData);
        const appGraph = buildResult.graph;
        const resolutionErrors = buildResult.resolutionErrors;
        logMemory("after-java-engine");
        sendProgress("Step 1/4", `Done in ${((Date.now() - graphStart) / 1000).toFixed(1)}s — ${appGraph.toJSON().nodes.length} nodes, ${appGraph.toJSON().edges.length} edges`);

        sendProgress("Step 2/4", "Analyzing graph endpoints...");
        const endpointImpacts = analyzeGraphEndpoints(appGraph);
        sendProgress("Step 2/4", `Done — ${endpointImpacts.length} endpoints found`);

        sendProgress("Step 3/4", `Analyzing frontend interactions (${frontendCount} files)...`);
        const feStart = Date.now();
        const frontendInteractions = analyzeFrontend(fileData, appGraph);
        sendProgress("Step 3/4", `Done in ${((Date.now() - feStart) / 1000).toFixed(1)}s — ${frontendInteractions.length} frontend interactions found`);

        let catalogEntryData = interactionsToCatalogEntries(
          frontendInteractions, appGraph, analysisRun.id, project.id
        );

        if (catalogEntryData.length === 0 && endpointImpacts.length > 0) {
          catalogEntryData = endpointImpactsToCatalogEntries(
            endpointImpacts, analysisRun.id, project.id
          );
        }

        sendProgress("Step 4/4", `LLM classification of ${catalogEntryData.length} entries...`);
        try {
          catalogEntryData = await classifyEntries(catalogEntryData);
          sendProgress("Step 4/4", "LLM classification complete");
        } catch (llmError) {
          console.error("[upload] Step 4/4 — LLM classification failed, using inferred values:", llmError);
          sendProgress("Step 4/4", "LLM classification failed, using inferred values");
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

        await storage.updateProjectStatus(project.id, "completed");

        const totalElapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
        console.log(`[upload] COMPLETE — Project "${projectName}" — ${scannedFiles.length} files, ${created.length} catalog entries, ${endpointImpacts.length} endpoints — total ${totalElapsed}s`);
        logMemory("complete");

        const result = {
          projectId: project.id,
          projectName: projectName,
          filesScanned: scannedFiles.length,
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
            fullCallChain: ei.fullCallChain,
            persistenceOperations: ei.persistenceOperations,
          })),
          resolutionErrors: resolutionErrors.length > 0 ? resolutionErrors : undefined,
        };

        if (heartbeatInterval) clearInterval(heartbeatInterval);
        cleanupTempFile();

        if (useSSE) {
          res.write(`data: ${JSON.stringify({ type: "complete", result })}\n\n`);
          res.end();
        } else {
          res.status(201).json(result);
        }
      } catch (analysisError) {
        const errorMsg = analysisError instanceof Error ? analysisError.message : "Analysis failed";
        console.error(`[upload] ANALYSIS FAILED: ${errorMsg}`, analysisError instanceof Error ? analysisError.stack : "");
        await storage.updateAnalysisRun(analysisRun.id, {
          status: "failed",
          completedAt: new Date(),
          errorMessage: errorMsg,
        });
        await storage.updateProjectStatus(project.id, "failed");
        throw analysisError;
      }
    } catch (error) {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      cleanupTempFile();
      const elapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
      const msg = error instanceof Error ? error.message : "Failed to process ZIP";
      console.error(`[upload] ERROR after ${elapsed}s: ${msg}`, error instanceof Error ? error.stack : "");
      logMemory("error");
      if (useSSE) {
        try {
          res.write(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`);
          res.end();
        } catch {}
      } else {
        if (!res.headersSent) {
          res.status(500).json({ message: msg });
        }
      }
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

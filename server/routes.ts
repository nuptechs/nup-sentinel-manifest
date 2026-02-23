import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { storage } from "./storage";
import { classifyEntries } from "./analyzers/semantic-engine";
import { extractAndScanZip, getFileType } from "./analyzers/repository-scanner";
import { generateManifest } from "./generators/manifest-generator";
import { generateAgentsMd } from "./generators/agents-md-generator";
import { generateOpenAPISpec } from "./generators/openapi-generator";
import { generatePolicyMatrix } from "./generators/policy-matrix-generator";
import { AnalysisPipeline } from "./pipeline/analysis-pipeline";
import { apiAuthMiddleware, generateApiKey, hashApiKey } from "./middleware/api-auth";
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

  app.use("/api", apiAuthMiddleware);

  app.post("/api/keys", async (req, res) => {
    try {
      const { name, projectScope } = req.body;
      if (!name || typeof name !== "string") {
        return res.status(400).json({ message: "Name is required" });
      }

      const { raw, prefix, hash } = generateApiKey();
      const apiKey = await storage.createApiKey({
        name,
        keyHash: hash,
        keyPrefix: prefix,
        projectScope: projectScope || null,
      });

      res.json({
        id: apiKey.id,
        name: apiKey.name,
        key: raw,
        prefix,
        projectScope: apiKey.projectScope,
        createdAt: apiKey.createdAt,
        message: "Store this key securely — it will not be shown again.",
      });
    } catch (error) {
      console.error("Error creating API key:", error);
      res.status(500).json({ message: "Failed to create API key" });
    }
  });

  app.get("/api/keys", async (_req, res) => {
    try {
      const keys = await storage.getApiKeys();
      res.json(keys.map(k => ({
        id: k.id,
        name: k.name,
        prefix: k.keyPrefix,
        projectScope: k.projectScope,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })));
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch API keys" });
    }
  });

  app.delete("/api/keys/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid key ID" });
      await storage.deleteApiKey(id);
      res.json({ message: "API key revoked" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete API key" });
    }
  });

  app.post("/api/analyze", async (req, res) => {
    try {
      const { files, options } = req.body;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ message: "files array is required with at least one entry { path, content }" });
      }

      for (const f of files) {
        if (!f.path || !f.content) {
          return res.status(400).json({ message: "Each file must have 'path' and 'content' fields" });
        }
      }

      const format = options?.format || "manifest";
      const projectName = options?.projectName || `headless-${Date.now()}`;

      const project = await storage.createProject({ name: projectName, description: "Headless analysis" });
      const fileData = files.map((f: any) => ({
        filePath: f.path,
        content: f.content,
      }));

      for (const f of fileData) {
        const fileType = getFileType(f.filePath);
        await storage.createSourceFile({
          projectId: project.id,
          filePath: f.filePath,
          fileType,
          content: f.content,
          contentHash: crypto.createHash("sha256").update(f.content).digest("hex"),
        });
      }
      await storage.updateProjectStatus(project.id, "uploaded", fileData.length);

      const pipeline = new AnalysisPipeline();
      const result = await pipeline.runFullAnalysis(project.id, fileData);

      const entries = await storage.getCatalogEntries(project.id);
      const manifest = generateManifest(project, entries);

      let output: any = { analysis: result, manifest };

      if (format === "agents-md") {
        output.agentsMd = generateAgentsMd(manifest);
      } else if (format === "openapi") {
        output.openapi = generateOpenAPISpec(manifest);
      } else if (format === "policy-matrix") {
        output.policyMatrix = generatePolicyMatrix(manifest);
      } else if (format === "all") {
        output.agentsMd = generateAgentsMd(manifest);
        output.openapi = generateOpenAPISpec(manifest);
        output.policyMatrix = generatePolicyMatrix(manifest);
      }

      res.json(output);
    } catch (error) {
      console.error("Headless analysis error:", error);
      const msg = error instanceof Error ? error.message : "Analysis failed";
      res.status(500).json({ message: msg });
    }
  });

  app.post("/api/analyze-zip", upload.single("file"), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ message: "ZIP file is required" });

      const format = (req.query.format as string) || "manifest";
      const projectName = (req.body.name as string) || `headless-zip-${Date.now()}`;

      const project = await storage.createProject({ name: projectName, description: "Headless ZIP analysis" });

      const scannedFiles = await extractAndScanZip(file.path);
      for (const f of scannedFiles) {
        await storage.createSourceFile({
          projectId: project.id,
          filePath: f.filePath,
          fileType: getFileType(f.filePath),
          content: f.content,
          contentHash: crypto.createHash("sha256").update(f.content).digest("hex"),
        });
      }
      await storage.updateProjectStatus(project.id, "uploaded", scannedFiles.length);

      try { fs.unlinkSync(file.path); } catch {}

      const fileData = scannedFiles.map(f => ({ filePath: f.filePath, content: f.content }));
      const pipeline = new AnalysisPipeline();
      const result = await pipeline.runFullAnalysis(project.id, fileData);

      const entries = await storage.getCatalogEntries(project.id);
      const manifest = generateManifest(project, entries);

      let output: any = { analysis: result, manifest, projectId: project.id };

      if (format === "agents-md" || format === "all") output.agentsMd = generateAgentsMd(manifest);
      if (format === "openapi" || format === "all") output.openapi = generateOpenAPISpec(manifest);
      if (format === "policy-matrix" || format === "all") output.policyMatrix = generatePolicyMatrix(manifest);

      res.json(output);
    } catch (error) {
      console.error("Headless ZIP analysis error:", error);
      const msg = error instanceof Error ? error.message : "ZIP analysis failed";
      res.status(500).json({ message: msg });
    }
  });

  app.get("/api/docs/openapi.json", async (_req, res) => {
    const { getOpenAPISpec } = await import("./api-spec");
    res.json(getOpenAPISpec());
  });

  app.get("/api/docs", async (_req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><title>PermaCat API Documentation</title>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest/dist/style.css">
</head><body>
<script id="api-reference" data-url="/api/docs/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@latest"></script>
</body></html>`);
  });

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

      const pipeline = new AnalysisPipeline();
      const result = await pipeline.runFromProject(projectId);
      res.json(result);
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

      const fileData = scannedFiles.map((f) => ({
        filePath: f.filePath,
        content: f.content,
      }));

      const pipeline = new AnalysisPipeline((p) => {
        sendProgress(p.step, p.detail);
      });

      logMemory("chunked-before-analysis");
      const result = await pipeline.runFullAnalysis(project.id, fileData);
      logMemory("chunked-after-analysis");

      const totalElapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
      console.log(`[chunked-upload] COMPLETE — Project "${session.projectName}" — ${scannedFiles.length} files, ${result.catalogEntries} catalog entries, ${result.totalEndpoints} endpoints — total ${totalElapsed}s`);
      logMemory("chunked-complete");

      const fullResult = {
        ...result,
        projectName: session.projectName,
        filesScanned: scannedFiles.length,
      };

      if (heartbeatInterval) clearInterval(heartbeatInterval);
      cleanupSession();

      if (useSSE) {
        res.write(`data: ${JSON.stringify({ type: "complete", result: fullResult })}\n\n`);
        res.end();
      } else {
        res.status(201).json(fullResult);
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

      const fileData2 = scannedFiles.map((f) => ({
        filePath: f.filePath,
        content: f.content,
      }));

      const pipeline2 = new AnalysisPipeline((p) => {
        sendProgress(p.step, p.detail);
      });

      logMemory("before-analysis");
      const result2 = await pipeline2.runFullAnalysis(project.id, fileData2);
      logMemory("after-analysis");

      const totalElapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
      console.log(`[upload] COMPLETE — Project "${projectName}" — ${scannedFiles.length} files, ${result2.catalogEntries} catalog entries, ${result2.totalEndpoints} endpoints — total ${totalElapsed}s`);
      logMemory("complete");

      const fullResult2 = {
        ...result2,
        projectName: projectName,
        filesScanned: scannedFiles.length,
      };

      if (heartbeatInterval) clearInterval(heartbeatInterval);
      cleanupTempFile();

      if (useSSE) {
        res.write(`data: ${JSON.stringify({ type: "complete", result: fullResult2 })}\n\n`);
        res.end();
      } else {
        res.status(201).json(fullResult2);
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

  app.get("/api/manifest/:projectId", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });
      const entries = await storage.getCatalogEntries(projectId);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (entries.length === 0) return res.status(404).json({ message: "No catalog entries found. Run analysis first." });

      const format = (req.query.format as string) || "manifest";

      const manifest = generateManifest(project, entries);

      switch (format) {
        case "manifest":
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Content-Disposition", `attachment; filename="MANIFEST.json"`);
          return res.json(manifest);

        case "agents-md":
          const agentsMd = generateAgentsMd(manifest);
          res.setHeader("Content-Type", "text/markdown; charset=utf-8");
          res.setHeader("Content-Disposition", `attachment; filename="AGENTS.md"`);
          return res.send(agentsMd);

        case "openapi":
          const openapi = generateOpenAPISpec(manifest);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Content-Disposition", `attachment; filename="openapi-spec.json"`);
          return res.json(openapi);

        case "policy-matrix":
          const policyMatrix = generatePolicyMatrix(manifest);
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Content-Disposition", `attachment; filename="policy-matrix.json"`);
          return res.json(policyMatrix);

        case "all": {
          const allAgentsMd = generateAgentsMd(manifest);
          const allOpenapi = generateOpenAPISpec(manifest);
          const allPolicyMatrix = generatePolicyMatrix(manifest);
          return res.json({
            manifest,
            agentsMd: allAgentsMd,
            openapi: allOpenapi,
            policyMatrix: allPolicyMatrix,
          });
        }

        default:
          return res.status(400).json({ message: `Unknown format: ${format}. Use: manifest, agents-md, openapi, policy-matrix, all` });
      }
    } catch (error) {
      console.error("Error generating manifest:", error);
      res.status(500).json({ message: "Failed to generate manifest" });
    }
  });

  app.get("/api/projects/:projectId/diff", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const runAId = parseInt(req.query.runA as string);
      const runBId = parseInt(req.query.runB as string);
      if (isNaN(runAId) || isNaN(runBId)) {
        return res.status(400).json({ message: "Both runA and runB query parameters are required (analysis run IDs)" });
      }

      const snapshotA = await storage.getAnalysisSnapshot(runAId);
      const snapshotB = await storage.getAnalysisSnapshot(runBId);

      if (!snapshotA) return res.status(404).json({ message: `No snapshot found for run ${runAId}. Only runs completed after snapshot feature was enabled have snapshots.` });
      if (!snapshotB) return res.status(404).json({ message: `No snapshot found for run ${runBId}` });

      const { diffManifests } = await import("./diff/manifest-diff-engine");
      const diff = diffManifests(
        snapshotA.manifestJson as any,
        snapshotB.manifestJson as any,
        runAId,
        runBId
      );

      res.json(diff);
    } catch (error) {
      console.error("Error computing diff:", error);
      res.status(500).json({ message: "Failed to compute manifest diff" });
    }
  });

  app.get("/api/projects/:projectId/diff/latest", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const snapshots = await storage.getLastTwoSnapshots(projectId);
      if (snapshots.length < 2) {
        return res.status(400).json({
          message: `Need at least 2 analysis runs with snapshots to compute a diff. Found: ${snapshots.length}. Run analysis again to create more snapshots.`,
          snapshotCount: snapshots.length,
        });
      }

      const [newer, older] = snapshots;
      const { diffManifests } = await import("./diff/manifest-diff-engine");
      const diff = diffManifests(
        older.manifestJson as any,
        newer.manifestJson as any,
        older.analysisRunId,
        newer.analysisRunId
      );

      res.json(diff);
    } catch (error) {
      console.error("Error computing latest diff:", error);
      res.status(500).json({ message: "Failed to compute latest manifest diff" });
    }
  });

  app.get("/api/projects/:projectId/snapshots", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const snapshots = await storage.getAnalysisSnapshots(projectId);
      const summaries = snapshots.map(s => ({
        id: s.id,
        analysisRunId: s.analysisRunId,
        createdAt: s.createdAt,
        summary: (s.manifestJson as any)?.summary || null,
      }));

      res.json(summaries);
    } catch (error) {
      console.error("Error fetching snapshots:", error);
      res.status(500).json({ message: "Failed to fetch snapshots" });
    }
  });

  const gitTokens = new Map<string, string>();

  app.post("/api/projects/:projectId/git/connect", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const { connectGitSchema } = await import("@shared/schema");
      const parsed = connectGitSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
      }

      const { provider, repoUrl, token, defaultBranch } = parsed.data;

      const { createGitProvider } = await import("./git/git-provider");
      const gitProvider = await createGitProvider({ provider, repoUrl, token });

      const branches = await gitProvider.fetchBranches();
      const resolvedDefault = defaultBranch || branches.find(b => b.isDefault)?.name || "main";

      const tokenRef = `git-token-${projectId}`;
      gitTokens.set(tokenRef, token);

      await storage.updateProjectGitConfig(projectId, {
        gitProvider: provider,
        gitRepoUrl: repoUrl,
        gitDefaultBranch: resolvedDefault,
        gitTokenRef: tokenRef,
      });

      res.json({
        message: "Git repository connected",
        provider,
        repoUrl,
        defaultBranch: resolvedDefault,
        branchCount: branches.length,
        branches: branches.map(b => b.name),
      });
    } catch (error) {
      console.error("Error connecting git:", error);
      const msg = error instanceof Error ? error.message : "Git connection failed";
      res.status(500).json({ message: msg });
    }
  });

  app.get("/api/projects/:projectId/git/branches", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!project.gitProvider || !project.gitRepoUrl || !project.gitTokenRef) {
        return res.status(400).json({ message: "Project is not connected to a Git repository" });
      }

      const token = gitTokens.get(project.gitTokenRef);
      if (!token) return res.status(400).json({ message: "Git token not found. Please reconnect the repository." });

      const { createGitProvider } = await import("./git/git-provider");
      const gitProvider = await createGitProvider({
        provider: project.gitProvider as "github" | "gitlab",
        repoUrl: project.gitRepoUrl,
        token,
      });

      const branches = await gitProvider.fetchBranches();
      res.json(branches);
    } catch (error) {
      console.error("Error fetching branches:", error);
      res.status(500).json({ message: "Failed to fetch branches" });
    }
  });

  app.get("/api/projects/:projectId/git/pull-requests", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!project.gitProvider || !project.gitRepoUrl || !project.gitTokenRef) {
        return res.status(400).json({ message: "Project is not connected to a Git repository" });
      }

      const token = gitTokens.get(project.gitTokenRef);
      if (!token) return res.status(400).json({ message: "Git token not found. Please reconnect the repository." });

      const { createGitProvider } = await import("./git/git-provider");
      const gitProvider = await createGitProvider({
        provider: project.gitProvider as "github" | "gitlab",
        repoUrl: project.gitRepoUrl,
        token,
      });

      const state = (req.query.state as string) || "open";
      const prs = await gitProvider.fetchPullRequests(state as any);
      res.json(prs);
    } catch (error) {
      console.error("Error fetching PRs:", error);
      res.status(500).json({ message: "Failed to fetch pull requests" });
    }
  });

  app.post("/api/projects/:projectId/analyze-branch", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!project.gitProvider || !project.gitRepoUrl || !project.gitTokenRef) {
        return res.status(400).json({ message: "Project is not connected to a Git repository" });
      }

      const token = gitTokens.get(project.gitTokenRef);
      if (!token) return res.status(400).json({ message: "Git token not found. Please reconnect the repository." });

      const branch = req.body.branch || project.gitDefaultBranch;

      const { createGitProvider } = await import("./git/git-provider");
      const gitProvider = await createGitProvider({
        provider: project.gitProvider as "github" | "gitlab",
        repoUrl: project.gitRepoUrl,
        token,
      });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sendEvent = (data: any) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent({ step: "Fetching", detail: `Fetching source files from ${project.gitProvider} branch: ${branch}...` });

      const files = await gitProvider.fetchFiles(branch);
      sendEvent({ step: "Fetching", detail: `Fetched ${files.length} source files` });

      await storage.deleteCatalogEntriesByProject(projectId);
      await storage.deleteSourceFilesByProject(projectId);

      for (const file of files) {
        const fileType = getFileType(file.filePath);
        await storage.createSourceFile({
          projectId,
          filePath: file.filePath,
          fileType,
          content: file.content,
          contentHash: crypto.createHash("sha256").update(file.content).digest("hex"),
        });
      }
      await storage.updateProjectStatus(projectId, "uploaded", files.length);

      const pipeline = new AnalysisPipeline((progress) => {
        sendEvent(progress);
      });

      const result = await pipeline.runFullAnalysis(projectId, files);

      sendEvent({ step: "Complete", detail: "Analysis complete", result });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      console.error("Error analyzing branch:", error);
      const msg = error instanceof Error ? error.message : "Branch analysis failed";
      if (!res.headersSent) {
        res.status(500).json({ message: msg });
      } else {
        res.write(`data: ${JSON.stringify({ step: "Error", detail: msg })}\n\n`);
        res.end();
      }
    }
  });

  app.post("/api/projects/:projectId/analyze-pr", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!project.gitProvider || !project.gitRepoUrl || !project.gitTokenRef) {
        return res.status(400).json({ message: "Project is not connected to a Git repository" });
      }

      const token = gitTokens.get(project.gitTokenRef);
      if (!token) return res.status(400).json({ message: "Git token not found. Please reconnect the repository." });

      const { analyzePRSchema } = await import("@shared/schema");
      const parsed = analyzePRSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
      }

      const { prNumber } = parsed.data;

      const { createGitProvider } = await import("./git/git-provider");
      const gitProvider = await createGitProvider({
        provider: project.gitProvider as "github" | "gitlab",
        repoUrl: project.gitRepoUrl,
        token,
      });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sendEvent = (data: any) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent({ step: "PR Diff", detail: `Fetching PR #${prNumber} diff from ${project.gitProvider}...` });

      const prDiff = await gitProvider.fetchPRDiff(prNumber);
      sendEvent({
        step: "PR Diff",
        detail: `PR "${prDiff.pullRequest.title}" — ${prDiff.changedFiles.length} changed files (${prDiff.pullRequest.sourceBranch} → ${prDiff.pullRequest.targetBranch})`,
      });

      sendEvent({ step: "Base Analysis", detail: `Analyzing base branch (${prDiff.pullRequest.targetBranch}) — ${prDiff.baseFiles.length} files...` });
      const basePipeline = new AnalysisPipeline((progress) => {
        sendEvent({ ...progress, step: `Base: ${progress.step}` });
      });
      const baseResult = await basePipeline.runFullAnalysis(projectId, prDiff.baseFiles);
      sendEvent({ step: "Base Analysis", detail: `Base analysis complete — ${baseResult.catalogEntries} entries` });

      sendEvent({ step: "Head Analysis", detail: `Analyzing PR branch (${prDiff.pullRequest.sourceBranch}) — ${prDiff.headFiles.length} files...` });
      const headPipeline = new AnalysisPipeline((progress) => {
        sendEvent({ ...progress, step: `Head: ${progress.step}` });
      });
      const headResult = await headPipeline.runFullAnalysis(projectId, prDiff.headFiles);
      sendEvent({ step: "Head Analysis", detail: `Head analysis complete — ${headResult.catalogEntries} entries` });

      sendEvent({ step: "Diff", detail: "Computing manifest diff between base and head..." });
      const snapshots = await storage.getAnalysisSnapshots(projectId);
      const sortedSnapshots = snapshots.sort((a, b) => a.id - b.id);
      const baseSnapshot = sortedSnapshots[sortedSnapshots.length - 2];
      const headSnapshot = sortedSnapshots[sortedSnapshots.length - 1];

      let diff = null;
      if (baseSnapshot && headSnapshot) {
        const { diffManifests } = await import("./diff/manifest-diff-engine");
        diff = diffManifests(
          baseSnapshot.manifestJson as any,
          headSnapshot.manifestJson as any,
          baseSnapshot.analysisRunId,
          headSnapshot.analysisRunId
        );
      }

      const prReport = {
        pullRequest: prDiff.pullRequest,
        changedFiles: prDiff.changedFiles,
        baseResult: { catalogEntries: baseResult.catalogEntries, endpoints: baseResult.totalEndpoints, interactions: baseResult.totalInteractions },
        headResult: { catalogEntries: headResult.catalogEntries, endpoints: headResult.totalEndpoints, interactions: headResult.totalInteractions },
        diff,
      };

      sendEvent({ step: "Complete", detail: "PR analysis complete", result: prReport });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      console.error("Error analyzing PR:", error);
      const msg = error instanceof Error ? error.message : "PR analysis failed";
      if (!res.headersSent) {
        res.status(500).json({ message: msg });
      } else {
        res.write(`data: ${JSON.stringify({ step: "Error", detail: msg })}\n\n`);
        res.end();
      }
    }
  });

  app.get("/api/projects/:projectId/git/status", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      res.json({
        connected: !!(project.gitProvider && project.gitRepoUrl),
        provider: project.gitProvider || null,
        repoUrl: project.gitRepoUrl || null,
        defaultBranch: project.gitDefaultBranch || null,
        tokenAvailable: project.gitTokenRef ? gitTokens.has(project.gitTokenRef) : false,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to get git status" });
    }
  });

  app.delete("/api/projects/:projectId/git/disconnect", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      if (project.gitTokenRef) {
        gitTokens.delete(project.gitTokenRef);
      }

      await storage.updateProjectGitConfig(projectId, {
        gitProvider: "",
        gitRepoUrl: "",
        gitDefaultBranch: "",
        gitTokenRef: "",
      });

      res.json({ message: "Git repository disconnected" });
    } catch (error) {
      res.status(500).json({ message: "Failed to disconnect git" });
    }
  });

  app.post("/api/enrich-with-llm/:projectId", async (req, res) => {
    try {
      const projectId = parseInt(req.params.projectId);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const entries = await storage.getCatalogEntries(projectId);
      if (entries.length === 0) {
        return res.status(404).json({ message: "No catalog entries found for this project" });
      }

      console.log(`[enrich-llm] Starting LLM enrichment for project ${projectId} — ${entries.length} entries`);

      const asInsert = entries.map((e) => ({
        analysisRunId: e.analysisRunId,
        projectId: e.projectId,
        screen: e.screen,
        interaction: e.interaction,
        interactionType: e.interactionType,
        endpoint: e.endpoint,
        httpMethod: e.httpMethod,
        controllerClass: e.controllerClass,
        controllerMethod: e.controllerMethod,
        serviceMethods: e.serviceMethods,
        repositoryMethods: e.repositoryMethods,
        entitiesTouched: e.entitiesTouched,
        fullCallChain: e.fullCallChain,
        persistenceOperations: e.persistenceOperations,
        technicalOperation: e.technicalOperation,
        criticalityScore: e.criticalityScore,
        suggestedMeaning: e.suggestedMeaning,
        humanClassification: e.humanClassification,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
      }));

      const enriched = await classifyEntries(asInsert);

      let updated = 0;
      for (let i = 0; i < entries.length; i++) {
        const original = entries[i];
        const enrichedEntry = enriched[i];
        if (enrichedEntry) {
          await storage.updateCatalogEntry(original.id, {
            technicalOperation: enrichedEntry.technicalOperation,
            criticalityScore: enrichedEntry.criticalityScore,
            suggestedMeaning: enrichedEntry.suggestedMeaning,
          });
          updated++;
        }
      }

      console.log(`[enrich-llm] Done — ${updated} entries enriched with LLM classifications`);
      res.json({ message: "LLM enrichment complete", entriesUpdated: updated });
    } catch (error) {
      console.error("Error enriching with LLM:", error);
      const msg = error instanceof Error ? error.message : "LLM enrichment failed";
      res.status(500).json({ message: msg });
    }
  });

  app.post("/api/projects/:id/webhook/configure", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const schema = z.object({
        webhookSecret: z.string().nullable(),
        webhookEnabled: z.boolean(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Validation failed", errors: parsed.error.issues.map(i => i.message) });
      }

      await storage.updateProjectWebhookConfig(id, parsed.data);
      res.json({ message: "Webhook configuration updated" });
    } catch (error) {
      console.error("Error configuring webhook:", error);
      res.status(500).json({ message: "Failed to configure webhook" });
    }
  });

  app.post("/api/webhook/github", async (req, res) => {
    try {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      const event = req.headers["x-github-event"] as string | undefined;

      if (event !== "pull_request") {
        return res.status(200).json({ message: "Event ignored" });
      }

      const body = req.body;
      const action = body?.action;
      if (action !== "opened" && action !== "synchronize") {
        return res.status(200).json({ message: "Action ignored" });
      }

      const repoUrl = body?.repository?.html_url;
      if (!repoUrl) {
        return res.status(400).json({ message: "Missing repository URL" });
      }

      const project = await storage.getProjectByGitRepoUrl(repoUrl);
      if (!project || !project.webhookEnabled) {
        return res.status(200).json({ message: "No matching project or webhook disabled" });
      }

      if (project.webhookSecret && signature) {
        const rawBody = JSON.stringify(req.body);
        const hmac = crypto.createHmac("sha256", project.webhookSecret).update(rawBody).digest("hex");
        const expected = `sha256=${hmac}`;
        if (signature !== expected) {
          return res.status(401).json({ message: "Invalid signature" });
        }
      } else if (project.webhookSecret && !signature) {
        return res.status(401).json({ message: "Missing signature" });
      }

      res.status(200).json({ message: "Webhook received, analysis triggered" });

      const prNumber = body?.pull_request?.number;
      if (prNumber && project.gitTokenRef) {
        try {
          const pipeline = new AnalysisPipeline();
          await pipeline.runFromProject(project.id);
          console.log(`[webhook:github] PR #${prNumber} analysis complete for project ${project.id}`);
        } catch (err) {
          console.error(`[webhook:github] PR #${prNumber} analysis failed:`, err);
        }
      }
    } catch (error) {
      console.error("[webhook:github] Error:", error);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });

  app.post("/api/webhook/gitlab", async (req, res) => {
    try {
      const token = req.headers["x-gitlab-token"] as string | undefined;
      const body = req.body;

      const objectKind = body?.object_kind;
      if (objectKind !== "merge_request") {
        return res.status(200).json({ message: "Event ignored" });
      }

      const action = body?.object_attributes?.action;
      if (action !== "open" && action !== "update") {
        return res.status(200).json({ message: "Action ignored" });
      }

      const repoUrl = body?.project?.web_url;
      if (!repoUrl) {
        return res.status(400).json({ message: "Missing project URL" });
      }

      const project = await storage.getProjectByGitRepoUrl(repoUrl);
      if (!project || !project.webhookEnabled) {
        return res.status(200).json({ message: "No matching project or webhook disabled" });
      }

      if (project.webhookSecret) {
        if (!token || token !== project.webhookSecret) {
          return res.status(401).json({ message: "Invalid token" });
        }
      }

      res.status(200).json({ message: "Webhook received, analysis triggered" });

      const mrIid = body?.object_attributes?.iid;
      if (mrIid && project.gitTokenRef) {
        try {
          const pipeline = new AnalysisPipeline();
          await pipeline.runFromProject(project.id);
          console.log(`[webhook:gitlab] MR !${mrIid} analysis complete for project ${project.id}`);
        } catch (err) {
          console.error(`[webhook:gitlab] MR !${mrIid} analysis failed:`, err);
        }
      }
    } catch (error) {
      console.error("[webhook:gitlab] Error:", error);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });

  return httpServer;
}

import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";
import {
  FolderUp,
  FileCode,
  Plus,
  Trash2,
  ArrowRight,
  Upload,
  Info,
  FileStack,
  Archive,
} from "lucide-react";

interface FileEntry {
  path: string;
  content: string;
  type: string;
}

function detectFileType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const typeMap: Record<string, string> = {
    java: "java",
    vue: "vue",
    jsx: "react",
    tsx: "react",
    ts: "typescript",
    js: "javascript",
    html: "html",
    xml: "xml",
  };
  return typeMap[ext] || "other";
}

const FILE_PATH_PATTERN = /^(?:\/\/\s*)?(?:[-\w./]+\/)*[-\w]+\.\w+\s*$/;
const SOURCE_EXTENSIONS = /\.(java|vue|jsx|tsx|ts|js|html|xml)$/i;

function parseBulkPaste(text: string): FileEntry[] {
  const lines = text.split("\n");
  const entries: FileEntry[] = [];
  let currentPath = "";
  let currentLines: string[] = [];

  function flushCurrent() {
    if (currentPath && currentLines.length > 0) {
      const content = currentLines.join("\n").trim();
      if (content) {
        entries.push({
          path: currentPath.trim(),
          content,
          type: detectFileType(currentPath),
        });
      }
    }
    currentLines = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed &&
      !trimmed.startsWith("package ") &&
      !trimmed.startsWith("import ") &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("/*") &&
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("@") &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("}") &&
      !trimmed.startsWith("public ") &&
      !trimmed.startsWith("private ") &&
      !trimmed.startsWith("protected ") &&
      !trimmed.startsWith("class ") &&
      !trimmed.startsWith("interface ") &&
      !trimmed.startsWith("return ") &&
      !trimmed.startsWith("this.") &&
      !trimmed.startsWith("<") &&
      !trimmed.startsWith("export ") &&
      !trimmed.startsWith("const ") &&
      !trimmed.startsWith("let ") &&
      !trimmed.startsWith("var ") &&
      !trimmed.startsWith("function ") &&
      SOURCE_EXTENSIONS.test(trimmed) &&
      FILE_PATH_PATTERN.test(trimmed)
    ) {
      flushCurrent();
      currentPath = trimmed.replace(/^\/\/\s*/, "");
    } else {
      currentLines.push(line);
    }
  }
  flushCurrent();
  return entries;
}

function FileTypeBadge({ type }: { type: string }) {
  const colorMap: Record<string, string> = {
    java: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
    vue: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
    react: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    typescript: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    javascript: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
    html: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${colorMap[type] || "bg-muted text-muted-foreground"}`}>
      {type.toUpperCase()}
    </span>
  );
}

type UploadMode = "single" | "bulk" | "zip";

export default function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [currentContent, setCurrentContent] = useState("");
  const [bulkContent, setBulkContent] = useState("");
  const [uploadMode, setUploadMode] = useState<UploadMode>("zip");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [progressMessages, setProgressMessages] = useState<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addFile = useCallback(() => {
    if (!currentPath.trim() || !currentContent.trim()) {
      toast({
        title: "Missing information",
        description: "Please provide both a file path and content.",
        variant: "destructive",
      });
      return;
    }
    const type = detectFileType(currentPath);
    setFiles((prev) => [...prev, { path: currentPath.trim(), content: currentContent, type }]);
    setCurrentPath("");
    setCurrentContent("");
  }, [currentPath, currentContent, toast]);

  const addBulkFiles = useCallback(() => {
    if (!bulkContent.trim()) {
      toast({
        title: "No content",
        description: "Please paste file contents with file paths as separators.",
        variant: "destructive",
      });
      return;
    }
    const parsed = parseBulkPaste(bulkContent);
    if (parsed.length === 0) {
      toast({
        title: "No files detected",
        description: "Could not detect file path separators. Each file should be preceded by its path (e.g., src/main/java/com/app/User.java).",
        variant: "destructive",
      });
      return;
    }
    setFiles((prev) => [...prev, ...parsed]);
    setBulkContent("");
    toast({
      title: `${parsed.length} file${parsed.length !== 1 ? "s" : ""} added`,
      description: `Detected and added ${parsed.length} file${parsed.length !== 1 ? "s" : ""} from bulk paste.`,
    });
  }, [bulkContent, toast]);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/projects", {
        name: projectName,
        description,
        files,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({
        title: "Project uploaded",
        description: "Your project has been uploaded successfully.",
      });
      setLocation(`/catalog?projectId=${data.id}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const zipUploadMutation = useMutation({
    mutationFn: async () => {
      if (!zipFile) throw new Error("No ZIP file selected");
      setProgressMessages([]);
      const formData = new FormData();
      formData.append("zipFile", zipFile);
      formData.append("name", projectName);
      if (description) formData.append("description", description);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20 * 60 * 1000);

      setProgressMessages(prev => [...prev, `upload: Uploading ${(zipFile.size / (1024 * 1024)).toFixed(1)} MB ZIP file...`]);

      let res: Response;
      try {
        res = await fetch("/api/projects/upload-zip", {
          method: "POST",
          body: formData,
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
      } catch (networkError: any) {
        clearTimeout(timeoutId);
        if (networkError.name === "AbortError") {
          throw new Error("The analysis timed out after 20 minutes. Your project may be very large — try uploading fewer files or splitting into smaller ZIPs.");
        }
        throw new Error(`Network error: could not reach the server (${networkError.message}). For very large files, the upload may have been interrupted.`);
      }

      if (!res.ok) {
        clearTimeout(timeoutId);
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const err = await res.json().catch(() => ({ message: `Server error (${res.status}).` }));
          throw new Error(err.message);
        }
        if (res.status === 413) {
          throw new Error("File too large. Maximum allowed size is 2GB. Please reduce your ZIP by excluding build artifacts and dependencies.");
        }
        const text = await res.text().catch(() => "");
        throw new Error(`Server error (${res.status}): ${text || "Unknown error"}`);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        clearTimeout(timeoutId);
        throw new Error("Could not read server response stream.");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: any = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith(":") || line.trim() === "" || line.startsWith("event:")) continue;
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "progress") {
              setProgressMessages(prev => [...prev, `${event.step}: ${event.detail}`]);
            } else if (event.type === "complete") {
              finalResult = event.result;
            } else if (event.type === "error") {
              clearTimeout(timeoutId);
              throw new Error(event.message);
            }
          } catch (parseErr: any) {
            if (parseErr.message && !parseErr.message.includes("JSON")) throw parseErr;
          }
        }
      }

      clearTimeout(timeoutId);
      if (!finalResult) throw new Error("Analysis completed but no result was received. Please check the catalog page.");
      return finalResult;
    },
    onSuccess: (data: { projectId: number; filesScanned: number; catalogEntries: number; totalEndpoints: number; totalEntities: number; resolutionErrors?: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analysis-runs/recent"] });
      setProgressMessages([]);
      if (data.resolutionErrors && data.resolutionErrors.length > 0) {
        toast({
          title: "Analysis complete with warnings",
          description: `${data.filesScanned} files scanned, ${data.catalogEntries} catalog entries generated. ${data.resolutionErrors.length} issue(s) detected.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Repository analyzed",
          description: `${data.filesScanned} files scanned, ${data.catalogEntries} catalog entries, ${data.totalEndpoints} endpoints, ${data.totalEntities} entities.`,
        });
      }
      setLocation(`/catalog?projectId=${data.projectId}`);
    },
    onError: (error: Error) => {
      setProgressMessages([]);
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const isAnalyzing = zipUploadMutation.isPending || uploadMutation.isPending;

  useEffect(() => {
    if (isAnalyzing) {
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isAnalyzing]);

  const formatElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const handleSubmit = () => {
    if (!projectName.trim()) {
      toast({
        title: "Missing project name",
        description: "Please enter a name for your project.",
        variant: "destructive",
      });
      return;
    }
    if (uploadMode === "zip") {
      if (!zipFile) {
        toast({
          title: "No ZIP file selected",
          description: "Please select a ZIP file containing your repository.",
          variant: "destructive",
        });
        return;
      }
      zipUploadMutation.mutate();
    } else {
      if (files.length === 0) {
        toast({
          title: "No files added",
          description: "Please add at least one source file.",
          variant: "destructive",
        });
        return;
      }
      uploadMutation.mutate();
    }
  };

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles) return;

    const newFiles: FileEntry[] = [];
    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      const text = await file.text();
      const path = file.webkitRelativePath || file.name;
      const type = detectFileType(path);
      newFiles.push({ path, content: text, type });
    }
    setFiles((prev) => [...prev, ...newFiles]);
    e.target.value = "";
  }, []);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-upload-title">
          Upload Project
        </h1>
        <p className="text-muted-foreground mt-1">
          Add your frontend and Spring Boot backend source files for analysis
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Project Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">Project Name</Label>
            <Input
              id="project-name"
              placeholder="e.g., Customer Portal v2"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              data-testid="input-project-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              placeholder="Brief description of the project..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="resize-none"
              data-testid="input-description"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Source Files</CardTitle>
          {uploadMode !== "zip" && (
            <Badge variant="secondary" className="text-xs">
              {files.length} file{files.length !== 1 ? "s" : ""} added
            </Badge>
          )}
          {uploadMode === "zip" && zipFile && (
            <Badge variant="secondary" className="text-xs">
              ZIP: {zipFile.name}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 p-4 rounded-md bg-accent/50">
            <Info className="h-4 w-4 text-muted-foreground shrink-0" />
            <p className="text-xs text-muted-foreground">
              Add Vue/React/Angular frontend files and Java Spring Boot backend files.
              You can paste code directly or upload files from your machine.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={uploadMode === "zip" ? "secondary" : "outline"}
                size="sm"
                onClick={() => setUploadMode("zip")}
                data-testid="button-mode-zip"
              >
                <Archive className="h-3.5 w-3.5 mr-1.5" />
                ZIP Repository
              </Button>
              <Button
                variant={uploadMode === "single" ? "secondary" : "outline"}
                size="sm"
                onClick={() => setUploadMode("single")}
                data-testid="button-mode-single"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Single File
              </Button>
              <Button
                variant={uploadMode === "bulk" ? "secondary" : "outline"}
                size="sm"
                onClick={() => setUploadMode("bulk")}
                data-testid="button-mode-bulk"
              >
                <FileStack className="h-3.5 w-3.5 mr-1.5" />
                Bulk Paste
              </Button>
            </div>

            {uploadMode === "zip" ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 p-4 rounded-md bg-accent/50">
                  <Info className="h-4 w-4 text-muted-foreground shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    Upload a ZIP file of your entire repository. The system will automatically scan all folders,
                    filter supported file types (.java, .ts, .tsx, .js, .vue, .py, .cs), and run the full analysis pipeline.
                    Directories like node_modules, .git, dist, build, and target are automatically ignored.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zip-file">Repository ZIP File</Label>
                  <div className="flex items-center gap-3">
                    <label
                      htmlFor="zip-input"
                      className="flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer hover-elevate text-sm font-medium"
                    >
                      <Archive className="h-4 w-4" />
                      {zipFile ? zipFile.name : "Choose ZIP file..."}
                    </label>
                    <input
                      id="zip-input"
                      type="file"
                      accept=".zip,application/zip,application/x-zip-compressed"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setZipFile(f);
                      }}
                      data-testid="input-zip-upload"
                    />
                    {zipFile && (
                      <Badge variant="secondary" className="text-xs">
                        {(zipFile.size / (1024 * 1024)).toFixed(1)} MB
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            ) : uploadMode === "single" ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <label className="cursor-pointer" htmlFor="file-input">
                    <div className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                      <Upload className="h-3.5 w-3.5" />
                      Upload files from disk
                    </div>
                    <input
                      id="file-input"
                      type="file"
                      multiple
                      accept=".java,.vue,.jsx,.tsx,.ts,.js,.html,.xml"
                      className="hidden"
                      onChange={handleFileUpload}
                      data-testid="input-file-upload"
                    />
                  </label>
                </div>
                <Separator />
                <div className="space-y-2">
                  <Label htmlFor="file-path">File Path</Label>
                  <Input
                    id="file-path"
                    placeholder="e.g., src/main/java/com/app/UserController.java"
                    value={currentPath}
                    onChange={(e) => setCurrentPath(e.target.value)}
                    data-testid="input-file-path"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="file-content">File Content</Label>
                  <Textarea
                    id="file-content"
                    placeholder="Paste your source code here..."
                    value={currentContent}
                    onChange={(e) => setCurrentContent(e.target.value)}
                    className="font-mono text-xs min-h-[200px]"
                    data-testid="input-file-content"
                  />
                </div>
                <Button variant="outline" onClick={addFile} data-testid="button-add-file">
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add File
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-md bg-accent/50">
                  <Info className="h-4 w-4 text-muted-foreground shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    Paste all files at once. Use file paths as separators between files. Example:
                    <br />
                    <code className="text-[10px] font-mono">src/main/java/com/app/User.java</code>
                    <br />
                    <code className="text-[10px] font-mono">package com.app; ...</code>
                    <br />
                    <code className="text-[10px] font-mono">src/main/java/com/app/UserController.java</code>
                    <br />
                    <code className="text-[10px] font-mono">package com.app; ...</code>
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bulk-content">Bulk Paste</Label>
                  <Textarea
                    id="bulk-content"
                    placeholder={"src/main/java/com/app/User.java\npackage com.app;\n\nimport jakarta.persistence.Entity;\n...\n\nsrc/main/java/com/app/UserController.java\npackage com.app;\n..."}
                    value={bulkContent}
                    onChange={(e) => setBulkContent(e.target.value)}
                    className="font-mono text-xs min-h-[300px]"
                    data-testid="input-bulk-content"
                  />
                </div>
                <Button variant="outline" onClick={addBulkFiles} data-testid="button-add-bulk">
                  <FileStack className="h-3.5 w-3.5 mr-1.5" />
                  Parse & Add Files
                </Button>
              </div>
            )}
          </div>

          {uploadMode !== "zip" && files.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-sm font-medium">Added Files</p>
                <div className="space-y-1">
                  {files.map((file, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between gap-2 p-2.5 rounded-md bg-accent/30"
                      data-testid={`card-file-${index}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <FileCode className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="text-sm font-mono truncate">{file.path}</span>
                        <FileTypeBadge type={file.type} />
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeFile(index)}
                        data-testid={`button-remove-file-${index}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={handleSubmit}
          disabled={
            (uploadMode === "zip"
              ? zipUploadMutation.isPending || !zipFile || !projectName.trim()
              : uploadMutation.isPending || files.length === 0 || !projectName.trim())
          }
          data-testid="button-upload-project"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              {zipUploadMutation.isPending ? "Analyzing..." : "Uploading..."} {formatElapsed(elapsedSeconds)}
            </>
          ) : (
            <>
              <FolderUp className="h-4 w-4 mr-1.5" />
              {uploadMode === "zip" ? "Upload ZIP & Analyze" : "Upload & Analyze"}
              <ArrowRight className="h-4 w-4 ml-1.5" />
            </>
          )}
        </Button>

        {isAnalyzing && progressMessages.length > 0 && (
          <Card className="mt-4">
            <CardContent className="pt-4 pb-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Analysis Progress</p>
              <div className="space-y-1 max-h-48 overflow-y-auto" data-testid="progress-log">
                {progressMessages.map((msg, i) => (
                  <p
                    key={i}
                    className={`text-xs font-mono ${i === progressMessages.length - 1 ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {msg}
                  </p>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

// @ts-ignore - adm-zip types
import AdmZip from "adm-zip";
import path from "path";

const SUPPORTED_EXTENSIONS = new Set([
  ".java", ".ts", ".tsx", ".js", ".jsx", ".vue", ".py", ".cs",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".idea",
  ".vscode", ".gradle", "__pycache__", ".next", "out", "bin", "obj",
  ".svn", ".hg", "vendor", ".settings", ".classpath", ".project",
]);

const MAX_FILE_SIZE = 512 * 1024;

interface ScannedFile {
  filePath: string;
  content: string;
}

export function extractAndScanZip(zipBuffer: Buffer): ScannedFile[] {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  const allPaths = entries
    .filter((e) => !e.isDirectory)
    .map((e) => e.entryName.replace(/\\/g, "/"));

  const commonPrefix = findCommonRootFolder(allPaths);

  const files: ScannedFile[] = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    let entryPath = entry.entryName.replace(/\\/g, "/");
    if (commonPrefix && entryPath.startsWith(commonPrefix)) {
      entryPath = entryPath.substring(commonPrefix.length);
    }

    if (!entryPath) continue;
    if (isIgnoredPath(entryPath)) continue;

    const ext = path.extname(entryPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

    if (entry.header.size > MAX_FILE_SIZE) continue;

    try {
      const content = entry.getData().toString("utf-8");
      if (content.trim().length === 0) continue;

      files.push({
        filePath: entryPath,
        content,
      });
    } catch {
      continue;
    }
  }

  return files;
}

function findCommonRootFolder(paths: string[]): string {
  if (paths.length === 0) return "";

  const firstSlash = paths[0].indexOf("/");
  if (firstSlash === -1) return "";

  const candidate = paths[0].substring(0, firstSlash + 1);
  const allMatch = paths.every((p) => p.startsWith(candidate));
  return allMatch ? candidate : "";
}

function isIgnoredPath(filePath: string): boolean {
  const parts = filePath.split("/");
  return parts.some((part) => IGNORED_DIRS.has(part));
}

export function getFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const typeMap: Record<string, string> = {
    ".java": "java",
    ".vue": "vue",
    ".jsx": "react",
    ".tsx": "react",
    ".ts": "typescript",
    ".js": "javascript",
    ".py": "python",
    ".cs": "csharp",
  };
  return typeMap[ext] || "other";
}

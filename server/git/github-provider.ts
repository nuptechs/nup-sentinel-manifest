import type { IGitProvider, GitFile, GitBranch, GitPullRequest, GitDiffFile, GitPRDiff, GitProviderConfig } from "./git-provider";
import { parseRepoUrl, isSourceFile } from "./git-provider";

const GITHUB_API = "https://api.github.com";

interface GitHubTreeItem {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

export class GitHubProvider implements IGitProvider {
  private owner: string;
  private repo: string;
  private token: string;
  private headers: Record<string, string>;

  constructor(config: GitProviderConfig) {
    const parsed = parseRepoUrl(config.repoUrl);
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.token = config.token;
    this.headers = {
      "Authorization": `Bearer ${this.token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const url = `${GITHUB_API}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { ...this.headers, ...options?.headers },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${body}`);
    }

    return res.json();
  }

  async fetchBranches(): Promise<GitBranch[]> {
    const [branches, repo] = await Promise.all([
      this.request(`/repos/${this.owner}/${this.repo}/branches?per_page=100`),
      this.request(`/repos/${this.owner}/${this.repo}`),
    ]);

    const defaultBranch = repo.default_branch;

    return branches.map((b: any) => ({
      name: b.name,
      isDefault: b.name === defaultBranch,
      lastCommitSha: b.commit.sha,
    }));
  }

  async fetchFileTree(branch: string): Promise<string[]> {
    const data = await this.request(
      `/repos/${this.owner}/${this.repo}/git/trees/${branch}?recursive=1`
    );

    return data.tree
      .filter((item: GitHubTreeItem) => item.type === "blob")
      .map((item: GitHubTreeItem) => item.path);
  }

  async fetchFiles(branch: string, extensions?: string[]): Promise<GitFile[]> {
    const allPaths = await this.fetchFileTree(branch);
    const filterFn = extensions
      ? (p: string) => extensions.some(ext => p.endsWith(ext))
      : isSourceFile;

    const sourcePaths = allPaths.filter(filterFn);
    console.log(`[github] Found ${sourcePaths.length} source files out of ${allPaths.length} total on branch ${branch}`);

    const batchSize = 20;
    const files: GitFile[] = [];

    for (let i = 0; i < sourcePaths.length; i += batchSize) {
      const batch = sourcePaths.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          try {
            const content = await this.fetchFileContent(branch, filePath);
            return { filePath, content };
          } catch (err) {
            console.warn(`[github] Failed to fetch ${filePath}: ${err}`);
            return null;
          }
        })
      );
      files.push(...results.filter((f): f is GitFile => f !== null));
    }

    return files;
  }

  async fetchFileContent(branch: string, filePath: string): Promise<string> {
    const url = `/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(filePath)}?ref=${branch}`;
    const res = await fetch(`${GITHUB_API}${url}`, {
      headers: { ...this.headers, "Accept": "application/vnd.github.raw+json" },
    });

    if (!res.ok) {
      throw new Error(`GitHub content fetch failed for ${filePath}: ${res.status}`);
    }

    return res.text();
  }

  async fetchPullRequests(state: "open" | "closed" | "all" = "open"): Promise<GitPullRequest[]> {
    const data = await this.request(
      `/repos/${this.owner}/${this.repo}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`
    );

    return data.map((pr: any) => ({
      id: pr.number,
      title: pr.title,
      description: pr.body || "",
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
      author: pr.user.login,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      url: pr.html_url,
    }));
  }

  async fetchPRDiff(prNumber: number): Promise<GitPRDiff> {
    const [pr, files] = await Promise.all([
      this.request(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`),
      this.request(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/files?per_page=300`),
    ]);

    const pullRequest: GitPullRequest = {
      id: pr.number,
      title: pr.title,
      description: pr.body || "",
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
      author: pr.user.login,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      url: pr.html_url,
    };

    const changedFiles: GitDiffFile[] = files
      .filter((f: any) => isSourceFile(f.filename))
      .map((f: any) => ({
        filePath: f.filename,
        status: f.status === "added" ? "added" :
                f.status === "removed" ? "removed" :
                f.status === "renamed" ? "renamed" : "modified",
        oldPath: f.previous_filename || undefined,
        additions: f.additions,
        deletions: f.deletions,
      }));

    const baseBranch = pr.base.ref;
    const headBranch = pr.head.ref;

    const sourceFilePaths = changedFiles
      .filter(f => f.status !== "removed")
      .map(f => f.filePath);

    const [baseFiles, headFiles] = await Promise.all([
      this.fetchFiles(baseBranch),
      this.fetchFiles(headBranch),
    ]);

    return {
      pullRequest,
      changedFiles,
      baseFiles,
      headFiles,
    };
  }

  /** Ver doc na interface (IGitProvider.fetchPRDiffLight). */
  async fetchPRDiffLight(prNumber: number): Promise<GitPRDiff> {
    const [pr, files] = await Promise.all([
      this.request(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`),
      this.request(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/files?per_page=300`),
    ]);

    const pullRequest: GitPullRequest = {
      id: pr.number,
      title: pr.title,
      description: pr.body || "",
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open",
      author: pr.user.login,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      url: pr.html_url,
    };

    const changedFiles: GitDiffFile[] = files
      .filter((f: any) => isSourceFile(f.filename))
      .map((f: any) => ({
        filePath: f.filename,
        status: f.status === "added" ? "added" :
                f.status === "removed" ? "removed" :
                f.status === "renamed" ? "renamed" : "modified",
        oldPath: f.previous_filename || undefined,
        additions: f.additions,
        deletions: f.deletions,
      }));

    // Conteúdo SÓ dos alterados, por SHA (não por branch — a branch head de
    // PR mergeado costuma estar deletada). Falha individual = pula o arquivo
    // (fail-soft, 1 linha de log — nunca o flood do fetch de árvore inteira).
    const baseSha = pr.base.sha;
    const headSha = pr.head.sha;
    const fetchAt = async (sha: string, paths: string[]): Promise<GitFile[]> => {
      const out: GitFile[] = [];
      for (const filePath of paths) {
        try {
          const content = await this.fetchFileContent(sha, filePath);
          out.push({ filePath, content });
        } catch {
          console.warn(`[github] fetchPRDiffLight: pulei ${filePath}@${sha.slice(0, 7)} (fetch falhou)`);
        }
      }
      return out;
    };

    const basePaths = changedFiles.filter((f) => f.status !== "added").map((f) => f.oldPath ?? f.filePath);
    const headPaths = changedFiles.filter((f) => f.status !== "removed").map((f) => f.filePath);
    const [baseFiles, headFiles] = await Promise.all([
      fetchAt(baseSha, basePaths),
      fetchAt(headSha, headPaths),
    ]);

    return { pullRequest, changedFiles, baseFiles, headFiles };
  }
}

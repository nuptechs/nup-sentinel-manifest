export interface GitFile {
  filePath: string;
  content: string;
}

export interface GitBranch {
  name: string;
  isDefault: boolean;
  lastCommitSha: string;
  lastCommitDate?: string;
}

export interface GitPullRequest {
  id: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  state: "open" | "closed" | "merged";
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface GitDiffFile {
  filePath: string;
  status: "added" | "modified" | "removed" | "renamed";
  oldPath?: string;
  additions: number;
  deletions: number;
}

export interface GitPRDiff {
  pullRequest: GitPullRequest;
  changedFiles: GitDiffFile[];
  baseFiles: GitFile[];
  headFiles: GitFile[];
}

export interface GitProviderConfig {
  provider: "github" | "gitlab";
  repoUrl: string;
  token: string;
}

export function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  const cleaned = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");

  const sshMatch = cleaned.match(/git@[^:]+:(.+?)\/(.+?)$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  const httpsMatch = cleaned.match(/https?:\/\/[^/]+\/(.+?)\/(.+?)$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
  }

  throw new Error(`Cannot parse repository URL: ${repoUrl}`);
}

export interface IGitProvider {
  fetchBranches(): Promise<GitBranch[]>;
  fetchFileTree(branch: string): Promise<string[]>;
  fetchFiles(branch: string, extensions?: string[]): Promise<GitFile[]>;
  fetchFileContent(branch: string, filePath: string): Promise<string>;
  fetchPullRequests(state?: "open" | "closed" | "all"): Promise<GitPullRequest[]>;
  fetchPRDiff(prNumber: number): Promise<GitPRDiff>;
  /**
   * Variante LEVE do fetchPRDiff pro bot de laudo (ADR-0023 O5 follow-up):
   * baseFiles/headFiles carregam SÓ o conteúdo dos arquivos ALTERADOS
   * (por SHA — funciona em PR mergeado com branch deletada), em vez da
   * árvore inteira ×2. O fetchPRDiff cheio num repo do tamanho do EasyNuP
   * (~8k arquivos) estoura a cota de 5000 req/h da API do GitHub em UMA
   * chamada — o laudo morria em rate-limit antes de nascer. O
   * buildUnifiedDiffFromPR só consulta os changed paths, então o shape
   * continua o mesmo. Opcional: provider sem a variante cai no cheio.
   */
  fetchPRDiffLight?(prNumber: number): Promise<GitPRDiff>;
}

const SOURCE_EXTENSIONS = [
  ".java", ".ts", ".tsx", ".js", ".jsx", ".vue", ".html",
  ".xml", ".properties", ".yml", ".yaml", ".json",
];

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.some(ext => filePath.endsWith(ext));
}

export async function createGitProvider(config: GitProviderConfig): Promise<IGitProvider> {
  switch (config.provider) {
    case "github": {
      const { GitHubProvider } = await import("./github-provider");
      return new GitHubProvider(config);
    }
    case "gitlab": {
      const { GitLabProvider } = await import("./gitlab-provider");
      return new GitLabProvider(config);
    }
    default:
      throw new Error(`Unsupported git provider: ${config.provider}`);
  }
}

import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  GitBranch,
  GitPullRequest as GitPullRequestIcon,
  Link2,
  Unlink,
  Loader2,
  Play,
  Shield,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ExternalLink,
  RefreshCw,
  GitMerge,
} from "lucide-react";
import { SiGithub, SiGitlab } from "react-icons/si";

interface Project {
  id: number;
  name: string;
  status: string;
  gitProvider: string | null;
  gitRepoUrl: string | null;
  gitDefaultBranch: string | null;
}

interface GitStatus {
  connected: boolean;
  provider: string | null;
  repoUrl: string | null;
  defaultBranch: string | null;
  tokenAvailable: boolean;
}

interface Branch {
  name: string;
  isDefault: boolean;
  lastCommitSha: string;
  lastCommitDate?: string;
}

interface PullRequest {
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

interface SSEEvent {
  step: string;
  detail: string;
  result?: any;
}

export default function GitIntegrationPage() {
  const { toast } = useToast();
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [repoUrl, setRepoUrl] = useState("");
  const [token, setToken] = useState("");
  const [analysisLog, setAnalysisLog] = useState<SSEEvent[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const { data: gitStatus, isLoading: loadingGitStatus, refetch: refetchGitStatus } = useQuery<GitStatus>({
    queryKey: ["/api/projects", selectedProjectId, "git", "status"],
    enabled: !!selectedProjectId,
  });

  const { data: branches, isLoading: loadingBranches, refetch: refetchBranches } = useQuery<Branch[]>({
    queryKey: ["/api/projects", selectedProjectId, "git", "branches"],
    enabled: !!selectedProjectId && !!gitStatus?.connected && !!gitStatus?.tokenAvailable,
  });

  const { data: pullRequests, isLoading: loadingPRs, refetch: refetchPRs } = useQuery<PullRequest[]>({
    queryKey: ["/api/projects", selectedProjectId, "git", "pull-requests"],
    enabled: !!selectedProjectId && !!gitStatus?.connected && !!gitStatus?.tokenAvailable,
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${selectedProjectId}/git/connect`, {
        provider,
        repoUrl,
        token,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Repository connected", description: `${data.branchCount} branches found on ${data.provider}` });
      setConnectDialogOpen(false);
      setToken("");
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "git"] });
    },
    onError: (err: Error) => {
      toast({ title: "Connection failed", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/projects/${selectedProjectId}/git/disconnect`);
    },
    onSuccess: () => {
      toast({ title: "Repository disconnected" });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", selectedProjectId, "git"] });
    },
  });

  const appendLog = useCallback((event: SSEEvent) => {
    setAnalysisLog((prev) => [...prev, event]);
    setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const runBranchAnalysis = useCallback(async (branch: string) => {
    if (!selectedProjectId) return;
    setAnalyzing(true);
    setAnalysisLog([]);
    setAnalysisResult(null);

    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/analyze-branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response body");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const event: SSEEvent = JSON.parse(payload);
              appendLog(event);
              if (event.result) setAnalysisResult(event.result);
            } catch {}
          }
        }
      }

      toast({ title: "Branch analysis complete" });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  }, [selectedProjectId, appendLog, toast]);

  const runPRAnalysis = useCallback(async (prNumber: number) => {
    if (!selectedProjectId) return;
    setAnalyzing(true);
    setAnalysisLog([]);
    setAnalysisResult(null);

    try {
      const res = await fetch(`/api/projects/${selectedProjectId}/analyze-pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prNumber }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response body");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const event: SSEEvent = JSON.parse(payload);
              appendLog(event);
              if (event.result) setAnalysisResult(event.result);
            } catch {}
          }
        }
      }

      toast({ title: "PR analysis complete" });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
    } catch (err: any) {
      toast({ title: "PR analysis failed", description: err.message, variant: "destructive" });
    } finally {
      setAnalyzing(false);
    }
  }, [selectedProjectId, appendLog, toast]);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">Git Integration</h1>
        <p className="text-muted-foreground">Connect repositories, analyze branches, and review PR security impact</p>
      </div>

      <div className="flex items-center gap-4">
        <div className="w-72">
          <Label>Project</Label>
          {loadingProjects ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              value={selectedProjectId?.toString() || ""}
              onValueChange={(v) => {
                setSelectedProjectId(parseInt(v));
                setAnalysisLog([]);
                setAnalysisResult(null);
              }}
            >
              <SelectTrigger data-testid="select-project">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects?.map((p) => (
                  <SelectItem key={p.id} value={p.id.toString()} data-testid={`select-project-${p.id}`}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {selectedProjectId && gitStatus && (
          <div className="flex items-center gap-2 pt-5">
            {gitStatus.connected ? (
              <>
                <Badge variant="default" className="bg-green-600" data-testid="badge-git-connected">
                  {gitStatus.provider === "github" ? <SiGithub className="h-3 w-3 mr-1" /> : <SiGitlab className="h-3 w-3 mr-1" />}
                  Connected
                </Badge>
                {!gitStatus.tokenAvailable && (
                  <Badge variant="destructive" data-testid="badge-token-expired">
                    <AlertTriangle className="h-3 w-3 mr-1" />Token expired
                  </Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConnectDialogOpen(true)}
                  data-testid="button-reconnect"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />Reconnect
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  data-testid="button-disconnect"
                >
                  <Unlink className="h-3 w-3 mr-1" />Disconnect
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setConnectDialogOpen(true)}
                data-testid="button-connect-repo"
              >
                <Link2 className="h-4 w-4 mr-2" />Connect Repository
              </Button>
            )}
          </div>
        )}
      </div>

      {selectedProjectId && gitStatus?.connected && gitStatus?.tokenAvailable && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GitBranch className="h-5 w-5" />
                Branches
              </CardTitle>
              <CardDescription>
                {gitStatus.repoUrl}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingBranches ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
                </div>
              ) : branches && branches.length > 0 ? (
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {branches.map((branch) => (
                    <div
                      key={branch.name}
                      className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                      data-testid={`branch-${branch.name}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
                        <span className="font-mono text-sm truncate">{branch.name}</span>
                        {branch.isDefault && (
                          <Badge variant="secondary" className="shrink-0">default</Badge>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runBranchAnalysis(branch.name)}
                        disabled={analyzing}
                        data-testid={`button-analyze-branch-${branch.name}`}
                      >
                        {analyzing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />}
                        Analyze
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No branches found</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GitPullRequestIcon className="h-5 w-5" />
                Pull Requests
              </CardTitle>
              <CardDescription>
                Open {gitStatus.provider === "gitlab" ? "merge requests" : "pull requests"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingPRs ? (
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
                </div>
              ) : pullRequests && pullRequests.length > 0 ? (
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {pullRequests.map((pr) => (
                    <div
                      key={pr.id}
                      className="p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                      data-testid={`pr-${pr.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <PRStateBadge state={pr.state} />
                            <span className="text-sm font-medium truncate">#{pr.id}</span>
                          </div>
                          <p className="text-sm font-medium mt-1 truncate">{pr.title}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            <span className="font-mono">{pr.sourceBranch}</span>
                            {" → "}
                            <span className="font-mono">{pr.targetBranch}</span>
                            {" · "}
                            {pr.author}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="sm"
                            onClick={() => runPRAnalysis(pr.id)}
                            disabled={analyzing}
                            data-testid={`button-analyze-pr-${pr.id}`}
                          >
                            {analyzing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Shield className="h-3 w-3 mr-1" />}
                            Analyze
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            asChild
                          >
                            <a href={pr.url} target="_blank" rel="noopener noreferrer" data-testid={`link-pr-${pr.id}`}>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No open pull requests</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {analysisLog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {analyzing ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5 text-green-600" />}
              Analysis Log
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted/50 rounded-lg p-4 font-mono text-xs space-y-1 max-h-[300px] overflow-y-auto" data-testid="analysis-log">
              {analysisLog.map((event, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-muted-foreground shrink-0 w-32 truncate">[{event.step}]</span>
                  <span>{event.detail}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </CardContent>
        </Card>
      )}

      {analysisResult && !analyzing && (
        <PRAnalysisResultCard result={analysisResult} />
      )}

      <Dialog open={connectDialogOpen} onOpenChange={setConnectDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Git Repository</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Provider</Label>
              <div className="flex gap-2 mt-1">
                <Button
                  variant={provider === "github" ? "default" : "outline"}
                  onClick={() => setProvider("github")}
                  className="flex-1"
                  data-testid="button-provider-github"
                >
                  <SiGithub className="h-4 w-4 mr-2" />GitHub
                </Button>
                <Button
                  variant={provider === "gitlab" ? "default" : "outline"}
                  onClick={() => setProvider("gitlab")}
                  className="flex-1"
                  data-testid="button-provider-gitlab"
                >
                  <SiGitlab className="h-4 w-4 mr-2" />GitLab
                </Button>
              </div>
            </div>
            <div>
              <Label htmlFor="repo-url">Repository URL</Label>
              <Input
                id="repo-url"
                placeholder={provider === "github" ? "https://github.com/owner/repo" : "https://gitlab.com/owner/repo"}
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                data-testid="input-repo-url"
              />
            </div>
            <div>
              <Label htmlFor="token">Personal Access Token</Label>
              <Input
                id="token"
                type="password"
                placeholder={provider === "github" ? "ghp_..." : "glpat-..."}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                data-testid="input-token"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {provider === "github"
                  ? "Requires repo scope. Generate at GitHub Settings → Developer Settings → Personal access tokens."
                  : "Requires read_repository scope. Generate at GitLab Settings → Access Tokens."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConnectDialogOpen(false)} data-testid="button-cancel-connect">
              Cancel
            </Button>
            <Button
              onClick={() => connectMutation.mutate()}
              disabled={!repoUrl || !token || connectMutation.isPending}
              data-testid="button-submit-connect"
            >
              {connectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Link2 className="h-4 w-4 mr-2" />}
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PRStateBadge({ state }: { state: "open" | "closed" | "merged" }) {
  if (state === "open") return <Badge variant="default" className="bg-green-600 text-xs"><GitPullRequestIcon className="h-3 w-3 mr-1" />Open</Badge>;
  if (state === "merged") return <Badge variant="secondary" className="text-xs"><GitMerge className="h-3 w-3 mr-1" />Merged</Badge>;
  return <Badge variant="outline" className="text-xs"><XCircle className="h-3 w-3 mr-1" />Closed</Badge>;
}

function PRAnalysisResultCard({ result }: { result: any }) {
  if (result.pullRequest) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            PR Security Report: #{result.pullRequest.id} — {result.pullRequest.title}
          </CardTitle>
          <CardDescription>
            {result.pullRequest.sourceBranch} → {result.pullRequest.targetBranch}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatBox label="Base Entries" value={result.baseResult?.catalogEntries || 0} />
            <StatBox label="Head Entries" value={result.headResult?.catalogEntries || 0} />
            <StatBox label="Base Endpoints" value={result.baseResult?.endpoints || 0} />
            <StatBox label="Head Endpoints" value={result.headResult?.endpoints || 0} />
          </div>

          {result.changedFiles && result.changedFiles.length > 0 && (
            <>
              <Separator />
              <div>
                <h3 className="text-sm font-semibold mb-2">Changed Files ({result.changedFiles.length})</h3>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {result.changedFiles.map((f: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs font-mono">
                      <FileStatusBadge status={f.status} />
                      <span className="truncate">{f.filePath}</span>
                      <span className="text-muted-foreground ml-auto">+{f.additions} -{f.deletions}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {result.diff && (
            <>
              <Separator />
              <DiffSummary diff={result.diff} />
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          Branch Analysis Complete
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatBox label="Catalog Entries" value={result.catalogEntries || 0} />
          <StatBox label="Endpoints" value={result.totalEndpoints || 0} />
          <StatBox label="Interactions" value={result.totalInteractions || 0} />
          <StatBox label="Entities" value={result.totalEntities || 0} />
        </div>
        {result.cacheStatus && (
          <p className="text-xs text-muted-foreground mt-3">Cache: {result.cacheStatus}</p>
        )}
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function FileStatusBadge({ status }: { status: string }) {
  if (status === "added") return <span className="text-green-600 w-4 text-center">A</span>;
  if (status === "removed") return <span className="text-red-600 w-4 text-center">D</span>;
  if (status === "renamed") return <span className="text-blue-600 w-4 text-center">R</span>;
  return <span className="text-yellow-600 w-4 text-center">M</span>;
}

function DiffSummary({ diff }: { diff: any }) {
  const s = diff.summary;
  if (!s) return null;

  const securityLevel = s.securityImpactLevel || "none";
  const securityColors: Record<string, string> = {
    none: "text-muted-foreground",
    low: "text-blue-600",
    medium: "text-yellow-600",
    high: "text-orange-600",
    critical: "text-red-600",
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        Manifest Diff Summary
        <Badge variant={securityLevel === "none" || securityLevel === "low" ? "secondary" : "destructive"} data-testid="badge-diff-impact">
          Security Impact: {securityLevel.toUpperCase()}
        </Badge>
      </h3>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
        <DiffStatItem label="Endpoints" added={s.endpointsAdded} removed={s.endpointsRemoved} modified={s.endpointsModified} />
        <DiffStatItem label="Screens" added={s.screensAdded} removed={s.screensRemoved} modified={s.screensModified} />
        <DiffStatItem label="Roles" added={s.rolesAdded} removed={s.rolesRemoved} />
        <DiffStatItem label="Entities" added={s.entitiesAdded} removed={s.entitiesRemoved} />
        <div className="rounded border p-2">
          <p className="font-medium">Security</p>
          <p className={securityColors[securityLevel]}>
            {diff.security?.newUnprotectedEndpoints?.length || 0} unprotected,{" "}
            {diff.security?.removedProtections?.length || 0} deprotected,{" "}
            {diff.security?.criticalityIncreases?.length || 0} criticality↑
          </p>
        </div>
      </div>
    </div>
  );
}

function DiffStatItem({ label, added = 0, removed = 0, modified = 0 }: {
  label: string;
  added?: number;
  removed?: number;
  modified?: number;
}) {
  return (
    <div className="rounded border p-2">
      <p className="font-medium">{label}</p>
      <p>
        {added > 0 && <span className="text-green-600">+{added} </span>}
        {removed > 0 && <span className="text-red-600">-{removed} </span>}
        {modified > 0 && <span className="text-yellow-600">~{modified}</span>}
        {added === 0 && removed === 0 && modified === 0 && <span className="text-muted-foreground">No changes</span>}
      </p>
    </div>
  );
}

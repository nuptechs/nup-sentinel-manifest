import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Search,
  Filter,
  Download,
  Play,
  FileSearch,
  Edit3,
  Eye,
  AlertTriangle,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import type { CatalogEntry, Project } from "@shared/schema";

function OperationBadge({ operation }: { operation: string | null }) {
  if (!operation) return <Badge variant="secondary">Unknown</Badge>;
  const colorMap: Record<string, string> = {
    READ: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    WRITE: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
    DELETE: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    STATE_CHANGE: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    FILE_IO: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
    EXTERNAL_INTEGRATION: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    NAVIGATION: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
    AUTHENTICATION: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ${colorMap[operation] || "bg-muted text-muted-foreground"}`}>
      {operation}
    </span>
  );
}

function CriticalityIndicator({ score }: { score: number | null }) {
  if (score === null || score === undefined) return <span className="text-muted-foreground text-xs">--</span>;
  let Icon = ShieldCheck;
  let colorClass = "text-green-600 dark:text-green-400";
  if (score >= 70) {
    Icon = ShieldAlert;
    colorClass = "text-red-500";
  } else if (score >= 40) {
    Icon = Shield;
    colorClass = "text-amber-500";
  }
  return (
    <div className="flex items-center gap-1.5">
      <Icon className={`h-3.5 w-3.5 ${colorClass}`} />
      <span className={`text-sm font-medium ${colorClass}`}>{score}</span>
    </div>
  );
}

function EntryDetailDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: CatalogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [humanClassification, setHumanClassification] = useState(
    entry?.humanClassification || ""
  );

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!entry) return;
      await apiRequest("PATCH", `/api/catalog-entries/${entry.id}`, {
        humanClassification,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/catalog-entries"] });
      toast({ title: "Entry updated", description: "Human classification saved." });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });

  if (!entry) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Catalog Entry Detail</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Screen</Label>
              <p className="text-sm font-medium mt-0.5" data-testid="text-detail-screen">{entry.screen}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Interaction</Label>
              <p className="text-sm font-medium mt-0.5" data-testid="text-detail-interaction">{entry.interaction}</p>
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Endpoint</Label>
              <p className="text-sm font-mono mt-0.5" data-testid="text-detail-endpoint">
                <Badge variant="outline" className="mr-1.5 text-xs">
                  {entry.httpMethod || "?"}
                </Badge>
                {entry.endpoint || "N/A"}
              </p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Technical Operation</Label>
              <div className="mt-1">
                <OperationBadge operation={entry.technicalOperation} />
              </div>
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Controller</Label>
              <p className="text-sm font-mono mt-0.5">{entry.controllerClass || "N/A"}</p>
              <p className="text-xs text-muted-foreground">{entry.controllerMethod || ""}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Criticality</Label>
              <div className="mt-1">
                <CriticalityIndicator score={entry.criticalityScore} />
              </div>
            </div>
          </div>
          <Separator />
          <div>
            <Label className="text-xs text-muted-foreground">Full Call Chain</Label>
            <div className="mt-1 space-y-0.5" data-testid="text-detail-call-chain">
              {(entry.fullCallChain as string[] || []).length > 0
                ? (entry.fullCallChain as string[]).map((step, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs font-mono">
                      <span className="text-muted-foreground select-none">{i === 0 ? "" : "\u2514\u2500"}</span>
                      <span className={
                        step.includes("Repository") || step.includes("Repo")
                          ? "text-amber-600 dark:text-amber-400"
                          : step.includes("Controller")
                          ? "text-blue-600 dark:text-blue-400"
                          : "text-foreground"
                      }>
                        {step}
                      </span>
                    </div>
                  ))
                : <span className="text-xs text-muted-foreground">No call chain traced</span>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Persistence Operations</Label>
              <div className="flex flex-wrap gap-1 mt-1" data-testid="text-detail-persistence-ops">
                {(entry.persistenceOperations as string[] || []).length > 0
                  ? (entry.persistenceOperations as string[]).map((op, i) => (
                      <Badge key={i} variant="secondary" className="text-xs font-mono">
                        {op}
                      </Badge>
                    ))
                  : <span className="text-xs text-muted-foreground">None</span>}
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Entities Touched</Label>
              <div className="flex flex-wrap gap-1 mt-1">
                {(entry.entitiesTouched as string[] || []).length > 0
                  ? (entry.entitiesTouched as string[]).map((e, i) => (
                      <Badge key={i} variant="outline" className="text-xs font-mono">
                        {e}
                      </Badge>
                    ))
                  : <span className="text-xs text-muted-foreground">None detected</span>}
              </div>
            </div>
          </div>
          <Separator />
          <div>
            <Label className="text-xs text-muted-foreground">Suggested Meaning (AI)</Label>
            <p className="text-sm mt-0.5">{entry.suggestedMeaning || "Not classified"}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="human-class">Human Classification</Label>
            <Textarea
              id="human-class"
              value={humanClassification}
              onChange={(e) => setHumanClassification(e.target.value)}
              placeholder="Enter your classification or permission description..."
              className="resize-none"
              data-testid="input-human-classification"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => updateMutation.mutate()}
            disabled={updateMutation.isPending}
            data-testid="button-save-classification"
          >
            {updateMutation.isPending ? "Saving..." : "Save Classification"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function CatalogPage() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const projectIdParam = params.get("projectId");
  const { toast } = useToast();

  const [searchTerm, setSearchTerm] = useState("");
  const [filterOp, setFilterOp] = useState<string>("all");
  const [selectedEntry, setSelectedEntry] = useState<CatalogEntry | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const { data: projects, isLoading: loadingProjects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    projectIdParam || ""
  );

  const { data: entries, isLoading: loadingEntries } = useQuery<CatalogEntry[]>({
    queryKey: ["/api/catalog-entries", selectedProjectId],
    enabled: !!selectedProjectId,
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${selectedProjectId}/analyze`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/catalog-entries", selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analysis-runs/recent"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      toast({ title: "Analysis complete", description: "Catalog has been generated." });
    },
    onError: (error: Error) => {
      toast({ title: "Analysis failed", description: error.message, variant: "destructive" });
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", `/api/catalog-entries/${selectedProjectId}/export`);
      return res.json();
    },
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `catalog-project-${selectedProjectId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (error: Error) => {
      toast({ title: "Export failed", description: error.message, variant: "destructive" });
    },
  });

  const filteredEntries = useMemo(() => {
    if (!entries) return [];
    return entries.filter((entry) => {
      const matchesSearch =
        !searchTerm ||
        entry.screen.toLowerCase().includes(searchTerm.toLowerCase()) ||
        entry.interaction.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (entry.endpoint || "").toLowerCase().includes(searchTerm.toLowerCase());
      const matchesFilter =
        filterOp === "all" || entry.technicalOperation === filterOp;
      return matchesSearch && matchesFilter;
    });
  }, [entries, searchTerm, filterOp]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-catalog-title">
            Action Catalog
          </h1>
          <p className="text-muted-foreground mt-1">
            Technical action catalog for IAM classification
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => analyzeMutation.mutate()}
            disabled={!selectedProjectId || analyzeMutation.isPending}
            data-testid="button-run-analysis"
          >
            {analyzeMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 mr-1.5" />
                Run Analysis
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => exportMutation.mutate()}
            disabled={!selectedProjectId || !entries?.length}
            data-testid="button-export"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export JSON
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="w-60">
              <Select
                value={selectedProjectId}
                onValueChange={setSelectedProjectId}
              >
                <SelectTrigger data-testid="select-project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {(projects || []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search interactions, endpoints..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
                data-testid="input-search-catalog"
              />
            </div>
            <div className="w-48">
              <Select value={filterOp} onValueChange={setFilterOp}>
                <SelectTrigger data-testid="select-filter-operation">
                  <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                  <SelectValue placeholder="All Operations" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Operations</SelectItem>
                  <SelectItem value="READ">READ</SelectItem>
                  <SelectItem value="WRITE">WRITE</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                  <SelectItem value="STATE_CHANGE">STATE_CHANGE</SelectItem>
                  <SelectItem value="FILE_IO">FILE_IO</SelectItem>
                  <SelectItem value="EXTERNAL_INTEGRATION">EXTERNAL_INTEGRATION</SelectItem>
                  <SelectItem value="NAVIGATION">NAVIGATION</SelectItem>
                  <SelectItem value="AUTHENTICATION">AUTHENTICATION</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loadingEntries ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !selectedProjectId ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileSearch className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-sm text-muted-foreground">Select a project to view its catalog</p>
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-sm text-muted-foreground">
                {entries?.length
                  ? "No entries match your search"
                  : "No catalog entries yet. Run an analysis to generate the catalog."}
              </p>
              {!entries?.length && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => analyzeMutation.mutate()}
                  disabled={analyzeMutation.isPending}
                  data-testid="button-run-first-analysis"
                >
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  Run Analysis
                </Button>
              )}
            </div>
          ) : (
            <ScrollArea className="w-full">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[120px]">Screen</TableHead>
                    <TableHead className="min-w-[160px]">Interaction</TableHead>
                    <TableHead className="min-w-[180px]">Endpoint</TableHead>
                    <TableHead className="min-w-[100px]">Entities</TableHead>
                    <TableHead className="min-w-[120px]">Operation</TableHead>
                    <TableHead className="min-w-[80px]">Risk</TableHead>
                    <TableHead className="min-w-[150px]">Suggested Meaning</TableHead>
                    <TableHead className="w-[80px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredEntries.map((entry) => (
                    <TableRow key={entry.id} data-testid={`row-entry-${entry.id}`}>
                      <TableCell className="text-sm font-medium">
                        {entry.screen}
                      </TableCell>
                      <TableCell className="text-sm">{entry.interaction}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1 text-xs font-mono">
                          {entry.httpMethod && (
                            <Badge variant="outline" className="text-xs shrink-0">
                              {entry.httpMethod}
                            </Badge>
                          )}
                          <span className="truncate max-w-[120px]">
                            {entry.endpoint || "--"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-0.5">
                          {(entry.entitiesTouched as string[] || []).slice(0, 2).map((e, i) => (
                            <Badge key={i} variant="outline" className="text-xs">
                              {e}
                            </Badge>
                          ))}
                          {(entry.entitiesTouched as string[] || []).length > 2 && (
                            <Badge variant="secondary" className="text-xs">
                              +{(entry.entitiesTouched as string[]).length - 2}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <OperationBadge operation={entry.technicalOperation} />
                      </TableCell>
                      <TableCell>
                        <CriticalityIndicator score={entry.criticalityScore} />
                      </TableCell>
                      <TableCell>
                        <p className="text-xs text-muted-foreground truncate max-w-[130px]">
                          {entry.suggestedMeaning || "--"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              setSelectedEntry(entry);
                              setDetailOpen(true);
                            }}
                            data-testid={`button-view-entry-${entry.id}`}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <EntryDetailDialog
        entry={selectedEntry}
        open={detailOpen}
        onOpenChange={setDetailOpen}
      />
    </div>
  );
}

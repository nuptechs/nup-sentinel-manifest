import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Key, Plus, Trash2, ExternalLink, Copy, Settings } from "lucide-react";

interface ApiKeyItem {
  id: number;
  name: string;
  prefix: string;
  projectScope: number | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Project {
  id: number;
  name: string;
}

export default function SettingsPage() {
  const { toast } = useToast();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyProjectScope, setKeyProjectScope] = useState<string>("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [deleteKeyId, setDeleteKeyId] = useState<number | null>(null);

  const { data: apiKeys, isLoading: loadingKeys } = useQuery<ApiKeyItem[]>({
    queryKey: ["/api/keys"],
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: { name: string; projectScope?: number } = { name: keyName };
      if (keyProjectScope && keyProjectScope !== "none") {
        body.projectScope = parseInt(keyProjectScope);
      }
      const res = await apiRequest("POST", "/api/keys", body);
      return res.json();
    },
    onSuccess: (data) => {
      setCreatedKey(data.key);
      setKeyName("");
      setKeyProjectScope("");
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
      toast({ title: "API key created", description: "Store this key securely." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create key", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/keys/${id}`);
    },
    onSuccess: () => {
      setDeleteKeyId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
      toast({ title: "API key revoked" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete key", description: err.message, variant: "destructive" });
    },
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "Never";
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const getProjectName = (scopeId: number | null) => {
    if (!scopeId || !projects) return null;
    const p = projects.find((proj) => proj.id === scopeId);
    return p?.name || `Project #${scopeId}`;
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-page-title">Settings</h1>
          <p className="text-muted-foreground">Manage API keys and configuration</p>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              API Keys
            </CardTitle>
            <CardDescription>Manage keys for programmatic access to the API</CardDescription>
          </div>
          <Button
            onClick={() => {
              setCreatedKey(null);
              setKeyName("");
              setKeyProjectScope("");
              setCreateDialogOpen(true);
            }}
            data-testid="button-create-api-key"
          >
            <Plus className="h-4 w-4 mr-2" />
            Create API Key
          </Button>
        </CardHeader>
        <CardContent>
          {loadingKeys ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : apiKeys && apiKeys.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key Prefix</TableHead>
                  <TableHead>Project Scope</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead className="w-[60px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((key) => (
                  <TableRow key={key.id} data-testid={`row-api-key-${key.id}`}>
                    <TableCell className="font-medium" data-testid={`text-key-name-${key.id}`}>
                      {key.name}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded" data-testid={`text-key-prefix-${key.id}`}>
                        {key.prefix}...
                      </code>
                    </TableCell>
                    <TableCell data-testid={`text-key-scope-${key.id}`}>
                      {key.projectScope ? (
                        <Badge variant="secondary">{getProjectName(key.projectScope)}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">All projects</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-key-created-${key.id}`}>
                      {formatDate(key.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground" data-testid={`text-key-last-used-${key.id}`}>
                      {formatDate(key.lastUsedAt)}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => setDeleteKeyId(key.id)}
                        data-testid={`button-delete-key-${key.id}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-no-keys">
              <Key className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No API keys yet. Create one to get started.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ExternalLink className="h-5 w-5" />
            API Documentation
          </CardTitle>
          <CardDescription>
            Explore the full API reference with interactive examples
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild data-testid="link-api-docs">
            <a href="/api/docs" target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4 mr-2" />
              Open API Documentation
            </a>
          </Button>
        </CardContent>
      </Card>

      <Dialog open={createDialogOpen} onOpenChange={(open) => {
        if (!open) {
          setCreatedKey(null);
        }
        setCreateDialogOpen(open);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
            <DialogDescription>
              Generate a new key for programmatic API access
            </DialogDescription>
          </DialogHeader>
          {createdKey ? (
            <div className="space-y-4 py-2">
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4">
                <p className="text-sm font-medium text-destructive mb-2">
                  Store this key securely — it will not be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={createdKey}
                    readOnly
                    className="font-mono text-xs"
                    data-testid="input-created-key"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => copyToClipboard(createdKey)}
                    data-testid="button-copy-key"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={() => setCreateDialogOpen(false)} data-testid="button-done-key">
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <div>
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  placeholder="e.g. CI/CD Pipeline"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  data-testid="input-key-name"
                />
              </div>
              <div>
                <Label htmlFor="key-scope">Project Scope (optional)</Label>
                <Select value={keyProjectScope} onValueChange={setKeyProjectScope}>
                  <SelectTrigger data-testid="select-key-scope">
                    <SelectValue placeholder="All projects" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">All projects</SelectItem>
                    {projects?.map((p) => (
                      <SelectItem key={p.id} value={p.id.toString()} data-testid={`select-scope-${p.id}`}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setCreateDialogOpen(false)}
                  data-testid="button-cancel-key"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={!keyName.trim() || createMutation.isPending}
                  data-testid="button-submit-key"
                >
                  {createMutation.isPending ? "Creating..." : "Create Key"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteKeyId !== null} onOpenChange={(open) => !open && setDeleteKeyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Any integrations using this key will stop working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteKeyId && deleteMutation.mutate(deleteKeyId)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Revoking..." : "Revoke Key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * Convention Profile — página de REVISÃO do Perfilador (ADR-0020 r2 Onda 5).
 *
 * O dono aprova regra a regra: lista o perfil do projeto (manual + minerado +
 * IA), remove regra (PUT do restante), re-minera (POST /mine apply) e pede
 * hipóteses de IA (POST /hypothesize apply). Toda ação devolve o relatório do
 * GATE (admitidas com contagens / rejeitadas com razão) — a mesma verdade
 * mecânica da API, nunca uma versão maquiada.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Ruler, Trash2, Pickaxe, Sparkles, RefreshCw } from "lucide-react";

interface Project { id: number; name: string }

interface ConventionRule {
  id: string;
  claim: string;
  kind: string;
  pattern: string;
  fileGlob?: string;
  minSites?: number;
  endpoint?: { pathTemplate: string; httpMethod?: string };
}

interface ProfileResponse {
  projectId: number;
  mode: "off" | "shadow" | "on";
  conventionProfile: { version: 1; rules: ConventionRule[]; source?: string; updatedAt?: string } | null;
}

interface VerificationView {
  admitted: { ruleId: string; sites?: number; distinctFiles?: number; claim?: string }[];
  rejected: { ruleId: string; reason: string }[];
}

const KIND_BADGE: Record<string, string> = {
  endpoint: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  "layer-suffix": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  persistence: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  naming: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
};

function sourceOf(ruleId: string): string {
  if (ruleId.startsWith("ai-")) return "IA";
  if (ruleId.startsWith("mined-")) return "estatística";
  return "manual";
}

export default function ConventionsPage() {
  const { toast } = useToast();
  const [projectId, setProjectId] = useState<string>("");
  const [lastVerification, setLastVerification] = useState<VerificationView | null>(null);

  const { data: projects } = useQuery<Project[]>({ queryKey: ["/api/projects"] });

  const profileKey = [`/api/projects/${projectId}/convention-profile`];
  const { data: profile, isLoading } = useQuery<ProfileResponse>({
    queryKey: profileKey,
    enabled: !!projectId,
  });

  const rules = profile?.conventionProfile?.rules ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: profileKey });

  const putProfile = useMutation({
    mutationFn: async (nextRules: ConventionRule[]) => {
      const body = nextRules.length
        ? { conventionProfile: { ...profile!.conventionProfile, version: 1, rules: nextRules } }
        : { conventionProfile: null };
      const res = await apiRequest("PUT", `/api/projects/${projectId}/convention-profile`, body);
      return res.json();
    },
    onSuccess: (d) => {
      if (d?.verification) setLastVerification(d.verification);
      invalidate();
      toast({ title: "Perfil atualizado", description: "O gate re-verificou as regras restantes." });
    },
    onError: (e: Error) => toast({ title: "Falha ao atualizar", description: e.message, variant: "destructive" }),
  });

  const mine = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/convention-profile/mine`, { apply: true });
      return res.json();
    },
    onSuccess: (d) => {
      setLastVerification(d?.verification ?? null);
      invalidate();
      toast({
        title: "Mineração estatística",
        description: `${d?.verification?.admitted?.length ?? 0} regra(s) admitida(s) pelo gate.`,
      });
    },
    onError: (e: Error) => toast({ title: "Falha na mineração", description: e.message, variant: "destructive" }),
  });

  const hypothesize = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/convention-profile/hypothesize`, { apply: true });
      return res.json();
    },
    onSuccess: (d) => {
      if (d?.skipped) {
        toast({ title: "IA indisponível", description: `Motivo: ${d.reason} — o perfil segue só-estatístico.` });
        return;
      }
      setLastVerification(d?.verification ?? null);
      invalidate();
      toast({
        title: "Hipóteses de IA",
        description: `${d?.proposedByLlm ?? 0} proposta(s); ${d?.verification?.admitted?.length ?? 0} sobreviveram ao gate.`,
      });
    },
    onError: (e: Error) => toast({ title: "Falha nas hipóteses", description: e.message, variant: "destructive" }),
  });

  const removeRule = (ruleId: string) => {
    putProfile.mutate(rules.filter((r) => r.id !== ruleId));
  };

  return (
    <div className="p-6 space-y-6" data-testid="conventions-page">
      <div className="flex items-center gap-3">
        <Ruler className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-semibold">Convention Profile</h1>
          <p className="text-sm text-muted-foreground">
            Regras de convenção do projeto — verificadas mecanicamente (gate D4): entram só com ≥N arquivos distintos.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Projeto</CardTitle>
          <CardDescription>
            Modo do perfilador: <Badge variant="outline">{profile?.mode ?? "…"}</Badge>{" "}
            {profile?.mode === "off" && "(off = a análise ignora o perfil — byte-a-byte)"}
            {profile?.mode === "shadow" && "(shadow = loga o que SERIA adicionado, não consome)"}
            {profile?.mode === "on" && "(on = endpoints do perfil entram ADITIVOS no grafo)"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Select value={projectId} onValueChange={(v) => { setProjectId(v); setLastVerification(null); }}>
            <SelectTrigger className="w-72" data-testid="select-project">
              <SelectValue placeholder="Selecione um projeto" />
            </SelectTrigger>
            <SelectContent>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>{p.name} (#{p.id})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={!projectId || mine.isPending} onClick={() => mine.mutate()} data-testid="button-mine">
            <Pickaxe className="h-4 w-4 mr-1" /> Minerar (estatística)
          </Button>
          <Button size="sm" variant="outline" disabled={!projectId || hypothesize.isPending} onClick={() => hypothesize.mutate()} data-testid="button-hypothesize">
            <Sparkles className="h-4 w-4 mr-1" /> Hipóteses (IA)
          </Button>
          <Button size="sm" variant="ghost" disabled={!projectId} onClick={() => invalidate()} data-testid="button-refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>

      {projectId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Regras do perfil {profile?.conventionProfile?.source ? (
                <span className="text-xs font-normal text-muted-foreground">· origem: {profile.conventionProfile.source}</span>
              ) : null}
            </CardTitle>
            <CardDescription>
              Remover uma regra re-verifica o restante pelo gate. Regra manual/curada nunca é sobrescrita por mineração/IA.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : rules.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="empty-profile">
                Sem perfil ainda — use “Minerar (estatística)” para o perfil nascer dos próprios arquivos do projeto.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Regra</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead>Claim</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => (
                    <TableRow key={r.id} data-testid={`rule-${r.id}`}>
                      <TableCell className="font-mono text-xs">{r.id}</TableCell>
                      <TableCell>
                        <span className={`px-2 py-0.5 rounded text-xs ${KIND_BADGE[r.kind] ?? KIND_BADGE.other}`}>{r.kind}</span>
                      </TableCell>
                      <TableCell className="text-xs">{sourceOf(r.id)}</TableCell>
                      <TableCell className="text-sm">{r.claim}</TableCell>
                      <TableCell>
                        <Button size="icon" variant="ghost" onClick={() => removeRule(r.id)} disabled={putProfile.isPending} data-testid={`remove-${r.id}`}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {lastVerification && (
        <Card data-testid="verification-card">
          <CardHeader>
            <CardTitle className="text-base">Último veredito do gate</CardTitle>
            <CardDescription>Admitidas com contagens medidas; rejeitadas com a razão — a verdade mecânica, sem maquiagem.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {lastVerification.admitted.map((a) => (
              <div key={a.ruleId} className="text-sm">
                <Badge className="mr-2">✓</Badge>
                <span className="font-mono text-xs mr-2">{a.ruleId}</span>
                {a.distinctFiles != null && <span className="text-muted-foreground">{a.distinctFiles} arquivos distintos</span>}
              </div>
            ))}
            {lastVerification.rejected.map((r) => (
              <div key={r.ruleId} className="text-sm">
                <Badge variant="destructive" className="mr-2">✕</Badge>
                <span className="font-mono text-xs mr-2">{r.ruleId}</span>
                <span className="text-muted-foreground">{r.reason}</span>
              </div>
            ))}
            {lastVerification.admitted.length === 0 && lastVerification.rejected.length === 0 && (
              <p className="text-sm text-muted-foreground">Sem itens no último veredito.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// DIAGRAMAS — a tela que VÊ os 8 diagramas UML gerados do grafo provado.
// Escolhe projeto + tipo (+ entrada/foco quando o tipo pede) e desenha o Mermaid
// que a API /reasoner/uml/:type devolve. Confiança por elemento vem embutida no
// próprio diagrama (seta cheia = provado/observado, tracejada = inferido).
// Regras da casa: Carregando ≠ vazio ≠ falhou; toda seção degrada isolada; nada
// é recalculado aqui — o desenho vem inteiro do endpoint.
// ─────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Check, RefreshCw, Workflow } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MermaidView } from "@/components/mermaid-view";

interface Project { id: number; name: string }
interface UmlModel { title?: string; notes?: string[]; stats?: Record<string, number>; source?: string }
// C4 responde no top-level (mermaid + dsl + stats + notes); UML aninha em model.
interface UmlResponse { type?: string; view?: string; model?: UmlModel; mermaid?: string; dsl?: string; stats?: Record<string, number>; notes?: string[]; entry?: { label?: string } }

export interface TypeMeta { type: string; label: string; q: string; needsEntry?: boolean; needsFocus?: boolean; family?: "uml" | "c4" }
// Regra PURA de endpoint (testável isolada): C4 vai p/ /reasoner/c4/:view; UML p/
// /reasoner/uml/:type, com o rótulo interno "uml_component" mapeado p/ "component"
// (evita colidir com a view C4 "component"). entry vira ?entry= ou ?focus=.
export function buildDiagramUrl(projectId: number, meta: TypeMeta, entry: string): string {
  const p = new URLSearchParams();
  if (entry && meta.needsEntry) p.set("entry", entry);
  if (entry && meta.needsFocus) p.set("focus", entry);
  const qs = p.toString();
  const suffix = qs ? `?${qs}` : "";
  if (meta.family === "c4") return `/api/projects/${projectId}/reasoner/c4/${meta.type}${suffix}`;
  const umlType = meta.type === "uml_component" ? "component" : meta.type;
  return `/api/projects/${projectId}/reasoner/uml/${umlType}${suffix}`;
}

export const TYPES: TypeMeta[] = [
  // ── C4 / Structurizr: UM modelo → N views (formato dominante 2025-26) ──
  { type: "container", label: "C4 · Contêineres", q: "Quais peças rodam e como conversam?", family: "c4" },
  { type: "context", label: "C4 · Contexto", q: "O sistema no mundo — quem usa?", family: "c4" },
  { type: "component", label: "C4 · Componentes", q: "Que módulos formam um contêiner?", family: "c4", needsFocus: true },
  { type: "landscape", label: "C4 · Paisagem", q: "Tudo junto — contêineres e módulos.", family: "c4" },
  // ── UML clássico (8 tipos), gerado do mesmo grafo provado ──
  { type: "usecase", label: "Caso de Uso", q: "O usuário faz o quê?" },
  { type: "activity", label: "Atividade", q: "Como o processo acontece?", needsEntry: true },
  { type: "sequence", label: "Sequência", q: "Quem chama quem e em que ordem?", needsEntry: true },
  { type: "class", label: "Classes", q: "Quais são as coisas e como se relacionam?", needsFocus: true },
  { type: "uml_component", label: "Componentes (UML)", q: "Quais partes formam o sistema?" },
  { type: "deployment", label: "Implantação", q: "Onde cada parte está instalada?" },
  { type: "state", label: "Estados", q: "Em que estado isso está e como muda?", needsFocus: true },
  { type: "package", label: "Pacotes", q: "Como organizar essas partes?" },
];

export default function DiagramsPage() {
  const projectsQuery = useQuery<Project[]>({ queryKey: ["/api/projects"] });
  const projects = projectsQuery.data;
  const [projectId, setProjectId] = useState<number | null>(null);
  const [type, setType] = useState<string>("container");
  const [entryDraft, setEntryDraft] = useState("");
  const [entry, setEntry] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (projectId == null && projects && projects.length > 0) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const meta = TYPES.find((t) => t.type === type)!;
  const needsInput = Boolean(meta.needsEntry || meta.needsFocus);

  // troca de tipo limpa a entrada
  useEffect(() => { setEntryDraft(""); setEntry(""); }, [type]);

  const url = useMemo(() => (projectId == null ? null : buildDiagramUrl(projectId, meta, entry)), [projectId, entry, meta]);

  // atividade/sequência EXIGEM entrada; classes/estados a entrada é opcional (foco)
  const enabled = projectId != null && url != null && !(meta.needsEntry && !entry);

  const diagram = useQuery<UmlResponse>({ queryKey: [url as string], enabled, retry: false });

  const [copiedDsl, setCopiedDsl] = useState(false);
  const copyText = async (text: string | undefined, mark: (v: boolean) => void) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      mark(true);
      setTimeout(() => mark(false), 1600);
    } catch { /* clipboard indisponível */ }
  };
  const copyMermaid = () => copyText(diagram.data?.mermaid, setCopied);

  const stats = diagram.data?.model?.stats ?? diagram.data?.stats;
  const notes = diagram.data?.model?.notes ?? diagram.data?.notes;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5 p-6">
      <div className="flex items-center gap-3">
        <Workflow className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Diagramas</h1>
          <p className="text-sm text-muted-foreground">C4/Structurizr (modelo único → N views) + os 8 UML, gerados do código provado — confiança por elemento (seta cheia = provado/observado, tracejada = inferido). O DSL do C4 é versionável em git.</p>
        </div>
      </div>

      {/* controles */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Projeto</label>
            <Select value={projectId != null ? String(projectId) : undefined} onValueChange={(v) => setProjectId(Number(v))}>
              <SelectTrigger className="w-56" data-testid="select-project"><SelectValue placeholder="Escolha o projeto" /></SelectTrigger>
              <SelectContent>
                {(projects || []).map((p) => (<SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Tipo de diagrama</label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-64" data-testid="select-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (<SelectItem key={t.type} value={t.type}>{t.label} — {t.q}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          {needsInput && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {meta.needsEntry ? "Funcionalidade (rota ou símbolo)" : meta.family === "c4" ? "Contêiner (foco do C4)" : "Foco (opcional — entidade/enum)"}
              </label>
              <div className="flex gap-2">
                <Input
                  className="w-64"
                  placeholder={meta.needsEntry ? "ex.: GET /api/users  ·  ContractService" : meta.family === "c4" ? "ex.: backend  ·  gateway  ·  frontend" : "ex.: Contract  ·  FinancialEntryStatus"}
                  value={entryDraft}
                  onChange={(e) => setEntryDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") setEntry(entryDraft.trim()); }}
                  data-testid="input-entry"
                />
                <Button variant="secondary" onClick={() => setEntry(entryDraft.trim())} data-testid="button-apply">Gerar</Button>
              </div>
            </div>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={() => diagram.refetch()} disabled={!enabled} data-testid="button-refresh">
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Atualizar
            </Button>
            <Button variant="outline" size="sm" onClick={copyMermaid} disabled={!diagram.data?.mermaid} data-testid="button-copy">
              {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />} {copied ? "Copiado" : "Copiar Mermaid"}
            </Button>
            {diagram.data?.dsl && (
              <Button variant="outline" size="sm" onClick={() => copyText(diagram.data?.dsl, setCopiedDsl)} data-testid="button-copy-dsl">
                {copiedDsl ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />} {copiedDsl ? "Copiado" : "Copiar DSL"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* diagrama */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">{diagram.data?.model?.title || meta.label}</CardTitle>
          {stats && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(stats).slice(0, 5).map(([k, v]) => (
                <Badge key={k} variant="secondary" className="font-mono text-[11px]">{k}: {v}</Badge>
              ))}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {meta.needsEntry && !entry ? (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="hint-entry">
              Este diagrama é por funcionalidade. Digite uma rota ou símbolo acima e clique <b>Gerar</b>.
            </div>
          ) : !enabled ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Escolha um projeto.</div>
          ) : diagram.isLoading ? (
            <div className="space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-64 w-full" /></div>
          ) : diagram.isError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive" data-testid="error-diagram">
              Falha ao gerar o diagrama. {(diagram.error as Error)?.message}
            </div>
          ) : diagram.data?.mermaid ? (
            <div className="space-y-4">
              <MermaidView code={diagram.data.mermaid} />
              {notes?.length ? (
                <ul className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
                  {notes.map((n, i) => (<li key={i}>• {n}</li>))}
                </ul>
              ) : null}
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground" data-testid="empty-diagram">
              Sem dados para desenhar. {notes?.[0] || "Rode uma análise deste projeto."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

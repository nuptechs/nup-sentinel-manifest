// ─────────────────────────────────────────────
// System Map — vista NARRATIVA + PERSPECTIVAS (ADR-0033 P4.4/P4.5).
//
// Surfaça no /system-map o que o endpoint `GET /api/projects/:id/narrative`
// já devolve: a narrativa TRAVADA AO GRAFO (só arestas verificadas, ponto-cego
// nomeado, abstenção honesta) e as PROJEÇÕES multi-perspectiva (dev/segurança/
// dados/arquiteto/negócio/impacto = FILTROS da MESMA espinha). O seletor de
// perspectiva chama `?perspective=` — uma verdade, N lentes.
//
// P4.5 (convergência com o laço ativo, ADR-0032 P3): as arestas REFUTADAS
// aparecem NOMEADAS (nunca como fato) e as promovidas a RUNTIME_OBSERVED sobem
// para a espinha PROVADA automaticamente (isso mora no backend; aqui só
// REVELAMOS). Reusa o encoding de evidência (`EVIDENCE`) — mesma cor/ícone/2º
// canal da legenda (WCAG 1.4.1).
//
// Estados explícitos: ocioso (sem símbolo) · carregando · erro · VAZIO (a
// narrativa se ABSTÉM — carregou, nada verificado ≠ falhou) · conteúdo.
// Degradação graciosa: campos ausentes (snapshot antigo) nunca crasham.
// ─────────────────────────────────────────────
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle,
  Search,
  BookOpen,
  ShieldOff,
  HelpCircle,
  Radar,
  ArrowRight,
  Info,
  ScrollText,
} from "lucide-react";
import { EVIDENCE, normalizeEvidenceMethod, type EvidenceMethod } from "./system-map-evidence";

// ── Tipos do payload /api/projects/:id/narrative ──────────────────────
export type Persona = "dev" | "security" | "data" | "architect" | "business" | "impact";

export interface NarrativeStatementDTO {
  kind: "partition" | "edge" | "blindspot" | "refuted" | "coverage" | "abstain" | string;
  text: string;
  edgeId?: string;
  method?: EvidenceMethod;
  origin?: "deterministic" | "llm" | string;
}
export interface NarrativeDTO {
  symbol: string;
  abstained: boolean;
  mode: string;
  statements: NarrativeStatementDTO[];
  prose: string;
  overallConfidence: number;
  overallMethod: EvidenceMethod;
  grounding?: { proposed: number; kept: number; discarded: number };
}
export interface NarrativeEdgeDTO {
  edgeId: string;
  fromLabel: string;
  toLabel: string;
  relationType: string;
  method: EvidenceMethod;
  provenance: string;
}
export interface RefutedEdgeDTO {
  edgeId: string;
  fromLabel: string;
  toLabel: string;
  relationType: string;
  method: EvidenceMethod;
  subtype: "REFUTED_LIKELY_DEAD" | "REFUTED_UNREACHABLE_BY_ROBOT" | string;
  attempts?: number;
  windows?: number;
  reason?: string;
  provenance: string;
}
export interface AdrLinkDTO {
  adrId: string;
  adrTitle: string;
  targetSymbol: string;
  sourceRef: string;
}
export interface PerspectiveDTO {
  persona: Persona;
  label: string;
  focus: string;
  edges: NarrativeEdgeDTO[];
  blindSpots?: { fromNode: string; toNode: string; relationType: string; reason: string }[];
  refutedEdges?: RefutedEdgeDTO[];
  adrLinks?: AdrLinkDTO[];
  empty: boolean;
  note?: string;
}
export interface NarrativeResponse {
  projectId: number;
  symbol: string;
  narrative: NarrativeDTO;
  perspectives: Partial<Record<Persona, PerspectiveDTO>>;
}

// ── Metadados de apresentação (pt-BR) — puros, testáveis ──────────────
export const PERSONA_OPTIONS: readonly { value: Persona; label: string }[] = [
  { value: "impact", label: "Impacto" },
  { value: "dev", label: "Desenvolvedor" },
  { value: "security", label: "Segurança" },
  { value: "data", label: "Dados" },
  { value: "architect", label: "Arquiteto" },
  { value: "business", label: "Negócio" },
] as const;

/** Escolhe a perspectiva pedida do payload, defensivamente (chave ausente → null). */
export function pickPerspective(
  perspectives: Partial<Record<Persona, PerspectiveDTO>> | null | undefined,
  persona: Persona,
): PerspectiveDTO | null {
  return (perspectives && perspectives[persona]) || null;
}

/** Rótulo + estilo do "tom" de cada frase da narrativa (proveniência da frase). */
export function statementMeta(kind: string): { label: string; className: string } {
  switch (kind) {
    case "partition":
      return { label: "Resumo", className: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300" };
    case "edge":
      return { label: "Fato", className: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" };
    case "blindspot":
      return { label: "Ponto-cego", className: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300" };
    case "refuted":
      return { label: "Refutada", className: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300" };
    case "abstain":
      return { label: "Abstenção", className: "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300" };
    case "coverage":
    default:
      return { label: "Censo", className: "border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400" };
  }
}

/** Grau honesto da refutação (ADR-0032 §4): morta-provável × UNKNOWN honesto. */
export function refutedMeta(subtype: string): { label: string; className: string } {
  return subtype === "REFUTED_LIKELY_DEAD"
    ? { label: "provável morta / falso-positivo", className: "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-300" }
    : { label: "não-confirmada pelo robô (UNKNOWN honesto)", className: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300" };
}

// ── Chip de método de evidência (reusa o encoding da legenda) ─────────
function MethodChip({ method }: { method?: EvidenceMethod }) {
  const m = normalizeEvidenceMethod(method);
  const meta = EVIDENCE[m];
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium"
      style={{ borderColor: meta.color, color: meta.color, opacity: meta.muted ? 0.85 : 1 }}
      title={meta.label}
      data-testid={`method-chip-${m}`}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

// ── A prosa travada ao grafo (statements) ─────────────────────────────
export function NarrativeProse({ narrative }: { narrative: NarrativeDTO }) {
  return (
    <div className="space-y-2" data-testid="narrative-prose">
      {narrative.statements.map((s, i) => {
        const meta = statementMeta(s.kind);
        return (
          <div key={i} className="flex items-start gap-2 text-sm" data-testid={`narrative-statement-${s.kind}`}>
            <span className={"mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " + meta.className}>
              {meta.label}
            </span>
            <span className="text-foreground">{s.text}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Um painel de PERSPECTIVA (VIEW da mesma espinha) — puro, testável ─
export function PerspectivePanel({ view }: { view: PerspectiveDTO }) {
  const refuted = view.refutedEdges ?? [];
  const blind = view.blindSpots ?? [];
  const adr = view.adrLinks ?? [];

  // Vazio ≠ falhou: carregou, nada casa esta lente — nota honesta, não erro.
  if (view.empty) {
    return (
      <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="perspective-empty">
        <Info className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
        {view.note || `Nada verificado sob a lente "${view.label}" (≠ falhou).`}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid={`perspective-${view.persona}`}>
      <p className="text-xs text-muted-foreground">{view.focus}</p>

      {view.edges.length > 0 && (
        <section data-testid="perspective-edges">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /> Arestas verificadas ({view.edges.length})
          </h4>
          <ul className="space-y-1.5">
            {view.edges.map((e) => (
              <li key={e.edgeId} className="flex flex-wrap items-center gap-2 text-sm" data-testid="perspective-edge">
                <span className="font-medium">{e.fromLabel}</span>
                <span className="text-muted-foreground">{e.relationType.toLowerCase().replace(/_/g, " ")}</span>
                <span className="font-medium">{e.toLabel}</span>
                <MethodChip method={e.method} />
                <span className="text-xs text-muted-foreground">{e.provenance}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {refuted.length > 0 && (
        <section data-testid="perspective-refuted">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
            <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" /> Refutadas pelo laço ativo ({refuted.length})
          </h4>
          <p className="mb-1.5 text-xs text-muted-foreground">
            O estático as desenhou; o robô dirigiu tráfego e NÃO as confirmou. Mostradas, nunca afirmadas como fato.
          </p>
          <ul className="space-y-1.5">
            {refuted.map((e) => {
              const g = refutedMeta(e.subtype);
              return (
                <li key={e.edgeId} className="flex flex-wrap items-center gap-2 text-sm" data-testid="perspective-refuted-edge">
                  <span className="font-medium line-through decoration-rose-400/70">{e.fromLabel}</span>
                  <span className="text-muted-foreground">{e.relationType.toLowerCase().replace(/_/g, " ")}</span>
                  <span className="font-medium line-through decoration-rose-400/70">{e.toLabel}</span>
                  <span className={"inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium " + g.className}>
                    {g.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{e.provenance}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {blind.length > 0 && (
        <section data-testid="perspective-blindspots">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" /> Pontos-cegos ({blind.length})
          </h4>
          <ul className="space-y-1 text-sm">
            {blind.slice(0, 8).map((b, i) => (
              <li key={i} className="text-muted-foreground">
                {b.fromNode.split(":").pop()} → {b.toNode.split(":").pop()} <span className="text-xs">({b.reason})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {adr.length > 0 && (
        <section data-testid="perspective-adr">
          <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ScrollText className="h-3.5 w-3.5" aria-hidden="true" /> Decisões que governam (ADR)
          </h4>
          <ul className="space-y-1 text-sm">
            {adr.map((l, i) => (
              <li key={i}>
                <span className="font-medium">{l.adrId}</span> {l.adrTitle}{" "}
                <code className="text-xs text-muted-foreground">{l.sourceRef}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── A vista completa (container com busca + seletor + estados) ────────
export function NarrativeView({ projectId }: { projectId: number }) {
  const [draft, setDraft] = useState("");
  const [symbol, setSymbol] = useState("");
  const [persona, setPersona] = useState<Persona>("impact");

  const url = useMemo(
    () =>
      symbol
        ? `/api/projects/${projectId}/narrative?symbol=${encodeURIComponent(symbol)}&perspective=${persona}`
        : null,
    [projectId, symbol, persona],
  );

  const query = useQuery<NarrativeResponse>({
    queryKey: url ? [url] : ["narrative-idle"],
    enabled: !!url,
    retry: false,
  });

  const view = pickPerspective(query.data?.perspectives, persona);

  return (
    <div className="flex flex-1 flex-col gap-4" data-testid="narrative-view">
      {/* Busca de símbolo + seletor de perspectiva */}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSymbol(draft.trim());
        }}
      >
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Símbolo (ex.: ContractService, Contract)"
            className="pl-8"
            aria-label="Símbolo para narrar"
            data-testid="input-narrative-symbol"
          />
        </div>
        <Select value={persona} onValueChange={(v) => setPersona(v as Persona)}>
          <SelectTrigger className="w-48" data-testid="select-perspective" aria-label="Perspectiva">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERSONA_OPTIONS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" className="gap-1.5" data-testid="button-narrate">
          <BookOpen className="h-4 w-4" /> Narrar
        </Button>
      </form>

      {/* Ocioso — nenhum símbolo ainda */}
      {!symbol && (
        <Card className="flex flex-1 items-center justify-center">
          <CardContent className="max-w-lg py-16 text-center text-sm text-muted-foreground">
            <BookOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" aria-hidden="true" />
            <p>
              Digite um símbolo e escolha uma perspectiva. A narrativa anda SÓ sobre arestas verificadas — o que está
              fora do mapa ela bloqueia (não inventa) e nomeia o ponto-cego. Cada perspectiva é a MESMA verdade sob uma lente.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Carregando */}
      {symbol && query.isLoading && (
        <div className="space-y-3" data-testid="narrative-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {/* Erro (≠ vazio) */}
      {symbol && query.isError && (
        <Card className="border-destructive/40" data-testid="narrative-error">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-5 w-5 text-destructive" /> Não foi possível narrar
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p>{(query.error as Error)?.message || "A narrativa não respondeu. Tente novamente."}</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Tentar novamente
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Conteúdo */}
      {symbol && query.data && (
        <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]" data-testid="narrative-content">
          {/* Coluna principal: perspectiva escolhida */}
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Radar className="h-4 w-4 text-primary" />
                <span data-testid="narrative-symbol">{query.data.symbol}</span>
                <span className="text-muted-foreground">·</span>
                <span>{view?.label || PERSONA_OPTIONS.find((p) => p.value === persona)?.label}</span>
                {query.data.narrative?.abstained && (
                  <Badge variant="outline" className="border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-400">
                    abstenção
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {view ? (
                <PerspectivePanel view={view} />
              ) : (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="perspective-missing">
                  <Info className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
                  Esta perspectiva não veio no payload (snapshot antigo). Reanalise o projeto.
                </div>
              )}
            </CardContent>
          </Card>

          {/* Coluna lateral: a prosa travada ao grafo */}
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Narrativa travada ao grafo</CardTitle>
            </CardHeader>
            <CardContent>
              {query.data.narrative ? (
                <NarrativeProse narrative={query.data.narrative} />
              ) : (
                <p className="text-sm text-muted-foreground">Sem narrativa neste snapshot.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

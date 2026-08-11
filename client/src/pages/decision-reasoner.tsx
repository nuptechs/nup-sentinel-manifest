// ─────────────────────────────────────────────
// Painel RACIOCÍNIO — a IA governada sobre o substrato provado, na tela.
//
// Consome os 4 endpoints do subsistema Reasoner (/reasoner/verdict, /dead-code,
// /domains, /runtime-gap) e os apresenta com a MESMA disciplina honesta do resto
// da Visão de Decisão: SectionCard (erro isolado + "não significa X"), NotKnown
// (vazio ≠ zero fabricado), SourceNote (procedência embaixo do número), e — o que
// diferencia esta camada — o LIVRO-RAZÃO DE GROUNDING exposto: quantos claims a IA
// propôs, quantos passaram no gate, quantos foram REJEITADOS por não citar uma
// âncora provada. A honestidade da IA vira um número na tela.
//
// Cards PUROS (recebem QueryLike) para teste sem I/O; `ReasonerPanel` faz as 4
// consultas e é montado na página. Cada card degrada sozinho.
// ─────────────────────────────────────────────
import { useQuery } from "@tanstack/react-query";
import { Brain, Skull, Boxes, Radar, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SectionCard, SourceNote, NotKnown, type QueryLike } from "./decision";

// ── Contratos (espelham a saída do server/reasoner/*) ─────────────────
interface GroundingLedger {
  proposed: number;
  kept: number;
  rejected: number;
  groundingRate: number;
}
export interface VerdictPayload {
  analysisRunId?: number;
  tier: "STRONG" | "MODERATE" | "WEAK";
  observedRatio: number;
  nodes: { observed: number; total: number };
  reasons: string[];
  explanation: string;
  mode: "deterministic" | "llm-grounded";
}
export interface DeadCodePayload {
  analysisRunId?: number;
  candidates: Array<{ nodeId: string; type: string; label: string; tier: string; confidence: number; question: string }>;
  excluded: { entryPoints: number; entrySurfaces: number; runtimeObserved: number; unreachableByRobot: number };
  grounding: GroundingLedger;
  mode: string;
  summary: string;
}
export interface DomainsPayload {
  analysisRunId?: number;
  domains: Array<{ id: string; name: string; size: number; byType: Record<string, number>; runtimeHot: number }>;
  seams: Array<{ from: string; to: string; edges: number }>;
  hubs: string[];
  grounding: GroundingLedger;
  mode: string;
  summary: string;
}
export interface RuntimeGapPayload {
  analysisRunId?: number;
  totalEntries: number;
  observedEntries: number;
  coverage: number;
  uncovered: Array<{ nodeId: string; type: string; label: string; reach: number; hint: string }>;
  grounding: GroundingLedger;
  mode: string;
  summary: string;
}

const pct = (x: number) => `${Math.round((x ?? 0) * 100)}%`;

/** A assinatura da IA: quantos claims propôs × passaram × foram rejeitados pelo gate. */
function GroundingNote({ g, mode, testId }: { g?: GroundingLedger; mode?: string; testId: string }) {
  if (!g || mode === "deterministic" || g.proposed === 0) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground" data-testid={testId}>
        modo determinístico — sem LLM (a leitura não depende de IA)
      </p>
    );
  }
  return (
    <p className="mt-2 text-[11px] text-muted-foreground" data-testid={testId}>
      grounding: IA propôs {g.proposed} · {g.kept} passaram no gate ·{" "}
      <span className={g.rejected > 0 ? "text-amber-600 dark:text-amber-400" : undefined}>{g.rejected} rejeitadas</span>{" "}
      (sem âncora provada) · taxa {pct(g.groundingRate)}
    </p>
  );
}

const TIER_STYLE: Record<VerdictPayload["tier"], { label: string; cls: string }> = {
  STRONG: { label: "FORTE", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
  MODERATE: { label: "MODERADA", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" },
  WEAK: { label: "FRACA", cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" },
};

// ── Veredito (a manchete) ─────────────────────────────────────────────
export function VerdictCard({ query }: { query: QueryLike<VerdictPayload> }) {
  const d = query.data;
  return (
    <SectionCard
      title="Confiança da leitura"
      icon={<Scale className="h-4 w-4 text-primary" />}
      hint="A convergência estático × runtime × config num veredito honesto."
      testId="reasoner-verdict"
      query={query}
      errorNote="que a leitura é forte"
    >
      {!d ? (
        <NotKnown testId="reasoner-verdict-empty">Sem veredito para este projeto.</NotKnown>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className={`rounded-md border px-2.5 py-1 text-sm font-semibold ${TIER_STYLE[d.tier].cls}`} data-testid="reasoner-verdict-tier">
              {TIER_STYLE[d.tier].label}
            </span>
            <span className="text-sm text-muted-foreground">
              {pct(d.observedRatio)} das arestas observadas · {d.nodes.observed}/{d.nodes.total} nós exercitados
            </span>
          </div>
          <p className="text-sm" data-testid="reasoner-verdict-explanation">{d.explanation}</p>
          <SourceNote endpoint="/reasoner/verdict" bits={[d.mode, d.analysisRunId != null ? `run #${d.analysisRunId}` : null]} testId="reasoner-verdict-source" />
        </div>
      )}
    </SectionCard>
  );
}

// ── Código morto (o que os agentes não conseguem) ─────────────────────
const DEADCODE_TIER: Record<string, string> = { isolated: "isolado (forte)", "runtime-refuted": "refutado por runtime", "no-proven-caller": "sem chamador (verificar DI)" };
export function DeadCodeCard({ query }: { query: QueryLike<DeadCodePayload> }) {
  const d = query.data;
  const cands = d?.candidates ?? [];
  return (
    <SectionCard
      title="Candidatos a código morto"
      icon={<Skull className="h-4 w-4 text-primary" />}
      hint="Convergência tri-eixo: sem chamador × sem runtime × não é ponto de entrada."
      testId="reasoner-deadcode"
      query={query}
      errorNote="que não há código morto"
    >
      {!d ? (
        <NotKnown testId="reasoner-deadcode-empty">Sem dados de código morto.</NotKnown>
      ) : cands.length === 0 ? (
        <NotKnown testId="reasoner-deadcode-none">
          Nenhum candidato: todo nó tem chamador, roda em runtime ou é ponto de entrada legítimo.
        </NotKnown>
      ) : (
        <div className="space-y-2">
          <ul className="space-y-1.5" data-testid="reasoner-deadcode-list">
            {cands.slice(0, 6).map((c) => (
              <li key={c.nodeId} className="text-sm">
                <span className="font-medium">{c.label}</span>{" "}
                <Badge variant="outline" className="ml-1 text-[10px]">{DEADCODE_TIER[c.tier] ?? c.tier}</Badge>{" "}
                <span className="text-muted-foreground">· {pct(c.confidence)} confiança</span>
                <p className="text-xs text-muted-foreground">{c.question}</p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground" data-testid="reasoner-deadcode-excluded">
            excluídos por honestidade: {d.excluded.entrySurfaces} superfícies de entrada · {d.excluded.entryPoints} gatilhos ·{" "}
            {d.excluded.runtimeObserved} observados · {d.excluded.unreachableByRobot} não-alcançáveis pelo robô (UNKNOWN, não morto)
          </p>
          <GroundingNote g={d.grounding} mode={d.mode} testId="reasoner-deadcode-grounding" />
          <SourceNote endpoint="/reasoner/dead-code" bits={[d.analysisRunId != null ? `run #${d.analysisRunId}` : null]} testId="reasoner-deadcode-source" />
        </div>
      )}
    </SectionCard>
  );
}

// ── Domínios (o call-graph vira mapa de negócio) ──────────────────────
export function DomainsCard({ query }: { query: QueryLike<DomainsPayload> }) {
  const d = query.data;
  const doms = d?.domains ?? [];
  return (
    <SectionCard
      title="Domínios de negócio"
      icon={<Boxes className="h-4 w-4 text-primary" />}
      hint="Emergem do que DE FATO se chama no grafo provado (não da pasta)."
      testId="reasoner-domains"
      query={query}
      errorNote="que não há domínios"
    >
      {!d ? (
        <NotKnown testId="reasoner-domains-empty">Sem dados de domínios.</NotKnown>
      ) : doms.length === 0 ? (
        <NotKnown testId="reasoner-domains-none">Nenhum domínio emergiu (grafo pequeno ou sem arestas de domínio).</NotKnown>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {doms.length} domínios · {d.seams.length} fronteiras de acoplamento · {d.hubs.length} hubs compartilhados
          </p>
          <ul className="space-y-1" data-testid="reasoner-domains-list">
            {doms.slice(0, 6).map((dom) => (
              <li key={dom.id} className="text-sm">
                <span className="font-medium">{dom.name}</span>{" "}
                <span className="text-muted-foreground">· {dom.size} nós · {Object.keys(dom.byType).join("/")}</span>
              </li>
            ))}
          </ul>
          <GroundingNote g={d.grounding} mode={d.mode} testId="reasoner-domains-grounding" />
          <SourceNote endpoint="/reasoner/domains" bits={[d.analysisRunId != null ? `run #${d.analysisRunId}` : null]} testId="reasoner-domains-source" />
        </div>
      )}
    </SectionCard>
  );
}

// ── Gap de runtime (o teto do observedRatio, acionável) ───────────────
export function RuntimeGapCard({ query }: { query: QueryLike<RuntimeGapPayload> }) {
  const d = query.data;
  const unc = d?.uncovered ?? [];
  const covCls = (d?.coverage ?? 0) >= 0.5 ? "text-emerald-600 dark:text-emerald-400" : (d?.coverage ?? 0) >= 0.15 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400";
  return (
    <SectionCard
      title="O que ainda não foi exercitado"
      icon={<Radar className="h-4 w-4 text-primary" />}
      hint="Pontos de entrada que existem mas nenhum tráfego tocou — cobrir, não remover."
      testId="reasoner-runtimegap"
      query={query}
      errorNote="que a cobertura está completa"
    >
      {!d ? (
        <NotKnown testId="reasoner-runtimegap-empty">Sem dados de cobertura.</NotKnown>
      ) : d.totalEntries === 0 ? (
        <NotKnown testId="reasoner-runtimegap-none">Nenhum ponto de entrada no grafo.</NotKnown>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">
            <span className={`font-semibold ${covCls}`} data-testid="reasoner-runtimegap-coverage">{pct(d.coverage)}</span>{" "}
            <span className="text-muted-foreground">de cobertura ({d.observedEntries}/{d.totalEntries} entradas exercitadas) · {unc.length} nunca rodaram</span>
          </p>
          <ul className="space-y-0.5" data-testid="reasoner-runtimegap-list">
            {unc.slice(0, 5).map((u) => (
              <li key={u.nodeId} className="text-sm">
                <span className="font-medium">{u.label}</span> <span className="text-muted-foreground">· alcança {u.reach} nós</span>
              </li>
            ))}
          </ul>
          <GroundingNote g={d.grounding} mode={d.mode} testId="reasoner-runtimegap-grounding" />
          <SourceNote endpoint="/reasoner/runtime-gap" bits={[d.analysisRunId != null ? `run #${d.analysisRunId}` : null]} testId="reasoner-runtimegap-source" />
        </div>
      )}
    </SectionCard>
  );
}

// ── O painel (I/O) — 4 consultas paralelas, cada uma degrada sozinha ──
export function ReasonerPanel({ projectId }: { projectId?: number }) {
  const enabled = projectId != null;
  const key = (suffix: string) => (enabled ? [`/api/projects/${projectId}/reasoner/${suffix}`] : ["noop-reasoner", suffix]);
  const verdict = useQuery<VerdictPayload>({ queryKey: key("verdict"), enabled, retry: false });
  const deadcode = useQuery<DeadCodePayload>({ queryKey: key("dead-code"), enabled, retry: false });
  const domains = useQuery<DomainsPayload>({ queryKey: key("domains"), enabled, retry: false });
  const runtimeGap = useQuery<RuntimeGapPayload>({ queryKey: key("runtime-gap"), enabled, retry: false });
  const wrap = <T,>(q: ReturnType<typeof useQuery>): QueryLike<T> => ({ data: q.data as T, isLoading: q.isLoading, isError: q.isError, error: q.error as Error | null, refetch: () => void q.refetch() });

  return (
    <div className="space-y-4" data-testid="reasoner-panel">
      <div className="flex items-center gap-2 pt-2">
        <Brain className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold tracking-tight">Raciocínio — IA sobre o provado</h2>
        <span className="text-xs text-muted-foreground">a IA propõe; o substrato provado dispõe; claim sem âncora é rejeitado</span>
      </div>
      <VerdictCard query={wrap<VerdictPayload>(verdict)} />
      <div className="grid gap-4 lg:grid-cols-2">
        <DeadCodeCard query={wrap<DeadCodePayload>(deadcode)} />
        <RuntimeGapCard query={wrap<RuntimeGapPayload>(runtimeGap)} />
      </div>
      <DomainsCard query={wrap<DomainsPayload>(domains)} />
    </div>
  );
}

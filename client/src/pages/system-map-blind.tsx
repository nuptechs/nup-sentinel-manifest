// ─────────────────────────────────────────────
// System Map — vista "Provas": o que a LEITURA ESTÁTICA não vê.
//
// Esta é a vitrine do BIMR (`GET /api/projects/:id/bimr`). A pergunta que ela
// responde, em português de gente: um agente de IA lendo o código — ou um dev
// novo, ou qualquer ferramenta de análise estática — enxerga o sistema inteiro?
// A resposta vem do único oráculo que pode dá-la: o que a produção DE FATO
// tocou. Tabela usada em produção que não tem entidade no código é invisível a
// qualquer leitura — e aqui ela aparece com nome.
//
// Junto vem a FAIXA DE CONFIANÇA CALIBRADA (`coverage.calibration` do /graph):
// quando há oráculo utilizável, a confiança de cada método deixa de ser peso de
// projeto e vira número MEDIDO com intervalo. Quando não há, a tela DIZ que está
// abstendo — nunca mostra um número inventado no lugar.
//
// Regra de estados (a mesma do resto do mapa): carregando ≠ vazio ≠ falhou.
// `available:false` (análise não rodou) é um estado NEUTRO, não um erro.
// ─────────────────────────────────────────────
import { EyeOff, AlertTriangle, RefreshCw, Database, Wrench, Unlink, Ruler, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EVIDENCE, type EvidenceMethod, normalizeEvidenceMethod, type GraphCalibration } from "./system-map-evidence";

// ── Contrato do payload /bimr (defensivo: tudo opcional) ──────────────
export interface BimrMintedTable {
  id: string;
  table: string;
  runtimeCount?: number;
  likelyInfrastructure: boolean;
}
export interface BimrOrphanEntity {
  id: string;
  label: string;
  runtimeCount?: number;
}
export interface BimrPayload {
  projectId?: number;
  analysisRunId?: string | number | null;
  /** o endpoint tinha o que ler? `false` = análise ainda não rodou (neutro). */
  available: boolean;
  /** motivo pt-BR quando `available=false`. */
  reason?: string;
  measurable?: boolean;
  tablesObservedRuntime?: number;
  tablesResolvedStatic?: number;
  tablesMintedRuntimeOnly?: number;
  mintedRatio?: number;
  mintedRatioExcludingInfrastructure?: number;
  observedExcludingInfrastructure?: number;
  minted?: BimrMintedTable[];
  entitiesHotWithoutStaticInbound?: { count: number; nodes: BimrOrphanEntity[] };
  caveats?: string[];
}

// ── Helpers puros (testáveis sem DOM) ─────────────────────────────────

export type BlindState = "unavailable" | "not-measurable" | "measured";

export interface BlindHeadline {
  state: BlindState;
  /** a frase de valor, pronta para leigo. */
  headline: string;
  /** a explicação de apoio (sempre presente). */
  sub: string;
  minted: number;
  observed: number;
  pct: number;
}

function pct(v: number | undefined): number {
  return Math.round((typeof v === "number" && Number.isFinite(v) ? v : 0) * 100);
}

/**
 * Traduz o payload na manchete pt-BR. Nunca inventa: sem análise → estado
 * neutro; com análise mas sem tráfego → "não medido" (jamais "0% invisível").
 */
export function bimrHeadline(data?: BimrPayload | null): BlindHeadline {
  const observed = data?.tablesObservedRuntime ?? 0;
  const minted = data?.tablesMintedRuntimeOnly ?? 0;
  if (!data || data.available === false) {
    return {
      state: "unavailable",
      headline: "Ainda não dá para medir",
      sub: data?.reason || "Rode uma análise deste projeto para o Sentinel ter o que comparar.",
      minted: 0,
      observed: 0,
      pct: 0,
    };
  }
  if (data.measurable === false || observed === 0) {
    return {
      state: "not-measurable",
      headline: "Sem tráfego observado nesta janela",
      sub:
        data.reason ||
        "Nenhuma tabela foi vista sendo usada em produção no período — sem esse oráculo, não há como dizer o que a leitura do código deixa passar. Isso não é 0%: é não-medido.",
      minted: 0,
      observed: 0,
      pct: 0,
    };
  }
  const p = pct(data.mintedRatio);
  return {
    state: "measured",
    headline:
      minted === 0
        ? `Todas as ${observed} tabelas usadas em produção existem no código`
        : `${minted} de ${observed} tabelas usadas em produção não existem no modelo do código`,
    sub:
      minted === 0
        ? "Nesta janela, tudo o que a produção tocou tem entidade correspondente — a leitura estática cobriu o observado."
        : `São ${p}% do que a produção tocou nesta janela. Nenhuma leitura de código encontraria essas tabelas: elas não têm entidade correspondente.`,
    minted,
    observed,
    pct: p,
  };
}

export interface CalibrationRow {
  method: EvidenceMethod;
  label: string;
  color: string;
  /** confiabilidade medida, em % (p̂). */
  reliabilityPct: number;
  /** limites do intervalo, em %. */
  lowerPct: number;
  upperPct: number;
  /** margem simétrica aproximada para a leitura "±x". */
  marginPct: number;
  /** peso de projeto (o "antes"), em %. */
  fixedPct: number;
  n: number;
  confirmed: number;
}

/**
 * Linhas da faixa calibrada — SÓ dos métodos que passaram no gate. Devolve `[]`
 * quando a calibração abstém (a UI então mostra o motivo, não uma tabela vazia
 * com cara de dado).
 */
export function calibrationRows(cal?: GraphCalibration | null): CalibrationRow[] {
  if (!cal || cal.calibrated !== true || !cal.byMethod) return [];
  const rows: CalibrationRow[] = [];
  for (const [rawMethod, m] of Object.entries(cal.byMethod)) {
    if (!m || m.calibrated !== true) continue;
    const method = normalizeEvidenceMethod(rawMethod);
    const meta = EVIDENCE[method];
    const lowerPct = pct(m.lower);
    const upperPct = pct(m.upper);
    const reliabilityPct = pct(m.reliability);
    rows.push({
      method,
      label: meta.label,
      color: meta.color,
      reliabilityPct,
      lowerPct,
      upperPct,
      marginPct: Math.max(upperPct - reliabilityPct, reliabilityPct - lowerPct),
      fixedPct: pct(cal.effectiveConfidenceByMethod?.[rawMethod]?.fixed),
      n: m.n ?? 0,
      confirmed: m.confirmed ?? 0,
    });
  }
  return rows.sort((a, b) => b.reliabilityPct - a.reliabilityPct);
}

// ── Faixas calibradas (entra no painel epistêmico) ────────────────────
export function CalibrationBands({ calibration }: { calibration?: GraphCalibration | null }) {
  if (!calibration) return null; // /graph antigo: degradação graciosa
  const rows = calibrationRows(calibration);
  return (
    <div className="mt-4 border-t pt-3" data-testid="calibration-bands">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Ruler className="h-3.5 w-3.5" /> Confiança calibrada contra o que rodou
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="calibration-abstained">
          <span className="font-medium text-amber-600 dark:text-amber-400">A calibração está aguardando oráculo.</span>{" "}
          {calibration.reason || "Sem tráfego comparável nesta janela."} Enquanto isso, a confiança exibida é o peso de
          projeto — não uma medida.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.method} className="flex items-center gap-2 text-sm" data-testid={`calibration-row-${r.method}`}>
              <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
              <span className="flex-1 truncate">{r.label}</span>
              <span className="tabular-nums font-medium">
                {r.reliabilityPct}% ±{r.marginPct}
              </span>
              <span className="w-28 text-right text-[11px] tabular-nums text-muted-foreground">
                IC {calibration.confidenceLevelPct ?? 90}%: {r.lowerPct}–{r.upperPct}%
              </span>
            </div>
          ))}
          <p className="pt-1 text-[11px] text-muted-foreground">
            Medido: das arestas de cada método, quantas o tráfego real confirmou. Substitui o peso de projeto.
          </p>
        </div>
      )}
      {calibration.completenessApplicable === true && calibration.completeness && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="completeness-note">
          Completude estimada: o mapa provavelmente tem{" "}
          <strong>{calibration.completeness.estimatedTotal?.toLocaleString("pt-BR")}</strong> ligações
          (vemos {calibration.completeness.observed?.toLocaleString("pt-BR")}) — faltariam{" "}
          {pct(calibration.completeness.missShare)}%.
        </p>
      )}
    </div>
  );
}

// ── Painel principal (PRESENTACIONAL — recebe estado por prop) ────────
export function BlindSpotPanel({
  data,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  data?: BimrPayload | null;
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <Card data-testid="blind-loading">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <EyeOff className="h-4 w-4 text-primary" /> O que a leitura do código não vê
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="border-destructive/40" data-testid="blind-error">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-destructive" /> Não deu para carregar esta medida
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            A consulta falhou — isto <strong>não</strong> quer dizer que não há pontos cegos, quer dizer que não sabemos.
            {error?.message ? ` (${error.message})` : ""}
          </p>
          {onRetry && (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onRetry} data-testid="blind-retry">
              <RefreshCw className="h-3.5 w-3.5" /> Tentar de novo
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const h = bimrHeadline(data);
  const minted = data?.minted ?? [];
  const orphans = data?.entitiesHotWithoutStaticInbound;

  return (
    <Card data-testid="blind-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <EyeOff className="h-4 w-4 text-primary" /> O que a leitura do código não vê
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Medido contra o que a produção realmente usou — o único juiz que existe para esta pergunta.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* manchete */}
        <div className="rounded-md border p-3" data-testid={`blind-state-${h.state}`}>
          {h.state === "measured" && (
            <div className="flex items-baseline gap-2">
              <span
                className="text-3xl font-bold tabular-nums leading-none text-amber-600 dark:text-amber-400"
                data-testid="blind-pct"
              >
                {h.pct}%
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {h.minted} de {h.observed} tabelas
              </span>
            </div>
          )}
          <p className={`text-sm font-medium ${h.state === "measured" ? "mt-1" : ""}`} data-testid="blind-headline">
            {h.headline}
          </p>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="blind-sub">
            {h.sub}
          </p>
        </div>

        {/* as tabelas invisíveis, com nome */}
        {minted.length > 0 && (
          <div data-testid="blind-minted-list">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Database className="h-3.5 w-3.5" /> Tabelas sem entidade no código
            </div>
            <div className="flex flex-wrap gap-1.5">
              {minted.map((m) => (
                <span
                  key={m.id}
                  data-testid={`minted-${m.table}`}
                  className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]"
                  title={m.runtimeCount ? `${m.runtimeCount} acessos observados` : undefined}
                >
                  {m.table}
                  {m.likelyInfrastructure && (
                    <Badge variant="secondary" className="gap-0.5 px-1 py-0 text-[9px] font-sans">
                      <Wrench className="h-2.5 w-2.5" /> infra
                    </Badge>
                  )}
                </span>
              ))}
            </div>
            {typeof data?.mintedRatioExcludingInfrastructure === "number" &&
              minted.some((m) => m.likelyInfrastructure) && (
                <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="blind-ex-infra">
                  Desconsiderando as de infraestrutura (migração, lock, sessão), a taxa é{" "}
                  <strong>{pct(data.mintedRatioExcludingInfrastructure)}%</strong>.
                </p>
              )}
          </div>
        )}

        {/* 2º sinal */}
        {orphans && orphans.count > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-800 dark:bg-amber-950/40" data-testid="blind-orphans">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
              <Unlink className="h-3.5 w-3.5" /> {orphans.count} entidade(s) rodam em produção sem ninguém no código
              apontando para elas
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {orphans.nodes.slice(0, 12).map((n) => (
                <span key={n.id} className="font-mono text-[11px] text-amber-900 dark:text-amber-200">
                  {n.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* honestidade: o que este número NÃO diz */}
        {(data?.caveats?.length ?? 0) > 0 && (
          <details className="text-[11px] text-muted-foreground" data-testid="blind-caveats">
            <summary className="cursor-pointer list-none">
              <span className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2">
                <Info className="h-3 w-3" /> O que este número não diz
              </span>
            </summary>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              {data!.caveats!.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

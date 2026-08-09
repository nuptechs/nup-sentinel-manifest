// ─────────────────────────────────────────────
// Visão de Decisão — o BANNER DE SAÚDE DA EVIDÊNCIA.
//
// É o item mais importante da página, e por um motivo estrutural: todo o resto
// do mapa (censo, ponto cego, tendência, arestas quentes) descreve o que o
// Sentinel SABE. Este banner responde se ele ainda está APRENDENDO. Se a
// evidência parou de chegar, os números abaixo continuam bonitos e verdadeiros
// — sobre um passado. O caso real que motivou o `/evidence-health`: o Gateway
// de um sistema caiu, o eixo runtime foi a zero, e o `/graph` seguiu
// respondendo 200 com `observedRatio: 0`, indistinguível de "nunca integrou".
//
// Daí a regra desta tela: quando a saúde não é `healthy`, o banner DIZ que o
// resto da página está sob suspeita. Não é enfeite — é a diferença entre ler
// "18% observado" como diagnóstico e ler como fotografia velha.
//
// ─── §HONESTIDADE ────────────────────────────────────────────────────
// • `absent` ≠ `stale`. Ausente é "nunca houve" (um projeto Node nunca terá
//   wiring de Spring) — informativo, não alarme. Parou é o alarme.
// • `unknown` ≠ "está tudo bem". É "não deu para perguntar" — dito com essas
//   palavras, nunca escondido atrás de um check verde.
// • A saúde vem do SERVIDOR (`overall`) E os culpados também (`culprits[]`) —
//   o cliente TRADUZ, não julga. O espelho local das regras de degradação
//   sobrevive apenas como retrocompatibilidade com servidor anterior ao campo;
//   quando a lista vem, ela vence (espelho que diverge aponta o culpado errado,
//   que é pior do que não apontar).
// • Drift (o mapa cobre o binário no ar?) fala quando SABE e cala quando não
//   foi pedido: sem `healthUrl` configurado, nenhuma linha — cobrar de quem
//   não pediu a medição treina o time a ignorar aviso.
// • Consulta que falhou não é "saudável": vira `unavailable` com suspeita
//   ligada. Carregando ≠ vazio ≠ falhou.
// ─────────────────────────────────────────────
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  GitCommitHorizontal,
  HelpCircle,
  RefreshCw,
  ShieldAlert,
  HeartPulse,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ── Contrato do payload /evidence-health (defensivo: tudo opcional) ───
export type AxisStatus = "fresh" | "stale" | "absent" | "unknown";
export type OverallHealth = "healthy" | "degraded" | "starving";
export type AxisKey = "static" | "config" | "runtime" | "analysis";

export interface AxisPayload {
  status?: AxisStatus | string;
  stale?: boolean;
  ageHours?: number | null;
  reason?: string;
  /** static/config */
  lastPushAt?: string | null;
  edgeCount?: number;
  /** runtime */
  lastTraceSeenAt?: string | null;
  tracesConsidered?: number;
  routesObserved?: number;
  /** analysis */
  lastRunId?: number | null;
  lastRunStatus?: string | null;
  thresholdHours?: number;
}

/** O eixo ortogonal: o mapa cobre o binário que RODA? (servidor: evidence-drift) */
export interface DriftPayload {
  analyzedSha?: string | null;
  analyzedAt?: string | null;
  deployedSha?: string | null;
  status?: "in-sync" | "drift" | "unknown" | string;
  reason?: string;
}

/**
 * Culpado RESOLVIDO PELO SERVIDOR. Enquanto não existia, esta tela espelhava à
 * mão as regras de degradação do servidor — espelho que só quebra no dia em que
 * as regras mudarem, apontando o culpado errado. O fallback espelhado continua
 * vivo para servidor antigo, mas a lista, quando vem, VENCE.
 */
export interface CulpritPayload {
  axis?: string;
  status?: string;
  reason?: string;
}

export interface EvidenceHealthPayload {
  projectId?: number;
  generatedAt?: string;
  static?: AxisPayload;
  config?: AxisPayload;
  runtime?: AxisPayload;
  analysis?: AxisPayload;
  drift?: DriftPayload;
  overall?: OverallHealth | string;
  culprits?: CulpritPayload[];
}

// ── Vocabulário pt-BR ─────────────────────────────────────────────────
export const AXIS_LABEL: Record<AxisKey, string> = {
  static: "índice do código",
  config: "wiring (DI, rotas)",
  runtime: "tráfego real",
  analysis: "análise do Sentinel",
};

export const AXIS_ORDER: readonly AxisKey[] = ["runtime", "static", "config", "analysis"] as const;

/** O drift não é um dos 4 chips de freshness, mas PODE ser culpado. */
export type CulpritKey = AxisKey | "drift";

export const CULPRIT_LABEL: Record<CulpritKey, string> = {
  ...AXIS_LABEL,
  drift: "cobertura do binário no ar",
};

/** Estado exibível: os 4 de freshness + os 2 do eixo de drift. */
export type ViewStatus = AxisStatus | "drift" | "in-sync";

const STATUS_LABEL: Record<ViewStatus, string> = {
  fresh: "chegando",
  stale: "parou",
  absent: "nunca houve",
  unknown: "não sabemos",
  drift: "divergiu",
  "in-sync": "em dia",
};

/**
 * Tradução dos `reason` do servidor. Chave desconhecida devolve `null` (a UI
 * então mostra só idade/estado) — jamais um texto inventado para o motivo.
 */
const REASON_TEXT: Record<string, string> = {
  "never-pushed": "nunca recebeu envio",
  "malformed-store": "o depósito de arestas veio corrompido",
  "no-timestamp": "há arestas, mas sem carimbo de quando chegaram",
  "invalid-timestamp": "carimbo de data inválido",
  "never-analyzed": "o projeto nunca foi analisado",
  "last-run-failed": "a última análise falhou",
  "storage-error": "não deu para ler o histórico de análises",
  "overlay-disabled": "o overlay de runtime não está configurado neste projeto",
  "jaeger-unreachable": "não deu para perguntar ao coletor de traços",
  "no-traces": "nenhum traço na janela",
  "no-anchorable-traces": "traços chegam, mas nenhum ancora numa rota",
  // eixo de drift (o mapa cobre o binário no ar?)
  "sha-mismatch": "o mapa descreve um commit diferente do que está no ar",
  "no-analyzed-sha": "nenhuma análise carimbou o commit que analisou",
  "runs-unavailable": "não deu para ler o histórico de análises",
  "health-url-not-configured": "o endereço de health do ambiente não está configurado neste projeto",
  "health-unreachable": "não deu para perguntar ao ambiente qual versão está no ar",
  "health-no-commit": "o ambiente respondeu, mas não informa qual commit está rodando",
};

export function reasonText(reason?: string): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? null;
}

/** Idade legível. Entrada inválida → `null` (nunca "há 0 h" fabricado). */
export function ageText(hours: number | null | undefined): string | null {
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) return null;
  if (hours < 1) return `há ${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `há ${Math.round(hours)} h`;
  return `há ${Math.round(hours / 24)} d`;
}

function normalizeStatus(s: unknown): AxisStatus {
  return s === "fresh" || s === "stale" || s === "absent" || s === "unknown" ? s : "unknown";
}

/**
 * Os dois `reason` em que o eixo runtime FOI DECLARADO (overlay configurado) e
 * mesmo assim não entrega evidência. Espelha `RUNTIME_DECLARED_BUT_EMPTY` do
 * servidor — é o que transforma um `absent` de runtime em culpa legítima.
 */
const RUNTIME_DECLARED_BUT_EMPTY = new Set(["no-traces", "no-anchorable-traces"]);

export interface AxisView {
  key: CulpritKey;
  label: string;
  status: ViewStatus;
  statusLabel: string;
  /** linha de apoio: idade + motivo, o que houver. Pode ser `null`. */
  detail: string | null;
  /** este eixo é a causa de o veredito não ser saudável? */
  culprit: boolean;
}

/** Traduz um eixo do payload numa linha da faixa. PURA. */
export function axisView(key: AxisKey, a: AxisPayload | undefined): AxisView {
  const status = normalizeStatus(a?.status);
  const culprit =
    a?.stale === true ||
    status === "stale" ||
    (key === "runtime" && !!a?.reason && RUNTIME_DECLARED_BUT_EMPTY.has(a.reason));

  const bits: string[] = [];
  const why = reasonText(a?.reason);
  if (why) bits.push(why);
  const age = ageText(a?.ageHours);
  if (age) bits.push(`última ${age}`);

  return {
    key,
    label: AXIS_LABEL[key],
    status,
    statusLabel: STATUS_LABEL[status],
    detail: bits.length ? bits.join(" · ") : null,
    culprit,
  };
}

export function axisViews(data?: EvidenceHealthPayload | null): AxisView[] {
  return AXIS_ORDER.map((k) => axisView(k, data?.[k]));
}

// ── Eixo de drift: o mapa cobre o binário que roda? ───────────────────

/** Prefixo legível de SHA. Entrada que não é SHA cheio → `null` (nunca meio-SHA). */
export function shortSha(raw: unknown): string | null {
  return typeof raw === "string" && /^[0-9a-f]{40}$/i.test(raw.trim()) ? raw.trim().toLowerCase().slice(0, 8) : null;
}

export interface DriftLine {
  state: "in-sync" | "drift" | "unknown";
  text: string;
}

/**
 * A linha de drift do banner — ou `null` para ficar CALADO.
 *
 * Silêncio é deliberado em dois casos: servidor antigo (sem o campo) e projeto
 * que nunca configurou o health do ambiente. Cobrar de quem não pediu o eixo é
 * o mesmo erro de degradar por `config: absent` — treina o time a ignorar
 * aviso. Os demais `unknown` (health fora do ar, run sem carimbo) FALAM, porque
 * ali alguém pediu a medição e ela não veio.
 */
export function driftLine(d?: DriftPayload | null): DriftLine | null {
  if (!d || !d.status) return null;

  if (d.status === "in-sync") {
    const sha = shortSha(d.analyzedSha);
    return { state: "in-sync", text: `O mapa cobre o que está no ar${sha ? ` (commit ${sha})` : ""}.` };
  }

  if (d.status === "drift") {
    const a = shortSha(d.analyzedSha);
    const b = shortSha(d.deployedSha);
    return {
      state: "drift",
      text:
        a && b
          ? `O mapa analisou ${a}, mas o ar roda ${b} — re-análise recomendada.`
          : "O mapa descreve um commit diferente do que está no ar — re-análise recomendada.",
    };
  }

  if (d.reason === "health-url-not-configured") return null;
  const why = reasonText(d.reason);
  return {
    state: "unknown",
    text: `Não deu para conferir se o mapa cobre o binário no ar${why ? ` — ${why}` : ""}.`,
  };
}

/** O drift como linha de culpado (só faz sentido quando `status === "drift"`). */
export function driftCulpritView(d?: DriftPayload | null): AxisView {
  const a = shortSha(d?.analyzedSha);
  const b = shortSha(d?.deployedSha);
  const why = reasonText(d?.reason);
  const bits = [why, a && b ? `analisado ${a} · no ar ${b}` : null].filter(Boolean) as string[];
  return {
    key: "drift",
    label: CULPRIT_LABEL.drift,
    status: "drift",
    statusLabel: STATUS_LABEL.drift,
    detail: bits.length ? bits.join(" · ") : null,
    culprit: true,
  };
}

/**
 * Quem causou. A lista do SERVIDOR vence quando existe (autoridade única); o
 * espelho local fica como retrocompatibilidade com servidor anterior ao campo.
 * Culpado que o servidor nomeia e não reconhecemos vira linha mínima honesta —
 * jamais é descartado em silêncio (senão o banner diria "degradado" sem dono).
 */
export function culpritViews(data: EvidenceHealthPayload | null | undefined, axes: AxisView[]): AxisView[] {
  const server = data?.culprits;
  if (Array.isArray(server)) {
    return server.map((c) => {
      if (c?.axis === "drift") return driftCulpritView(data?.drift);
      const known = axes.find((a) => a.key === c?.axis);
      if (known) return { ...known, culprit: true };
      const status = normalizeStatus(c?.status);
      return {
        key: (c?.axis || "unknown") as CulpritKey,
        label: typeof c?.axis === "string" ? c.axis : "eixo desconhecido",
        status,
        statusLabel: STATUS_LABEL[status],
        detail: reasonText(c?.reason),
        culprit: true,
      };
    });
  }

  // servidor antigo: espelho local (as MESMAS regras, aqui só como rede)
  const mirrored = axes.filter((a) => a.culprit);
  return data?.drift?.status === "drift" ? [...mirrored, driftCulpritView(data.drift)] : mirrored;
}

export type HealthState = "unavailable" | OverallHealth;

export interface HealthHeadline {
  state: HealthState;
  headline: string;
  sub: string;
  /** os números do resto da página devem ser lidos com ressalva? */
  suspect: boolean;
  axes: AxisView[];
  culprits: AxisView[];
  /** a linha "o mapa cobre o binário no ar?" — `null` = ficar calado. */
  drift: DriftLine | null;
  /**
   * O lembrete do rodapé da página, quando `suspect`. Mora aqui porque depende
   * de QUAL é a suspeita: com drift a evidência está chegando (só descreve
   * outro commit), e repetir "a evidência não está chegando" mandaria o dono
   * caçar um pipeline saudável.
   */
  suspectNote: string;
  generatedAt: string | null;
}

const NOTE_EVIDENCE_STOPPED =
  "Lembrete: a evidência não está chegando normalmente — os números acima descrevem o último retrato conhecido.";
const NOTE_UNKNOWN =
  "Lembrete: não sabemos se a evidência está chegando — trate os números acima como um retrato de data desconhecida.";
const NOTE_DRIFT =
  "Lembrete: a evidência está chegando, mas sobre um commit diferente do que está no ar — re-analise o projeto.";

/**
 * A manchete honesta da saúde. `overall` vem do servidor (autoridade); aqui só
 * traduzimos e nomeamos quem causou. Sem payload → `unavailable` com suspeita
 * LIGADA: não saber se a evidência chega é motivo para desconfiar do resto,
 * nunca para assumir que está tudo bem.
 */
export function healthHeadline(data?: EvidenceHealthPayload | null): HealthHeadline {
  const rawAxes = axisViews(data);
  const culprits = culpritViews(data, rawAxes);
  // os chips seguem a MESMA lista: chip destacado e linha de culpado não podem
  // discordar (era o risco do espelho local vs. veredito do servidor).
  const culpritKeys = new Set(culprits.map((c) => c.key));
  const axes = rawAxes.map((a) => ({ ...a, culprit: culpritKeys.has(a.key) }));
  const drift = driftLine(data?.drift);
  const generatedAt = typeof data?.generatedAt === "string" ? data.generatedAt : null;

  if (!data || (data.overall !== "healthy" && data.overall !== "degraded" && data.overall !== "starving")) {
    return {
      state: "unavailable",
      headline: "Não sabemos se a evidência está chegando",
      sub:
        "A checagem de saúde não respondeu (ou veio num formato que não reconhecemos). Trate os números abaixo como um retrato de data desconhecida.",
      suspect: true,
      axes,
      culprits,
      drift,
      suspectNote: NOTE_UNKNOWN,
      generatedAt,
    };
  }

  if (data.overall === "starving") {
    return {
      state: "starving",
      headline: "Nenhuma evidência está chegando",
      sub: "Nenhum dos quatro eixos está fresco — o mapa não está sendo alimentado por nada. Tudo abaixo é o último retrato conhecido, não o agora.",
      suspect: true,
      axes,
      culprits,
      drift,
      suspectNote: NOTE_EVIDENCE_STOPPED,
      generatedAt,
    };
  }

  if (data.overall === "degraded") {
    const nomes = culprits.map((c) => c.label).join(", ");
    // Drift SOZINHO não é "a evidência parou de chegar" — é o oposto: ela chega
    // fresquinha, sobre o commit errado. Dizer a frase genérica mandaria o dono
    // caçar um pipeline morto que está vivo.
    const onlyDrift = culprits.length === 1 && culprits[0].key === "drift";
    return {
      state: "degraded",
      headline: onlyDrift
        ? "O mapa não descreve o que está no ar"
        : culprits.length === 1
          ? `A evidência parou de chegar em 1 eixo: ${nomes}`
          : culprits.length > 1
            ? `A evidência parou de chegar em ${culprits.length} eixos: ${nomes}`
            : "A evidência está degradada",
      sub: onlyDrift
        ? "A evidência está chegando normalmente, mas sobre um commit que o ambiente já deixou para trás. Re-analise o projeto no commit que está no ar."
        : culprits.length === 1
          ? "Enquanto esse eixo não voltar, os números abaixo descrevem o último retrato bom — não o agora."
          : culprits.length > 1
            ? "Enquanto esses eixos não voltarem, os números abaixo descrevem o último retrato bom — não o agora."
            : "O servidor reportou degradação, mas nenhum eixo se declarou culpado neste payload. Trate os números abaixo com ressalva.",
      suspect: true,
      axes,
      culprits,
      drift,
      suspectNote: onlyDrift ? NOTE_DRIFT : NOTE_EVIDENCE_STOPPED,
      generatedAt,
    };
  }

  const fresh = axes.filter((a) => a.status === "fresh").map((a) => a.label);
  return {
    state: "healthy",
    headline: "A evidência está chegando",
    sub:
      fresh.length > 0
        ? `Eixos ativos e frescos: ${fresh.join(", ")}. Os números abaixo descrevem o agora.`
        : "Os números abaixo descrevem o agora.",
    suspect: false,
    axes,
    culprits,
    drift,
    suspectNote: "",
    generatedAt,
  };
}

// ── Aparência por estado (cor + ícone + palavra = 3 canais, WCAG 1.4.1) ─
const TONE: Record<HealthState, { card: string; text: string; icon: typeof CheckCircle2 }> = {
  healthy: {
    card: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40",
    text: "text-emerald-800 dark:text-emerald-300",
    icon: CheckCircle2,
  },
  degraded: {
    card: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
    text: "text-amber-900 dark:text-amber-300",
    icon: AlertTriangle,
  },
  starving: {
    card: "border-destructive/50 bg-destructive/5",
    text: "text-destructive",
    icon: ShieldAlert,
  },
  unavailable: {
    card: "border-muted-foreground/30 bg-muted/40",
    text: "text-foreground",
    icon: HelpCircle,
  },
};

const AXIS_DOT: Record<ViewStatus, string> = {
  fresh: "bg-emerald-500",
  stale: "bg-amber-500",
  absent: "bg-slate-400",
  unknown: "bg-slate-400",
  drift: "bg-amber-500",
  "in-sync": "bg-emerald-500",
};

/** Ícone + palavra + cor: 3 canais também na linha de drift (WCAG 1.4.1). */
const DRIFT_TONE: Record<DriftLine["state"], { icon: typeof CheckCircle2; className: string }> = {
  "in-sync": { icon: GitCommitHorizontal, className: "text-emerald-700 dark:text-emerald-400" },
  drift: { icon: AlertTriangle, className: "text-amber-800 dark:text-amber-300 font-medium" },
  unknown: { icon: HelpCircle, className: "text-muted-foreground" },
};

/** A linha do eixo de drift. `null` do helper = renderiza NADA (silêncio honesto). */
export function DriftLineRow({ line }: { line: DriftLine | null }) {
  if (!line) return null;
  const tone = DRIFT_TONE[line.state];
  const Icon = tone.icon;
  return (
    <p className={`mt-2 flex items-start gap-1.5 text-xs ${tone.className}`} data-testid={`health-drift-${line.state}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{line.text}</span>
    </p>
  );
}

function AxisChip({ a }: { a: AxisView }) {
  return (
    <span
      data-testid={`health-axis-${a.key}`}
      title={a.detail ?? undefined}
      className={
        "inline-flex items-center gap-1.5 rounded border bg-background/70 px-2 py-0.5 text-[11px] " +
        (a.culprit ? "border-amber-400 font-medium" : "border-border")
      }
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${AXIS_DOT[a.status]}`} />
      <span className="text-muted-foreground">{a.label}</span>
      <span className={a.culprit ? "text-amber-700 dark:text-amber-300" : ""}>{a.statusLabel}</span>
    </span>
  );
}

/**
 * O banner. PRESENTACIONAL (recebe estado por prop) — a página é quem busca.
 * Carregando ≠ falhou ≠ saudável: cada um tem render próprio.
 */
export function EvidenceHealthBanner({
  data,
  isLoading,
  isError,
  error,
  onRetry,
}: {
  data?: EvidenceHealthPayload | null;
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  if (isLoading) {
    return (
      <Card data-testid="health-loading">
        <CardContent className="space-y-2 p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  // Consulta falhou é um estado PRÓPRIO: não sabemos se a evidência chega, e
  // isso é exatamente o que a tela diz (e mantém a suspeita ligada).
  const h = healthHeadline(isError ? null : data);
  const tone = TONE[h.state];
  const Icon = tone.icon;

  return (
    <Card className={tone.card} data-testid={`health-banner-${h.state}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone.text}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <HeartPulse className="mr-1 inline h-3 w-3" />A evidência ainda está chegando?
              </span>
            </div>
            <p className={`mt-0.5 text-base font-semibold leading-tight ${tone.text}`} data-testid="health-headline">
              {h.headline}
            </p>
            <p className="mt-1 text-sm text-muted-foreground" data-testid="health-sub">
              {isError && error?.message ? `${h.sub} (${error.message})` : h.sub}
            </p>

            {/* o aviso que faz esta página valer: o resto está sob suspeita */}
            {h.suspect && (
              <p
                className="mt-2 rounded border border-dashed border-current/30 px-2 py-1 text-xs font-medium"
                data-testid="health-suspect-warning"
              >
                ⚠ Leia o resto desta página com ressalva — os números descrevem o último retrato, não necessariamente o
                agora.
              </p>
            )}

            {/* o mapa cobre o binário que roda? (cala quando não dá para saber) */}
            <DriftLineRow line={h.drift} />

            {/* faixa por eixo (sempre visível: quem está fresco também informa) */}
            <div className="mt-2.5 flex flex-wrap gap-1.5" data-testid="health-axes">
              {h.axes.map((a) => (
                <AxisChip key={a.key} a={a} />
              ))}
            </div>

            {/* culpado com detalhe explícito (não só o chip) */}
            {h.culprits.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" data-testid="health-culprits">
                {h.culprits.map((c) => (
                  <li key={c.key} data-testid={`health-culprit-${c.key}`}>
                    <Activity className="mr-1 inline h-3 w-3" />
                    <strong>{c.label}</strong>
                    {c.detail ? ` — ${c.detail}` : ""}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-2 flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground" data-testid="health-source">
                fonte: /evidence-health
                {h.generatedAt ? ` · medido em ${new Date(h.generatedAt).toLocaleString("pt-BR")}` : ""}
              </span>
              {(isError || h.state !== "healthy") && onRetry && (
                <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px]" onClick={onRetry} data-testid="health-retry">
                  <RefreshCw className="h-3 w-3" /> Rechecar
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

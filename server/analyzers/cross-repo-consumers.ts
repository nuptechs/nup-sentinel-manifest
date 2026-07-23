/**
 * Consumidores cross-repo no laudo de impacto — ADR-0021 r2 Onda 4.
 *
 * Para cada quebra ALCANÇÁVEL do diff, pergunta ao índice de símbolos do
 * Sentinel (GET /api/symbols/consumers) QUEM CONSOME aquele símbolo — em
 * qualquer repo da organização. O laudo do PR passa a dizer não só "quebra
 * X atinge N endpoints DESTE repo" mas também "e é consumido por estes
 * OUTROS repos" (o join produtor==consumidor do emit-scip).
 *
 * Contrato anti-regressão: TUDO fail-soft e env-gated —
 *   - sem SENTINEL_SYMBOLS_URL/KEY ⇒ enriquecimento nem roda (laudo
 *     byte-a-byte);
 *   - índice fora do ar / timeout ⇒ seção omitida com nota nos limites,
 *     nunca erro;
 *   - cap de símbolos consultados (as quebras top) + timeout por consulta.
 */

export interface ConsumersConfig {
  url: string;
  apiKey: string;
  organizationId?: string;
}

export interface SymbolConsumers {
  symbol: string;
  totalConsumers: number;
  repos: { repo: string; count: number; sample: { relativePath: string; startLine: number }[] }[];
}

export interface CrossRepoSection {
  repoSlug: string;
  bySymbol: SymbolConsumers[];
  /** Símbolos consultados sem consumidor (contados — anti-silêncio). */
  noConsumers: string[];
  /** Falhas de consulta (fail-soft, nomeadas nos limites do laudo). */
  errors: string[];
  /**
   * Supressões breaking-but-dead CONTESTADAS pelo índice: o grafo não viu
   * consumidor, mas o índice viu N consumos. O veredito do grafo fica de pé
   * (não des-suprime — precisão>recall), mas a contradição é ANUNCIADA:
   * a segunda opinião que a supressão de Ochoa não tinha.
   */
  contested?: { symbol: string; totalConsumers: number }[];
}

const MAX_SYMBOLS = 8;
const TIMEOUT_MS = 4_000;

export function consumersConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConsumersConfig | null {
  const url = (env.SENTINEL_SYMBOLS_URL || "").trim().replace(/\/+$/, "");
  const apiKey = (env.SENTINEL_SYMBOLS_KEY || "").trim();
  if (!url || !apiKey) return null;
  const organizationId = (env.SENTINEL_SYMBOLS_ORG || "").trim();
  return { url, apiKey, ...(organizationId ? { organizationId } : {}) };
}

/** `Classe.simbolo` qualificado → o nome nu que o índice conhece. */
export function bareSymbolName(qualified: string): string {
  const last = qualified.includes(".") ? qualified.split(".").pop()! : qualified;
  return last.trim();
}

/** slug `owner/name` de uma URL de repo (espelho do extractRepoSlug do Sentinel). */
export function repoSlugOf(repoUrl: string | null | undefined): string | null {
  if (typeof repoUrl !== "string" || !repoUrl.trim()) return null;
  const trimmed = repoUrl.trim().replace(/\.git$/, "");
  const m = trimmed.match(/[/:]([^/:\s]+\/[^/\s]+)$/);
  if (m && m[1]) return m[1];
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed;
  return null;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Consulta o índice para os símbolos das quebras ALCANÇÁVEIS (cap MAX_SYMBOLS,
 * dedupe por nome nu). Retorna null quando não há o que perguntar.
 */
export async function fetchCrossRepoConsumers(
  breakingSymbols: string[],
  repoSlug: string,
  cfg: ConsumersConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<CrossRepoSection | null> {
  const names = Array.from(new Set(breakingSymbols.map(bareSymbolName).filter(Boolean))).slice(0, MAX_SYMBOLS);
  if (names.length === 0) return null;

  const section: CrossRepoSection = { repoSlug, bySymbol: [], noConsumers: [], errors: [] };

  for (const name of names) {
    const qs = new URLSearchParams({ repo: repoSlug, name });
    if (cfg.organizationId) qs.set("organizationId", cfg.organizationId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${cfg.url}/api/symbols/consumers?${qs}`, {
        headers: { "x-sentinel-key": cfg.apiKey },
        signal: controller.signal,
      });
      if (!res.ok) {
        section.errors.push(`${name}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { data?: { totalConsumers?: number; repos?: SymbolConsumers["repos"] } };
      const total = body?.data?.totalConsumers ?? 0;
      if (total > 0) {
        section.bySymbol.push({ symbol: name, totalConsumers: total, repos: body!.data!.repos ?? [] });
      } else {
        section.noConsumers.push(name);
      }
    } catch (err) {
      section.errors.push(`${name}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (section.bySymbol.length === 0 && section.errors.length === 0 && section.noConsumers.length === 0) return null;
  return section;
}

/** Bloco markdown da seção (consumido pelo renderImpactDiffMarkdown). */
export function renderCrossRepoSection(section: CrossRepoSection): string[] {
  const L: string[] = [];
  L.push("");
  L.push("### 🌐 Consumidores no índice de símbolos (cross-repo)");
  if (section.bySymbol.length === 0) {
    L.push(`> Nenhum consumidor indexado para os símbolos quebrados (${section.noConsumers.join(", ") || "—"}).`);
  }
  for (const s of section.bySymbol) {
    L.push(`- \`${s.symbol}\` — **${s.totalConsumers} consumo(s)** em ${s.repos.length} repo(s):`);
    for (const r of s.repos.slice(0, 5)) {
      const sample = r.sample.map((x) => `\`${x.relativePath}:${x.startLine}\``).join(", ");
      const cross = r.repo !== section.repoSlug ? " ⚠️ **outro repo**" : "";
      L.push(`  - ${r.repo}: ${r.count}× (${sample})${cross}`);
    }
  }
  if (section.noConsumers.length > 0 && section.bySymbol.length > 0) {
    L.push(`> Sem consumidor indexado: ${section.noConsumers.map((n) => `\`${n}\``).join(", ")}.`);
  }
  if (section.contested && section.contested.length > 0) {
    for (const c of section.contested) {
      L.push(
        `> 🔴 **Supressão contestada pelo índice**: \`${c.symbol}\` foi suprimida como breaking-but-dead (o grafo não vê consumidor), mas o índice de símbolos registra **${c.totalConsumers} consumo(s)** — revisar antes de confiar na supressão.`,
      );
    }
  }
  if (section.errors.length > 0) {
    L.push(`> ⚠️ Consultas ao índice que falharam (fail-soft): ${section.errors.join("; ")}.`);
  }
  return L;
}

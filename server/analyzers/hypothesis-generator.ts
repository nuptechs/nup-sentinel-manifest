/**
 * Gerador de hipóteses por IA — ADR-0020 r2 Onda 3 (D3).
 *
 * A IA NUNCA AFIRMA — propõe regras FALSIFICÁVEIS no mesmo formato
 * ConventionRule do perfil, cada uma com CITAÇÃO OBRIGATÓRIA
 * (arquivo + faixa de linha de um exemplo real). O contrato em camadas:
 *
 *   1. parse ESTRITO da resposta (JSON fora do shape → inválida, nomeada);
 *   2. regra SEM `cited` → descartada AQUI (antes até do gate — o D3 não
 *      aceita afirmação sem endereço);
 *   3. validação fail-closed do formato (REUSA parseConventionProfile — a
 *      mesma régua de regra manual/minerada);
 *   4. GATE D4 (verifyConventionProfile, no chamador): ≥minSites arquivos
 *      distintos + a citação tem de RESOLVER + anti-largo — alucinação morre
 *      com 0 matches, nunca entra por eloquência.
 *
 * Amostragem determinística (o que a IA lê): estratificada por diretório de
 * topo + extensão, com foco no RESÍDUO (arquivos que nenhuma regra
 * estatística admitida cobriu — é onde a IA pode agregar; o que a
 * frequência já achou vai no prompt como contexto "não repita").
 * O andaime PageRank de símbolos (codelens rankSymbols) pluga aqui quando a
 * unificação da ADR-0021 aterrissar — declarado, não fingido.
 *
 * LLM atrás de PORTA: `HypothesisLlm = (prompt) => Promise<string>`. Sem
 * chave configurada o chamador nem constrói a porta ⇒ estágio pulado,
 * perfil segue só-estatístico (degradação honesta da ADR).
 */
import {
  ConventionProfile,
  ConventionRule,
  ProfileFile,
  VerifiedRule,
  parseConventionProfile,
} from "./convention-profile";

export type HypothesisLlm = (prompt: string) => Promise<string>;

export interface HypothesisStats {
  proposedByLlm: number;
  dropped: { rule: string; reason: string }[];
  candidates: ConventionRule[];
}

const MAX_SAMPLE_FILES = 12;
const MAX_CHARS_PER_FILE = 2_000;
const MAX_RULES_FROM_LLM = 10;
const AI_ID_PREFIX = "ai-";
const SOURCE_EXT_RE = /\.(java|kt|ts|tsx|js|jsx|cs|py|go|rb|php)$/i;

/** Estrato = dirTopo + extensão ("src|.java"). */
function stratumOf(filePath: string): string {
  const top = filePath.includes("/") ? filePath.split("/")[0] : ".";
  const ext = (/\.[a-z0-9]+$/i.exec(filePath) || [""])[0];
  return `${top}|${ext}`;
}

/**
 * Amostragem determinística: resíduo primeiro (arquivos fora de qualquer
 * regra estatística admitida), ~2 por estrato, ordenação por path (estável).
 */
export function pickSampleFiles(
  files: ProfileFile[],
  admitted: VerifiedRule[],
  maxFiles = MAX_SAMPLE_FILES,
): ProfileFile[] {
  const covered = new Set<string>();
  for (const a of admitted) for (const m of a.sample) covered.add(m.file);

  const source = files
    .filter((f) => SOURCE_EXT_RE.test(f.filePath))
    .sort((a, b) => (a.filePath < b.filePath ? -1 : 1));

  const residue = source.filter((f) => !covered.has(f.filePath));
  const rest = source.filter((f) => covered.has(f.filePath));

  const perStratum = new Map<string, number>();
  const out: ProfileFile[] = [];
  for (const pool of [residue, rest]) {
    for (const f of pool) {
      if (out.length >= maxFiles) return out;
      const key = stratumOf(f.filePath);
      const n = perStratum.get(key) ?? 0;
      if (n >= 2) continue;
      perStratum.set(key, n + 1);
      out.push(f);
    }
  }
  return out;
}

export function buildHypothesisPrompt(
  samples: ProfileFile[],
  statisticalClaims: string[],
  maxRules = MAX_RULES_FROM_LLM,
): string {
  const fileBlocks = samples
    .map((f) => {
      const body = f.content.slice(0, MAX_CHARS_PER_FILE);
      return `--- FILE: ${f.filePath} ---\n${body}`;
    })
    .join("\n\n");

  const already = statisticalClaims.length
    ? `Convenções JÁ descobertas estatisticamente (NÃO repita):\n${statisticalClaims.map((c) => `- ${c}`).join("\n")}`
    : "Nenhuma convenção estatística descoberta ainda.";

  return `Você analisa convenções de desenvolvimento de um repositório. Proponha até ${maxRules} REGRAS DE CONVENÇÃO adicionais que a análise estatística não captou (padrões de rota/camada/persistência/nomenclatura específicos DESTE repo).

REGRAS DO JOGO (violação = regra descartada mecanicamente):
1. Cada regra DEVE citar um exemplo real: {"cited": {"file": "<path exato de um FILE abaixo>", "lineStart": N, "lineEnd": M}} contendo uma ocorrência do padrão. SEM citação a regra é descartada sem leitura.
2. "pattern" é uma REGEX JavaScript ancorada que casa UMA LINHA de código (não comentário). Toda regra será EXECUTADA no repo inteiro: se casar menos de "minSites" arquivos DISTINTOS, morre. Não proponha o que você não viu.
3. "kind": "endpoint" (registro de rota — inclua "endpoint": {"pathTemplate": "/...$1...", "httpMethod": "GET|POST|..."}, onde $1..$9 referenciam grupos do pattern) | "layer-suffix" | "persistence" | "naming".
4. "minSites": inteiro ≥ 3 (quantos arquivos distintos você espera).
5. "fileGlob": sufixo de extensão (".java") ou fragmento de caminho, opcional.
6. "id": kebab-case curto SEM prefixo (o sistema prefixa "ai-").
7. "claim": uma frase em pt-BR dizendo a convenção.

Responda SOMENTE um array JSON de regras, sem markdown, sem comentário.

${already}

AMOSTRA DO REPOSITÓRIO:
${fileBlocks}`;
}

/**
 * Parse ESTRITO da resposta do LLM. Regra sem citação, fora do formato, ou
 * além do teto é DESCARTADA COM RAZÃO NOMEADA — nunca silêncio, nunca
 * "aproveita o que der" sem registro.
 */
export function parseHypotheses(raw: string): HypothesisStats {
  const dropped: { rule: string; reason: string }[] = [];
  const candidates: ConventionRule[] = [];

  let parsed: unknown;
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) throw new Error("resposta sem array JSON");
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return {
      proposedByLlm: 0,
      dropped: [{ rule: "(resposta inteira)", reason: `JSON inválido: ${(err as Error).message}` }],
      candidates: [],
    };
  }
  if (!Array.isArray(parsed)) {
    return { proposedByLlm: 0, dropped: [{ rule: "(resposta)", reason: "top-level não é array" }], candidates: [] };
  }

  const list = parsed.slice(0, MAX_RULES_FROM_LLM);
  for (let i = MAX_RULES_FROM_LLM; i < parsed.length; i++) {
    dropped.push({ rule: `#${i}`, reason: `acima do teto de ${MAX_RULES_FROM_LLM} regras` });
  }

  for (const item of list) {
    const label = (item as { id?: string })?.id ?? "(sem id)";
    if (item == null || typeof item !== "object") {
      dropped.push({ rule: String(label), reason: "não é objeto" });
      continue;
    }
    const rule = { ...(item as Record<string, unknown>) };

    // Contrato D3: citação OBRIGATÓRIA — sem endereço, sem conversa.
    if (rule.cited == null) {
      dropped.push({ rule: String(label), reason: "sem cited (citação é obrigatória para regra de IA)" });
      continue;
    }

    // Prefixo ai- + dedupe de id contra o teto.
    const baseId = typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : `regra-${candidates.length + 1}`;
    rule.id = baseId.startsWith(AI_ID_PREFIX) ? baseId : `${AI_ID_PREFIX}${baseId}`;

    // Validação fail-closed: a MESMA régua das regras manuais/mineradas.
    try {
      const validated = parseConventionProfile({ version: 1, rules: [rule] });
      candidates.push(validated.rules[0]);
    } catch (err) {
      dropped.push({ rule: String(rule.id), reason: (err as Error).message });
    }
  }

  return { proposedByLlm: Array.isArray(parsed) ? parsed.length : 0, dropped, candidates };
}

export interface GenerateHypothesesResult extends HypothesisStats {
  skipped: boolean;
  reason?: string;
}

/**
 * Orquestra D3: amostra → prompt → LLM → parse estrito. O GATE roda no
 * chamador (mesma chamada de verifyConventionProfile das outras fontes).
 * Sem `llm` ⇒ skipped honesto (perfil segue só-estatístico).
 */
export async function generateHypotheses(
  files: ProfileFile[],
  statisticalAdmitted: VerifiedRule[],
  llm: HypothesisLlm | null,
): Promise<GenerateHypothesesResult> {
  if (!llm) {
    return { skipped: true, reason: "llm_unconfigured", proposedByLlm: 0, dropped: [], candidates: [] };
  }
  const samples = pickSampleFiles(files, statisticalAdmitted);
  if (samples.length === 0) {
    return { skipped: true, reason: "no_source_files", proposedByLlm: 0, dropped: [], candidates: [] };
  }
  const prompt = buildHypothesisPrompt(
    samples,
    statisticalAdmitted.map((a) => a.rule.claim),
  );
  let raw: string;
  try {
    raw = await llm(prompt);
  } catch (err) {
    return {
      skipped: true,
      reason: `llm_failed: ${(err as Error).message}`,
      proposedByLlm: 0,
      dropped: [],
      candidates: [],
    };
  }
  return { skipped: false, ...parseHypotheses(raw) };
}

/** Perfil-envelope pro gate (mantém a fonte declarada na auditoria). */
export function hypothesesAsProfile(candidates: ConventionRule[]): ConventionProfile {
  return { version: 1, rules: candidates, source: "llm-hypothesis" };
}

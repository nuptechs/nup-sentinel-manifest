/**
 * ConventionProfile — ADR-0020 r2 Onda 1 (nup-sentinel).
 *
 * O perfil de convenções por projeto: regras EXECUTÁVEIS (não prosa) que
 * descrevem como ESTE repo roteia/nomeia/persiste, cada uma admitida só
 * depois do GATE DE VERIFICAÇÃO MECÂNICA (§D4 da ADR): ≥ minSites arquivos
 * DISTINTOS casando o padrão + citação que resolve (o intervalo citado contém
 * uma ocorrência real). Alucinação morre com 0 matches — nunca entra por
 * afirmação.
 *
 * 2ª instância do mecanismo `businessOntology` (JSONB por projeto + GET/PUT +
 * validação fail-closed que compila cada regex) — deliberadamente NÃO um blob
 * paralelo ad-hoc (correção r2 §11.1-3).
 *
 * Modos (MANIFEST_CONVENTION_PROFILER): off (default, byte-a-byte — pipeline
 * intocado) | shadow (verifica e LOGA o que seria adicionado; não consome) |
 * on (consome ADITIVAMENTE — só adiciona nós, nunca remove).
 */

// ─── Modo ────────────────────────────────────────────────────────────────────

export type ProfilerMode = "off" | "shadow" | "on";

export function profilerMode(env: NodeJS.ProcessEnv = process.env): ProfilerMode {
  const raw = (env.MANIFEST_CONVENTION_PROFILER || "").trim().toLowerCase();
  if (raw === "on") return "on";
  if (raw === "shadow") return "shadow";
  return "off";
}

// ─── Formato do perfil ───────────────────────────────────────────────────────

export type ConventionRuleKind =
  | "endpoint"      // padrão que materializa endpoints HTTP (vira nó CONTROLLER sintético)
  | "layer-suffix"  // sufixo de camada (ex.: *ServiceV1) — informativo na Onda 1
  | "persistence"   // forma de chamada de persistência — informativo na Onda 1
  | "naming"        // convenção de nome — informativo na Onda 1
  | "other";

export interface RuleCitation {
  file: string;
  lineStart: number;
  lineEnd: number;
}

export interface EndpointExtraction {
  /**
   * Template do path com $1..$9 referenciando grupos do padrão.
   * Ex.: padrão `class\s+(\w+)WsV(\d+)` + template `/easynup/$1.v$2`.
   */
  pathTemplate: string;
  httpMethod?: string;
}

export interface ConventionRule {
  id: string;
  /** Afirmação humana — o que a regra diz sobre o repo. */
  claim: string;
  kind: ConventionRuleKind;
  /** Regex ANCORADO (fonte). Compilado no parse — fail-closed. */
  pattern: string;
  patternFlags?: string;
  /**
   * Filtro de arquivo simples: sufixo (".java") ou fragmento de caminho
   * ("services/web/"). Ausente = todos os arquivos.
   */
  fileGlob?: string;
  /** Sites DISTINTOS (arquivos) mínimos pro gate admitir. Default 3. */
  minSites?: number;
  /** Citação obrigatória quando a regra veio de IA (D3); opcional na manual. */
  cited?: RuleCitation;
  /** Só para kind === "endpoint". */
  endpoint?: EndpointExtraction;
}

export interface ConventionProfile {
  version: 1;
  rules: ConventionRule[];
  /** Proveniência do perfil (auditoria); livre na Onda 1. */
  source?: string;
  updatedAt?: string;
}

const KINDS: ReadonlySet<string> = new Set([
  "endpoint",
  "layer-suffix",
  "persistence",
  "naming",
  "other",
]);

const MAX_RULES = 200;
const MAX_PATTERN_LEN = 500;

/**
 * Parser FAIL-CLOSED (espelha `parseProjectOntology`): estrutura inválida,
 * kind desconhecido, regex que não compila ou template órfão ⇒ throw com
 * mensagem nomeando a regra. Nunca aceita parcialmente em silêncio.
 */
export function parseConventionProfile(raw: unknown): ConventionProfile {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("perfil deve ser um objeto { version, rules[] }");
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new Error(`version deve ser 1 (got: ${String(o.version)})`);
  if (!Array.isArray(o.rules)) throw new Error("rules[] é obrigatório");
  if (o.rules.length > MAX_RULES) throw new Error(`máximo de ${MAX_RULES} regras (got: ${o.rules.length})`);

  const seen = new Set<string>();
  const rules: ConventionRule[] = o.rules.map((r, i) => {
    if (r == null || typeof r !== "object") throw new Error(`rules[${i}] deve ser objeto`);
    const rule = r as Record<string, unknown>;
    const id = typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : "";
    if (!id) throw new Error(`rules[${i}].id é obrigatório`);
    if (seen.has(id)) throw new Error(`rules[${i}].id duplicado: ${id}`);
    seen.add(id);

    if (typeof rule.claim !== "string" || !rule.claim.trim()) {
      throw new Error(`regra ${id}: claim é obrigatório`);
    }
    if (typeof rule.kind !== "string" || !KINDS.has(rule.kind)) {
      throw new Error(`regra ${id}: kind inválido (${String(rule.kind)})`);
    }
    if (typeof rule.pattern !== "string" || !rule.pattern.trim()) {
      throw new Error(`regra ${id}: pattern é obrigatório`);
    }
    if (rule.pattern.length > MAX_PATTERN_LEN) {
      throw new Error(`regra ${id}: pattern excede ${MAX_PATTERN_LEN} chars`);
    }
    const flags = rule.patternFlags == null ? undefined : String(rule.patternFlags);
    try {
      // Compila SEM 'g' (o matcher adiciona) — valida sintaxe + flags.
      new RegExp(rule.pattern, (flags || "").replace(/g/g, ""));
    } catch (err) {
      throw new Error(`regra ${id}: regex inválida — ${(err as Error).message}`);
    }

    let cited: RuleCitation | undefined;
    if (rule.cited != null) {
      const c = rule.cited as Record<string, unknown>;
      if (typeof c.file !== "string" || !c.file.trim()) throw new Error(`regra ${id}: cited.file inválido`);
      const ls = Number(c.lineStart);
      const le = Number(c.lineEnd);
      if (!Number.isInteger(ls) || !Number.isInteger(le) || ls < 1 || le < ls) {
        throw new Error(`regra ${id}: cited.lineStart/lineEnd inválidos`);
      }
      cited = { file: c.file.trim(), lineStart: ls, lineEnd: le };
    }

    let endpoint: EndpointExtraction | undefined;
    if (rule.endpoint != null) {
      if (rule.kind !== "endpoint") throw new Error(`regra ${id}: endpoint só vale para kind "endpoint"`);
      const e = rule.endpoint as Record<string, unknown>;
      const tpl = typeof e.pathTemplate === "string" ? e.pathTemplate.trim() : "";
      // Aceita "/x/$1" (prefixado) OU "$1" (grupo-puro — o grupo capturado é o
      // próprio literal de rota, caso do minerador route-anchor). O augment
      // ainda guarda: path RENDERIZADO que não começe com "/" é descartado.
      if (!tpl || !(tpl.startsWith("/") || /^\$[1-9]/.test(tpl))) {
        throw new Error(`regra ${id}: endpoint.pathTemplate deve começar com "/" ou "$<n>"`);
      }
      endpoint = {
        pathTemplate: tpl,
        ...(typeof e.httpMethod === "string" && e.httpMethod.trim()
          ? { httpMethod: e.httpMethod.trim().toUpperCase() }
          : {}),
      };
    }
    if (rule.kind === "endpoint" && !endpoint) {
      throw new Error(`regra ${id}: kind "endpoint" exige endpoint.pathTemplate`);
    }

    const minSites =
      rule.minSites == null ? undefined : Number.isInteger(Number(rule.minSites)) && Number(rule.minSites) >= 1
        ? Number(rule.minSites)
        : (() => { throw new Error(`regra ${id}: minSites deve ser inteiro ≥ 1`); })();

    return {
      id,
      claim: (rule.claim as string).trim(),
      kind: rule.kind as ConventionRuleKind,
      pattern: rule.pattern as string,
      ...(flags ? { patternFlags: flags } : {}),
      ...(typeof rule.fileGlob === "string" && rule.fileGlob.trim() ? { fileGlob: rule.fileGlob.trim() } : {}),
      ...(minSites != null ? { minSites } : {}),
      ...(cited ? { cited } : {}),
      ...(endpoint ? { endpoint } : {}),
    };
  });

  return {
    version: 1,
    rules,
    ...(typeof o.source === "string" ? { source: o.source } : {}),
    ...(typeof o.updatedAt === "string" ? { updatedAt: o.updatedAt } : {}),
  };
}

// ─── Porta PatternMatcher + matcher V1 (regex ancorado por linha) ────────────

export interface ProfileFile {
  filePath: string;
  content: string;
}

export interface PatternMatch {
  file: string;
  /** 1-based. */
  line: number;
  text: string;
  groups: string[];
}

/**
 * Resultado do matcher: CONTAGENS EXATAS + amostra capada.
 *
 * Auditoria 2026-07-23 (furo B): o cap antigo de 5.000 matches truncava a
 * PRÓPRIA contagem — falso-negativo dependente de ordem (1 arquivo gigante
 * esgotava o cap e escondia os demais), razão anti-largo subestimada e
 * `sites` capado no relatório humano. Agora: `sites`/`files`/`citationHit`
 * são exatos (a varredura NUNCA para cedo); só `matches` (a amostra que
 * alimenta samples e a materialização de endpoints) é capada.
 */
export interface MatchReport {
  /** Amostra de ocorrências (≤ MATCH_STORE_CAP) — para samples/endpoints. */
  matches: PatternMatch[];
  /** Contagem EXATA de ocorrências. */
  sites: number;
  /** Arquivos DISTINTOS com ≥1 ocorrência (exato). */
  files: string[];
  /** true/false quando a regra tem citação; null quando não tem. */
  citationHit: boolean | null;
}

/**
 * Porta plugável (ADR-0020 D4): o rigor do gate é o INVARIANTE (≥N sites
 * distintos + citação que resolve), não a ferramenta. V1 = regex ancorado;
 * adapters estruturais (TsAst / TreeSitter da ADR-0021) plugam aqui sem
 * tocar o gate nem o pipeline.
 */
export interface PatternMatcher {
  match(rule: ConventionRule, files: ProfileFile[]): MatchReport;
}

const COMMENT_LINE_RE = /^\s*(\/\/|\*|\/\*|#|<!--)/;
/** Cap da AMOSTRA armazenada — nunca das contagens (exatas por contrato). */
const MATCH_STORE_CAP = 20_000;

export class RegexAnchoredMatcher implements PatternMatcher {
  match(rule: ConventionRule, files: ProfileFile[]): MatchReport {
    const flags = (rule.patternFlags || "").replace(/g/g, "");
    // Regex içada pra fora dos loops (furo A da auditoria: recompilar por
    // linha custava milhões de new RegExp por análise; sem flag g o exec é
    // stateless — não há estado a resetar).
    const re = new RegExp(rule.pattern, flags);
    const matches: PatternMatch[] = [];
    const filesMatched = new Set<string>();
    let sites = 0;
    let citationHit: boolean | null = rule.cited ? false : null;

    for (const file of files) {
      if (!fileMatchesGlob(file.filePath, rule.fileGlob)) continue;
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i];
        // Anti-superalarme herdado do changed-symbols: linha de comentário não
        // é evidência de convenção (Javadoc citando "WsV1" não é um WsV1).
        if (COMMENT_LINE_RE.test(lineText)) continue;
        const m = re.exec(lineText);
        if (!m) continue;
        sites++;
        filesMatched.add(file.filePath);
        if (
          rule.cited &&
          file.filePath === rule.cited.file &&
          i + 1 >= rule.cited.lineStart &&
          i + 1 <= rule.cited.lineEnd
        ) {
          citationHit = true;
        }
        if (matches.length < MATCH_STORE_CAP) {
          matches.push({ file: file.filePath, line: i + 1, text: lineText.trim().slice(0, 200), groups: m.slice(1) });
        }
      }
    }
    return { matches, sites, files: Array.from(filesMatched), citationHit };
  }
}

export function fileMatchesGlob(filePath: string, glob?: string): boolean {
  if (!glob) return true;
  if (glob.startsWith(".")) return filePath.endsWith(glob);
  return filePath.includes(glob);
}

// ─── O GATE (D4) — verificação mecânica ──────────────────────────────────────

export interface VerifiedRule {
  rule: ConventionRule;
  sites: number;
  distinctFiles: number;
  sample: PatternMatch[];
}

export interface RejectedRule {
  rule: ConventionRule;
  reason: string;
}

export interface VerificationReport {
  admitted: VerifiedRule[];
  rejected: RejectedRule[];
  verifiedAt: string;
}

const DEFAULT_MIN_SITES = 3;
/** Padrão que casa "quase tudo" é ruído, não convenção (anti-superalarme). */
const MAX_FILE_COVERAGE_RATIO = 0.8;

export function verifyConventionProfile(
  profile: ConventionProfile,
  files: ProfileFile[],
  matcher: PatternMatcher = new RegexAnchoredMatcher(),
  now: () => string = () => new Date().toISOString(),
): VerificationReport {
  const admitted: VerifiedRule[] = [];
  const rejected: RejectedRule[] = [];

  for (const rule of profile.rules) {
    let report: MatchReport;
    try {
      report = matcher.match(rule, files);
    } catch (err) {
      rejected.push({ rule, reason: `matcher falhou: ${(err as Error).message}` });
      continue;
    }

    const distinct = report.files.length;
    const minSites = rule.minSites ?? DEFAULT_MIN_SITES;

    if (distinct < minSites) {
      rejected.push({
        rule,
        reason: `sites insuficientes: ${report.sites} match(es) em ${distinct} arquivo(s) distintos; mínimo ${minSites} arquivos`,
      });
      continue;
    }

    const candidates = files.filter((f) => fileMatchesGlob(f.filePath, rule.fileGlob)).length;
    if (candidates > 0 && distinct / candidates > MAX_FILE_COVERAGE_RATIO && candidates >= 10) {
      rejected.push({
        rule,
        reason: `padrão largo demais: casa ${distinct}/${candidates} dos arquivos candidatos (> ${MAX_FILE_COVERAGE_RATIO * 100}%) — ruído, não convenção`,
      });
      continue;
    }

    if (rule.cited && report.citationHit !== true) {
      rejected.push({
        rule,
        reason: `citação não resolve: nenhuma ocorrência em ${rule.cited.file}:${rule.cited.lineStart}-${rule.cited.lineEnd}`,
      });
      continue;
    }

    admitted.push({
      rule,
      sites: report.sites,
      distinctFiles: distinct,
      sample: report.matches.slice(0, 5),
    });
  }

  return { admitted, rejected, verifiedAt: now() };
}

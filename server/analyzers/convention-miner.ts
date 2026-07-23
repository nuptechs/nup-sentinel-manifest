/**
 * Minerador estatístico de convenções — ADR-0020 r2 Onda 2 (D2).
 *
 * Gera CANDIDATOS de ConventionRule a partir de frequência sobre o próprio
 * repo (estilo Naturalize: minere a convenção, não a adivinhe) e os passa
 * IMEDIATAMENTE pelo MESMO gate D4 do perfil (dog-food: nenhum candidato entra
 * sem ≥N arquivos distintos + anti-largo-demais). ZERO LLM neste estágio —
 * a IA (Onda 3) só propõe hipóteses ADICIONAIS sobre o que a estatística não
 * alcança; o chão é determinístico.
 *
 * Duas famílias de mineração (correção r2 §11.1-2: mecânica de RATIO/contagem
 * na linha do architecture-detector + gating por limiar do graph-connector,
 * SEM criar maquinaria paralela de matching — a verificação é o gate):
 *
 *   A) LAYER-SUFFIX — sufixos PascalCase dominantes de nomes de classe
 *      (ServiceV1, Repository, Controller, WsV1…): a assinatura de camadas
 *      do repo. Vira regra `kind: "layer-suffix"` (informativa na Onda 2;
 *      alimenta face funcional/correlator nas ondas seguintes).
 *
 *   B) ROUTE-ANCHOR — identificador/anotação que "embrulha" um literal de
 *      rota (`router.get("/api/x")`, `@Ws("/easynup/y")`): a forma
 *      framework-agnóstica de descobrir COMO este repo registra endpoints.
 *      Vira regra `kind: "endpoint"` com template `$1` = o literal capturado.
 */
import {
  ConventionRule,
  ProfileFile,
  VerificationReport,
  verifyConventionProfile,
} from "./convention-profile";

export interface MinedCandidate {
  rule: ConventionRule;
  /** Ocorrências totais vistas na mineração (pré-gate). */
  support: number;
  distinctFiles: number;
}

export interface MineResult {
  candidates: MinedCandidate[];
  /** Os candidatos APÓS o gate D4 — a única saída que pode ser consumida. */
  report: VerificationReport;
}

const COMMENT_LINE_RE = /^\s*(\/\/|\*|\/\*|#|<!--)/;
const CLASS_DECL_RE = /\bclass\s+([A-Z][A-Za-z0-9_]*)/;
const SOURCE_EXT_RE = /\.(java|kt|ts|tsx|js|jsx|cs|py|go|rb|php)$/i;

/** Divide PascalCase/camelCase em segmentos ("FindContractWsV1" → [Find,Contract,Ws,V1]). */
export function camelSegments(name: string): string[] {
  // Acrônimo (HTTP em HTTPServer) só fecha quando o próximo par é Maiúscula+
  // minúscula; senão a maiúscula puxa os dígitos junto (V1, S3, Db2).
  return name.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
}

const MIN_SUFFIX_LEN = 3;
const MAX_SUFFIX_SEGMENTS = 3;
const DEFAULT_MIN_FILES = 5;
const MAX_RULES_PER_FAMILY = 12;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extensão dominante entre os arquivos de suporte (vira o fileGlob da regra). */
function dominantExtension(files: Iterable<string>): string | undefined {
  const counts = new Map<string, number>();
  for (const f of Array.from(files)) {
    const m = /\.[a-z0-9]+$/i.exec(f);
    if (m) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [ext, n] of Array.from(counts.entries())) if (n > bestN) { best = ext; bestN = n; }
  return best;
}

// ─── A) layer-suffix ─────────────────────────────────────────────────────────

export function mineLayerSuffixes(
  files: ProfileFile[],
  minFiles = DEFAULT_MIN_FILES,
): MinedCandidate[] {
  // sufixo → { total, files }
  const stats = new Map<string, { support: number; files: Set<string> }>();

  for (const file of files) {
    if (!SOURCE_EXT_RE.test(file.filePath)) continue;
    const lines = file.content.split("\n");
    for (const line of lines) {
      if (COMMENT_LINE_RE.test(line)) continue;
      const m = CLASS_DECL_RE.exec(line);
      if (!m) continue;
      const segs = camelSegments(m[1]);
      // Sufixos de 1..MAX segmentos camel, com comprimento mínimo — "V1"
      // sozinho tem 2 chars e vira ruído; "WsV1"/"ServiceV1" são assinatura.
      for (let k = 1; k <= Math.min(MAX_SUFFIX_SEGMENTS, segs.length - 1); k++) {
        const suffix = segs.slice(-k).join("");
        if (suffix.length < MIN_SUFFIX_LEN) continue;
        let s = stats.get(suffix);
        if (!s) stats.set(suffix, (s = { support: 0, files: new Set() }));
        s.support++;
        s.files.add(file.filePath);
      }
    }
  }

  // Domina: se "ServiceV1" tem o MESMO conjunto de arquivos que "V1", o mais
  // longo é a convenção real e o curto é sombra — mantém o mais informativo.
  const entries = Array.from(stats.entries())
    .filter(([, s]) => s.files.size >= minFiles)
    .sort((a, b) => b[1].files.size - a[1].files.size || b[0].length - a[0].length);

  const kept: [string, { support: number; files: Set<string> }][] = [];
  for (const [suffix, s] of entries) {
    const shadowed = kept.some(
      ([other, os]) =>
        other.endsWith(suffix) && os.files.size >= s.files.size * 0.9,
    );
    if (!shadowed) kept.push([suffix, s]);
    if (kept.length >= MAX_RULES_PER_FAMILY) break;
  }

  return kept.map(([suffix, s]) => ({
    support: s.support,
    distinctFiles: s.files.size,
    rule: {
      id: `mined-suffix-${suffix.toLowerCase()}`,
      claim: `Classes de camada terminam em "${suffix}" (${s.files.size} arquivos)`,
      kind: "layer-suffix",
      pattern: `\\bclass\\s+\\w+${escapeRe(suffix)}\\b`,
      ...(dominantExtension(s.files) ? { fileGlob: dominantExtension(s.files) } : {}),
      minSites: Math.min(DEFAULT_MIN_FILES, s.files.size),
    },
  }));
}

// ─── B) route-anchor ─────────────────────────────────────────────────────────

/** Âncoras que embrulham path-literal mas NÃO são registro de rota. */
const ANCHOR_DENYLIST = new Set([
  "require", "import", "join", "resolve", "readFile", "readFileSync",
  "writeFile", "writeFileSync", "existsSync", "redirect", "fetch", "get",
]);
// Nota: "get" cru fica fora (fetch/Map.get ambíguos); "router.get"/"app.get"
// entram porque a âncora minerada preserva o RECEPTOR ("router.get").

const HTTP_BY_ANCHOR_TAIL: Record<string, string> = {
  get: "GET", post: "POST", put: "PUT", delete: "DELETE", patch: "PATCH",
  getmapping: "GET", postmapping: "POST", putmapping: "PUT",
  deletemapping: "DELETE", patchmapping: "PATCH", requestmapping: "POST",
};

const ROUTE_CALL_RE = /(@?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(\s*["'](\/[A-Za-z0-9_\-./:{}$]*)["']/g;

export function mineRouteAnchors(
  files: ProfileFile[],
  minFiles = DEFAULT_MIN_FILES,
): MinedCandidate[] {
  const stats = new Map<string, { support: number; files: Set<string>; sample: string }>();

  for (const file of files) {
    if (!SOURCE_EXT_RE.test(file.filePath)) continue;
    const lines = file.content.split("\n");
    for (const line of lines) {
      if (COMMENT_LINE_RE.test(line)) continue;
      ROUTE_CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ROUTE_CALL_RE.exec(line)) !== null) {
        const anchor = m[1];
        const bare = anchor.includes(".") ? anchor.split(".").pop()! : anchor.replace(/^@/, "");
        if (!anchor.includes(".") && ANCHOR_DENYLIST.has(bare)) continue;
        if (ANCHOR_DENYLIST.has(anchor)) continue;
        let s = stats.get(anchor);
        if (!s) stats.set(anchor, (s = { support: 0, files: new Set(), sample: m[2] }));
        s.support++;
        s.files.add(file.filePath);
      }
    }
  }

  const kept = Array.from(stats.entries())
    .filter(([, s]) => s.files.size >= minFiles)
    .sort((a, b) => b[1].files.size - a[1].files.size)
    .slice(0, MAX_RULES_PER_FAMILY);

  return kept.map(([anchor, s]) => {
    const tail = (anchor.includes(".") ? anchor.split(".").pop()! : anchor.replace(/^@/, "")).toLowerCase();
    const method = HTTP_BY_ANCHOR_TAIL[tail] ?? "POST";
    return {
      support: s.support,
      distinctFiles: s.files.size,
      rule: {
        id: `mined-route-${anchor.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`,
        claim: `Rotas registradas via ${anchor}("<path>") — ex.: ${s.sample} (${s.files.size} arquivos)`,
        kind: "endpoint",
        pattern: `${escapeRe(anchor)}\\s*\\(\\s*["'](\\/[^"']*)["']`,
        ...(dominantExtension(s.files) ? { fileGlob: dominantExtension(s.files) } : {}),
        minSites: Math.min(DEFAULT_MIN_FILES, s.files.size),
        endpoint: { pathTemplate: "$1", httpMethod: method },
      },
    };
  });
}

// ─── Composição + gate ───────────────────────────────────────────────────────

export interface MineOptions {
  minFiles?: number;
}

/**
 * Minera as duas famílias e roda os candidatos pelo GATE D4 — a saída
 * consumível é SEMPRE `report.admitted` (a estatística propõe; o código
 * prova, como qualquer outra fonte de regra).
 *
 * Nota de formato: `pathTemplate: "$1"` (o path é o literal capturado) é
 * válido para o augment (o grupo 1 sempre começa com "/").
 */
export function mineConventionProfile(files: ProfileFile[], opts: MineOptions = {}): MineResult {
  const minFiles = opts.minFiles ?? DEFAULT_MIN_FILES;
  const candidates = [...mineLayerSuffixes(files, minFiles), ...mineRouteAnchors(files, minFiles)];
  const report = verifyConventionProfile(
    { version: 1, rules: candidates.map((c) => c.rule), source: "statistical" },
    files,
  );
  return { candidates, report };
}

/**
 * Merge dos ADMITIDOS minerados num perfil existente: regra existente com o
 * MESMO id vence (manual/curada > minerada — nunca sobrescreve em silêncio).
 */
export function mergeMinedIntoProfile(
  existing: { version: 1; rules: ConventionRule[]; source?: string } | null,
  admitted: ConventionRule[],
): { version: 1; rules: ConventionRule[]; source: string; updatedAt: string } {
  const base = existing?.rules ?? [];
  const existingIds = new Set(base.map((r) => r.id));
  const merged = [...base, ...admitted.filter((r) => !existingIds.has(r.id))];
  return {
    version: 1,
    rules: merged,
    source: existing?.source ? `${existing.source}+statistical` : "statistical",
    updatedAt: new Date().toISOString(),
  };
}

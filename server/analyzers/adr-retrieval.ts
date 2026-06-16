/**
 * Recuperação de ADRs relevantes para um conjunto de arquivos (ADR-070 Onda 1 —
 * Crítica arquitetural / conformidade com decisões registradas).
 *
 * Determinístico e advisory: NÃO afirma "você violou X" — responde "estas
 * decisões arquiteturais governam o que você está mexendo, revalide contra
 * elas". É a metade de *retrieval* da conformidade-com-ADR (a metade de
 * julgamento, com LLM como voz num Tribunal, vem depois). Casa por sobreposição
 * de símbolos fortes (nomes de classe/entidade em CamelCase), evitando jogar os
 * 64+ ADRs no contexto. Puro; sem I/O.
 */

export interface AdrEntry {
  id: string; // "ADR-064"
  title: string; // título da 1ª linha #
  status: string | null; // Aceita | Proposta | ...
  file: string; // caminho do .md
  symbols: string[]; // símbolos fortes citados (CamelCase)
}

export interface AdrMatch {
  id: string;
  title: string;
  status: string | null;
  file: string;
  score: number; // nº de símbolos distintos que casaram
  matchedSymbols: string[];
}

// Um "símbolo forte" = identificador CamelCase com ≥2 segmentos OU PascalCase de
// ≥4 letras (Contract, ContractGuarantee, ServiceClass, SlaIndicator). Curtos e
// palavras comuns ficam de fora pra não gerar ruído.
const STRONG_SYMBOL = /\b([A-Z][a-z]+(?:[A-Z][a-z0-9]+)+|[A-Z][a-z]{3,})\b/g;

// Stopwords PascalCase que aparecem em prosa de ADR e NÃO são símbolos de domínio.
const SYMBOL_STOPWORDS = new Set<string>([
  "Status", "Data", "Decisores", "Aceita", "Proposta", "Rejeitada", "Onda",
  "Contexto", "Decisao", "Decisão", "Consequencias", "Consequências", "Lei",
  "Claude", "Yuri", "Opus", "Sonnet", "Anthropic", "Este", "Esta", "Quando",
  "Como", "Porque", "Para", "Com", "Sem", "Mais", "Menos", "Todo", "Toda",
  "Nunca", "Sempre", "Apenas", "Antes", "Depois", "Sobre", "Entre", "Cada",
  "Reuso", "Crava", "Doc", "Fase", "Fases", "Roadmap", "Anexo", "Artigo",
]);

function extractSymbols(text: string): Set<string> {
  const out = new Set<string>();
  Array.from(text.matchAll(STRONG_SYMBOL)).forEach((g) => {
    const s = g[1];
    if (!SYMBOL_STOPWORDS.has(s)) out.add(s);
  });
  return out;
}

/** True se o caminho parece ser um arquivo de ADR (.md com ADR-NNN no nome). */
export function isAdrFile(filePath: string): boolean {
  if (typeof filePath !== "string") return false;
  if (!/\.md$/i.test(filePath)) return false;
  return /ADR-\d+/i.test(filePath.split("/").pop() || "");
}

/** Parseia um arquivo de ADR. Retorna null se não for um ADR reconhecível. */
export function parseAdr(filePath: string, content: string): AdrEntry | null {
  if (!isAdrFile(filePath) || typeof content !== "string") return null;
  const base = filePath.split("/").pop() || filePath;
  const idFromName = base.match(/ADR-\d+/i)?.[0];
  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
  const idFromHeading = firstHeading.match(/ADR-\d+/i)?.[0];
  const id = (idFromName || idFromHeading || "").toUpperCase();
  if (!id) return null;
  const status = content.match(/\*\*Status:\*\*\s*([^\n*]+)/i)?.[1]?.trim() || null;
  // Símbolos: do corpo inteiro, mas remove a 1ª linha de título (ruído) e os
  // símbolos do próprio cabeçalho de metadados.
  const symbols = Array.from(extractSymbols(content)).sort();
  return { id, title: firstHeading || id, status, file: filePath, symbols };
}

/** Constrói o índice de ADRs a partir dos arquivos disponíveis (só os .md de ADR). */
export function buildAdrIndex(
  files: { filePath: string; content: string }[],
): AdrEntry[] {
  const out: AdrEntry[] = [];
  const seen = new Set<string>();
  for (const f of files || []) {
    const adr = parseAdr(f.filePath, f.content);
    if (!adr || seen.has(adr.id)) continue;
    seen.add(adr.id);
    out.push(adr);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Símbolos fortes derivados do nome de um arquivo mudado (sem sufixos comuns). */
function symbolsFromFile(filePath: string): Set<string> {
  const base = (filePath.split("/").pop() || filePath).replace(/\.(java|ts|tsx|js|jsx|vue|kt)$/i, "");
  const stripped = base.replace(/(WsV\d+|Ws|ServiceV\d+|Service|RepositoryImpl|Repository|Controller|ParamsV\d+|ReturnV\d+|Component|Resolver|Executor)$/i, "");
  const out = new Set<string>();
  for (const cand of [base, stripped]) {
    for (const s of Array.from(extractSymbols(cand))) out.add(s);
  }
  return out;
}

/**
 * Recupera os ADRs mais relevantes para um conjunto de arquivos mudados, por
 * sobreposição de símbolos fortes. `limit` corta o ranking (default 5) pra não
 * inundar o contexto. Puro.
 */
export function retrieveAdrsForFiles(
  index: AdrEntry[],
  files: string[],
  opts: { limit?: number } = {},
): AdrMatch[] {
  const limit = opts.limit ?? 5;
  if (!Array.isArray(index) || !index.length || !Array.isArray(files) || !files.length) return [];

  // símbolos da entrega (união dos arquivos mudados)
  const changed = new Set<string>();
  for (const f of files) {
    if (typeof f !== "string") continue;
    for (const s of Array.from(symbolsFromFile(f))) changed.add(s);
  }
  if (!changed.size) return [];

  const matches: AdrMatch[] = [];
  for (const adr of index) {
    const adrSyms = new Set(adr.symbols);
    const matched: string[] = [];
    for (const s of Array.from(changed)) {
      if (adrSyms.has(s)) matched.push(s);
    }
    if (matched.length === 0) continue;
    matches.push({
      id: adr.id,
      title: adr.title,
      status: adr.status,
      file: adr.file,
      score: matched.length,
      matchedSymbols: matched.sort(),
    });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Render Markdown da seção "Decisões arquiteturais aplicáveis" (advisory). */
export function renderApplicableAdrsMarkdown(matches: AdrMatch[]): string {
  if (!matches.length) return "";
  const L: string[] = [];
  L.push("## Decisões arquiteturais aplicáveis (revalidar conformidade)");
  L.push("");
  for (const m of matches) {
    const st = m.status ? ` _(${m.status})_` : "";
    L.push(`- **${m.id}**${st} — ${m.title.replace(/^ADR-\d+\s*[—-]\s*/i, "")}`);
    L.push(`  - toca: ${m.matchedSymbols.join(", ")}`);
  }
  L.push("");
  return L.join("\n");
}

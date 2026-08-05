/**
 * Conhecimento tácito: ligações ADR ↔ símbolo com PROVENIÊNCIA (ADR-0028 P5 —
 * Mapa Epistêmico, fundação).
 *
 * O `adr-retrieval` responde "quais decisões governam esta ENTREGA?" (casamento
 * por sobreposição de símbolos, nível arquivo). Aqui a pergunta é a inversa e
 * mais fina: "qual decisão governa ESTE código?" — cada citação de símbolo/
 * arquivo dentro de uma ADR vira uma LIGAÇÃO de 1ª classe, ancorada na LINHA da
 * ADR que cita (o `sourceRef` = `arquivo:linha`). É o elo que preenche o vazio
 * do "Code Digital Twin": o grafo de símbolos ganha uma sobreposição de decisão.
 *
 * Extração 100% determinística (regex + símbolo conhecido do grafo). Por isso o
 * contrato epistêmico aqui só usa dois níveis:
 *   - STATIC_PROVEN     → o símbolo citado EXISTE no grafo de símbolos.
 *   - STATIC_UNRESOLVED → citado mas não resolvido a um símbolo conhecido.
 * `LLM_CONJECTURED` fica RESERVADO para a co-evolução plena (próximo passo — um
 * juiz LLM inferindo ligações semânticas que a regex não vê); NÃO é emitido aqui.
 *
 * Puro; sem I/O.
 */

import { isAdrFile, parseAdr, SYMBOL_STOPWORDS, strongSymbolRegex } from "./adr-retrieval.ts";

export type AdrLinkConfidence = "STATIC_PROVEN" | "STATIC_UNRESOLVED";

/** Como o símbolo foi citado na linha da ADR (transparência da proveniência). */
export type AdrLinkCitation = "file" | "backtick" | "prose";

export interface AdrLink {
  adrId: string; // "ADR-063"
  adrTitle: string; // título da 1ª linha #
  targetSymbol: string; // símbolo/classe citado (ex.: "ContractBalanceComponent")
  sourceRef: string; // proveniência: "docs/adr/ADR-063-...md:12"
  sourceLine: number; // linha (1-based) da citação dentro da ADR
  sourceText: string; // texto da linha citante (trim + cap), para auditoria
  citation: AdrLinkCitation; // file | backtick | prose
  confidence: AdrLinkConfidence; // STATIC_PROVEN se o símbolo existe no grafo
}

export interface AdrLinksResult {
  links: AdrLink[];
  stats: {
    adrs: number; // ADRs parseadas
    links: number; // total de ligações
    proven: number; // STATIC_PROVEN
    unresolved: number; // STATIC_UNRESOLVED
  };
}

const SOURCE_TEXT_CAP = 240;

// Extensões de código que, quando aparecem num token, marcam citação de ARQUIVO.
const CODE_EXT = /\.(java|ts|tsx|js|jsx|vue|kt|py|go|rb|cs|sql)$/i;

/**
 * De um token bruto (conteúdo de crase, ou palavra da prosa), extrai o símbolo
 * candidato + o tipo de citação. Retorna null se o token não vira símbolo útil.
 *
 * Regras (determinísticas):
 *   - `path/x/Foo.java:25` / `Foo.java` → symbol = "Foo", citation = "file".
 *   - `com.pkg.Bar` / `Bar` (PascalCase forte) → symbol = "Bar".
 *   - `arquivo:linha` genérico sem símbolo forte → ignorado (ruído).
 */
function symbolFromToken(token: string): { symbol: string; citation: AdrLinkCitation } | null {
  let t = token.trim();
  if (!t) return null;

  // Corta um sufixo `:NN` de proveniência (path:linha) antes de tudo.
  const lineSuffix = t.match(/^(.*?):(\d+(?:-\d+)?)$/);
  let citedFile = false;
  if (lineSuffix) {
    t = lineSuffix[1];
    citedFile = true; // `x:NN` é sempre referência ancorada a arquivo/local
  }

  // Se tem extensão de código, é citação de ARQUIVO: símbolo = basename sem ext.
  // A extensão (`.java`/`.ts`/…) já PROVA que o basename é um tipo, então aqui a
  // régua é leve (identificador PascalCase, sem exigir o ≥4-letras da prosa) —
  // uma classe curta citada como arquivo (`Node.java`, `Sla.java`) é sinal alto,
  // não ruído. Continua barrando stopwords.
  if (CODE_EXT.test(t)) {
    const base = (t.split("/").pop() || t).replace(CODE_EXT, "");
    if (/^[A-Z][A-Za-z0-9_]*$/.test(base) && !SYMBOL_STOPWORDS.has(base)) {
      return { symbol: base, citation: "file" };
    }
    return null;
  }

  // Qualificado por ponto (com.pkg.Bar) → último segmento.
  const sym = lastStrongSegment(t);
  if (!sym) return null;
  return { symbol: sym, citation: citedFile ? "file" : "backtick" };
}

/** Último segmento (por `.` ou `/`) que seja um símbolo forte não-stopword. */
function lastStrongSegment(raw: string): string | null {
  const segs = raw.split(/[./]/).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const re = strongSymbolRegex();
    const m = re.exec(s);
    // símbolo forte = o segmento INTEIRO casa (evita pegar "Balance" de "xBalance")
    if (m && m[1] === s && !SYMBOL_STOPWORDS.has(s)) return s;
  }
  return null;
}

/**
 * Extrai as citações de uma ÚNICA linha de ADR, com o tipo de cada uma.
 * Prioridade por token para não duplicar: um símbolo em crase conta como
 * `backtick`/`file`; fora de crase, `Arquivo.ext` conta como `file` e um símbolo
 * PascalCase forte conta como `prose`. Dedupe por símbolo dentro da linha,
 * preservando a citação de maior sinal (file > backtick > prose).
 */
export function extractLineCitations(
  line: string,
): { symbol: string; citation: AdrLinkCitation }[] {
  const rank: Record<AdrLinkCitation, number> = { file: 3, backtick: 2, prose: 1 };
  const best = new Map<string, AdrLinkCitation>();
  const consider = (symbol: string, citation: AdrLinkCitation) => {
    const prev = best.get(symbol);
    if (!prev || rank[citation] > rank[prev]) best.set(symbol, citation);
  };

  // 1) Spans em crase: `ContractBalanceComponent`, `Foo.java:25`, `com.x.Bar`.
  const backtickSpans: string[] = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    backtickSpans.push(m[1]);
    // um span pode ter vários tokens ("reusa `Foo` e `Bar.java`")
    for (const tok of m[1].split(/[\s,;()]+/).filter(Boolean)) {
      const r = symbolFromToken(tok);
      if (r) consider(r.symbol, r.citation);
    }
  }

  // Texto fora das craseiras, para não recontar o que já veio de crase.
  const outside = line.replace(/`[^`]+`/g, " ");

  // 2) Arquivos `Arquivo.ext` em prosa (com opcional `:NN`).
  for (const m of outside.matchAll(/\b([\w./-]+\.(?:java|ts|tsx|js|jsx|vue|kt|py|go|rb|cs|sql)(?::\d+(?:-\d+)?)?)\b/gi)) {
    const r = symbolFromToken(m[1]);
    if (r) consider(r.symbol, "file");
  }

  // 3) Símbolos PascalCase fortes soltos na prosa.
  const re = strongSymbolRegex();
  for (const m of outside.matchAll(re)) {
    const s = m[1];
    if (!SYMBOL_STOPWORDS.has(s)) consider(s, "prose");
  }

  return Array.from(best.entries()).map(([symbol, citation]) => ({ symbol, citation }));
}

/**
 * Constrói as ligações ADR↔símbolo, com proveniência por linha, a partir dos
 * arquivos disponíveis. `knownSymbols` = símbolos que EXISTEM no grafo (nomes de
 * classe dos nós); usado só para graduar a confiança (proven vs unresolved) —
 * ausente/vazio ⇒ tudo STATIC_UNRESOLVED (honesto: sem grafo, nada foi provado).
 *
 * Uma ligação por (adrId, targetSymbol): mantém a PRIMEIRA citação como fonte
 * (linha mais alta = a menção mais próxima do topo/decisão). Puro.
 */
export function buildAdrLinks(
  files: { filePath: string; content: string }[],
  knownSymbols?: Iterable<string> | null,
  opts: { maxLinksPerAdr?: number } = {},
): AdrLinksResult {
  const known = new Set<string>(knownSymbols ? Array.from(knownSymbols) : []);
  const maxPerAdr = opts.maxLinksPerAdr ?? 200;
  const links: AdrLink[] = [];
  let adrCount = 0;

  for (const f of files || []) {
    if (!f || typeof f.filePath !== "string" || typeof f.content !== "string") continue;
    if (!isAdrFile(f.filePath)) continue;
    const adr = parseAdr(f.filePath, f.content);
    if (!adr) continue;
    adrCount++;

    const lines = f.content.split(/\r?\n/);
    // key = targetSymbol → primeira ocorrência (dedupe por ADR)
    const firstSeen = new Map<string, AdrLink>();

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      // Ignora a 1ª linha de título e linhas de metadados de cabeçalho (ruído).
      if (i === 0 && /^#\s/.test(raw)) continue;
      if (/^\s*\*\*(Status|Data|Decisores?)\:\*\*/i.test(raw)) continue;

      for (const c of extractLineCitations(raw)) {
        if (firstSeen.has(c.symbol)) continue;
        // Precisão: citação de código EXPLÍCITA (crase ou `Arquivo.ext`) é sinal
        // alto e vira ligação sempre (proven ou não). PascalCase solto na prosa
        // é baixo sinal (em pt-BR, "Modela"/"Reusa"/"Verificado" parecem símbolo)
        // — só vira ligação quando o símbolo REALMENTE existe no grafo. Assim o
        // ruído de prosa não polui, e a co-evolução via LLM (reservada) é quem
        // resgatará ligações semânticas que a régua determinística descarta.
        if (c.citation === "prose" && !known.has(c.symbol)) continue;
        const lineNo = i + 1;
        const link: AdrLink = {
          adrId: adr.id,
          adrTitle: adr.title,
          targetSymbol: c.symbol,
          sourceRef: `${f.filePath}:${lineNo}`,
          sourceLine: lineNo,
          sourceText: raw.trim().slice(0, SOURCE_TEXT_CAP),
          citation: c.citation,
          confidence: known.has(c.symbol) ? "STATIC_PROVEN" : "STATIC_UNRESOLVED",
        };
        firstSeen.set(c.symbol, link);
      }
    }

    // Ordena por linha (proveniência crescente) e aplica o teto anti-payload.
    const perAdr = Array.from(firstSeen.values())
      .sort((a, b) => a.sourceLine - b.sourceLine || a.targetSymbol.localeCompare(b.targetSymbol))
      .slice(0, maxPerAdr);
    links.push(...perAdr);
  }

  links.sort(
    (a, b) =>
      a.adrId.localeCompare(b.adrId) ||
      a.sourceLine - b.sourceLine ||
      a.targetSymbol.localeCompare(b.targetSymbol),
  );

  const proven = links.filter((l) => l.confidence === "STATIC_PROVEN").length;
  return {
    links,
    stats: { adrs: adrCount, links: links.length, proven, unresolved: links.length - proven },
  };
}

/**
 * Deriva o conjunto de símbolos conhecidos a partir do `systemGraph` persistido
 * (nomes de classe dos nós). Fail-soft: shape inesperado ⇒ conjunto vazio.
 */
export function knownSymbolsFromSystemGraph(systemGraph: unknown): Set<string> {
  const out = new Set<string>();
  const nodes = (systemGraph as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    const cn = (n as { className?: unknown })?.className;
    if (typeof cn === "string" && cn.trim()) out.add(cn.trim());
  }
  return out;
}

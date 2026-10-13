// ─────────────────────────────────────────────────────────────────────────
// OBS-D08 (ADR-0036 WS-D) — tipos COMUNS dos analisadores de backend .NET/Python
// com AST real (além do ingest-only que o README declara em §"Estado, com
// honestidade": ".py/.cs são aceitos pelo scanner mas NÃO têm analisador").
//
// O que estes analisadores entregam: um GRAFO DE SÍMBOLO + CALL-CHAIN derivado
// de um parse ESTRUTURAL do arquivo (lexer que mascara strings/comentários +
// árvore de escopos por indentação/chaves), NÃO um regex cego sobre o texto cru.
//
// HONESTIDADE EPISTÊMICA (§2.1/§2.2 da ADR-0036):
//   • A resolução de chamada é INTRA-ARQUIVO e por NOME SIMPLES — não há
//     symbol-solver (não é compiler-accurate como o scip/engine Java). Logo a
//     evidência da aresta é `STATIC_UNRESOLVED` (heurística declarada, confiança
//     0.40 — o tier do README), NUNCA `STATIC_PROVEN`.
//   • Um nome de chamada só vira aresta resolvida quando EXATAMENTE UM símbolo
//     do arquivo tem aquele nome simples; ambíguo (N>1) ou externo fica
//     `unresolved` — o mapa admite que não sabe em vez de chutar.
//   • O parser NUNCA lança: erro de parse de um arquivo vira `parseErrors[]` e os
//     demais arquivos seguem (fail-soft).
//
// INERTE: nenhum produtor do pipeline chama estes módulos ainda (igual à leva
// WS-E: orphan-surface/triple-orphan/death-certificate são puros e provados por
// fixture, sem fiação). O boot não muda. A fiação ao grafo é de outro item (D11).
// ─────────────────────────────────────────────────────────────────────────

/** Confiança nominal da heurística intra-arquivo — o tier `STATIC_UNRESOLVED` do README. */
export const BACKEND_AST_HEURISTIC_CONFIDENCE = 0.4;

export type BackendLanguage = "python" | "csharp";

export type BackendSymbolKind = "module" | "class" | "function" | "method";

export interface BackendSymbol {
  /** id estável e determinístico: `${language}:${kind}:${qualifiedName}@${sourceFile}`. */
  id: string;
  kind: BackendSymbolKind;
  language: BackendLanguage;
  /** nome simples (o último segmento do qualificado). */
  name: string;
  /** caminho pontilhado dentro do arquivo (ex. `Outer.Inner.method`). */
  qualifiedName: string;
  sourceFile: string;
  /** 1-based, linha da declaração. */
  startLine: number;
  /** símbolo-dono (classe) para kind=method; ausente em function/class/module. */
  owner?: string;
  /**
   * Decorators Python (`@app.route`) / atributos C# (`[HttpGet]`) na declaração.
   * Dica de PONTO DE ENTRADA — alcançado de fora do grafo de chamada (framework).
   */
  decorators?: string[];
}

export type BackendCallResolution = "intra-file" | "unresolved";

export interface BackendCallEdge {
  /** símbolo CHAMADOR (quem contém a chamada). */
  fromSymbolId: string;
  /** nome simples invocado (último segmento após o ponto: `self.foo(` → `foo`). */
  calleeName: string;
  /** símbolo CHAMADO, resolvido intra-arquivo por nome único; ausente = `unresolved`. */
  toSymbolId?: string;
  resolution: BackendCallResolution;
  /** 1-based, linha da chamada. */
  line: number;
}

export interface BackendParseError {
  sourceFile: string;
  message: string;
}

export interface BackendAstResult {
  language: BackendLanguage;
  symbols: BackendSymbol[];
  edges: BackendCallEdge[];
  /** nº de arquivos efetivamente parseados (não vazios, extensão certa). */
  filesParsed: number;
  parseErrors: BackendParseError[];
}

/** Palavras-reservadas que precedem `(` mas NÃO são chamada de função (controle de fluxo). */
export const NON_CALL_KEYWORDS = new Set<string>([
  // comuns às duas linguagens
  "if", "for", "while", "switch", "catch", "return", "lock", "using",
  "foreach", "fixed", "sizeof", "typeof", "nameof", "default", "await",
  "yield", "throw", "new",
  // python
  "elif", "with", "assert", "del", "raise", "and", "or", "not", "in", "is",
  "lambda", "print" /* builtin — ruído: não é símbolo do projeto */,
]);

/** Constrói o id determinístico de um símbolo. */
export function symbolId(
  language: BackendLanguage,
  kind: BackendSymbolKind,
  qualifiedName: string,
  sourceFile: string,
): string {
  return `${language}:${kind}:${qualifiedName}@${sourceFile}`;
}

/**
 * Resolve uma lista de arestas CRUAS (calleeName por símbolo) contra os símbolos
 * do MESMO arquivo. Regra honesta: resolve só quando EXATAMENTE UM símbolo
 * (function/method) tem aquele nome simples naquele arquivo. Ambíguo/externo →
 * `unresolved`. PURO, determinístico. Compartilhado por Python e C#.
 */
export function resolveIntraFileCalls(
  raw: Array<{ fromSymbolId: string; calleeName: string; line: number; sourceFile: string }>,
  symbols: BackendSymbol[],
): BackendCallEdge[] {
  // nome simples → ids de símbolos chamáveis (function/method) POR arquivo.
  const byFileName = new Map<string, Map<string, string[]>>();
  for (const s of symbols) {
    if (s.kind !== "function" && s.kind !== "method") continue;
    let m = byFileName.get(s.sourceFile);
    if (!m) { m = new Map(); byFileName.set(s.sourceFile, m); }
    const arr = m.get(s.name) ?? [];
    arr.push(s.id);
    m.set(s.name, arr);
  }

  const out: BackendCallEdge[] = [];
  for (const r of raw) {
    const candidates = byFileName.get(r.sourceFile)?.get(r.calleeName);
    if (candidates && candidates.length === 1 && candidates[0] !== r.fromSymbolId) {
      out.push({ fromSymbolId: r.fromSymbolId, calleeName: r.calleeName, toSymbolId: candidates[0], resolution: "intra-file", line: r.line });
    } else {
      out.push({ fromSymbolId: r.fromSymbolId, calleeName: r.calleeName, resolution: "unresolved", line: r.line });
    }
  }
  // ordem estável para reprodutibilidade (recibo/teste byte-estável).
  out.sort((a, b) => a.line - b.line || a.fromSymbolId.localeCompare(b.fromSymbolId) || a.calleeName.localeCompare(b.calleeName));
  return out;
}

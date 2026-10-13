// ─────────────────────────────────────────────────────────────────────────
// OBS-D08 (ADR-0036 WS-D) — ANALISADOR DE BACKEND PYTHON com parse ESTRUTURAL.
//
// Antes: `.py` era aceito pelo scanner e descartado (ingest-only, README). Agora
// um parse real: um LEXER mascara strings (', ", ''' """) e comentários (#) —
// preservando colunas — e uma ÁRVORE DE ESCOPOS por INDENTAÇÃO extrai símbolos
// (`class`/`def`/`async def`), seu aninhamento (método = def dentro de class) e
// as CHAMADAS dentro de cada corpo. Decorators (`@app.route`) viram dica de
// ponto de entrada.
//
// Por que lexer e não regex cru: `def` dentro de uma docstring, um `foo(` dentro
// de uma string ou comentário, continuação de linha por parêntese aberto — tudo
// isso quebra regex. O lexer mascara o que não é código ANTES da extração, então
// nenhum `def`/chamada fantasma de dentro de literal entra no grafo.
//
// Resolução intra-arquivo por nome único (STATIC_UNRESOLVED, conf. 0.40) —
// honesto: sem symbol-solver, chamada externa/ambígua fica `unresolved`.
// PURO; nunca lança (erro de arquivo → parseErrors[]). §2.3: IA não entra.
// ─────────────────────────────────────────────────────────────────────────

import {
  symbolId,
  resolveIntraFileCalls,
  NON_CALL_KEYWORDS,
  type BackendAstResult,
  type BackendSymbol,
} from "./backend-ast-common";

interface ScannedFile {
  filePath: string;
  content: string;
}

/**
 * LEXER: devolve, por linha física, a versão MASCARADA (strings/comentários
 * trocados por espaços, mesmo comprimento ⇒ colunas preservadas) e a profundidade
 * de parênteses `()[]{}` ao FIM da linha (para juntar continuações). Varre
 * caractere a caractere com máquina de estados (triple-quote, escape, comentário).
 */
function lexPython(content: string): { masked: string[]; bracketAtLineEnd: number[] } {
  const rawLines = content.split("\n");
  const masked: string[] = [];
  const bracketAtLineEnd: number[] = [];

  let inTriple: '"""' | "'''" | null = null;
  let bracket = 0;

  for (const line of rawLines) {
    const chars = line.split("");
    const out = chars.slice();
    let i = 0;

    const mask = (from: number, to: number) => {
      for (let k = from; k < to && k < out.length; k++) out[k] = " ";
    };

    while (i < chars.length) {
      // dentro de triple-quote: procura o fechamento nesta linha
      if (inTriple) {
        const close = line.indexOf(inTriple, i);
        if (close === -1) { mask(i, chars.length); i = chars.length; break; }
        mask(i, close + 3);
        i = close + 3;
        inTriple = null;
        continue;
      }
      const c = chars[i];
      // comentário até o fim da linha
      if (c === "#") { mask(i, chars.length); i = chars.length; break; }
      // abertura de triple-quote
      if ((c === '"' || c === "'") && chars[i + 1] === c && chars[i + 2] === c) {
        const q = (c + c + c) as '"""' | "'''";
        const close = line.indexOf(q, i + 3);
        if (close === -1) { mask(i, chars.length); inTriple = q; i = chars.length; break; }
        mask(i, close + 3);
        i = close + 3;
        continue;
      }
      // string de aspa simples/dupla numa linha
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < chars.length) {
          if (chars[j] === "\\") { j += 2; continue; }
          if (chars[j] === c) { j++; break; }
          j++;
        }
        mask(i, j);
        i = j;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") bracket++;
      else if (c === ")" || c === "]" || c === "}") bracket = Math.max(0, bracket - 1);
      i++;
    }

    masked.push(out.join(""));
    bracketAtLineEnd.push(bracket);
  }

  return { masked, bracketAtLineEnd };
}

interface Scope {
  kind: "class" | "function" | "method";
  qualifiedName: string;
  id: string;
  indent: number;
  bodyIndent: number | null; // indentação mínima observada do corpo (p/ saber onde fecha)
}

function leadingIndent(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 1;
    else break;
  }
  return n;
}

const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const CLASS_RE = /^class\s+([A-Za-z_]\w*)/;
const DECORATOR_RE = /^@\s*([A-Za-z_][\w.]*)/;
const CALL_RE = /([A-Za-z_][\w.]*)\s*\(/g;

/** Analisa UM arquivo .py. Nunca lança — devolve parcial + erro se algo escapar. */
function analyzePythonFile(
  file: ScannedFile,
  symbols: BackendSymbol[],
  rawCalls: Array<{ fromSymbolId: string; calleeName: string; line: number; sourceFile: string }>,
  parseErrors: BackendAstResult["parseErrors"],
): void {
  try {
    const { masked, bracketAtLineEnd } = lexPython(file.content);
    const scopeStack: Scope[] = [];
    let pendingDecorators: string[] = [];

    for (let lineNo = 0; lineNo < masked.length; lineNo++) {
      // pular linhas que são CONTINUAÇÃO (parêntese aberto na linha anterior)
      if (lineNo > 0 && bracketAtLineEnd[lineNo - 1] > 0) continue;

      const mLine = masked[lineNo];
      const trimmed = mLine.trim();
      if (trimmed.length === 0) continue; // vazia ou só-comentário/string

      const indent = leadingIndent(mLine);

      // fecha escopos cujo corpo terminou (nova linha de código com indent <= indent do escopo)
      while (scopeStack.length > 0 && indent <= scopeStack[scopeStack.length - 1].indent) {
        scopeStack.pop();
      }

      const dec = trimmed.match(DECORATOR_RE);
      if (dec) { pendingDecorators.push(dec[1]); continue; }

      const defM = trimmed.match(DEF_RE);
      const classM = trimmed.match(CLASS_RE);

      if (defM || classM) {
        const name = (defM ? defM[1] : classM![1]);
        const parent = scopeStack[scopeStack.length - 1];
        const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
        const kind: BackendSymbol["kind"] = classM ? "class" : (parent && parent.kind === "class" ? "method" : "function");
        const id = symbolId("python", kind, qualifiedName, file.filePath);
        const sym: BackendSymbol = {
          id,
          kind,
          language: "python",
          name,
          qualifiedName,
          sourceFile: file.filePath,
          startLine: lineNo + 1,
          ...(kind === "method" && parent ? { owner: parent.qualifiedName } : {}),
          ...(pendingDecorators.length ? { decorators: pendingDecorators.slice() } : {}),
        };
        symbols.push(sym);
        scopeStack.push({ kind, qualifiedName, id, indent, bodyIndent: null });
        pendingDecorators = [];
        // extrai chamadas que aparecem na MESMA linha após a assinatura? Não: a
        // assinatura (default args) pode ter chamadas — mas são do escopo-pai e
        // raras; para precisão, pulamos a linha-assinatura na extração de chamadas.
        continue;
      }

      pendingDecorators = []; // decorator sem def/class imediato → descarta

      // CHAMADAS: só contam dentro de uma função/método (não no corpo de classe/módulo,
      // onde chamadas são setup, não call-chain de execução de símbolo).
      const enclosingCallable = [...scopeStack].reverse().find((s) => s.kind === "function" || s.kind === "method");
      if (!enclosingCallable) continue;

      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(mLine)) !== null) {
        const dotted = m[1];
        const calleeName = dotted.includes(".") ? dotted.split(".").pop()! : dotted;
        if (!calleeName || NON_CALL_KEYWORDS.has(calleeName)) continue;
        // ignora `def`/`class` keyword capturado como nome (já tratado acima, defensivo)
        if (calleeName === "def" || calleeName === "class") continue;
        rawCalls.push({ fromSymbolId: enclosingCallable.id, calleeName, line: lineNo + 1, sourceFile: file.filePath });
      }
    }
  } catch (err) {
    parseErrors.push({ sourceFile: file.filePath, message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Analisa todos os arquivos `.py` de um conjunto escaneado. PURO (sem I/O — recebe
 * conteúdo já lido pelo repository-scanner), determinístico, fail-soft.
 */
export function analyzePythonBackend(files: ScannedFile[]): BackendAstResult {
  const symbols: BackendSymbol[] = [];
  const rawCalls: Array<{ fromSymbolId: string; calleeName: string; line: number; sourceFile: string }> = [];
  const parseErrors: BackendAstResult["parseErrors"] = [];
  let filesParsed = 0;

  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.filePath !== "string" || !f.filePath.toLowerCase().endsWith(".py")) continue;
    if (typeof f.content !== "string" || f.content.trim().length === 0) continue;
    filesParsed++;
    analyzePythonFile(f, symbols, rawCalls, parseErrors);
  }

  symbols.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName));
  const edges = resolveIntraFileCalls(rawCalls, symbols);

  return { language: "python", symbols, edges, filesParsed, parseErrors };
}

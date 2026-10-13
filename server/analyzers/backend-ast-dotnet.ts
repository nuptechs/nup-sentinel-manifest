// ─────────────────────────────────────────────────────────────────────────
// OBS-D08 (ADR-0036 WS-D) — ANALISADOR DE BACKEND .NET (C#) com parse ESTRUTURAL.
//
// Antes: `.cs` aceito pelo scanner e descartado (ingest-only, README). Agora um
// parse real por CHAVES: um LEXER mascara strings (", @"verbatim, char ''),
// comentários (// e /* */) — preservando offsets — e uma máquina de pilha sobre
// `{`/`}` monta a ÁRVORE de namespace→(class|struct|interface|record)→método, de
// onde saem símbolos e as CHAMADAS de cada corpo de método.
//
// Distinção DECLARAÇÃO×CHAMADA (o ponto difícil em C#): um método é uma linha de
// escopo de TIPO cujo token antes de `(` é um NOME precedido de um tipo de retorno
// (dois identificadores) e/ou modificadores (public/static/async/…), terminada em
// `{`, `=>` ou `;` (abstract/interface). Construtor = nome == tipo + modificador.
// `if (`, `while (`, `foreach (` etc. são barrados por NON_CALL_KEYWORDS.
//
// HONESTIDADE: sem Roslyn/symbol-solver, a resolução é intra-arquivo por nome
// único ⇒ evidência `STATIC_UNRESOLVED` (conf. 0.40), overloads/externos ficam
// `unresolved`. Genéricos/LINQ/expression-trees NÃO são resolvidos — é um mapa de
// símbolo+call-chain declarado, não compiler-accurate. PURO; nunca lança.
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
 * LEXER C#: mascara strings/char/comentários preservando comprimento. Trata `@"`
 * (verbatim: `""` é aspa escapada), `"` normal (com `\`), `'x'`, comentário de
 * linha e comentário de bloco. Devolve o texto mascarado inteiro (um só string).
 */
function lexCSharp(content: string): string {
  const out = content.split("");
  const n = out.length;
  let i = 0;

  const mask = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    const c = content[i];
    const c2 = content[i + 1];

    // comentário de linha
    if (c === "/" && c2 === "/") {
      let j = i + 2;
      while (j < n && content[j] !== "\n") j++;
      mask(i, j); i = j; continue;
    }
    // comentário de bloco
    if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(content[j] === "*" && content[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      mask(i, j); i = j; continue;
    }
    // string verbatim @"..."  (""  = aspa literal)
    if (c === "@" && c2 === '"') {
      let j = i + 2;
      while (j < n) {
        if (content[j] === '"' && content[j + 1] === '"') { j += 2; continue; }
        if (content[j] === '"') { j++; break; }
        j++;
      }
      mask(i, j); i = j; continue;
    }
    // string normal "..." (inclui interpolada $"..."; mascaramos o conteúdo todo —
    // basta para não contar chamadas/chaves dentro do literal)
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content[j] === '"') { j++; break; }
        if (content[j] === "\n") break;
        j++;
      }
      mask(i, j); i = j; continue;
    }
    // char 'x' / '\n'
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (content[j] === "\\") { j += 2; continue; }
        if (content[j] === "'") { j++; break; }
        if (content[j] === "\n") break;
        j++;
      }
      mask(i, j); i = j; continue;
    }
    i++;
  }
  return out.join("");
}

interface CsScope {
  kind: "namespace" | "type" | "method";
  qualifiedName: string;
  id?: string;
  braceDepthAtOpen: number;
}

const TYPE_DECL_RE = /\b(?:class|struct|interface|record|enum)\s+([A-Za-z_]\w*)/;
const NS_DECL_RE = /\bnamespace\s+([A-Za-z_][\w.]*)/;
const MODIFIER = "(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|extern|unsafe|new|partial|readonly|const|ref|out|in)";
// método: (modificadores)* TipoRetorno Nome ( ... )   com corpo `{`/`=>`/`;`
const METHOD_DECL_RE = new RegExp(
  `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:${MODIFIER}\\s+)*([A-Za-z_][\\w.<>,\\[\\]?]*)\\s+([A-Za-z_]\\w*)\\s*\\(`,
);
// construtor: (modificadores)+ Nome ( ... )  — sem tipo de retorno
const CTOR_DECL_RE = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:${MODIFIER}\\s+)+([A-Za-z_]\\w*)\\s*\\(`);
const ATTR_RE = /\[\s*([A-Za-z_][\w.]*)/g;
const CALL_RE = /([A-Za-z_][\w.]*)\s*\(/g;

/** nomes que o METHOD_DECL_RE poderia confundir com tipo-de-retorno de uma chamada/controle. */
const CONTROL_HEADS = new Set(["if", "for", "while", "switch", "foreach", "catch", "using", "lock", "fixed", "return", "else", "do", "case"]);

function analyzeCSharpFile(
  file: ScannedFile,
  symbols: BackendSymbol[],
  rawCalls: Array<{ fromSymbolId: string; calleeName: string; line: number; sourceFile: string }>,
  parseErrors: BackendAstResult["parseErrors"],
): void {
  try {
    const masked = lexCSharp(file.content);
    const lines = masked.split("\n");
    const scopeStack: CsScope[] = [];
    let braceDepth = 0;
    let pendingAttrs: string[] = [];

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo];
      const trimmed = line.trim();

      // atributos [HttpGet] numa linha isolada → acumula para a próxima decl
      if (trimmed.startsWith("[")) {
        ATTR_RE.lastIndex = 0;
        let a: RegExpExecArray | null;
        while ((a = ATTR_RE.exec(trimmed)) !== null) pendingAttrs.push(a[1]);
        // se a linha é SÓ atributos, segue; senão continua processando (pode ter decl na mesma linha)
        if (/^(?:\[[^\]]*\]\s*)+$/.test(trimmed)) continue;
      }

      const enclosingType = [...scopeStack].reverse().find((s) => s.kind === "type");
      const enclosingMethod = [...scopeStack].reverse().find((s) => s.kind === "method");

      // ── declarações (só fora de corpo de método) ──
      if (!enclosingMethod) {
        const ns = trimmed.match(NS_DECL_RE);
        const typeM = trimmed.match(TYPE_DECL_RE);
        if (ns && !typeM) {
          scopeStack.push({ kind: "namespace", qualifiedName: ns[1], braceDepthAtOpen: braceDepth });
          pendingAttrs = [];
        } else if (typeM) {
          const parent = scopeStack[scopeStack.length - 1];
          const qn = parent ? `${parent.qualifiedName}.${typeM[1]}` : typeM[1];
          const id = symbolId("csharp", "class", qn, file.filePath);
          symbols.push({
            id, kind: "class", language: "csharp", name: typeM[1], qualifiedName: qn,
            sourceFile: file.filePath, startLine: lineNo + 1,
            ...(pendingAttrs.length ? { decorators: pendingAttrs.slice() } : {}),
          });
          scopeStack.push({ kind: "type", qualifiedName: qn, id, braceDepthAtOpen: braceDepth });
          pendingAttrs = [];
        } else if (enclosingType) {
          // método/construtor dentro de um tipo
          const methM = trimmed.match(METHOD_DECL_RE);
          const ctorM = trimmed.match(CTOR_DECL_RE);
          const retHead = methM ? methM[1].split(/[.<\[]/)[0] : "";
          if (methM && !CONTROL_HEADS.has(retHead) && !CONTROL_HEADS.has(methM[2])) {
            registerMethod(methM[2], enclosingType, file, lineNo, pendingAttrs, braceDepth, trimmed, symbols, scopeStack);
            pendingAttrs = [];
          } else if (ctorM && ctorM[1] === enclosingType.qualifiedName.split(".").pop()) {
            registerMethod(ctorM[1], enclosingType, file, lineNo, pendingAttrs, braceDepth, trimmed, symbols, scopeStack);
            pendingAttrs = [];
          } else if (trimmed.length > 0 && !trimmed.startsWith("[")) {
            pendingAttrs = [];
          }
        } else if (trimmed.length > 0 && !trimmed.startsWith("[")) {
          pendingAttrs = [];
        }
      } else {
        // ── dentro de método: extrai chamadas ──
        CALL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CALL_RE.exec(line)) !== null) {
          const dotted = m[1];
          const calleeName = dotted.includes(".") ? dotted.split(".").pop()! : dotted;
          if (!calleeName || NON_CALL_KEYWORDS.has(calleeName) || CONTROL_HEADS.has(calleeName)) continue;
          rawCalls.push({ fromSymbolId: enclosingMethod.id!, calleeName, line: lineNo + 1, sourceFile: file.filePath });
        }
      }

      // ── contabilidade de chaves (depois da decl, para abrir o corpo no depth certo) ──
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          braceDepth--;
          while (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].braceDepthAtOpen >= braceDepth) {
            scopeStack.pop();
          }
        }
      }
    }
  } catch (err) {
    parseErrors.push({ sourceFile: file.filePath, message: err instanceof Error ? err.message : String(err) });
  }
}

function registerMethod(
  name: string,
  enclosingType: CsScope,
  file: ScannedFile,
  lineNo: number,
  attrs: string[],
  braceDepth: number,
  trimmed: string,
  symbols: BackendSymbol[],
  scopeStack: CsScope[],
): void {
  const qn = `${enclosingType.qualifiedName}.${name}`;
  const id = symbolId("csharp", "method", qn, file.filePath);
  symbols.push({
    id, kind: "method", language: "csharp", name, qualifiedName: qn,
    sourceFile: file.filePath, startLine: lineNo + 1, owner: enclosingType.qualifiedName,
    ...(attrs.length ? { decorators: attrs.slice() } : {}),
  });
  // método com corpo de BLOCO: abre escopo (fecha no `}` par). O `{` pode estar na
  // mesma linha (K&R) ou na próxima (Allman) — por isso empilhamos no ponto da
  // declaração e deixamos a contagem de chaves abrir/fechar o corpo. NÃO empilha
  // expression-body (`=> expr;`) nem abstract/interface (`;` sem `{`).
  const isAbstractOrInterface = /;\s*$/.test(trimmed) && !trimmed.includes("{");
  const isExpressionBody = trimmed.includes("=>");
  const opensBlock = !isAbstractOrInterface && !isExpressionBody;
  if (opensBlock) {
    scopeStack.push({ kind: "method", qualifiedName: qn, id, braceDepthAtOpen: braceDepth });
  }
}

/** Analisa todos os `.cs`. PURO, determinístico, fail-soft. */
export function analyzeDotnetBackend(files: ScannedFile[]): BackendAstResult {
  const symbols: BackendSymbol[] = [];
  const rawCalls: Array<{ fromSymbolId: string; calleeName: string; line: number; sourceFile: string }> = [];
  const parseErrors: BackendAstResult["parseErrors"] = [];
  let filesParsed = 0;

  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.filePath !== "string" || !f.filePath.toLowerCase().endsWith(".cs")) continue;
    if (typeof f.content !== "string" || f.content.trim().length === 0) continue;
    filesParsed++;
    analyzeCSharpFile(f, symbols, rawCalls, parseErrors);
  }

  symbols.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile) || a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName));
  const edges = resolveIntraFileCalls(rawCalls, symbols);

  return { language: "csharp", symbols, edges, filesParsed, parseErrors };
}

// ─────────────────────────────────────────────
// changed-symbols — ADR-0018 Onda 1 (nup-sentinel)
//
// Lê o DIFF DE VERDADE em vez do NOME do arquivo. Dado um `git diff` unificado,
// extrai os SÍMBOLOS alterados (método/campo/classe/função/componente) a partir
// de dois sinais determinísticos, sem dependência externa:
//
//   1. o CONTEXTO de função que o próprio git põe no cabeçalho do hunk
//      (`@@ -a,b +c,d @@ <assinatura da função que contém a mudança>`);
//   2. as DECLARAÇÕES nas linhas alteradas (`+`/`-`) — quando a linha em si é
//      a declaração de um símbolo (o símbolo foi adicionado/removido/mudou a
//      assinatura).
//
// Régua: PRECISÃO > recall. Só emite identificadores plausíveis (não keyword),
// e quem consome (`computeImpactForDiff`) cai no basename (`symbolsForFile`)
// quando nada é extraído — nunca fica PIOR que o comportamento atual.
//
// NÃO é diff estrutural de AST (GumTree/ChangeDistiller) — esse é o tier de
// PRECISÃO da Onda 1 (PR sucessor). Este é o tier heurístico-mas-real, que já
// mata o "casamento por nome de arquivo".
// ─────────────────────────────────────────────

export interface DiffHunk {
  /** contexto de função do cabeçalho `@@ ... @@ <contexto>` (git function-context) */
  context: string;
  addedLines: string[];
  removedLines: string[];
}

export interface DiffFile {
  /** caminho novo (b/…); para arquivo deletado, o caminho antigo (a/…) */
  path: string;
  status: "added" | "removed" | "modified";
  hunks: DiffHunk[];
}

export interface ChangedSymbols {
  path: string;
  status: DiffFile["status"];
  /** símbolos alterados extraídos do CONTEÚDO do diff (declaração + contexto) */
  symbols: string[];
}

// keywords/tipos comuns que NÃO são identificadores de negócio — evita ruído.
const STOPWORDS = new Set([
  "public", "private", "protected", "static", "final", "abstract", "synchronized",
  "native", "transient", "volatile", "default", "class", "interface", "enum",
  "record", "extends", "implements", "return", "if", "else", "for", "while",
  "switch", "case", "break", "continue", "new", "this", "super", "void", "int",
  "long", "short", "byte", "char", "boolean", "float", "double", "string",
  "const", "let", "var", "function", "async", "await", "export", "import",
  "from", "type", "fun", "val", "def", "throws", "throw", "try", "catch",
  "finally", "package", "true", "false", "null", "undefined", "get", "set",
  "list", "map", "set", "object", "number", "any", "unknown", "readonly",
]);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{2,}$/;

function isUsefulIdent(s: string): boolean {
  if (!IDENT.test(s)) return false;
  if (STOPWORDS.has(s.toLowerCase())) return false;
  return true;
}

/**
 * Parseia um diff unificado (`git diff`) em arquivos → hunks. Puro, tolerante a
 * ruído (linhas que não reconhece são ignoradas). Suporta múltiplos arquivos.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (typeof diffText !== "string" || !diffText.trim()) return files;

  const lines = diffText.split(/\r?\n/);
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;
  let pendingOldPath: string | null = null;

  const pushFile = () => { if (cur) { if (curHunk) cur.hunks.push(curHunk); curHunk = null; files.push(cur); } };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushFile();
      cur = { path: "", status: "modified", hunks: [] };
      pendingOldPath = null;
      curHunk = null;
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      pendingOldPath = p === "/dev/null" ? null : stripAB(p);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") {
        cur.status = "removed";
        cur.path = pendingOldPath || cur.path;
      } else {
        cur.path = stripAB(p);
        if (pendingOldPath === null) cur.status = "added";
      }
      continue;
    }
    if (line.startsWith("@@")) {
      if (curHunk) cur.hunks.push(curHunk);
      // `@@ -a,b +c,d @@ <context>` — o contexto vem após o 2º `@@`.
      const ctxIdx = line.indexOf("@@", 2);
      const context = ctxIdx >= 0 ? line.slice(ctxIdx + 2).trim() : "";
      curHunk = { context, addedLines: [], removedLines: [] };
      continue;
    }
    if (!curHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) curHunk.addedLines.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) curHunk.removedLines.push(line.slice(1));
  }
  pushFile();
  return files;
}

function stripAB(p: string): string {
  // remove prefixo a/ ou b/ e qualquer sufixo de tab/metadata do git
  return p.replace(/^[ab]\//, "").split("\t")[0].trim();
}

// ── extração de símbolo por linguagem (conservadora) ──

/** declarações Java/Kotlin: método, campo, classe/interface/enum/record. */
function javaKotlinSymbols(line: string): string[] {
  const out: string[] = [];
  // classe/interface/enum/record/ (Java) e class/object/interface (Kotlin)
  const cls = line.match(/\b(?:class|interface|enum|record|object)\s+([A-Z][A-Za-z0-9_]*)/);
  if (cls) out.push(cls[1]);
  // método Java: `... Tipo nome(` ; Kotlin: `fun nome(`
  const kfun = line.match(/\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (kfun) out.push(kfun[1]);
  const jm = line.match(/\b(?:public|private|protected|static|final|abstract|synchronized|\s)+[A-Za-z_][A-Za-z0-9_<>\[\],\s.]*?\s+([a-z][A-Za-z0-9_]*)\s*\(/);
  if (jm) out.push(jm[1]);
  // campo Java: `... Tipo nome;` ou `= ...`
  const jf = line.match(/\b(?:private|protected|public|static|final|\s)+[A-Z][A-Za-z0-9_<>\[\],\s.]*?\s+([a-z][A-Za-z0-9_]*)\s*[;=]/);
  if (jf) out.push(jf[1]);
  return out;
}

/** declarações TS/JS/Vue-script. */
function tsJsSymbols(line: string): string[] {
  const out: string[] = [];
  const fn = line.match(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (fn) out.push(fn[1]);
  const cls = line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (cls) out.push(cls[1]);
  // const/let/var nome = ...  (inclui arrow functions e composables)
  const decl = line.match(/\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/);
  if (decl) out.push(decl[1]);
  // export function/const/class nome
  const exp = line.match(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (exp) out.push(exp[1]);
  // método de classe/objeto: `nome(args) {` ou `nome(args):`
  const method = line.match(/^\s*(?:public|private|protected|async|static|\s)*([a-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*[:{]/);
  if (method) out.push(method[1]);
  return out;
}

/**
 * Mascara o CONTEÚDO de string literal (`"…"`, `'…'`, crase) por espaços,
 * preservando as aspas. Mensagem de erro/`@Operation(summary="… X (…")`/
 * OpenAPI têm prosa pt-BR com `palavra (` dentro da string, que dispara a
 * regex de método — o último foco de SUPERALARME (D7). Máscara mata isso sem
 * tocar em declaração real (nome declarado nunca vive dentro de string; o
 * `name:"Foo"` do Vue é extraído à parte, da linha CRUA).
 */
function maskStrings(line: string): string {
  return line.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[0]);
}

/** Vue/defineComponent: `name: "Foo"` — lido da linha CRUA (precisa do conteúdo). */
function vueComponentName(line: string): string[] {
  const m = line.match(/\bname\s*:\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/);
  return m ? [m[1]] : [];
}

/**
 * Linha é comentário/Javadoc/prosa? Comentário em pt-BR do tipo
 * `* auditável de que grantedBy consentiu que a funcionalidade` dispara as
 * regexes de declaração (texto tem `palavra (` e `palavra;`), o que vira
 * SUPERALARME no consumidor (D7 do ADR-0018). Régua precisão>recall: prosa
 * não declara símbolo — pula. Só pega linha cujo conteúdo COMEÇA com marcador
 * de comentário; declaração real com comentário no fim (`int x; // nota`)
 * segue analisada.
 */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  return (
    t.startsWith("*") ||        // corpo de Javadoc / bloco
    t.startsWith("//") ||       // linha // …
    t.startsWith("/*") ||       // abre bloco
    t.startsWith("*/") ||       // fecha bloco
    t.startsWith("#") ||        // shell/yaml/py
    t.startsWith("<!--") ||     // template Vue/HTML
    t.startsWith("-->")
  );
}

/**
 * Corta o comentário no FIM da linha (`return; // roda como antes`) antes de
 * extrair. O nome declarado sempre está ANTES do valor/comentário, então cortar
 * o rabo não perde símbolo e mata a prosa que dispara as regexes. Heurístico
 * (não parseia string): aceitável porque o corte só remove o sufixo, e o
 * identificador declarado fica intacto.
 */
function stripInlineComment(line: string): string {
  const a = line.indexOf("//");
  const b = line.indexOf("/*");
  const idx = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  return idx >= 0 ? line.slice(0, idx) : line;
}

function symbolsFromLine(path: string, line: string): string[] {
  if (isCommentLine(line)) return [];
  const code = stripInlineComment(line);
  const masked = maskStrings(code); // prosa dentro de string não é declaração
  const p = path.toLowerCase();
  if (/\.(java|kt)$/.test(p)) return javaKotlinSymbols(masked);
  if (/\.(ts|tsx|js|jsx|vue|mjs|cjs)$/.test(p)) return [...tsJsSymbols(masked), ...vueComponentName(code)];
  // linguagem desconhecida: tenta ambos (best-effort), sem inventar
  return [...javaKotlinSymbols(masked), ...tsJsSymbols(masked), ...vueComponentName(code)];
}

/** identificadores plausíveis do contexto de função do git (`@@ ... @@ ctx`). */
function symbolsFromContext(path: string, context: string): string[] {
  if (!context || isCommentLine(context)) return [];
  // o contexto é a assinatura da função/classe que contém o hunk.
  const fromDecl = symbolsFromLine(path, context);
  if (fromDecl.length) return fromDecl;
  // fallback: pega o último identificador plausível ANTES de um `(` (nome de método)
  const m = context.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (m && isUsefulIdent(m[1])) return [m[1]];
  return [];
}

/**
 * Extrai os símbolos alterados de UM arquivo do diff. Une declarações das linhas
 * `+`/`-` (o símbolo mexido) com o contexto de função dos hunks (o símbolo que
 * contém a mudança). Filtra keywords. Determinístico.
 */
export function extractChangedSymbols(file: DiffFile): string[] {
  const out = new Set<string>();
  for (const h of file.hunks) {
    for (const s of symbolsFromContext(file.path, h.context)) if (isUsefulIdent(s)) out.add(s);
    for (const line of [...h.addedLines, ...h.removedLines]) {
      for (const s of symbolsFromLine(file.path, line)) if (isUsefulIdent(s)) out.add(s);
    }
  }
  return Array.from(out);
}

/**
 * Ponto de entrada: diff unificado → símbolos alterados por arquivo.
 */
export function changedSymbolsFromDiff(diffText: string): ChangedSymbols[] {
  return parseUnifiedDiff(diffText).map((f) => ({
    path: f.path,
    status: f.status,
    symbols: extractChangedSymbols(f),
  }));
}

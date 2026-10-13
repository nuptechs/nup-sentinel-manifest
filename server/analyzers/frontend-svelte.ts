// ─────────────────────────────────────────────────────────────────────────
// OBS-D06 (ADR-0036 WS-D) — ANALYZER DE FRONTEND SVELTE (SFC).
//
// O repo já cobre Vue (SFC) · React (JSX/TSX) · Angular em
// `frontend-analyzer.ts`, mas .svelte cai em `detectFileType → null` (é
// ignorado hoje). Este módulo parseia um componente Svelte DE VERDADE e emite
// nós/arestas rastreáveis para o grafo de sistema (mesmo contrato
// `RawSystemNode`/`RawSystemEdge` do `system-graph.ts`), seguindo o padrão
// INERTE do `field-graph.ts` (OBS-D05): construtores puros + um produtor
// `mergeSvelteGraph` mesclável, SEM fiação no pipeline — nenhum consumidor o
// chama ainda, logo o grafo servido continua byte-a-byte e boot/deploy não
// mudam. A régua D2 (0037) nasce ◐: código real e provado por fixture, inerte.
//
// O QUE É PARSEADO (real, não stub):
//  • COMPONENTE — o próprio `.svelte` vira um nó `COMPONENT` (vocabulário CM1).
//  • IMPORTS — os `<script>`/`<script context="module">` são parseados com o
//    MESMO parser TS do resto do frontend (`parseTypeScript`); cada
//    `import … from '…'` vira um nó de módulo + aresta `IMPORTS`.
//  • SÍMBOLOS — declarações de topo do script (`let`/`const`/`function`/`class`
//    + reativos `$:`) viram nós `symbol:` ligados ao componente por `DECLARES`.
//  • BINDING→SÍMBOLO — a marcação Svelte (`bind:`, `on:`, mustaches `{expr}`,
//    `{#each … as}`, auto-subscription `$store`) é varrida; cada binding que
//    referencia um símbolo declarado OU um import vira uma aresta `BINDS`
//    binding→símbolo, carregando no metadata o tipo de binding e a linha.
//
// HONESTIDADE (régua da 0037 + README §métodos de aresta):
//  • import é fato sintático → `resolution:'import'` (STATIC_PROVEN no censo).
//  • binding→símbolo é casado por NOME no escopo do arquivo (sem type-checker)
//    → `resolution:'convention-name'` (STATIC_UNRESOLVED 0.40 — heurística
//    honesta, não prova). Binding cujo alvo NÃO existe no script → NÃO inventa
//    símbolo flutuante; conta em `bindingSymbolUnresolved`.
//  • PURO: nada aqui lança nem faz I/O; `mergeSvelteGraph` clona o grafo.
// ─────────────────────────────────────────────────────────────────────────

import _ts from "typescript";
import { parseTypeScript, getLineNumber } from "./frontend/parsers";
import type { RawSystemNode, RawSystemEdge } from "./system-graph";

import ts = _ts;

export const SVELTE_REL = {
  /** componente → módulo importado. */
  IMPORTS: "IMPORTS",
  /** componente → símbolo que ele declara (let/const/function/$:). */
  DECLARES: "DECLARES",
  /** binding da marcação → símbolo/import que ele referencia. */
  BINDS: "BINDS",
} as const;
export type SvelteRelation = (typeof SVELTE_REL)[keyof typeof SVELTE_REL];

/** Natureza do símbolo declarado no `<script>`. */
export type SvelteSymbolKind = "var" | "function" | "class" | "reactive" | "import";

/** Tipo de binding encontrado na marcação. */
export type SvelteBindingKind = "bind" | "on" | "mustache" | "each" | "store";

const C_PREFIX = "component:svelte:";
const S_PREFIX = "symbol:svelte:";
const M_PREFIX = "module:";

// `#`/`:` são separadores de id de símbolo — escapam p/ parse reversível.
function enc(s: string): string {
  return s.replace(/%/g, "%25").replace(/#/g, "%23").replace(/:/g, "%3A");
}

/** Normaliza o path (sep `/`, sem `./` líder) p/ id estável multiplataforma. */
export function normalizeSveltePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** id do nó-componente de um `.svelte`. Determinístico e reversível. */
export function svelteComponentId(filePath: string): string {
  return `${C_PREFIX}${normalizeSveltePath(filePath)}`;
}

/** Nome do componente a partir do arquivo (ex.: `src/Foo.svelte` → `Foo`). */
export function svelteComponentName(filePath: string): string {
  const base = normalizeSveltePath(filePath).split("/").pop() || filePath;
  return base.replace(/\.svelte$/i, "");
}

/** id de um símbolo declarado no script de um componente. */
export function svelteSymbolId(filePath: string, name: string): string {
  return `${S_PREFIX}${enc(normalizeSveltePath(filePath))}#${enc(name)}`;
}

/** id de um nó-módulo importado (bruto, pelo especificador do import). */
export function svelteModuleId(specifier: string): string {
  return `${M_PREFIX}${specifier}`;
}

export interface SvelteImport {
  specifier: string;
  /** bindings trazidos pelo import (default/named/namespace), p/ casar bindings. */
  names: string[];
  line: number;
}
export interface SvelteSymbol {
  name: string;
  kind: SvelteSymbolKind;
  line: number;
}
export interface SvelteBinding {
  kind: SvelteBindingKind;
  /** nome do símbolo referenciado (já resolvido a um identificador raiz). */
  symbol: string;
  /** detalhe cru do binding (ex.: `on:click`, `bind:value`). */
  raw: string;
  line: number;
}

export interface SvelteComponentModel {
  filePath: string;
  componentId: string;
  componentName: string;
  imports: SvelteImport[];
  symbols: SvelteSymbol[];
  bindings: SvelteBinding[];
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const JS_KEYWORDS = new Set([
  "true", "false", "null", "undefined", "this", "new", "typeof", "void",
  "if", "else", "return", "await", "async", "function", "const", "let", "var",
  "in", "of", "instanceof", "class", "import", "export", "default",
]);

/** Extrai o identificador-raiz de uma expressão de binding (ex.: `user.name` →
 *  `user`; `$store` → `store`; `() => save()` → `save`). Heurística honesta. */
function rootIdentifiers(expr: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IDENT_RE.lastIndex = 0;
  // casa também $store (auto-subscription) removendo o `$` líder ao casar símbolo.
  const scan = expr.replace(/\$([A-Za-z_])/g, "$1");
  while ((m = IDENT_RE.exec(scan)) !== null) {
    const id = m[0];
    // descarta acesso a membro: só o identificador-raiz conta (não `.name`).
    if (m.index > 0 && scan[m.index - 1] === ".") continue;
    if (JS_KEYWORDS.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Remove blocos `<script>`/`<style>` deixando só a marcação (p/ varrer bindings). */
function stripScriptStyle(content: string): string {
  return content
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "));
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

/** Extrai imports + símbolos de topo de um bloco de script via parser TS real. */
function parseScriptBlock(
  filePath: string,
  script: string,
): { imports: SvelteImport[]; symbols: SvelteSymbol[] } {
  const imports: SvelteImport[] = [];
  const symbols: SvelteSymbol[] = [];
  let sf: ts.SourceFile;
  try {
    sf = parseTypeScript(script, filePath.replace(/\.svelte$/i, ".ts"));
  } catch {
    return { imports, symbols };
  }

  for (const stmt of sf.statements) {
    const line = getLineNumber(sf, stmt.getStart(sf));

    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const names: string[] = [];
      const clause = stmt.importClause;
      if (clause) {
        if (clause.name) names.push(clause.name.text); // default
        const nb = clause.namedBindings;
        if (nb) {
          if (ts.isNamespaceImport(nb)) names.push(nb.name.text);
          else if (ts.isNamedImports(nb)) for (const el of nb.elements) names.push(el.name.text);
        }
      }
      imports.push({ specifier: stmt.moduleSpecifier.text, names, line });
      for (const n of names) symbols.push({ name: n, kind: "import", line });
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) symbols.push({ name: d.name.text, kind: "var", line });
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      symbols.push({ name: stmt.name.text, kind: "function", line });
      continue;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      symbols.push({ name: stmt.name.text, kind: "class", line });
      continue;
    }
    // Reativo Svelte `$: foo = …` → LabeledStatement com label `$`.
    if (ts.isLabeledStatement(stmt) && stmt.label.text === "$") {
      const body = stmt.statement;
      if (ts.isExpressionStatement(body) && ts.isBinaryExpression(body.expression)
        && body.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(body.expression.left)) {
        symbols.push({ name: body.expression.left.text, kind: "reactive", line });
      }
    }
  }
  return { imports, symbols };
}

/**
 * Parseia um componente Svelte e devolve o modelo (componente, imports,
 * símbolos, bindings). PURO: não lança (falha de parse = modelo parcial).
 */
export function analyzeSvelteComponent(filePath: string, content: string): SvelteComponentModel {
  const componentId = svelteComponentId(filePath);
  const componentName = svelteComponentName(filePath);
  const imports: SvelteImport[] = [];
  const symbols: SvelteSymbol[] = [];

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(content)) !== null) {
    const body = sm[2];
    const parsed = parseScriptBlock(filePath, body);
    imports.push(...parsed.imports);
    symbols.push(...parsed.symbols);
  }

  const markup = stripScriptStyle(content);
  const bindings: SvelteBinding[] = [];
  // Registra TODA referência da marcação (o parser é honesto sobre o que o
  // template cita); a resolução a um símbolo declarado × não-declarado é feita
  // pelo PRODUTOR (`mergeSvelteGraph`), espelhando `field-graph` (owner resolvido
  // × `fieldOwnerUnresolved`).
  const pushBinding = (kind: SvelteBindingKind, raw: string, expr: string, index: number) => {
    const line = lineOf(content, index);
    for (const id of rootIdentifiers(expr)) {
      bindings.push({ kind, symbol: id, raw, line });
    }
  };

  // bind:prop={expr} e bind:prop (shorthand → expr = prop)
  const bindRe = /\bbind:([A-Za-z_][\w-]*)(?:=\{([^}]*)\})?/g;
  let m: RegExpExecArray | null;
  while ((m = bindRe.exec(markup)) !== null) {
    pushBinding("bind", `bind:${m[1]}`, m[2] ?? m[1], m.index);
  }
  // on:event={handler}
  const onRe = /\bon:([A-Za-z_][\w-]*)=\{([^}]*)\}/g;
  while ((m = onRe.exec(markup)) !== null) {
    pushBinding("on", `on:${m[1]}`, m[2], m.index);
  }
  // {#each expr as …} — referencia o símbolo iterado
  const eachRe = /\{#each\s+([^}]+?)\s+as\b/g;
  while ((m = eachRe.exec(markup)) !== null) {
    pushBinding("each", "{#each}", m[1], m.index);
  }
  // mustaches genéricos {expr} — exclui blocos de controle {#…}{/…}{:…}
  const mustacheRe = /\{(?![#/:@])([^}]+)\}/g;
  while ((m = mustacheRe.exec(markup)) !== null) {
    const expr = m[1];
    const storeMatch = /\$([A-Za-z_]\w*)/.test(expr);
    pushBinding(storeMatch ? "store" : "mustache", storeMatch ? "$store" : "{expr}", expr, m.index);
  }

  return { filePath, componentId, componentName, imports, symbols, bindings };
}

// ── construtores puros de nós/arestas (mesmo contrato de system-graph) ──

export function makeSvelteComponentNode(model: SvelteComponentModel): RawSystemNode {
  return {
    id: model.componentId,
    type: "COMPONENT",
    className: model.componentName,
    metadata: { framework: "svelte", sourceFile: normalizeSveltePath(model.filePath) },
  };
}

export function makeSvelteSymbolNode(filePath: string, sym: SvelteSymbol): RawSystemNode {
  return {
    id: svelteSymbolId(filePath, sym.name),
    type: "SYMBOL",
    className: sym.name,
    metadata: { symbolKind: sym.kind, sourceFile: normalizeSveltePath(filePath), line: sym.line },
  };
}

export interface SvelteGraphStats {
  componentsAdded: number;
  symbolNodesAdded: number;
  importEdges: number;
  declaresEdges: number;
  bindsEdges: number;
  /** binding cujo símbolo-alvo não existe no script → não atribui (honesto). */
  bindingSymbolUnresolved: number;
}

interface MinimalGraph {
  nodes: RawSystemNode[];
  edges: RawSystemEdge[];
}

function zeroStats(): SvelteGraphStats {
  return { componentsAdded: 0, symbolNodesAdded: 0, importEdges: 0, declaresEdges: 0, bindsEdges: 0, bindingSymbolUnresolved: 0 };
}

/**
 * Produtor: mescla o(s) componente(s) Svelte como subgrafo. PURO (clona o
 * grafo), dedup por id de nó e por tripla de aresta, INERTE (nenhum pipeline
 * chama isto). Só processa `.svelte` (ignora o resto sem erro).
 */
export function mergeSvelteGraph<G extends MinimalGraph>(
  rawGraph: G | null | undefined,
  files: { filePath: string; content: string }[] | null | undefined,
): { graph: G; stats: SvelteGraphStats } {
  const stats = zeroStats();
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) {
    return { graph: rawGraph as G, stats };
  }
  const svelteFiles = (files ?? []).filter((f) => f && typeof f.filePath === "string" && /\.svelte$/i.test(f.filePath));
  if (svelteFiles.length === 0) return { graph: rawGraph, stats };

  const graph = { ...rawGraph, nodes: rawGraph.nodes.slice(), edges: rawGraph.edges.slice() } as G;
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  const seenEdge = new Set<string>();
  for (const e of graph.edges) seenEdge.add(`${e.fromNode}|${e.toNode}|${e.relationType}`);

  const addNode = (n: RawSystemNode): boolean => {
    if (existingIds.has(n.id)) return false;
    existingIds.add(n.id);
    graph.nodes.push(n);
    return true;
  };
  const addEdge = (e: RawSystemEdge): boolean => {
    const key = `${e.fromNode}|${e.toNode}|${e.relationType}`;
    if (seenEdge.has(key)) return false;
    seenEdge.add(key);
    graph.edges.push(e);
    return true;
  };

  for (const file of svelteFiles) {
    let model: SvelteComponentModel;
    try {
      model = analyzeSvelteComponent(file.filePath, file.content ?? "");
    } catch {
      continue; // fail-soft por arquivo
    }
    if (addNode(makeSvelteComponentNode(model))) stats.componentsAdded++;

    for (const sym of model.symbols) {
      if (addNode(makeSvelteSymbolNode(file.filePath, sym))) stats.symbolNodesAdded++;
      if (addEdge({ fromNode: model.componentId, toNode: svelteSymbolId(file.filePath, sym.name), relationType: SVELTE_REL.DECLARES, metadata: { resolution: "convention-name", symbolKind: sym.kind } })) {
        stats.declaresEdges++;
      }
    }

    for (const imp of model.imports) {
      const modId = svelteModuleId(imp.specifier);
      addNode({ id: modId, type: "MODULE", className: imp.specifier, metadata: { framework: "svelte" } });
      if (addEdge({ fromNode: model.componentId, toNode: modId, relationType: SVELTE_REL.IMPORTS, metadata: { resolution: "import", names: imp.names, line: imp.line } })) {
        stats.importEdges++;
      }
    }

    const declared = new Set(model.symbols.map((s) => s.name));
    for (const b of model.bindings) {
      if (!declared.has(b.symbol)) { stats.bindingSymbolUnresolved++; continue; }
      const symId = svelteSymbolId(file.filePath, b.symbol);
      if (addEdge({ fromNode: model.componentId, toNode: symId, relationType: SVELTE_REL.BINDS, metadata: { resolution: "convention-name", bindingKind: b.kind, raw: b.raw, line: b.line } })) {
        stats.bindsEdges++;
      }
    }
  }

  return { graph, stats };
}

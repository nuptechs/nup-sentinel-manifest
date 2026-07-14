// ─────────────────────────────────────────────
// Call-chain multi-hop do backend Node — ADR-0015 Onda 2, D7.
//
// Responde: "a partir desta função (handler de rota Express), quais tabelas
// Drizzle são tocadas — mesmo quando o acesso está a N arquivos de distância
// (handler → service → repo → db.insert(tabela))?" É o análogo Node do que o
// analisador Java faz com CALLS→WRITES_ENTITY/READS_ENTITY + walkChain.
//
// Arquitetura: espelho do global-call-graph do frontend (indexação AST por
// chave "filePath::fn", import bindings, travessia com anti-ciclo), com o
// payload trocado de HttpCall para DrizzleTouch. Espelhado, não importado —
// o módulo do frontend carrega heurísticas de Vue/React Query que não se
// aplicam aqui (decisão da exploração da Onda 2).
//
// REGRA DE OURO (conservadora): só liga o que dá pra provar por declaração
// local ou import resolvido. Na dúvida — símbolo não encontrado, resolução
// ambígua, dispatch dinâmico — NÃO liga (falso negativo > falso positivo).
// Fora de escopo, documentado: dynamic dispatch (handlers[k]()), DI containers,
// cadeias de re-export/barrel (export * from), callbacks higher-order
// (arr.map(fn)), herança/super, pacotes npm, aliases tsconfig arbitrários.
//
// Vive atrás de MANIFEST_MULTISTACK_NODE (só o parser Express o invoca).
// DEFAULT OFF ⇒ ninguém chama este módulo ⇒ pipeline byte-a-byte (G2).
// ON ⇒ apenas ENRIQUECE catalog entries que só existem com a flag (G3).
// ─────────────────────────────────────────────

import _ts from "typescript";
import { parseTypeScript } from "../frontend/parsers";
import type { DrizzleEntity } from "./drizzle-schema";

import ts = _ts;

// Tetos de segurança: estourou ⇒ o chamador degrada para o scan same-file
// (o pipeline nunca quebra por causa do resolver).
export const MAX_CALL_DEPTH = 15; // paridade com walkChain (application-graph)
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1_500_000;
const MAX_NODES = 50_000;

export interface DrizzleTouch {
  /** Nome da tabela no banco (identidade da entidade, ex.: webhook_event). */
  entity: string;
  op: "read" | "write" | "delete";
}

export interface BackendFnNode {
  /** Chave global "filePath::fnName" (fnName pode ser qualificado: "svc.method"). */
  key: string;
  filePath: string;
  functionName: string;
  /** Toques Drizzle DIRETOS no corpo desta função (as folhas do grafo). */
  touches: DrizzleTouch[];
  /** Chaves globais das funções que esta chama (já resolvidas; só o provável). */
  callees: Set<string>;
}

export type BackendCallGraph = Map<string, BackendFnNode>;

export function makeBackendKey(filePath: string, fnName: string): string {
  return filePath + "::" + fnName;
}

const BACKEND_EXTS = [".ts", ".js", ".tsx", ".jsx"];
const SKIP_PATH = /node_modules|\bdist\/|\bbuild\/|__tests__/;

function isCandidateFile(f: { filePath: string; content: string }): boolean {
  if (f.filePath.endsWith(".java")) return false;
  if (SKIP_PATH.test(f.filePath)) return false;
  const ext = f.filePath.substring(f.filePath.lastIndexOf("."));
  if (!BACKEND_EXTS.includes(ext)) return false;
  if (f.content.length > MAX_FILE_BYTES) return false;
  return true;
}

/**
 * Resolve um module specifier para um path do projeto. Relativos com
 * extensões/index.*; alias `@/`/`~/` com roots derivados do próprio importador
 * (todo prefixo que termina em src/) + convenções. Pacote npm ⇒ null.
 * Lookup em Set — O(1), sem o indexOf linear do normalizeModulePath do frontend.
 */
export function resolveBackendModulePath(
  importerPath: string,
  spec: string,
  pathSet: Set<string>,
): string | null {
  const EXTS = ["", ".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"];

  const tryBase = (base: string): string | null => {
    for (const ext of EXTS) {
      const candidate = base + ext;
      if (pathSet.has(candidate)) return candidate;
    }
    return null;
  };

  if (spec.startsWith(".")) {
    const importerDir = importerPath.substring(0, importerPath.lastIndexOf("/"));
    const resolved: string[] = importerDir ? importerDir.split("/") : [];
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") {
        resolved.pop();
        continue;
      }
      resolved.push(seg);
    }
    return tryBase(resolved.join("/"));
  }

  if (spec.startsWith("@/") || spec.startsWith("~/")) {
    const rest = spec.substring(2);
    // Roots candidatos: cada prefixo do importador que termina em "src/"
    // (ex.: services/gateway/src/) + convenções comuns.
    const roots = new Set<string>();
    const parts = importerPath.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === "src") roots.add(parts.slice(0, i + 1).join("/") + "/");
    }
    roots.add("src/");
    roots.add("server/");
    roots.add("");
    for (const root of Array.from(roots)) {
      const hit = tryBase(root + rest);
      if (hit) return hit;
    }
    return null;
  }

  return null; // bare specifier (npm) — fora de escopo, de propósito.
}

// `from "x"` / `require("x")` / `import("x")` — só pra computar o FECHO de
// imports a partir dos arquivos de rota (evita parsear o repo inteiro).
const MODULE_SPEC_RE =
  /\bfrom\s*['"`]([^'"`]+)['"`]|\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

function importClosure(
  entryFiles: string[],
  byPath: Map<string, string>,
  pathSet: Set<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue = entryFiles.filter((p) => byPath.has(p));
  while (queue.length > 0 && seen.size < MAX_FILES) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const content = byPath.get(path)!;
    MODULE_SPEC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MODULE_SPEC_RE.exec(content)) !== null) {
      const spec = m[1] || m[2] || m[3];
      const resolved = resolveBackendModulePath(path, spec, pathSet);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

interface ImportBinding {
  sourcePath: string;
  originalName: string; // "default" | "*" | nome exportado
}

/** Espelho do parseImportBindingsInternal do frontend, com resolução própria. */
function parseImports(
  sourceFile: ts.SourceFile,
  importerPath: string,
  pathSet: Set<string>,
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveBackendModulePath(
        importerPath,
        node.moduleSpecifier.text,
        pathSet,
      );
      if (resolved && node.importClause) {
        if (node.importClause.name) {
          bindings.set(node.importClause.name.text, {
            sourcePath: resolved,
            originalName: "default",
          });
        }
        const named = node.importClause.namedBindings;
        if (named) {
          if (ts.isNamedImports(named)) {
            for (const spec of named.elements) {
              bindings.set(spec.name.text, {
                sourcePath: resolved,
                originalName: spec.propertyName ? spec.propertyName.text : spec.name.text,
              });
            }
          } else if (ts.isNamespaceImport(named)) {
            bindings.set(named.name.text, { sourcePath: resolved, originalName: "*" });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

// ── Indexação de funções de um arquivo ──

interface IndexedFn {
  /** Nome canônico: "fn", "Class.method" ou "objLiteral.method". */
  canonical: string;
  node: ts.Node;
}

interface FileIndex {
  /** nome (plano OU qualificado) → chave canônica global. Primeiro vence. */
  names: Map<string, string>;
  fns: IndexedFn[];
  imports: Map<string, ImportBinding>;
  /** variável local → nome da classe (const r = new Repo()). */
  instanceTypes: Map<string, string>;
}

/** Dono de uma função declarada dentro de object literal: `const svc = { fn(){} }`. */
function objectLiteralOwner(node: ts.Node): string | null {
  const obj = node.parent;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return null;
  const decl = obj.parent;
  if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    return decl.name.text;
  }
  return null;
}

function indexFile(sourceFile: ts.SourceFile): Omit<FileIndex, "imports"> {
  const names = new Map<string, string>();
  const fns: IndexedFn[] = [];
  const instanceTypes = new Map<string, string>();
  let currentClass: string | null = null;

  const register = (canonical: string, node: ts.Node, aliases: string[]) => {
    fns.push({ canonical, node });
    for (const alias of [canonical, ...aliases]) {
      if (!names.has(alias)) names.set(alias, canonical);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node)) {
      const prev = currentClass;
      currentClass = node.name ? node.name.text : null;
      ts.forEachChild(node, visit);
      currentClass = prev;
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      register(node.name.text, node, []);
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const method = node.name.text;
      const owner = currentClass ?? objectLiteralOwner(node);
      if (owner) register(`${owner}.${method}`, node, [method]);
      else register(method, node, []);
    } else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      node.parent
    ) {
      const p = node.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
        register(p.name.text, node, []);
      } else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
        const owner = currentClass ?? objectLiteralOwner(p);
        if (owner) register(`${owner}.${p.name.text}`, node, [p.name.text]);
        else register(p.name.text, node, []);
      } else if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) {
        const owner = currentClass;
        if (owner) register(`${owner}.${p.name.text}`, node, [p.name.text]);
        else register(p.name.text, node, []);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression)
    ) {
      instanceTypes.set(node.name.text, node.initializer.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { names, fns, instanceTypes };
}

// ── Extração de toques Drizzle e callees do corpo de uma função ──

/** Candidato a callee ainda não resolvido: nomes em ordem de preferência. */
interface CalleeCandidate {
  filePath: string;
  names: string[];
}

function fnBody(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.body ?? null;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.body;
  return null;
}

const WRITE_METHODS = new Set(["insert", "update"]);

function walkFnBody(
  body: ts.Node,
  filePath: string,
  fileIdx: FileIndex,
  currentOwner: string | null,
  drizzle: Map<string, DrizzleEntity>,
): { touches: DrizzleTouch[]; candidates: CalleeCandidate[] } {
  const touches: DrizzleTouch[] = [];
  const candidates: CalleeCandidate[] = [];

  const addTouch = (symbol: string, op: DrizzleTouch["op"]) => {
    const ent = drizzle.get(symbol);
    if (ent) touches.push({ entity: ent.entity, op });
  };

  const visit = (node: ts.Node) => {
    // `db.query.<sym>` — leitura via query API do Drizzle.
    if (
      ts.isPropertyAccessExpression(node) &&
      drizzle.has(node.name.text) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "query"
    ) {
      addTouch(node.name.text, "read");
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      // Folhas Drizzle: .insert(sym)/.update(sym) → write; .delete(sym) → delete;
      // .from(sym) → read. Símbolo validado contra o índice do schema.
      if (ts.isPropertyAccessExpression(expr) && node.arguments.length > 0) {
        const method = expr.name.text;
        const arg0 = node.arguments[0];
        if (ts.isIdentifier(arg0) && drizzle.has(arg0.text)) {
          if (WRITE_METHODS.has(method)) addTouch(arg0.text, "write");
          else if (method === "delete") addTouch(arg0.text, "delete");
          else if (method === "from") addTouch(arg0.text, "read");
        }
      }

      // Callees. Regra de ouro: só declaração local ou import resolvido.
      if (ts.isIdentifier(expr)) {
        const name = expr.text;
        const imported = fileIdx.imports.get(name);
        if (imported) {
          candidates.push({ filePath: imported.sourcePath, names: [imported.originalName] });
        } else if (fileIdx.names.has(name)) {
          candidates.push({ filePath, names: [name] });
        }
      } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
        const method = expr.name.text;
        const obj = expr.expression;
        if (obj.kind === ts.SyntaxKind.ThisKeyword && currentOwner) {
          candidates.push({ filePath, names: [`${currentOwner}.${method}`, method] });
        } else if (ts.isIdentifier(obj)) {
          const objName = obj.text;
          const imported = fileIdx.imports.get(objName);
          if (imported) {
            // Namespace (`import * as svc`) chama exportado direto; objeto
            // nomeado/default chama membro qualificado no arquivo de origem.
            const names =
              imported.originalName === "*"
                ? [method]
                : [`${imported.originalName}.${method}`];
            candidates.push({ filePath: imported.sourcePath, names });
          } else if (fileIdx.instanceTypes.has(objName)) {
            // `const r = new Repo()` — a classe pode ser local ou importada.
            const className = fileIdx.instanceTypes.get(objName)!;
            const classImport = fileIdx.imports.get(className);
            candidates.push(
              classImport
                ? {
                    filePath: classImport.sourcePath,
                    names: [`${classImport.originalName}.${method}`],
                  }
                : { filePath, names: [`${className}.${method}`] },
            );
          } else if (fileIdx.names.has(`${objName}.${method}`)) {
            candidates.push({ filePath, names: [`${objName}.${method}`] });
          }
          // objName desconhecido ⇒ não liga (dynamic dispatch/DI ficam de fora).
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { touches, candidates };
}

export interface BackendCallChain {
  graph: BackendCallGraph;
  /**
   * Resolve os nomes CHAMADOS num trecho de código (`fn(...)`, `obj.method(...)`)
   * do arquivo dado para chaves existentes no grafo — as seeds da travessia.
   * Mesmas regras de resolução do grafo (imports/locais/instâncias); nome que
   * não resolve não vira seed. Uso: args da rota Express (trecho regex, sem AST).
   */
  seedsFor(filePath: string, snippet: string): string[];
}

// `ident(` ou `obj.method(` num trecho de código.
const SNIPPET_CALL_RE =
  /\b([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g;

const JS_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "await", "async",
  "function", "new", "typeof", "delete", "void", "throw", "do", "else",
]);

function buildInternal(
  files: { filePath: string; content: string }[],
  drizzle: Map<string, DrizzleEntity>,
  opts?: { entryFiles?: string[] },
): { graph: BackendCallGraph; fileIndexes: Map<string, FileIndex> } {
  const graph: BackendCallGraph = new Map();

  const candidates = files.filter(isCandidateFile);
  const byPath = new Map(candidates.map((f) => [f.filePath, f.content]));
  const pathSet = new Set(byPath.keys());

  let scope: string[];
  if (opts?.entryFiles && opts.entryFiles.length > 0) {
    scope = Array.from(importClosure(opts.entryFiles, byPath, pathSet));
  } else {
    scope = Array.from(byPath.keys()).slice(0, MAX_FILES);
  }
  if (scope.length >= MAX_FILES) {
    console.log(
      `[node-backend] call-chain: teto de ${MAX_FILES} arquivos atingido — cobertura parcial (degrada para same-file scan no excedente)`,
    );
  }

  // Passe 1: indexa funções e imports de cada arquivo do escopo.
  const fileIndexes = new Map<string, FileIndex>();
  for (const path of scope) {
    const content = byPath.get(path);
    if (content === undefined) continue;
    try {
      const sourceFile = parseTypeScript(content, path);
      const idx = indexFile(sourceFile);
      fileIndexes.set(path, {
        ...idx,
        imports: parseImports(sourceFile, path, pathSet),
      });
    } catch {
      // Arquivo que não parseia não entra no grafo — degrade silencioso local.
    }
  }

  // Passe 2: cria nós com toques e candidatos; resolve callees no passe 3
  // (quando todos os nomes de todos os arquivos já são conhecidos).
  const rawCallees = new Map<string, CalleeCandidate[]>();
  for (const [path, fileIdx] of Array.from(fileIndexes.entries())) {
    for (const fn of fileIdx.fns) {
      if (graph.size >= MAX_NODES) {
        console.log(`[node-backend] call-chain: teto de ${MAX_NODES} nós atingido`);
        break;
      }
      const key = makeBackendKey(path, fn.canonical);
      if (graph.has(key)) continue;
      const body = fnBody(fn.node);
      const owner = fn.canonical.includes(".") ? fn.canonical.split(".")[0] : null;
      const { touches, candidates: cands } = body
        ? walkFnBody(body, path, fileIdx, owner, drizzle)
        : { touches: [], candidates: [] };
      graph.set(key, {
        key,
        filePath: path,
        functionName: fn.canonical,
        touches,
        callees: new Set(),
      });
      rawCallees.set(key, cands);
    }
  }

  // Passe 3: resolve candidatos → chaves canônicas existentes. Não achou ⇒ não liga.
  for (const [key, cands] of Array.from(rawCallees.entries())) {
    const node = graph.get(key)!;
    for (const cand of cands) {
      const targetIdx = fileIndexes.get(cand.filePath);
      if (!targetIdx) continue;
      for (const name of cand.names) {
        const canonical = targetIdx.names.get(name);
        if (canonical) {
          const targetKey = makeBackendKey(cand.filePath, canonical);
          if (targetKey !== key && graph.has(targetKey)) node.callees.add(targetKey);
          break;
        }
      }
    }
  }

  return { graph, fileIndexes };
}

/** Só o grafo (API dos testes unitários e de quem não precisa de seeds). */
export function buildBackendCallGraph(
  files: { filePath: string; content: string }[],
  drizzle: Map<string, DrizzleEntity>,
  opts?: { entryFiles?: string[] },
): BackendCallGraph {
  return buildInternal(files, drizzle, opts).graph;
}

/** Grafo + resolvedor de seeds para trechos de código (args de rota Express). */
export function buildBackendCallChain(
  files: { filePath: string; content: string }[],
  drizzle: Map<string, DrizzleEntity>,
  opts?: { entryFiles?: string[] },
): BackendCallChain {
  const { graph, fileIndexes } = buildInternal(files, drizzle, opts);

  const seedsFor = (filePath: string, snippet: string): string[] => {
    const fileIdx = fileIndexes.get(filePath);
    if (!fileIdx) return [];
    const seeds: string[] = [];

    const tryPush = (targetFile: string, names: string[]) => {
      const idx = fileIndexes.get(targetFile);
      if (!idx) return;
      for (const name of names) {
        const canonical = idx.names.get(name);
        if (canonical) {
          const key = makeBackendKey(targetFile, canonical);
          if (graph.has(key) && !seeds.includes(key)) seeds.push(key);
          return;
        }
      }
    };

    SNIPPET_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SNIPPET_CALL_RE.exec(snippet)) !== null) {
      const [, first, second] = m;
      if (JS_KEYWORDS.has(first) || (second && JS_KEYWORDS.has(second))) continue;

      if (second) {
        const imported = fileIdx.imports.get(first);
        if (imported) {
          tryPush(
            imported.sourcePath,
            imported.originalName === "*" ? [second] : [`${imported.originalName}.${second}`],
          );
        } else if (fileIdx.instanceTypes.has(first)) {
          const className = fileIdx.instanceTypes.get(first)!;
          const classImport = fileIdx.imports.get(className);
          if (classImport) tryPush(classImport.sourcePath, [`${classImport.originalName}.${second}`]);
          else tryPush(filePath, [`${className}.${second}`]);
        } else {
          tryPush(filePath, [`${first}.${second}`]);
        }
      } else {
        const imported = fileIdx.imports.get(first);
        if (imported) tryPush(imported.sourcePath, [imported.originalName]);
        else tryPush(filePath, [first]);
      }
    }
    return seeds;
  };

  return { graph, seedsFor };
}

export interface CallChainResolution {
  /** Toques únicos (entity+op), ordenados por entity, depois op. */
  touches: DrizzleTouch[];
  /** Primeira cadeia encontrada até um toque: ["file::fn", ...]. Vazia se nada. */
  chain: string[];
}

/**
 * Percorre o grafo a partir das seeds (chaves globais) coletando os toques
 * Drizzle alcançáveis. DFS memoizada com color-marking (cinza corta ciclo),
 * profundidade ≤ maxDepth (default 15, paridade com o walkChain do Java).
 */
export function resolveTouches(
  seedKeys: string[],
  graph: BackendCallGraph,
  maxDepth: number = MAX_CALL_DEPTH,
): CallChainResolution {
  const memo = new Map<string, { touches: DrizzleTouch[]; chain: string[] }>();
  const gray = new Set<string>();

  const visit = (key: string, depth: number): { touches: DrizzleTouch[]; chain: string[] } => {
    if (depth > maxDepth) return { touches: [], chain: [] };
    const done = memo.get(key);
    if (done) return done;
    if (gray.has(key)) return { touches: [], chain: [] }; // ciclo — corta.
    const node = graph.get(key);
    if (!node) return { touches: [], chain: [] };

    gray.add(key);
    const touches: DrizzleTouch[] = [...node.touches];
    let chain: string[] = node.touches.length > 0 ? [key] : [];
    for (const callee of Array.from(node.callees)) {
      const sub = visit(callee, depth + 1);
      touches.push(...sub.touches);
      if (chain.length === 0 && sub.chain.length > 0) chain = [key, ...sub.chain];
    }
    gray.delete(key);

    const result = { touches, chain };
    memo.set(key, result);
    return result;
  };

  const all: DrizzleTouch[] = [];
  let chain: string[] = [];
  for (const seed of seedKeys) {
    const r = visit(seed, 0);
    all.push(...r.touches);
    if (chain.length === 0 && r.chain.length > 0) chain = r.chain;
  }

  const seen = new Set<string>();
  const touches = all
    .filter((t) => {
      const k = `${t.entity} ${t.op}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.op.localeCompare(b.op));

  return { touches, chain };
}

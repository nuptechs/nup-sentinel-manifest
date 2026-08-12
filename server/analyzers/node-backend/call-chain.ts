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
// DENTRO do escopo (tudo ainda por prova sintática, nunca por chute):
//   · aliases do tsconfig (compilerOptions.paths/baseUrl, tsconfig*.json do
//     próprio payload — o que fazia a cadeia parar antes de packages/core);
//   · barrels/re-exports (`export * from`, `export { x } from`, `export * as ns`);
//   · DI simples por construtor (parameter property tipada, `this.x = param`
//     tipado, `this.x = new Classe()`) — `this.repo.save()` resolve pela
//     ANOTAÇÃO DE TIPO do membro, que é declaração, não runtime.
// Fora de escopo, documentado: dynamic dispatch (handlers[k]()), DI por
// CONTAINER (token/decorator — awilix/inversify/nest), callbacks higher-order
// (arr.map(fn)), herança/super, pacotes npm, DI por interface (impl ≠ tipo).
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

// ── Aliases do tsconfig (compilerOptions.paths) ──
// O payload pode conter tsconfig.json/tsconfig.*.json (o scanner os aceita por
// basename). Cada config vira um conjunto de padrões `@core/* → packages/core/
// src/*`, ESCOPADO ao diretório do próprio tsconfig (config mais próxima do
// importador vence — semântica de monorepo). Parsing JSONC fail-soft: config
// quebrada é ignorada, nunca derruba o resolver. `extends` fora de escopo — em
// monorepo cada pacote com paths próprios já cobre o caso real.

interface TsconfigPattern {
  /** parte antes do `*` (ou a chave inteira, se exata). */
  prefix: string;
  /** parte depois do `*`. */
  suffix: string;
  exact: boolean;
  /** bases já resolvidas contra dir+baseUrl; `*` preservado p/ substituição. */
  targets: string[];
}

export interface TsconfigPathsIndex {
  /** ordenado por dir mais específico primeiro (config mais próxima vence). */
  configs: { dir: string; patterns: TsconfigPattern[] }[];
}

const TSCONFIG_BASENAME_RE = /(^|\/)tsconfig(\.[\w.-]+)?\.json$/;

/** Remove comentários (fora de strings) e vírgulas finais — tsconfig é JSONC. */
function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/** Join relativo determinístico ("a/b" + "../c" → "a/c"), sem fs. */
function joinRelative(dir: string, rel: string): string {
  const out: string[] = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Indexa os `compilerOptions.paths` de todo tsconfig*.json do payload. */
export function buildTsconfigPathsIndex(
  files: { filePath: string; content: string }[],
): TsconfigPathsIndex {
  const configs: TsconfigPathsIndex["configs"] = [];
  for (const f of files) {
    if (!TSCONFIG_BASENAME_RE.test(f.filePath)) continue;
    try {
      const json = JSON.parse(stripJsonc(f.content)) as {
        compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> };
      };
      const co = json?.compilerOptions;
      if (!co?.paths || typeof co.paths !== "object") continue;
      const dir = f.filePath.includes("/")
        ? f.filePath.slice(0, f.filePath.lastIndexOf("/"))
        : "";
      const base = joinRelative(dir, typeof co.baseUrl === "string" ? co.baseUrl : ".");
      const patterns: TsconfigPattern[] = [];
      for (const key of Object.keys(co.paths)) {
        const raw = co.paths[key];
        const targets = (Array.isArray(raw) ? raw : []).filter(
          (t): t is string => typeof t === "string",
        );
        if (targets.length === 0) continue;
        const star = key.indexOf("*");
        patterns.push({
          prefix: star >= 0 ? key.slice(0, star) : key,
          suffix: star >= 0 ? key.slice(star + 1) : "",
          exact: star < 0,
          targets: targets.map((t) => joinRelative(base, t)),
        });
      }
      if (patterns.length > 0) configs.push({ dir, patterns });
    } catch {
      // JSONC quebrado/exótico ⇒ config ignorada (fail-soft, nunca derruba).
    }
  }
  configs.sort((a, b) => b.dir.length - a.dir.length);
  return { configs };
}

/**
 * Resolve um module specifier para um path do projeto. Relativos com
 * extensões/index.*; aliases do tsconfig (paths — config mais próxima do
 * importador vence); alias `@/`/`~/` com roots derivados do próprio importador
 * (todo prefixo que termina em src/) + convenções. Pacote npm ⇒ null.
 * Lookup em Set — O(1), sem o indexOf linear do normalizeModulePath do frontend.
 */
export function resolveBackendModulePath(
  importerPath: string,
  spec: string,
  pathSet: Set<string>,
  aliases?: TsconfigPathsIndex,
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

  // Aliases do tsconfig ANTES da heurística `@/` — config declarada vence chute.
  // Escopo: só configs cujo dir é prefixo do importador (raiz "" vale pra todos).
  if (aliases) {
    for (const cfg of aliases.configs) {
      if (cfg.dir && importerPath !== cfg.dir && !importerPath.startsWith(cfg.dir + "/")) {
        continue;
      }
      for (const p of cfg.patterns) {
        let bases: string[];
        if (p.exact) {
          if (spec !== p.prefix) continue;
          bases = p.targets;
        } else {
          if (!spec.startsWith(p.prefix)) continue;
          if (p.suffix && !spec.endsWith(p.suffix)) continue;
          const mid = spec.slice(p.prefix.length, spec.length - p.suffix.length);
          bases = p.targets.map((t) => t.replace("*", mid));
        }
        for (const base of bases) {
          const hit = tryBase(base);
          if (hit) return hit;
        }
      }
    }
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
  aliases?: TsconfigPathsIndex,
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
      const resolved = resolveBackendModulePath(path, spec, pathSet, aliases);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

interface ImportBinding {
  sourcePath: string;
  originalName: string; // "default" | "*" | nome exportado
}

interface ParsedImports {
  bindings: Map<string, ImportBinding>;
  /** re-export nomeado do barrel: nome EXPORTADO → origem (`export {a as b} from`). */
  reexportNamed: Map<string, ImportBinding>;
  /** origens de `export * from "./x"` (ordem de declaração — 1º acerto vence). */
  reexportStars: string[];
}

/** Espelho do parseImportBindingsInternal do frontend, com resolução própria.
 *  Também indexa os RE-EXPORTS do arquivo (barrels): `export * from`,
 *  `export { a as b } from`, `export * as ns from` e `export { x }` de um
 *  binding importado — tudo declaração sintática, dentro da regra de ouro. */
function parseImports(
  sourceFile: ts.SourceFile,
  importerPath: string,
  pathSet: Set<string>,
  aliases?: TsconfigPathsIndex,
): ParsedImports {
  const bindings = new Map<string, ImportBinding>();
  const reexportNamed = new Map<string, ImportBinding>();
  const reexportStars: string[] = [];
  // `export { x }` sem specifier: o nome local pode ser um IMPORT — resolve
  // depois do visit, quando todos os bindings já são conhecidos.
  const localReexports: { exported: string; local: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveBackendModulePath(
        importerPath,
        node.moduleSpecifier.text,
        pathSet,
        aliases,
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
    } else if (ts.isExportDeclaration(node)) {
      const specText =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : null;
      if (specText) {
        const resolved = resolveBackendModulePath(importerPath, specText, pathSet, aliases);
        if (resolved) {
          if (!node.exportClause) {
            reexportStars.push(resolved); // export * from "./x"
          } else if (ts.isNamedExports(node.exportClause)) {
            for (const spec of node.exportClause.elements) {
              reexportNamed.set(spec.name.text, {
                sourcePath: resolved,
                originalName: spec.propertyName ? spec.propertyName.text : spec.name.text,
              });
            }
          } else if (ts.isNamespaceExport(node.exportClause)) {
            // export * as ns from "./x" — ns.fn resolve no arquivo de origem.
            reexportNamed.set(node.exportClause.name.text, {
              sourcePath: resolved,
              originalName: "*",
            });
          }
        }
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          localReexports.push({
            exported: spec.name.text,
            local: spec.propertyName ? spec.propertyName.text : spec.name.text,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const { exported, local } of localReexports) {
    const imported = bindings.get(local);
    // Só vira re-export se o binding local É um import (barrel `import`+`export`);
    // nome declarado no próprio arquivo já está em names — não precisa daqui.
    if (imported && !reexportNamed.has(exported)) reexportNamed.set(exported, imported);
  }
  return { bindings, reexportNamed, reexportStars };
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
  /**
   * DI simples por construtor: "Classe.membro" → nome do TIPO declarado
   * (parameter property `private repo: Repo`, propriedade tipada `repo: Repo`,
   * `this.repo = param` com param tipado, ou `this.repo = new Repo()`).
   * Resolve `this.repo.save()` pela declaração — nunca por runtime.
   */
  memberTypes: Map<string, string>;
  /** re-export nomeado do barrel: nome exportado → origem. */
  reexportNamed: Map<string, ImportBinding>;
  /** origens de `export * from "./x"`. */
  reexportStars: string[];
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

/** Nome do tipo de uma anotação `x: Tipo` (só TypeReference simples). */
function typeNameOf(typeNode: ts.TypeNode | undefined): string | null {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) return null;
  return ts.isIdentifier(typeNode.typeName) ? typeNode.typeName.text : null;
}

/**
 * DI simples por construtor — registra "Classe.membro" → Tipo a partir de:
 *   · parameter property: `constructor(private repo: Repo)`;
 *   · propriedade tipada/inicializada: `repo: Repo` / `repo = new Repo()`;
 *   · atribuição no corpo: `this.repo = param` (param tipado) / `= new Repo()`.
 */
function indexClassMemberTypes(
  cls: ts.ClassDeclaration,
  className: string,
  memberTypes: Map<string, string>,
): void {
  const put = (member: string, type: string | null) => {
    if (type && !memberTypes.has(`${className}.${member}`)) {
      memberTypes.set(`${className}.${member}`, type);
    }
  };
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      const fromType = typeNameOf(member.type);
      const fromNew =
        member.initializer &&
        ts.isNewExpression(member.initializer) &&
        ts.isIdentifier(member.initializer.expression)
          ? member.initializer.expression.text
          : null;
      put(member.name.text, fromType ?? fromNew);
    } else if (ts.isConstructorDeclaration(member)) {
      const paramTypes = new Map<string, string>();
      for (const param of member.parameters) {
        if (!ts.isIdentifier(param.name)) continue;
        const type = typeNameOf(param.type);
        if (!type) continue;
        paramTypes.set(param.name.text, type);
        // parameter property (private/public/protected/readonly) VIRA membro
        const mods = ts.getModifiers?.(param) ?? [];
        if (mods.length > 0) put(param.name.text, type);
      }
      // `this.x = y` no corpo: y identifier tipado ou `new Classe()`.
      const scanAssign = (node: ts.Node) => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(node.left.name)
        ) {
          const member2 = node.left.name.text;
          if (ts.isIdentifier(node.right)) put(member2, paramTypes.get(node.right.text) ?? null);
          else if (ts.isNewExpression(node.right) && ts.isIdentifier(node.right.expression)) {
            put(member2, node.right.expression.text);
          }
        }
        ts.forEachChild(node, scanAssign);
      };
      if (member.body) scanAssign(member.body);
    }
  }
}

function indexFile(
  sourceFile: ts.SourceFile,
): Omit<FileIndex, "imports" | "reexportNamed" | "reexportStars"> {
  const names = new Map<string, string>();
  const fns: IndexedFn[] = [];
  const instanceTypes = new Map<string, string>();
  const memberTypes = new Map<string, string>();
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
      if (currentClass) indexClassMemberTypes(node, currentClass, memberTypes);
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
  return { names, fns, instanceTypes, memberTypes };
}

/**
 * Resolve um NOME (plano ou qualificado "obj.metodo") num arquivo, atravessando
 * BARRELS quando o arquivo não o declara: re-export nomeado segue a origem
 * declarada; `export * from` tenta cada origem em ordem (1º acerto vence);
 * `export * as ns` resolve `ns.metodo` como `metodo` na origem. Anti-ciclo por
 * (arquivo,nome) + teto de profundidade — barrel circular não trava.
 */
function resolveNameInFile(
  filePath: string,
  name: string,
  fileIndexes: Map<string, FileIndex>,
  depth = 0,
  seen?: Set<string>,
): { filePath: string; canonical: string } | null {
  if (depth > 8) return null;
  const idx = fileIndexes.get(filePath);
  if (!idx) return null;
  const canonical = idx.names.get(name);
  if (canonical) return { filePath, canonical };

  const visitKey = `${filePath}::${name}`;
  const guard = seen ?? new Set<string>();
  if (guard.has(visitKey)) return null;
  guard.add(visitKey);

  const dot = name.indexOf(".");
  const head = dot >= 0 ? name.slice(0, dot) : name;
  const tail = dot >= 0 ? name.slice(dot + 1) : null;

  const named = idx.reexportNamed.get(head);
  if (named) {
    const targetName =
      named.originalName === "*"
        ? tail // `export * as ns from` — ns.metodo vira metodo na origem
        : tail
          ? `${named.originalName}.${tail}`
          : named.originalName;
    if (targetName) {
      const hit = resolveNameInFile(named.sourcePath, targetName, fileIndexes, depth + 1, guard);
      if (hit) return hit;
    }
  }
  for (const src of idx.reexportStars) {
    const hit = resolveNameInFile(src, name, fileIndexes, depth + 1, guard);
    if (hit) return hit;
  }
  return null;
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

// ── Toque por SQL CRU (ADR-0018 pronto-pra-cliente) ──
// Nem todo backend Node é Drizzle: o gateway do easynup (e muito cliente) usa
// pg/knex com SQL em string/template literal. Detecta a TABELA no próprio SQL:
// INSERT INTO t / UPDATE t … SET / DELETE FROM t / FROM t / JOIN t.
// Guardas de precisão: identificador não pode ser keyword SQL; UPDATE exige um
// SET no mesmo literal (evita prosa "update the record"); placeholders fora.
const SQL_KEYWORDS = new Set([
  "select", "where", "set", "values", "on", "as", "left", "right", "inner",
  "outer", "join", "group", "order", "limit", "offset", "returning", "distinct",
  "union", "all", "case", "when", "then", "else", "end", "null", "not", "and",
  "or", "in", "exists", "between", "like", "is", "asc", "desc", "into", "from",
  "table", "if", "only",
]);
const SQL_TOUCH_RE = /\b(insert\s+into|delete\s+from|update|from|join)\s+"?([a-z_][a-z0-9_]{1,63})"?/gi;

export function sqlTouchesFromText(text: string): DrizzleTouch[] {
  if (!text || text.length > 20_000) return [];
  const out: DrizzleTouch[] = [];
  const lower = text.toLowerCase();
  // gate de FORMA de SQL (não palavra solta): select…from / insert into /
  // update…set / delete from — prosa em inglês não passa.
  if (
    !/\bselect\b[\s\S]*\bfrom\b/.test(lower) &&
    !/\binsert\s+into\b/.test(lower) &&
    !/\bupdate\b[\s\S]*\bset\b/.test(lower) &&
    !/\bdelete\s+from\b/.test(lower)
  ) return [];
  SQL_TOUCH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SQL_TOUCH_RE.exec(text)) !== null) {
    const kw = m[1].toLowerCase().replace(/\s+/g, " ");
    const table = m[2].toLowerCase();
    if (SQL_KEYWORDS.has(table)) continue;
    if (kw === "update" && !/\bset\b/i.test(text)) continue; // prosa, não SQL
    const op: DrizzleTouch["op"] =
      kw === "insert into" || kw === "update" ? "write" : kw === "delete from" ? "delete" : "read";
    out.push({ entity: table, op });
  }
  return out;
}

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
    // SQL cru em literal (ADR-0018): pg/knex — a tabela está no texto.
    if (ts.isStringLiteralLike(node)) {
      for (const t of sqlTouchesFromText(node.text)) touches.push(t);
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)].join(" ");
      for (const t of sqlTouchesFromText(parts)) touches.push(t);
    }

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
        } else if (
          ts.isPropertyAccessExpression(obj) &&
          obj.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(obj.name) &&
          currentOwner
        ) {
          // `this.repo.save()` — DI por construtor: o TIPO declarado do membro
          // (parameter property / propriedade tipada) diz a classe-alvo.
          const memberType = fileIdx.memberTypes.get(`${currentOwner}.${obj.name.text}`);
          if (memberType) {
            const typeImport = fileIdx.imports.get(memberType);
            candidates.push(
              typeImport
                ? {
                    filePath: typeImport.sourcePath,
                    names: [`${typeImport.originalName}.${method}`],
                  }
                : { filePath, names: [`${memberType}.${method}`] },
            );
          }
          // membro sem tipo declarado ⇒ não liga (regra de ouro).
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
  /**
   * Resolve um IDENTIFICADOR nu do arquivo dado (handler passado por referência:
   * `router.delete('/x', deleteHandler)`) para uma chave do grafo, ou null.
   */
  seedForName(filePath: string, name: string): string | null;
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
  // Aliases do tsconfig vêm do payload INTEIRO (tsconfig*.json não é candidato).
  const aliases = buildTsconfigPathsIndex(files);

  let scope: string[];
  if (opts?.entryFiles && opts.entryFiles.length > 0) {
    scope = Array.from(importClosure(opts.entryFiles, byPath, pathSet, aliases));
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
      const parsed = parseImports(sourceFile, path, pathSet, aliases);
      fileIndexes.set(path, {
        ...idx,
        imports: parsed.bindings,
        reexportNamed: parsed.reexportNamed,
        reexportStars: parsed.reexportStars,
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

  // Passe 3: resolve candidatos → chaves canônicas existentes (atravessando
  // barrels via resolveNameInFile). Não achou ⇒ não liga.
  for (const [key, cands] of Array.from(rawCallees.entries())) {
    const node = graph.get(key)!;
    for (const cand of cands) {
      for (const name of cand.names) {
        const hit = resolveNameInFile(cand.filePath, name, fileIndexes);
        if (hit) {
          const targetKey = makeBackendKey(hit.filePath, hit.canonical);
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
      for (const name of names) {
        const hit = resolveNameInFile(targetFile, name, fileIndexes);
        if (hit) {
          const key = makeBackendKey(hit.filePath, hit.canonical);
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

  const seedForName = (filePath: string, name: string): string | null => {
    const fileIdx = fileIndexes.get(filePath);
    if (!fileIdx) return null;
    const imported = fileIdx.imports.get(name);
    const targetFile = imported ? imported.sourcePath : filePath;
    const targetName = imported ? imported.originalName : name;
    const hit = resolveNameInFile(targetFile, targetName, fileIndexes);
    if (!hit) return null;
    const key = makeBackendKey(hit.filePath, hit.canonical);
    return graph.has(key) ? key : null;
  };

  return { graph, seedsFor, seedForName };
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
  const memo = new Map<string, { touches: DrizzleTouch[]; chain: string[]; hop: string[] }>();
  const gray = new Set<string>();

  const visit = (key: string, depth: number): { touches: DrizzleTouch[]; chain: string[]; hop: string[] } => {
    if (depth > maxDepth) return { touches: [], chain: [], hop: [] };
    const done = memo.get(key);
    if (done) return done;
    if (gray.has(key)) return { touches: [], chain: [], hop: [] }; // ciclo — corta.
    const node = graph.get(key);
    if (!node) return { touches: [], chain: [], hop: [] };

    gray.add(key);
    const touches: DrizzleTouch[] = [...node.touches];
    let chain: string[] = node.touches.length > 0 ? [key] : [];
    // hop-chain (ADR-0018): o caminho de FUNÇÕES percorrido, INDEPENDENTE de
    // toque em tabela — o alcance (quem depende de quem) tem valor por si
    // (breaking × reachable) mesmo quando a persistência não é detectável.
    let bestHop: string[] = [];
    for (const callee of Array.from(node.callees)) {
      const sub = visit(callee, depth + 1);
      touches.push(...sub.touches);
      if (chain.length === 0 && sub.chain.length > 0) chain = [key, ...sub.chain];
      if (sub.hop.length > bestHop.length) bestHop = sub.hop;
    }
    gray.delete(key);

    const result = { touches, chain, hop: [key, ...bestHop] };
    memo.set(key, result);
    return result;
  };

  const all: DrizzleTouch[] = [];
  let chain: string[] = [];
  let hop: string[] = [];
  for (const seed of seedKeys) {
    const r = visit(seed, 0);
    all.push(...r.touches);
    if (chain.length === 0 && r.chain.length > 0) chain = r.chain;
    if (r.hop.length > hop.length) hop = r.hop;
  }
  // preferência: cadeia ancorada em toque; senão o hop-path (só se tem ≥2 nós —
  // [seed] sozinho não informa nada)
  if (chain.length === 0 && hop.length >= 2) chain = hop;

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

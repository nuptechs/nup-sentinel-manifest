// ─────────────────────────────────────────────────────────────────────────
// Codelens frontend extractor (ADR-044 Onda 1 — PRODUTOR do payload de lookup)
//
// PROBLEMA QUE RESOLVE: a PR 1.3 criou o INGEST (`ingestCodelensExtraction`)
// e o `/lookup` das tabelas `manifest_routes|pages|composables|entities|
// i18n_keys`, mas NUNCA existiu um PRODUTOR do payload — nenhum caller de
// `codelens-extraction` em repo algum (confirmado por grep + `git log -S`).
// Sem produtor, `/lookup?type=route` do easynup (projeto 27) devolve 0, e a
// âncora tela→código do Sentinel (flag `SENTINEL_WIDGET_ANCHOR`) não resolve.
//
// Este módulo é esse produtor, no formato EXATO do `codelensExtractionSchema`
// (server/manifest-lookup-schema.ts). É PURO: recebe `{filePath, content}[]`
// (a mesma forma que `storage.getSourceFiles` devolve) e produz o payload.
// Isso o torna reusável (a) no servidor, lendo a fonte já armazenada, e
// (b) num CLI local, lendo um checkout — sem clone, sem rede.
//
// CONTRATO DO CONSUMIDOR (nup-sentinel, confirmado na fonte):
//   - `manifest.adapter.js:lookupRoutes` lê `{routePath,name,component,sourcePath}`.
//   - `widget-anchor.js:componentFileFromRoute` → `route.component` é o CAMINHO
//     do `.vue` (ex.: `./pages/X.vue`, `@/pages/X.vue`); ele tira o `./` e
//     mantém `@/`. Por isso `component` é o ESPECIFICADOR do import, como escrito.
//   - `widget-anchor.js:pageNameFromRoute` → faz fallback p/ o basename do
//     `component` sem extensão; por isso `page.name` = basename do `.vue`.
//   - Numa ROTA, `sourcePath` é o ARQUIVO QUE DEFINE a rota (o `router.ts`),
//     NÃO o componente. Numa PÁGINA, `sourcePath` É o `.vue`.
// ─────────────────────────────────────────────────────────────────────────

import _ts from "typescript";
import { parseTypeScript, extractVueScript } from "./parsers";
import type { CodelensExtractionPayload } from "../../manifest-lookup-schema";

import ts = _ts;

export interface SourceInput {
  filePath: string;
  content: string;
}

export interface ExtractionDiagnostics {
  routerFiles: string[];
  routesTotal: number;
  routesWithComponentPath: number;
  /** rotas cujo component resolveu para um .vue REAL do fileset (repo-rel). */
  routesComponentResolvedToFile: number;
  routesUnresolvedComponent: Array<{ routePath: string; component: string | null }>;
  vueFiles: number;
  composableFiles: number;
  javaEntityFiles: number;
  /** chaves i18n descartadas por exceder o teto do ingest (10k). */
  i18nKeysDropped: number;
}

export interface ExtractionOutcome {
  payload: CodelensExtractionPayload;
  diagnostics: ExtractionDiagnostics;
}

const MAX_SAMPLE_FILES = 5; // schema: sampleFiles.max(5)
// Espelha `MAX_ITEMS_PER_KIND` do ingest (server/manifest-lookup.ts): acima
// disso o `assertSize` REJEITA o payload inteiro. Capamos aqui p/ nunca estourar.
const MAX_ITEMS_PER_KIND = 10_000;

// ───────────────────────────── helpers ─────────────────────────────

function isVue(p: string): boolean {
  return p.toLowerCase().endsWith(".vue");
}

/** Arquivos de teste/storybook/mock NÃO são fonte de produto — ignorados em
 *  toda extração (senão viram rotas/páginas fantasma, ex.: `/a`, `/b`). */
function isNoiseFile(p: string): boolean {
  const l = p.toLowerCase();
  return (
    /[\\/]__tests__[\\/]/.test(l) ||
    /[\\/]__mocks__[\\/]/.test(l) ||
    /[\\/]\.storybook[\\/]/.test(l) ||
    /[\\/]e2e[\\/]/.test(l) ||
    /\.(test|spec|stories|story|cy|e2e)\.[tj]sx?$/.test(l) ||
    /\.d\.ts$/.test(l)
  );
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function nameNoExt(p: string): string {
  return basename(p).replace(/\.(vue|tsx|jsx|ts|js|mts|cts)$/i, "");
}

// ── resolução de caminho posix (filePaths são repo-relativos com '/') ──

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

function posixNormalize(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Resolve o ESPECIFICADOR do import de um componente para o caminho REAL do
 * `.vue` no fileset (repo-relativo), para o `sourceFile` da âncora casar com o
 * mesmo arquivo que os demais findings do Sentinel agrupam. Se não resolver,
 * devolve o especificador cru (ainda passa pelo `COMPONENT_FILE_RE` do
 * consumidor). Suporta `./`, `../`, e o alias `@/` → raiz `src/`.
 */
function resolveComponentToFile(
  spec: string,
  routerPath: string,
  fileset: Set<string>,
): string {
  if (!/\.(vue|tsx|jsx)$/i.test(spec)) return spec; // nome puro, não caminho
  let candidate: string | null = null;
  if (spec.startsWith("@/")) {
    const srcIdx = routerPath.indexOf("/src/");
    const srcRoot =
      srcIdx >= 0 ? routerPath.slice(0, srcIdx + 5) : posixDirname(routerPath) + "/";
    candidate = posixNormalize(srcRoot + spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    candidate = posixNormalize(posixDirname(routerPath) + "/" + spec);
  }
  if (candidate && fileset.has(candidate)) return candidate;
  // fallback: casa pelo sufixo do caminho (alias desconhecido / raiz incerta)
  const tail = spec.replace(/^(?:@\/|\.\/|(?:\.\.\/)+)/, "");
  const suffixHits = [...fileset].filter((f) => f === tail || f.endsWith("/" + tail));
  if (suffixHits.length === 1) return suffixHits[0];
  return spec; // cru — melhor que nada; o consumidor normaliza o `./`
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

/** Collect every string key in `t('...')` / `$t('...')` / `i18n.global.t('...')`. */
function collectI18nKeys(content: string, fileName: string): string[] {
  const out: string[] = [];
  // Template + script: a regex é suficiente e robusta a `$t`, `t`, `i18n.t`.
  // Captura o 1º argumento string de chamadas cujo callee termina em `t`.
  const re = /(?:\$t|(?<![\w.])t|i18n(?:\.global)?\.t)\s*\(\s*(['"`])((?:[^'"`\\]|\\.)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const key = m[2];
    if (key && key.length > 1 && /[a-zA-Z]/.test(key)) out.push(key);
  }
  return out;
}

// ───────────────────────────── routes ─────────────────────────────

/**
 * Resolve o `component` de uma rota para o ESPECIFICADOR do import, exatamente
 * como escrito no fonte — que é o que o consumidor espera:
 *   - `() => import('./pages/X.vue')`  → `./pages/X.vue`
 *   - `() => import('@/pages/X.vue')`  → `@/pages/X.vue`
 *   - identificador de import estático  → resolve o especificador do import
 *   - string literal                    → a própria string
 * Devolve null se não houver como resolver para um caminho/nome.
 */
function resolveComponentSpecifier(
  value: ts.Expression,
  staticImports: Map<string, string>,
): string | null {
  // `() => import('x')` ou `() => import('x').then(...)`
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    let found: string | null = null;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (
        ts.isCallExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        n.arguments.length > 0
      ) {
        found = stringLiteralValue(n.arguments[0]) ?? null;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(value);
    return found;
  }
  // string literal direto
  const lit = stringLiteralValue(value);
  if (lit) return lit;
  // identificador (import estático) → especificador do import
  if (ts.isIdentifier(value)) {
    return staticImports.get(value.text) ?? value.text;
  }
  return null;
}

type PaletteInfo = {
  paletteLabel?: string;
  paletteCategory?: string;
  permissions: string[];
  hasPaletteMeta: boolean;
};

function extractPalette(metaObj: ts.ObjectLiteralExpression | undefined): PaletteInfo {
  const info: PaletteInfo = { permissions: [], hasPaletteMeta: false };
  if (!metaObj) return info;
  const paletteProp = metaObj.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name && p.name.getText() === "palette",
  );
  if (
    !paletteProp ||
    !ts.isPropertyAssignment(paletteProp) ||
    !ts.isObjectLiteralExpression(paletteProp.initializer)
  ) {
    return info;
  }
  info.hasPaletteMeta = true;
  for (const prop of paletteProp.initializer.properties) {
    if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
    const key = prop.name.getText().replace(/['"]/g, "");
    if (key === "labelKey") info.paletteLabel = stringLiteralValue(prop.initializer);
    else if (key === "label" && !info.paletteLabel)
      info.paletteLabel = stringLiteralValue(prop.initializer);
    else if (key === "category") info.paletteCategory = stringLiteralValue(prop.initializer);
    else if (key === "permission") {
      const v = stringLiteralValue(prop.initializer);
      if (v) info.permissions.push(v);
    } else if (key === "anyOf" && ts.isArrayLiteralExpression(prop.initializer)) {
      for (const el of prop.initializer.elements) {
        const v = stringLiteralValue(el);
        if (v) info.permissions.push(v);
      }
    }
  }
  return info;
}

function routeObjectHasPath(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) => ts.isPropertyAssignment(p) && p.name && p.name.getText().replace(/['"]/g, "") === "path",
  );
}

function propInit(
  obj: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined {
  const prop = obj.properties.find(
    (p) =>
      ts.isPropertyAssignment(p) && p.name && p.name.getText().replace(/['"]/g, "") === key,
  );
  return prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
}

function extractRoutesFromFile(
  file: SourceInput,
  diag: ExtractionDiagnostics,
  fileset: Set<string>,
): CodelensExtractionPayload["routes"] {
  const routes: CodelensExtractionPayload["routes"] = [];
  const emitted = new Set<ts.Node>(); // evita emitir o mesmo objeto-rota 2x
  let sf: ts.SourceFile;
  try {
    sf = parseTypeScript(file.content, file.filePath);
  } catch {
    return routes;
  }

  // Mapa identificador→especificador dos imports estáticos (p/ component por nome).
  const staticImports = new Map<string, string>();
  sf.statements.forEach((st) => {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      if (clause?.name) staticImports.set(clause.name.text, spec);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        clause.namedBindings.elements.forEach((e) => staticImports.set(e.name.text, spec));
      }
    }
  });

  let sawRoute = false;

  const handleRouteObject = (obj: ts.ObjectLiteralExpression, parentPath: string) => {
    if (!routeObjectHasPath(obj)) return;
    if (emitted.has(obj)) return; // já processado (via pai OU via varredura)
    emitted.add(obj);
    sawRoute = true;
    const rawPath = stringLiteralValue(propInit(obj, "path"));
    if (rawPath === undefined) return;

    // Junta o path do filho ao do pai (vue-router: filho sem `/` é relativo).
    let routePath: string;
    if (rawPath.startsWith("/")) routePath = rawPath;
    else if (parentPath) routePath = `${parentPath.replace(/\/$/, "")}/${rawPath}`;
    else routePath = rawPath;
    if (routePath === "") routePath = parentPath || "/";

    const name = stringLiteralValue(propInit(obj, "name"));
    const compInit = propInit(obj, "component") ?? propInit(obj, "components");
    const rawComponent = compInit ? resolveComponentSpecifier(compInit, staticImports) : null;
    // Resolve p/ o .vue REAL do fileset (repo-rel) quando possível, p/ o
    // sourceFile da âncora casar com os demais findings do arquivo.
    const component = rawComponent
      ? resolveComponentToFile(rawComponent, file.filePath, fileset)
      : null;

    const metaInit = propInit(obj, "meta");
    const palette = extractPalette(
      metaInit && ts.isObjectLiteralExpression(metaInit) ? metaInit : undefined,
    );

    diag.routesTotal += 1;
    if (component && /\.(vue|tsx|jsx)$/i.test(component)) {
      diag.routesWithComponentPath += 1;
      if (fileset.has(component)) diag.routesComponentResolvedToFile += 1;
    } else {
      diag.routesUnresolvedComponent.push({ routePath, component });
    }

    routes.push({
      routePath,
      name: name ?? undefined,
      component: component ?? undefined,
      paletteLabel: palette.paletteLabel,
      paletteCategory: palette.paletteCategory,
      permissions: palette.permissions,
      hasPaletteMeta: palette.hasPaletteMeta,
      sourcePath: file.filePath,
    });

    // children
    const childrenInit = propInit(obj, "children");
    if (childrenInit && ts.isArrayLiteralExpression(childrenInit)) {
      childrenInit.elements.forEach((el) => {
        if (ts.isObjectLiteralExpression(el)) handleRouteObject(el, routePath);
      });
    }
  };

  // Procura arrays de objetos-rota em qualquer lugar do arquivo (o `routes`
  // array normalmente é top-level, mas pode estar inline em createRouter).
  const visit = (n: ts.Node) => {
    if (ts.isArrayLiteralExpression(n)) {
      const objs = n.elements.filter(ts.isObjectLiteralExpression);
      if (objs.length && objs.some(routeObjectHasPath)) {
        objs.forEach((o) => handleRouteObject(o, ""));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  if (sawRoute) diag.routerFiles.push(file.filePath);
  return routes;
}

function looksLikeRouterFile(file: SourceInput): boolean {
  const p = file.filePath.toLowerCase();
  if (!/\.(ts|js|mts|cts)$/.test(p)) return false;
  if (p.includes("node_modules")) return false;
  // Heurística barata antes de parsear tudo: menciona vue-router ou define rotas.
  return (
    /from\s+['"]vue-router['"]/.test(file.content) ||
    /RouteRecordRaw/.test(file.content) ||
    /createRouter\s*\(/.test(file.content)
  );
}

// ───────────────────────────── pages (.vue) ─────────────────────────────

function extractPage(file: SourceInput): CodelensExtractionPayload["pages"][number] {
  let script = "";
  try {
    script = extractVueScript(file.content) || "";
  } catch {
    script = "";
  }

  const imports: string[] = [];
  const composables = new Set<string>();
  const props: string[] = [];
  const emits: string[] = [];

  if (script) {
    let sf: ts.SourceFile | undefined;
    try {
      sf = parseTypeScript(script, file.filePath + ".ts");
    } catch {
      sf = undefined;
    }
    if (sf) {
      sf.statements.forEach((st) => {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
          imports.push(st.moduleSpecifier.text);
          const clause = st.importClause;
          const addIfUse = (id: string) => {
            if (/^use[A-Z]/.test(id)) composables.add(id);
          };
          if (clause?.name) addIfUse(clause.name.text);
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            clause.namedBindings.elements.forEach((e) => addIfUse(e.name.text));
          }
        }
      });

      const visit = (n: ts.Node) => {
        // defineProps / defineEmits
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const callee = n.expression.text;
          if (/^use[A-Z]/.test(callee)) composables.add(callee);
          if (callee === "defineProps" || callee === "defineEmits") {
            const target = callee === "defineProps" ? props : emits;
            // defineProps({...}) / defineProps<{...}>() / defineProps(['a','b'])
            const arg = n.arguments[0];
            if (arg && ts.isObjectLiteralExpression(arg)) {
              arg.properties.forEach((p) => {
                if (p.name) target.push(p.name.getText().replace(/['"]/g, ""));
              });
            } else if (arg && ts.isArrayLiteralExpression(arg)) {
              arg.elements.forEach((e) => {
                const v = stringLiteralValue(e);
                if (v) target.push(v);
              });
            }
            const typeArg = n.typeArguments?.[0];
            if (typeArg && ts.isTypeLiteralNode(typeArg)) {
              typeArg.members.forEach((mem) => {
                if (mem.name) target.push(mem.name.getText().replace(/['"?]/g, ""));
              });
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }

  const i18nKeys = Array.from(new Set(collectI18nKeys(file.content, file.filePath)));

  return {
    name: nameNoExt(file.filePath),
    sourcePath: file.filePath,
    imports: Array.from(new Set(imports)),
    props: Array.from(new Set(props)),
    emits: Array.from(new Set(emits)),
    composables: Array.from(composables),
    i18nKeys,
  };
}

// ───────────────────────────── composables (.ts) ─────────────────────────────

function isComposableFile(file: SourceInput): boolean {
  const p = file.filePath.toLowerCase();
  if (!/\.(ts|mts|cts)$/.test(p)) return false;
  if (p.includes("node_modules") || p.endsWith(".d.ts")) return false;
  // composables/useX.ts OU qualquer arquivo exportando `use<Capital>`
  if (/[\\/]composables[\\/]/.test(p)) return true;
  return /export\s+(?:function|const)\s+use[A-Z]/.test(file.content);
}

function extractComposables(file: SourceInput): CodelensExtractionPayload["composables"] {
  const out: CodelensExtractionPayload["composables"] = [];
  let sf: ts.SourceFile;
  try {
    sf = parseTypeScript(file.content, file.filePath);
  } catch {
    return out;
  }

  const collectReturns = (body: ts.Node | undefined): string[] => {
    const keys = new Set<string>();
    if (!body) return [];
    const visit = (n: ts.Node) => {
      if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
        n.expression.properties.forEach((p) => {
          // shorthand (`{ list }`) e assignment (`{ list: ref() }`) têm `name`.
          if (p.name) keys.add(p.name.getText().replace(/['"]/g, ""));
        });
      }
      // não desce em funções aninhadas para não pegar returns internos
      if (
        n !== body &&
        (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
      ) {
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return Array.from(keys);
  };

  const collectDeps = (body: ts.Node | undefined): string[] => {
    const deps = new Set<string>();
    if (!body) return [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use[A-Z]/.test(n.expression.text)) {
        deps.add(n.expression.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return Array.from(deps);
  };

  sf.statements.forEach((st) => {
    // export function useX() {...}
    if (
      ts.isFunctionDeclaration(st) &&
      st.name &&
      /^use[A-Z]/.test(st.name.text) &&
      st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      out.push({
        name: st.name.text,
        sourcePath: file.filePath,
        returns: collectReturns(st.body),
        dependencies: collectDeps(st.body).filter((d) => d !== st.name!.text),
      });
    }
    // export const useX = () => {...} / function(){...}
    if (ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      st.declarationList.declarations.forEach((decl) => {
        if (
          ts.isIdentifier(decl.name) &&
          /^use[A-Z]/.test(decl.name.text) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          const body = decl.initializer.body;
          out.push({
            name: decl.name.text,
            sourcePath: file.filePath,
            returns: collectReturns(body),
            dependencies: collectDeps(body).filter((d) => d !== (decl.name as ts.Identifier).text),
          });
        }
      });
    }
  });

  return out;
}

// ───────────────────────────── entities (Java @Entity) ─────────────────────────────
// O schema de entity é JPA (package/tableName/@Column/relationship). No fonte
// do FRONTEND não existem entidades nessa forma. Extraímos @Entity Java SE a
// fonte os incluir (monorepo); caso contrário, [] — NÃO inventamos entidades TS.

function extractJavaEntities(files: SourceInput[], diag: ExtractionDiagnostics): CodelensExtractionPayload["entities"] {
  const out: CodelensExtractionPayload["entities"] = [];
  for (const f of files) {
    if (!f.filePath.endsWith(".java")) continue;
    if (!/@Entity\b/.test(f.content)) continue;
    diag.javaEntityFiles += 1;
    const classMatch = f.content.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
    if (!classMatch) continue;
    const pkgMatch = f.content.match(/package\s+([\w.]+)\s*;/);
    const tableMatch = f.content.match(/@Table\s*\(\s*name\s*=\s*"([^"]+)"/);
    out.push({
      name: classMatch[1],
      package: pkgMatch?.[1] ?? "",
      tableName: tableMatch?.[1],
      extendsClass: classMatch[2],
      sourcePath: f.filePath,
      fields: [], // extração de campos JPA fica p/ o java-analyzer-engine; piso.
    });
  }
  return out;
}

// ───────────────────────────── i18n aggregate ─────────────────────────────

function aggregateI18n(files: SourceInput[]): { keys: CodelensExtractionPayload["i18nKeys"]; dropped: number } {
  const map = new Map<string, { count: number; files: string[] }>();
  for (const f of files) {
    const p = f.filePath.toLowerCase();
    if (!/\.(vue|ts|tsx|js|jsx)$/.test(p) || p.includes("node_modules")) continue;
    if (isNoiseFile(f.filePath)) continue;
    const keys = collectI18nKeys(f.content, f.filePath);
    for (const k of keys) {
      let e = map.get(k);
      if (!e) {
        e = { count: 0, files: [] };
        map.set(k, e);
      }
      e.count += 1;
      if (e.files.length < MAX_SAMPLE_FILES && !e.files.includes(f.filePath)) {
        e.files.push(f.filePath);
      }
    }
  }
  const all = Array.from(map.entries()).map(([key, v]) => ({
    key,
    usageCount: Math.max(1, v.count),
    sampleFiles: v.files.slice(0, MAX_SAMPLE_FILES),
  }));
  // Acima do cap do ingest o payload é rejeitado — ordena por uso (mantém as
  // chaves mais relevantes) e corta no teto.
  if (all.length > MAX_ITEMS_PER_KIND) {
    all.sort((a, b) => b.usageCount - a.usageCount);
    return { keys: all.slice(0, MAX_ITEMS_PER_KIND), dropped: all.length - MAX_ITEMS_PER_KIND };
  }
  return { keys: all, dropped: 0 };
}

/** Corta um array no teto do ingest (defensivo; só i18n costuma estourar). */
function cap<T>(arr: T[]): T[] {
  return arr.length > MAX_ITEMS_PER_KIND ? arr.slice(0, MAX_ITEMS_PER_KIND) : arr;
}

// ───────────────────────────── entrypoint ─────────────────────────────

/**
 * Produz o payload Codelens (formato EXATO de `codelensExtractionSchema`) a
 * partir de uma lista de arquivos-fonte. Puro e fail-soft por-arquivo.
 */
export function extractCodelens(files: SourceInput[]): ExtractionOutcome {
  const diag: ExtractionDiagnostics = {
    routerFiles: [],
    routesTotal: 0,
    routesWithComponentPath: 0,
    routesComponentResolvedToFile: 0,
    routesUnresolvedComponent: [],
    vueFiles: 0,
    composableFiles: 0,
    javaEntityFiles: 0,
    i18nKeysDropped: 0,
  };

  const routes: CodelensExtractionPayload["routes"] = [];
  const pages: CodelensExtractionPayload["pages"] = [];
  const composables: CodelensExtractionPayload["composables"] = [];

  const fileset = new Set(files.map((f) => f.filePath));

  for (const f of files) {
    if (f.filePath.toLowerCase().includes("node_modules")) continue;
    if (isNoiseFile(f.filePath)) continue;
    if (looksLikeRouterFile(f)) {
      routes.push(...extractRoutesFromFile(f, diag, fileset));
    }
    if (isVue(f.filePath)) {
      diag.vueFiles += 1;
      try {
        pages.push(extractPage(f));
      } catch {
        /* fail-soft por-arquivo */
      }
    }
    if (isComposableFile(f)) {
      const comps = extractComposables(f);
      if (comps.length) {
        diag.composableFiles += 1;
        composables.push(...comps);
      }
    }
  }

  const entities = extractJavaEntities(files, diag);
  const i18n = aggregateI18n(files);
  diag.i18nKeysDropped = i18n.dropped;

  const payload: CodelensExtractionPayload = {
    entities: cap(entities),
    pages: cap(pages),
    composables: cap(composables),
    routes: cap(routes),
    i18nKeys: i18n.keys, // já capado em aggregateI18n (por uso)
  };

  return { payload, diagnostics: diag };
}

/** Conveniência: só o payload (p/ o ingest same-run na pipeline). */
export function extractCodelensPayload(files: SourceInput[]): CodelensExtractionPayload {
  return extractCodelens(files).payload;
}

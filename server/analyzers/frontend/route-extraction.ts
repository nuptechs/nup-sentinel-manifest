import _ts from "typescript";
import * as vueSfc from "@vue/compiler-sfc";
import type { RouteDefinition, RouteMap } from "./types";
import { parseTypeScript } from "./parsers";

import ts = _ts;

const GUARD_COMPONENT_NAMES = new Set([
  "protectedroute", "requireauth", "requireauthentication", "authguard",
  "privateroute", "authroute", "guardedroute", "secureroute",
  "authenticatedroute", "authrequired", "loginrequired", "withauth",
]);

function extractComponentFromJsxElement(node: ts.Node, sourceFile: ts.SourceFile, guards: string[]): string | null {
  if (ts.isJsxSelfClosingElement(node)) {
    const tag = node.tagName.getText(sourceFile);
    if (GUARD_COMPONENT_NAMES.has(tag.toLowerCase())) {
      guards.push(tag);
      return null;
    }
    return tag;
  }

  if (ts.isJsxElement(node)) {
    const tag = node.openingElement.tagName.getText(sourceFile);
    if (GUARD_COMPONENT_NAMES.has(tag.toLowerCase())) {
      guards.push(tag);
      for (const child of node.children) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          const inner = extractComponentFromJsxElement(child, sourceFile, guards);
          if (inner) return inner;
        }
      }
    }
    return tag;
  }

  if (ts.isCallExpression(node)) {
    const text = node.expression.getText(sourceFile);
    if (text.includes("lazy") || text.includes("Suspense")) {
      for (const arg of node.arguments) {
        if (ts.isArrowFunction(arg) && arg.body) {
          const bodyText = arg.body.getText(sourceFile);
          const match = bodyText.match(/import\(["']([^"']+)["']\)/);
          if (match) {
            const parts = match[1].split("/");
            return parts[parts.length - 1].replace(/\.(tsx|jsx|ts|js|vue)$/, "");
          }
        }
      }
    }
  }

  const text = node.getText(sourceFile).replace(/<|\/>/g, "").trim();
  const firstWord = text.split(/[\s({]/)[0];
  return firstWord || null;
}

function extractJsxRoute(node: ts.JsxElement | ts.JsxSelfClosingElement, sourceFile: ts.SourceFile): RouteDefinition | null {
  const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  let path = "";
  let component = "";
  let isIndex = false;
  const guards: string[] = [];

  for (const attr of attrs.properties) {
    if (ts.isJsxAttribute(attr) && attr.name) {
      const attrName = attr.name.getText(sourceFile);
      if (attrName === "path" && attr.initializer) {
        if (ts.isStringLiteral(attr.initializer)) {
          path = attr.initializer.text;
        } else if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression && ts.isStringLiteral(attr.initializer.expression)) {
          path = attr.initializer.expression.text;
        }
      }
      if (attrName === "index" && !attr.initializer) {
        isIndex = true;
      }
      if (attrName === "index" && attr.initializer) {
        if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          if (attr.initializer.expression.kind === ts.SyntaxKind.TrueKeyword) isIndex = true;
        } else {
          isIndex = true;
        }
      }
      if ((attrName === "element" || attrName === "component") && attr.initializer) {
        if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
          const extracted = extractComponentFromJsxElement(attr.initializer.expression, sourceFile, guards);
          component = extracted || attr.initializer.expression.getText(sourceFile).replace(/<|\/>/g, "").trim();
        }
      }
    }
  }

  const childRoutes: RouteDefinition[] = [];
  if (ts.isJsxElement(node)) {
    for (const child of node.children) {
      if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
        const childTag = ts.isJsxElement(child) ? child.openingElement.tagName.getText(sourceFile) : child.tagName.getText(sourceFile);
        if (childTag === "Route") {
          const childRoute = extractJsxRoute(child, sourceFile);
          if (childRoute) childRoutes.push(childRoute);
        }
      }
    }
  }

  if (isIndex && !path) path = "";
  if (path || isIndex) return { path, component, guards, children: childRoutes };
  if (component && childRoutes.length > 0) return { path: "", component, guards, children: childRoutes };
  return null;
}

export function buildRouteMap(files: { filePath: string; content: string }[]): RouteMap {
  const routeMap: RouteMap = new Map();
  const allRoutes: RouteDefinition[] = [];

  for (const file of files) {
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx", ".vue"].includes(ext)) continue;
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) continue;

    const isRouterFile = file.filePath.toLowerCase().includes("router") ||
      file.filePath.toLowerCase().includes("routes") ||
      file.filePath.toLowerCase().includes("routing") ||
      file.filePath.toLowerCase().endsWith("app.tsx") ||
      file.filePath.toLowerCase().endsWith("app.jsx") ||
      file.filePath.toLowerCase().endsWith("app.vue");
    const hasRouterImport = file.content.includes("createRouter") ||
      file.content.includes("vue-router") ||
      file.content.includes("react-router") ||
      file.content.includes("@angular/router") ||
      file.content.includes("createBrowserRouter") ||
      file.content.includes("RouterModule") ||
      file.content.includes("wouter") ||
      file.content.includes("<Route") ||
      file.content.includes("<Switch") ||
      file.content.includes("<Routes") ||
      file.content.includes("useRoute") ||
      file.content.includes("useLocation");

    if (!isRouterFile && !hasRouterImport) continue;

    try {
      let content = file.content;
      if (ext === ".vue") {
        const parsed = vueSfc.parse(content);
        if (parsed.descriptor.scriptSetup) {
          content = parsed.descriptor.scriptSetup.content;
        } else if (parsed.descriptor.script) {
          content = parsed.descriptor.script.content;
        } else {
          continue;
        }
      }
      const sourceFile = parseTypeScript(content, file.filePath);
      const routes = extractRoutesFromAST(sourceFile, file.filePath);
      if (routes.length === 0) {
        const hasRoute = content.includes("<Route");
        const hasSwitch = content.includes("<Switch");
        if (hasRoute || hasSwitch) {
          console.log(`[frontend-analyzer] Route debug: ${file.filePath} has <Route>=${hasRoute}, <Switch>=${hasSwitch} in content but AST found 0 routes`);
        }
      }
      allRoutes.push(...routes);
    } catch (err) {
      console.warn(`[frontend-analyzer] Route parse error in ${file.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const flatten = (routes: RouteDefinition[], parentPath: string = "", parentGuards: string[] = []) => {
    for (const route of routes) {
      let fullPath: string;
      if (route.path === "" || route.path === undefined) {
        fullPath = parentPath || "/";
      } else if (route.path.startsWith("/")) {
        fullPath = route.path;
      } else {
        fullPath = parentPath.endsWith("/")
          ? parentPath + route.path
          : parentPath + "/" + route.path;
      }
      const mergedGuards = [...parentGuards, ...route.guards];
      const componentName = route.component;

      if (componentName) {
        const normalizedName = componentName.replace(/\.(vue|tsx|jsx|ts|js)$/, "");
        const baseName = normalizedName.split("/").pop() || normalizedName;
        const lowerBase = baseName.toLowerCase();
        const routeEntry = { route: fullPath, guards: mergedGuards };
        routeMap.set(lowerBase, routeEntry);
        routeMap.set(normalizedName.toLowerCase(), routeEntry);
        const pascalToKebab = baseName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
        if (pascalToKebab !== lowerBase) {
          routeMap.set(pascalToKebab, routeEntry);
        }
        const noHyphens = lowerBase.replace(/[-_]/g, "");
        if (noHyphens !== lowerBase) {
          routeMap.set(noHyphens, routeEntry);
        }
        const withSpaces = baseName.replace(/[-_]/g, " ").toLowerCase();
        if (withSpaces !== lowerBase) {
          routeMap.set(withSpaces, routeEntry);
        }
      }

      if (route.children && route.children.length > 0) {
        flatten(route.children, fullPath, mergedGuards);
      }
    }
  };

  flatten(allRoutes);

  if (allRoutes.length > 0) {
    console.log(`[frontend-analyzer] Router extraction: ${allRoutes.length} routes found, ${routeMap.size} component mappings`);
    const routeEntries = Array.from(routeMap.entries());
    for (const [name, info] of routeEntries.slice(0, 10)) {
      console.log(`[frontend-analyzer]   Route: ${name} → ${info.route} [guards: ${info.guards.join(",")||"none"}]`);
    }
    const sizeBefore = routeMap.size;
    inferRoutesFromFilePaths(files, routeMap);
    const inferred = routeMap.size - sizeBefore;
    if (inferred > 0) {
      console.log(`[frontend-analyzer] Supplemental file-path route inference: ${inferred} additional component mappings (total: ${routeMap.size})`);
    }
  } else {
    console.log(`[frontend-analyzer] No router routes found, inferring routes from file paths`);
    const sizeBefore = routeMap.size;
    inferRoutesFromFilePaths(files, routeMap);
    const inferred = routeMap.size - sizeBefore;
    if (inferred > 0) {
      console.log(`[frontend-analyzer] File-path route inference: ${inferred} additional component mappings (total: ${routeMap.size})`);
    }
  }

  return routeMap;
}

export function inferRoutesFromFilePaths(files: { filePath: string; content: string }[], routeMap: RouteMap): void {
  const componentExtensions = [".tsx", ".jsx", ".vue"];
  const skipDirs = new Set(["node_modules", "dist", "build", "__tests__", "test", "tests", "utils", "lib", "hooks", "types", "contexts", "services", "api", "helpers", "assets", "styles", "shared", "common", "config", "constants"]);
  const skipFiles = new Set(["index", "app", "main", "vite-env.d", "setupTests", "reportWebVitals"]);
  const sharedComponentPatterns = /^(Button|Input|Select|Modal|Dialog|Dropdown|Tooltip|Spinner|Loader|Loading|Icon|Badge|Card|Avatar|Table|Tabs|Tab|Header|Footer|Sidebar|Navbar|Nav|Layout|Wrapper|Container|Provider|ErrorBoundary|Suspense|Portal|Popover|Toast|Alert|Breadcrumb|Pagination|Skeleton|Divider|Label|Checkbox|Radio|Switch|Toggle|Textarea|Form|FormField|FormSection|FormGroup)$/i;
  const screenDirs = new Set(["pages", "views", "screens"]);

  const allComponentNames = new Set<string>();
  for (const file of files) {
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (!componentExtensions.includes(ext)) continue;
    const parts = file.filePath.replace(/\\/g, "/").split("/");
    const fileName = parts[parts.length - 1].replace(/\.(vue|tsx|jsx|ts|js)$/, "");
    if (/^[A-Z]/.test(fileName)) allComponentNames.add(fileName);
  }

  for (const file of files) {
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (!componentExtensions.includes(ext)) continue;

    const parts = file.filePath.replace(/\\/g, "/").split("/");
    if (parts.some(p => skipDirs.has(p.toLowerCase()))) continue;
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) continue;

    const fileName = parts[parts.length - 1].replace(/\.(vue|tsx|jsx|ts|js)$/, "");
    if (skipFiles.has(fileName.toLowerCase())) continue;

    if (sharedComponentPatterns.test(fileName)) continue;

    const parentDir = parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : "";
    const isInScreenDir = screenDirs.has(parentDir);
    const isInComponentsDir = parentDir === "components";
    const isInUiDir = parentDir === "ui";

    if (isInUiDir) continue;

    const isLikelyScreen = isInScreenDir ||
      (isInComponentsDir && /^[A-Z]/.test(fileName) && !sharedComponentPatterns.test(fileName)) ||
      (/^[A-Z]/.test(fileName) && (file.content.includes("return (") || file.content.includes("return(")));

    if (!isLikelyScreen) continue;

    const srcIdx = parts.findIndex(p => p === "src" || p === "app");
    let routePath: string;
    if (srcIdx >= 0) {
      const relParts = parts.slice(srcIdx + 1);
      const lastPart = relParts[relParts.length - 1].replace(/\.(vue|tsx|jsx|ts|js)$/, "");
      const dirParts = relParts.slice(0, -1).filter(p => p !== "components" && p !== "pages" && p !== "views" && p !== "screens");
      const kebabName = lastPart.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
      routePath = "/" + [...dirParts, kebabName].join("/");
    } else {
      routePath = "/" + fileName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    }

    const guards: string[] = [];
    const hasAuthImport = /\b(useAuth|withAuth|ProtectedRoute|RequireAuth|AuthGuard)\b/.test(file.content);
    if (hasAuthImport) {
      guards.push("requiresAuth");
    }

    const routeEntry = { route: routePath, guards };
    const lowerName = fileName.toLowerCase();
    if (!routeMap.has(lowerName)) routeMap.set(lowerName, routeEntry);

    const kebab = fileName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    if (kebab !== lowerName && !routeMap.has(kebab)) routeMap.set(kebab, routeEntry);

    const noHyphens = lowerName.replace(/[-_]/g, "");
    if (noHyphens !== lowerName && !routeMap.has(noHyphens)) routeMap.set(noHyphens, routeEntry);

    const withSpaces = fileName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    if (withSpaces !== lowerName && !routeMap.has(withSpaces)) routeMap.set(withSpaces, routeEntry);
  }
}

function extractRoutesFromAST(sourceFile: ts.SourceFile, filePath: string): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const parent = node.parent;
      if (parent) {
        let isRoutesArray = false;

        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          const name = parent.name.text.toLowerCase();
          if (name.includes("route")) isRoutesArray = true;
        }

        if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
          const name = parent.name.text;
          if (name === "routes" || name === "children") isRoutesArray = true;
        }

        if (ts.isCallExpression(parent)) {
          const callText = parent.expression.getText(sourceFile);
          if (callText.includes("createRouter") || callText.includes("createBrowserRouter") ||
              callText.includes("RouterModule.forRoot") || callText.includes("RouterModule.forChild")) {
            isRoutesArray = true;
          }
        }

        if (isRoutesArray) {
          for (const element of node.elements) {
            if (ts.isObjectLiteralExpression(element)) {
              const route = parseRouteObject(element, sourceFile);
              if (route) routes.push(route);
            }
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callText = node.expression.getText(sourceFile);
      if (callText.includes("createBrowserRouter") || callText.includes("createHashRouter") || callText.includes("createMemoryRouter")) {
        for (const arg of node.arguments) {
          if (ts.isArrayLiteralExpression(arg)) {
            for (const element of arg.elements) {
              if (ts.isObjectLiteralExpression(element)) {
                const route = parseRouteObject(element, sourceFile);
                if (route) routes.push(route);
              }
            }
          }
        }
      }
    }

    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = ts.isJsxElement(node) ? node.openingElement.tagName.getText(sourceFile) : node.tagName.getText(sourceFile);
      if (tagName === "Route") {
        const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
        let path = "";
        let component = "";
        let isIndex = false;
        const guards: string[] = [];

        for (const attr of attrs.properties) {
          if (ts.isJsxAttribute(attr) && attr.name) {
            const attrName = attr.name.getText(sourceFile);
            if (attrName === "path" && attr.initializer) {
              if (ts.isStringLiteral(attr.initializer)) {
                path = attr.initializer.text;
              } else if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression && ts.isStringLiteral(attr.initializer.expression)) {
                path = attr.initializer.expression.text;
              }
            }
            if (attrName === "index" && !attr.initializer) {
              isIndex = true;
            }
            if (attrName === "index" && attr.initializer) {
              if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
                if (attr.initializer.expression.kind === ts.SyntaxKind.TrueKeyword) isIndex = true;
              } else {
                isIndex = true;
              }
            }
            if ((attrName === "element" || attrName === "component") && attr.initializer) {
              if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
                const elementText = attr.initializer.expression.getText(sourceFile);
                const extracted = extractComponentFromJsxElement(attr.initializer.expression, sourceFile, guards);
                component = extracted || elementText.replace(/<|\/>/g, "").trim();
              }
            }
          }
        }

        const childRoutes: RouteDefinition[] = [];
        if (ts.isJsxElement(node)) {
          for (const child of node.children) {
            if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
              const childTag = ts.isJsxElement(child) ? child.openingElement.tagName.getText(sourceFile) : child.tagName.getText(sourceFile);
              if (childTag === "Route") {
                const childRoute = extractJsxRoute(child, sourceFile);
                if (childRoute) childRoutes.push(childRoute);
              }
            }
          }
        }

        if (isIndex && !path) path = "";
        if (path || isIndex) {
          routes.push({ path, component, guards, children: childRoutes });
          return;
        }
        if (component && childRoutes.length > 0) {
          routes.push({ path: "", component, guards, children: childRoutes });
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return routes;
}

function parseRouteObject(node: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): RouteDefinition | null {
  let path = "";
  let component = "";
  let isIndex = false;
  const guards: string[] = [];
  const children: RouteDefinition[] = [];

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
      if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) continue;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === "index") isIndex = true;
      continue;
    }
    if (!ts.isIdentifier(prop.name)) continue;
    const name = prop.name.text;

    if (name === "path") {
      if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
        path = prop.initializer.text;
      }
    }

    if (name === "index") {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) isIndex = true;
    }

    if (name === "component" || name === "element") {
      component = extractComponentName(prop.initializer, sourceFile);
    }

    if (name === "name") {
      if (ts.isStringLiteral(prop.initializer)) {
        if (!component) component = prop.initializer.text;
      }
    }

    if (name === "beforeEnter" || name === "canActivate" || name === "canActivateChild" || name === "canDeactivate" || name === "canLoad") {
      guards.push(...extractGuardNames(prop.initializer, sourceFile));
    }

    if (name === "meta" && ts.isObjectLiteralExpression(prop.initializer)) {
      for (const metaProp of prop.initializer.properties) {
        if (ts.isPropertyAssignment(metaProp) && ts.isIdentifier(metaProp.name)) {
          const metaName = metaProp.name.text.toLowerCase();
          if (metaName === "requiresauth" || metaName === "requireauth" || metaName === "auth" || metaName === "authenticated") {
            if (metaProp.initializer.kind === ts.SyntaxKind.TrueKeyword) {
              guards.push("requiresAuth");
            }
          }
          if (metaName === "roles" || metaName === "requiredroles" || metaName === "permissions") {
            if (ts.isArrayLiteralExpression(metaProp.initializer)) {
              for (const el of metaProp.initializer.elements) {
                if (ts.isStringLiteral(el)) {
                  guards.push(`role:${el.text}`);
                }
              }
            }
          }
          if (metaName === "guard" || metaName === "guards") {
            guards.push(...extractGuardNames(metaProp.initializer, sourceFile));
          }
        }
      }
    }

    if (name === "children" && ts.isArrayLiteralExpression(prop.initializer)) {
      for (const child of prop.initializer.elements) {
        if (ts.isObjectLiteralExpression(child)) {
          const childRoute = parseRouteObject(child, sourceFile);
          if (childRoute) children.push(childRoute);
        }
      }
    }
  }

  if (isIndex && !path) path = "";
  if (!path && !isIndex && !component) return null;
  return { path, component, guards, children };
}

function extractComponentName(node: ts.Node, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node)) return node.text;

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const body = node.body;
    if (ts.isCallExpression(body)) {
      const callText = body.expression.getText(sourceFile);
      if (callText === "import") {
        const firstArg = body.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          const importPath = firstArg.text;
          return importPath.split("/").pop()?.replace(/\.(vue|tsx|jsx|ts|js)$/, "") || importPath;
        }
      }
    }
    if (ts.isBlock(body)) {
      const text = body.getText(sourceFile);
      const importMatch = text.match(/import\(\s*['"]([^'"]+)['"]\s*\)/);
      if (importMatch) {
        return importMatch[1].split("/").pop()?.replace(/\.(vue|tsx|jsx|ts|js)$/, "") || importMatch[1];
      }
    }
  }

  if (ts.isCallExpression(node)) {
    const callText = node.expression.getText(sourceFile);
    if (callText === "lazy" || callText === "React.lazy" || callText === "defineAsyncComponent") {
      const firstArg = node.arguments[0];
      if (firstArg) return extractComponentName(firstArg, sourceFile);
    }
    if (callText === "import") {
      const firstArg = node.arguments[0];
      if (firstArg && ts.isStringLiteral(firstArg)) {
        return firstArg.text.split("/").pop()?.replace(/\.(vue|tsx|jsx|ts|js)$/, "") || firstArg.text;
      }
    }
  }

  return node.getText(sourceFile).replace(/[()]/g, "").trim();
}

function extractGuardNames(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const guards: string[] = [];

  if (ts.isIdentifier(node)) {
    guards.push(node.text);
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const el of node.elements) {
      if (ts.isIdentifier(el)) {
        guards.push(el.text);
      } else if (ts.isNewExpression(el) && ts.isIdentifier(el.expression)) {
        guards.push(el.expression.text);
      } else if (ts.isCallExpression(el)) {
        guards.push(el.expression.getText(sourceFile));
      }
    }
  } else if (ts.isCallExpression(node)) {
    guards.push(node.expression.getText(sourceFile));
  }

  return guards;
}

import _ts from "typescript";
import type {
  ImportBinding,
  ExternalCall,
  HttpServiceMap,
  HttpCall,
  FrontendInteraction,
  ResolutionStep,
  SymbolDeclaration,
} from "./types";
import { parseTypeScript, getLineNumber } from "./parsers";
import type { ApplicationGraph, GraphNode } from "../application-graph";

import ts = _ts;

interface SymbolTableLike {
  resolveHandlerNode(name: string): ts.Node | null;
  getDeclaration(node: ts.Node): SymbolDeclaration | undefined;
}

export function getComponentName(filePath: string): string {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  const name = fileName.replace(/\.(vue|jsx|tsx|ts|js|html)$/, "");
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
}

export function extractUrlFromNode(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const spanExpr = span.expression;
      if (ts.isIdentifier(spanExpr)) {
        const constVal = traceLocalConstant(spanExpr);
        if (constVal) {
          result += constVal + span.literal.text;
          continue;
        }
      }
      result += "{param}" + span.literal.text;
    }
    return result;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractUrlFromNode(node.left);
    const right = extractUrlFromNode(node.right);
    if (left && right) return left + right;
    if (left) return left + "{param}";
    if (right) return "{param}" + right;
  }
  if (ts.isIdentifier(node)) {
    const constVal = traceLocalConstant(node);
    if (constVal && (constVal.startsWith("/") || constVal.startsWith("http"))) {
      return constVal;
    }
  }
  if (ts.isPropertyAccessExpression(node)) {
    const constVal = tracePropertyConstant(node);
    if (constVal && (constVal.startsWith("/") || constVal.startsWith("http"))) {
      return constVal;
    }
  }
  return null;
}

const OPERATION_HINT_FIELDS = new Set([
  "service", "action", "command", "operation",
  "operationName", "serviceName", "actionName", "commandName", "queryName",
  "rpc", "procedure", "topic", "operationType", "serviceAction",
]);

export function extractOperationHint(
  callNode: ts.CallExpression,
  sourceFile: ts.SourceFile,
  bodyArgIndex: number
): string | null {
  if (callNode.arguments.length <= bodyArgIndex) return null;
  const bodyArg = callNode.arguments[bodyArgIndex];

  if (ts.isObjectLiteralExpression(bodyArg)) {
    return extractOperationFromObject(bodyArg, sourceFile);
  }

  if (ts.isIdentifier(bodyArg)) {
    let current: ts.Node | undefined = bodyArg.parent;
    while (current && !ts.isSourceFile(current) && !ts.isBlock(current)) {
      current = current.parent;
    }
    if (current) {
      let found: string | null = null;
      const visit = (node: ts.Node) => {
        if (found) return;
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === bodyArg.text) {
          if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
            found = extractOperationFromObject(node.initializer, sourceFile);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(current);
      return found;
    }
  }

  const urlArg = callNode.arguments[0];
  if (urlArg && (ts.isStringLiteral(urlArg) || ts.isNoSubstitutionTemplateLiteral(urlArg))) {
    const url = urlArg.text;
    const queryIdx = url.indexOf("?");
    if (queryIdx >= 0) {
      const queryStr = url.substring(queryIdx + 1);
      const params = queryStr.split("&");
      for (const param of params) {
        const [key, value] = param.split("=");
        if (key && value && OPERATION_HINT_FIELDS.has(key)) {
          return value;
        }
      }
    }
  }

  return null;
}

export function extractOperationFromObject(obj: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): string | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      if (OPERATION_HINT_FIELDS.has(prop.name.text)) {
        if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
          return prop.initializer.text;
        }
      }
    }
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "params") {
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        const nested = extractOperationFromObject(prop.initializer, sourceFile);
        if (nested) return nested;
      }
    }
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "data") {
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        const nested = extractOperationFromObject(prop.initializer, sourceFile);
        if (nested) return nested;
      }
    }
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "body") {
      if (ts.isObjectLiteralExpression(prop.initializer)) {
        const nested = extractOperationFromObject(prop.initializer, sourceFile);
        if (nested) return nested;
      }
    }
  }
  return null;
}

export function traceLocalConstant(id: ts.Identifier): string | null {
  let current: ts.Node | undefined = id.parent;
  while (current) {
    if (ts.isSourceFile(current) || ts.isBlock(current)) {
      break;
    }
    current = current.parent;
  }
  if (!current) return null;

  let result: string | null = null;
  const visit = (node: ts.Node) => {
    if (result !== null) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === id.text) {
      if (node.initializer) {
        if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
          const modifiers = ts.canHaveModifiers(node.parent?.parent!) ? ts.getModifiers(node.parent?.parent!) : undefined;
          const isConst = node.parent && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
          if (isConst) {
            result = node.initializer.text;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(current);
  return result;
}

export function tracePropertyConstant(node: ts.PropertyAccessExpression): string | null {
  if (ts.isIdentifier(node.expression)) {
    const objName = node.expression.text;
    const propName = node.name.text;

    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isSourceFile(current) || ts.isBlock(current)) break;
      current = current.parent;
    }
    if (!current) return null;

    let result: string | null = null;
    const visit = (n: ts.Node) => {
      if (result !== null) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === objName) {
        if (n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
          for (const prop of n.initializer.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === propName) {
              if (ts.isStringLiteral(prop.initializer)) {
                result = prop.initializer.text;
              }
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(current);
    return result;
  }
  return null;
}

export function extractInlineHandlerTarget(node: ts.ArrowFunction | ts.FunctionExpression): { handlerName: string; objectName?: string } {
  let result = "";
  let objectName: string | undefined;
  function visit(n: ts.Node) {
    if (result) return;
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        result = n.expression.text;
      } else if (ts.isPropertyAccessExpression(n.expression)) {
        result = n.expression.name.text;
        if (ts.isIdentifier(n.expression.expression)) {
          objectName = n.expression.expression.text;
        }
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node.body);
  return { handlerName: result || "__inline_handler__", objectName };
}

export function classifyElement(tagName: string): string {
  const tag = tagName.toLowerCase();
  if (tag === "button" || tag.includes("button") || tag.includes("btn") || tag === "el-button" || tag === "a-button" || tag === "v-btn" || tag === "mat-button" || tag === "mat-raised-button" || tag === "mat-icon-button") {
    return "button";
  }
  if (tag === "a" || tag === "router-link" || tag === "link" || tag === "navlink") {
    return "link";
  }
  if (tag === "form" || tag === "el-form" || tag === "nz-form" || tag === "mat-form") {
    return "form";
  }
  if (tag.includes("menu-item") || tag.includes("menuitem") || tag.includes("dropdown") || tag.includes("list-item")) {
    return "menu";
  }
  if (tag === "input" || tag === "select" || tag === "textarea" || tag.includes("input") || tag.includes("select")) {
    return "input";
  }
  if (tag === "icon" || tag.includes("icon")) {
    return "icon";
  }
  return "element";
}

export function normalizeUrl(url: string): string {
  return url
    .replace(/\$\{[^}]+\}/g, "{param}")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/\/+/g, "/")
    .trim();
}

export function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function extractExternalDomain(url: string): string | null {
  const match = url.match(/^https?:\/\/([^\/]+)/i);
  return match ? match[1] : null;
}

export function isServerSideFile(filePath: string): boolean {
  const serverIndicators = [
    /^server\//i,
    /\/server\//i,
    /^backend\//i,
    /\/backend\//i,
    /\/middlewares?\//i,
    /\/controllers?\//i,
    /\/services?\//i,
    /\/routes?\//i,
    /\/api\//i,
  ];
  const fileContent = filePath.toLowerCase();
  if (fileContent.includes("node_modules") || fileContent.includes("dist/") || fileContent.includes("build/")) {
    return false;
  }
  for (const indicator of serverIndicators) {
    if (indicator.test(filePath)) {
      if (filePath.includes("/src/views/") || filePath.includes("/src/pages/") || 
          filePath.includes("/src/components/") || filePath.includes("/src/layouts/")) {
        return false;
      }
      return true;
    }
  }
  return false;
}

export function extractOperationNameFromUrl(url: string): string | null {
  const cleaned = url.replace(/\?.*$/, "").replace(/\/+/g, "/").replace(/\/$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (isParamSegment(seg)) continue;
    const withoutVersion = seg.replace(/\.v\d+$/i, "");
    if (/^[a-z][a-zA-Z]{4,}$/.test(withoutVersion) && /[A-Z]/.test(withoutVersion)) {
      return withoutVersion;
    }
  }
  return null;
}

export function normalizeClassName(className: string): string {
  return className
    .replace(/(?:WsV\d+|ServiceV\d+|Ws|Handler|Action|Command|Controller|Resource|Endpoint)$/i, "")
    .toLowerCase();
}

export function operationNameMatchScore(operationName: string, className: string): number {
  const normalizedOp = operationName.toLowerCase();
  const normalizedClass = normalizeClassName(className);
  if (normalizedOp === normalizedClass) return 90;
  if (normalizedClass.includes(normalizedOp) || normalizedOp.includes(normalizedClass)) {
    const longer = Math.max(normalizedOp.length, normalizedClass.length);
    const shorter = Math.min(normalizedOp.length, normalizedClass.length);
    if (shorter / longer >= 0.6) return 80;
    return 70;
  }
  return 0;
}

export function matchUrlToEndpoint(
  httpMethod: string,
  url: string,
  graph: ApplicationGraph
): GraphNode | null {
  if (isExternalUrl(url)) return null;

  const normalizedUrl = normalizeUrl(url);
  const controllers = graph.getNodesByType("CONTROLLER");
  let bestNode: GraphNode | null = null;
  let bestScore = 0;

  for (const node of controllers) {
    const meta = node.metadata as { httpMethod?: string; fullPath?: string };
    if (!meta.httpMethod || !meta.fullPath) continue;
    if (httpMethod && meta.httpMethod.toUpperCase() !== httpMethod.toUpperCase()) continue;

    const score = endpointMatchScore(normalizedUrl, meta.fullPath);
    if (score > bestScore && score >= 50) {
      bestScore = score;
      bestNode = node;
    }
  }

  if (!bestNode) {
    const operationName = extractOperationNameFromUrl(normalizedUrl);
    if (operationName) {
      let bestOpScore = 0;
      for (const node of controllers) {
        const meta = node.metadata as { httpMethod?: string; fullPath?: string };
        if (httpMethod && meta.httpMethod && meta.httpMethod.toUpperCase() !== httpMethod.toUpperCase()) continue;

        const opScore = operationNameMatchScore(operationName, node.className);
        if (opScore > bestOpScore && opScore >= 70) {
          bestOpScore = opScore;
          bestNode = node;
        }
      }
    }
  }

  if (!bestNode) {
    for (const node of controllers) {
      const meta = node.metadata as { httpMethod?: string; fullPath?: string };
      if (!meta.fullPath) continue;
      const score = endpointMatchScore(normalizedUrl, meta.fullPath);
      if (score > bestScore && score >= 40) {
        bestScore = score;
        bestNode = node;
      }
    }
  }

  return bestNode;
}

export function normalizeSegment(seg: string): string {
  return seg.replace(/\.v\d+$/, "").replace(/\.(json|xml|html|csv|pdf)$/i, "");
}

export function isParamSegment(seg: string): boolean {
  return seg === "{param}" || seg.startsWith("{") || seg.startsWith(":");
}

export function endpointMatchScore(frontendUrl: string, backendPath: string): number {
  const normFront = frontendUrl.replace(/\/+/g, "/").replace(/\/$/, "").replace(/\?.*$/, "");
  const normBack = backendPath.replace(/\/+/g, "/").replace(/\/$/, "");

  if (normFront === normBack) return 100;

  const frontParts = normFront.split("/").filter(Boolean);
  const backParts = normBack.split("/").filter(Boolean);

  if (backParts.length <= 1 && frontParts.length > 2) {
    return 0;
  }

  const hasBasePrefix = frontParts.length > 0 && frontParts[0] === "{base}";

  if (hasBasePrefix) {
    const suffixParts = frontParts.slice(1);
    if (suffixParts.length === 0) return 0;

    if (backParts.length >= suffixParts.length) {
      const backSuffix = backParts.slice(backParts.length - suffixParts.length);
      let matchCount = 0;
      for (let i = 0; i < suffixParts.length; i++) {
        const fp = normalizeSegment(suffixParts[i]);
        const bp = normalizeSegment(backSuffix[i]);
        if (fp === bp) {
          matchCount++;
        } else if (isParamSegment(bp) || isParamSegment(fp)) {
          matchCount += 0.8;
        } else {
          return 0;
        }
      }
      return (matchCount / suffixParts.length) * 85;
    }
    return 0;
  }

  if (frontParts.length === backParts.length) {
    let matchCount = 0;
    let literalMatches = 0;
    for (let i = 0; i < frontParts.length; i++) {
      const fp = normalizeSegment(frontParts[i]);
      const bp = normalizeSegment(backParts[i]);
      if (fp === bp) {
        matchCount++;
        literalMatches++;
      } else if (isParamSegment(bp) || isParamSegment(fp)) {
        matchCount += 0.8;
      }
    }
    if (literalMatches === 0 && frontParts.length > 1) return 0;
    return (matchCount / frontParts.length) * 100;
  }

  if (frontParts.length > 0 && backParts.length > 0) {
    const frontStr = frontParts.map(normalizeSegment).join("/");
    const backStr = backParts.map(normalizeSegment).join("/");
    if (backParts.length >= 2 && (frontStr.includes(backStr) || backStr.includes(frontStr))) {
      const ratio = Math.min(frontParts.length, backParts.length) / Math.max(frontParts.length, backParts.length);
      if (ratio >= 0.5) return 60;
    }
  }

  if (frontParts.length > backParts.length && backParts.length >= 2) {
    const offset = frontParts.length - backParts.length;
    let matchCount = 0;
    let literalMatches = 0;
    for (let i = 0; i < backParts.length; i++) {
      const fp = normalizeSegment(frontParts[i + offset]);
      const bp = normalizeSegment(backParts[i]);
      if (fp === bp) {
        matchCount++;
        literalMatches++;
      } else if (isParamSegment(bp) || isParamSegment(fp)) {
        matchCount += 0.8;
      } else {
        return 0;
      }
    }
    if (literalMatches === 0) return 0;
    return (matchCount / backParts.length) * 70;
  }

  if (backParts.length > frontParts.length && frontParts.length >= 2) {
    const offset = backParts.length - frontParts.length;
    let matchCount = 0;
    let literalMatches = 0;
    for (let i = 0; i < frontParts.length; i++) {
      const fp = normalizeSegment(frontParts[i]);
      const bp = normalizeSegment(backParts[i + offset]);
      if (fp === bp) {
        matchCount++;
        literalMatches++;
      } else if (isParamSegment(bp) || isParamSegment(fp)) {
        matchCount += 0.8;
      } else {
        return 0;
      }
    }
    if (literalMatches === 0) return 0;
    return (matchCount / frontParts.length) * 65;
  }

  return 0;
}

export function normalizeModulePath(importerPath: string, moduleSpecifier: string, allFilePaths: string[]): string | null {
  if (moduleSpecifier.startsWith(".")) {
    const importerDir = importerPath.substring(0, importerPath.lastIndexOf("/"));
    const parts = importerDir.split("/");
    const specParts = moduleSpecifier.split("/");
    const resolved: string[] = [...parts];
    for (const seg of specParts) {
      if (seg === ".") continue;
      if (seg === "..") { resolved.pop(); continue; }
      resolved.push(seg);
    }
    const base = resolved.join("/");
    const extensions = [".ts", ".js", ".tsx", ".jsx", ".vue", "/index.ts", "/index.js", "/index.vue"];
    for (const ext of extensions) {
      const candidate = base + ext;
      if (allFilePaths.indexOf(candidate) >= 0) return candidate;
    }
    if (allFilePaths.indexOf(base) >= 0) return base;
    return null;
  }

  if (moduleSpecifier.startsWith("@/") || moduleSpecifier.startsWith("~/")) {
    const relative = moduleSpecifier.substring(2);
    const prefixes = ["frontend/src/", "src/", "app/", ""];
    const extensions = ["", ".ts", ".js", ".tsx", ".jsx", ".vue", "/index.ts", "/index.js", "/index.vue"];
    for (const prefix of prefixes) {
      for (const ext of extensions) {
        const candidate = prefix + relative + ext;
        if (allFilePaths.indexOf(candidate) >= 0) return candidate;
      }
    }
    return null;
  }

  if (!moduleSpecifier.startsWith(".") && !moduleSpecifier.startsWith("/")) {
    return null;
  }

  return null;
}

export function parseImportBindings(sourceFile: ts.SourceFile, importerPath: string, allFilePaths: string[]): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpec = node.moduleSpecifier.text;
      const resolvedPath = normalizeModulePath(importerPath, moduleSpec, allFilePaths);
      if (!resolvedPath) {
        ts.forEachChild(node, visit);
        return;
      }

      if (node.importClause) {
        if (node.importClause.name) {
          bindings.set(node.importClause.name.text, {
            sourcePath: resolvedPath,
            originalName: "default",
            isDefault: true,
          });
        }

        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const spec of node.importClause.namedBindings.elements) {
              const localName = spec.name.text;
              const originalName = spec.propertyName ? spec.propertyName.text : localName;
              bindings.set(localName, {
                sourcePath: resolvedPath,
                originalName,
                isDefault: false,
              });
            }
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            bindings.set(node.importClause.namedBindings.name.text, {
              sourcePath: resolvedPath,
              originalName: "*",
              isDefault: false,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return bindings;
}

export function extractExternalCalls(body: ts.Node, localNames: Set<string>): ExternalCall[] {
  const calls: ExternalCall[] = [];

  const walk = (node: ts.Node, enclosingFn: string | null) => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      let fnName = enclosingFn;
      if (ts.isFunctionDeclaration(node) && node.name) fnName = node.name.text;
      else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) fnName = node.name.text;
      else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) fnName = node.parent.name.text;
        else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) fnName = node.parent.name.text;
      }
      ts.forEachChild(node, child => walk(child, fnName));
      return;
    }

    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      if (ts.isPropertyAccessExpression(expr)) {
        const obj = expr.expression;
        if (ts.isIdentifier(obj) && !localNames.has(obj.text) && obj.text !== "this" && obj.text !== "console" && obj.text !== "Math" && obj.text !== "JSON" && obj.text !== "Object" && obj.text !== "Array" && obj.text !== "Promise" && obj.text !== "window" && obj.text !== "document") {
          calls.push({
            importedName: obj.text,
            methodName: expr.name.text,
            callerFunction: enclosingFn || "__unknown__",
          });
        }
      }

      if (ts.isIdentifier(expr) && !localNames.has(expr.text) && expr.text !== "fetch" && expr.text !== "setTimeout" && expr.text !== "setInterval" && expr.text !== "clearTimeout" && expr.text !== "clearInterval" && expr.text !== "require") {
        calls.push({
          importedName: expr.text,
          methodName: null,
          callerFunction: enclosingFn || "__unknown__",
        });
      }
    }

    ts.forEachChild(node, child => walk(child, enclosingFn));
  };

  walk(body, null);
  return calls;
}

export function resolveExternalCallsToHttpCalls(
  externalCalls: ExternalCall[],
  importBindings: Map<string, ImportBinding>,
  serviceMap: HttpServiceMap,
  handlerName: string,
  symbolTable?: SymbolTableLike,
): HttpCall[] {
  const results: HttpCall[] = [];
  const seen = new Set<string>();

  const relevantFunctions = new Set<string>([handlerName, "__unknown__"]);
  if (symbolTable) {
    const handlerNode = symbolTable.resolveHandlerNode(handlerName);
    if (handlerNode) {
      const visited = new Set<ts.Node>();
      const collectCalled = (node: ts.Node) => {
        if (visited.has(node)) return;
        visited.add(node);
        const decl = symbolTable!.getDeclaration(node);
        if (decl && decl.name) {
          relevantFunctions.add(decl.name);
          for (const calledNode of decl.calledNodes) {
            collectCalled(calledNode);
          }
        }
      };
      collectCalled(handlerNode);
    }
  }

  for (const extCall of externalCalls) {
    if (!relevantFunctions.has(extCall.callerFunction)) continue;

    const binding = importBindings.get(extCall.importedName);
    if (!binding) continue;

    const fileEntry = serviceMap.get(binding.sourcePath);
    if (!fileEntry) continue;

    if (extCall.methodName) {
      const lookupKeys = [
        binding.originalName + "." + extCall.methodName,
        "default." + extCall.methodName,
        extCall.importedName + "." + extCall.methodName,
      ];

      for (const key of lookupKeys) {
        if (seen.has(key)) continue;
        const methodEntry = fileEntry.methods.get(key);
        if (methodEntry && methodEntry.httpCalls.length > 0) {
          results.push(...methodEntry.httpCalls);
          seen.add(key);
          break;
        }
      }
    } else {
      const lookupKeys = [binding.originalName, "default", extCall.importedName];
      for (const key of lookupKeys) {
        if (seen.has(key)) continue;
        const funcCalls = fileEntry.directFunctions.get(key);
        if (funcCalls && funcCalls.length > 0) {
          results.push(...funcCalls);
          seen.add(key);
          break;
        }
      }
    }
  }

  return results;
}

export function isAngularComponent(content: string): boolean {
  return content.includes("@Component") || content.includes("@NgModule") || content.includes("@Injectable");
}

export function detectFileType(filePath: string): "vue" | "react" | "angular" | "javascript" | "html" | null {
  if (filePath.endsWith(".vue")) return "vue";
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return "react";
  if (filePath.endsWith(".html") && !filePath.includes("index.html")) return "html";
  if (filePath.endsWith(".ts") || filePath.endsWith(".js")) {
    return "javascript";
  }
  return null;
}

export function addUnmappedHttpCalls(
  interactions: FrontendInteraction[],
  httpCalls: HttpCall[],
  component: string,
  filePath: string,
  graph: ApplicationGraph
) {
  const mappedUrls = new Set(
    interactions
      .filter((i) => i.url)
      .map((i) => `${i.httpMethod}:${i.url}`)
  );

  for (const call of httpCalls) {
    const key = `${call.method}:${call.url}`;
    if (!mappedUrls.has(key)) {
      const backendNode = matchUrlToEndpoint(call.method, call.url, graph);
      const unmappedPath: ResolutionStep[] = [{ tier: "local", file: filePath, function: call.callerFunction, detail: "unmapped direct HTTP call" }];
      if (backendNode) {
        unmappedPath.push({ tier: "controller", file: backendNode.className, function: backendNode.methodName, detail: `matched ${call.method} ${call.url}` });
      }
      interactions.push({
        component,
        elementType: "http_call",
        actionName: call.callerFunction || "anonymous",
        httpMethod: call.method,
        url: call.url,
        mappedBackendNode: backendNode,
        sourceFile: filePath,
        lineNumber: call.lineNumber,
        resolutionTier: "local",
        resolutionStrategy: "local",
        resolutionPath: unmappedPath,
        interactionCategory: "HTTP",
        confidence: 1.0,
        operationHint: call.operationHint || null,
      });
      mappedUrls.add(key);
    }
  }
}

import _ts from "typescript";
import type { ApplicationGraph, GraphNode } from "./application-graph";
import type { GlobalCallGraphNode, GlobalCallGraph, FileAuthPatterns } from "./frontend/types";
import { makeGlobalKey, buildGlobalCallGraph, propagateHttpCapability, lookupGlobalCallGraph, getFnBody, parseImportBindingsInternal } from "./frontend/global-call-graph";
import { ImportedHttpClients } from "./frontend/http-clients";
import { ScriptSymbolTable } from "./frontend/symbol-table";
import { buildComponentEventGraph, lookupEventGraph } from "./frontend/event-graph";
import { extractVueScript, parseTypeScript, getLineNumber } from "./frontend/parsers";
import { buildStateFlowGraph, lookupStateFlowGraph } from "./frontend/state-flow-graph";
import {
  getComponentName,
  extractUrlFromNode,
  extractOperationHint,
  normalizeUrl,
  isExternalUrl,
  extractExternalDomain,
  isServerSideFile,
  matchUrlToEndpoint,
  parseImportBindings,
  extractExternalCalls,
  resolveExternalCallsToHttpCalls,
  normalizeModulePath,
  isAngularComponent,
  detectFileType,
} from "./frontend/utils";
export { extractUrlFromNode, extractOperationHint } from "./frontend/utils";
import { buildArchitecturalLayerGraph, lookupArchitecturalLayerGraph } from "./frontend/architectural-layer-graph";
import { buildRouteMap, inferRoutesFromFilePaths } from "./frontend/route-extraction";
import { detectFileAuthPatterns } from "./frontend/auth-detection";
import { analyzeVueFile, analyzeReactFile, analyzeAngularFile, parseAngularTemplateAST, parseJSXTemplate } from "./frontend/file-analyzers";

import ts = _ts;

export interface ResolutionStep {
  tier: string;
  file: string;
  function: string | null;
  detail: string | null;
}

export interface ResolutionMetadata {
  tier: string;
  resolutionPath: ResolutionStep[];
}

export interface FrontendInteraction {
  component: string;
  elementType: string;
  actionName: string;
  httpMethod: string | null;
  url: string | null;
  mappedBackendNode: GraphNode | null;
  sourceFile: string;
  lineNumber: number;
  resolutionTier: string | null;
  resolutionStrategy: string | null;
  resolutionPath: ResolutionStep[] | null;
  interactionCategory: "HTTP" | "UI_ONLY" | "STATE_ONLY" | "SERVICE_BRIDGE" | "EXTERNAL_SERVICE";
  confidence: number;
  frontendRoute?: string | null;
  routeGuards?: string[];
  detectedRoles?: string[];
  externalDomain?: string | null;
  operationHint?: string | null;
}

interface HttpCall {
  method: string;
  url: string;
  lineNumber: number;
  callerFunction: string | null;
  operationHint?: string | null;
}

interface TemplateBinding {
  elementType: string;
  eventType: string;
  handlerName: string;
  lineNumber: number;
  objectName?: string;
}

interface SymbolDeclaration {
  name: string;
  node: ts.Node;
  httpCalls: HttpCall[];
  calledNodes: ts.Node[];
}

interface DestructuredBinding {
  name: string;
  sourceCallName: string;
  sourceIsHook: boolean;
}

interface VariableOrigin {
  varName: string;
  sourceCallName: string;
  sourceIsHook: boolean;
}

interface ComponentEmitEntry {
  eventName: string;
  emitterFunction: string;
}

interface EventListenerEntry {
  childTag: string;
  childFilePath: string | null;
  eventName: string;
  parentHandler: string;
}

interface ComponentEventGraph {
  emitters: Map<string, ComponentEmitEntry[]>;
  listeners: Map<string, EventListenerEntry[]>;
  componentRegistry: Map<string, string>;
}

type BaseURLRegistry = Map<string, string>;

function buildBaseURLRegistry(files: { filePath: string; content: string }[]): BaseURLRegistry {
  const registry: BaseURLRegistry = new Map();

  for (const file of files) {
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx"].includes(ext)) continue;
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) continue;

    try {
      const sourceFile = parseTypeScript(file.content, file.filePath);
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const name = node.name.text;
          const nameLower = name.toLowerCase();

          if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
            const value = node.initializer.text;
            if ((nameLower.includes("base") || nameLower.includes("prefix") || nameLower.includes("api_url") || nameLower.includes("apiurl")) && value.startsWith("/")) {
              registry.set(`${file.filePath}::${name}`, value);
            }
          }

          if (ts.isCallExpression(node.initializer)) {
            const callExpr = node.initializer.expression;
            if (ts.isPropertyAccessExpression(callExpr) && callExpr.name.text === "create") {
              const args = node.initializer.arguments;
              if (args.length > 0 && ts.isObjectLiteralExpression(args[0])) {
                for (const prop of args[0].properties) {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "baseURL") {
                    if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
                      registry.set(`${file.filePath}::${name}`, prop.initializer.text);
                    }
                  }
                }
              }
            }
          }
        }

        if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
          const bin = node.expression;
          if (bin.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const leftText = bin.left.getText(sourceFile);
            if (leftText.includes("defaults.baseURL") || leftText.includes("defaults.baseUrl")) {
              if (ts.isStringLiteral(bin.right) || ts.isNoSubstitutionTemplateLiteral(bin.right)) {
                registry.set(`${file.filePath}::__defaults__`, bin.right.text);
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    } catch (err) {
    }
  }

  if (registry.size > 0) {
    console.log(`[frontend-analyzer] BaseURLRegistry: ${registry.size} entries found`);
    registry.forEach((value, key) => {
      console.log(`[frontend-analyzer]   ${key} → ${value}`);
    });
  }

  return registry;
}

function resolveBaseURL(url: string, filePath: string, baseURLRegistry: BaseURLRegistry): string {
  if (!url || url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) return url;

  if (url.startsWith("{base}/") || url.startsWith("{base}")) {
    const suffix = url.replace(/^\{base\}\/?/, "");
    for (const [key, base] of Array.from(baseURLRegistry.entries())) {
      if (key.startsWith(filePath + "::") || key.includes("::__defaults__")) {
        const resolved = base.replace(/\/$/, "") + "/" + suffix;
        return resolved.replace(/\/+/g, "/");
      }
    }
    for (const [, base] of Array.from(baseURLRegistry.entries())) {
      const resolved = base.replace(/\/$/, "") + "/" + suffix;
      return resolved.replace(/\/+/g, "/");
    }
  }

  if (!url.startsWith("/") && !url.startsWith("http")) {
    for (const [key, base] of Array.from(baseURLRegistry.entries())) {
      if (key.startsWith(filePath + "::") || key.includes("::__defaults__")) {
        const resolved = base.replace(/\/$/, "") + "/" + url;
        return resolved.replace(/\/+/g, "/");
      }
    }
    for (const [, base] of Array.from(baseURLRegistry.entries())) {
      const resolved = base.replace(/\/$/, "") + "/" + url;
      return resolved.replace(/\/+/g, "/");
    }
  }

  return url;
}

// ImportedHttpClients class extracted to ./frontend/http-clients.ts


interface ExternalCall {
  importedName: string;
  methodName: string | null;
  callerFunction: string;
}

interface ServiceMethodEntry {
  httpCalls: HttpCall[];
}

interface FileServiceEntry {
  methods: Map<string, ServiceMethodEntry>;
  directFunctions: Map<string, HttpCall[]>;
}

type HttpServiceMap = Map<string, FileServiceEntry>;

interface ImportBinding {
  sourcePath: string;
  originalName: string;
  isDefault: boolean;
}

function extractExports(sourceFile: ts.SourceFile): { exportedNames: Set<string>; classInstances: Map<string, string>; defaultExportName: string | null } {
  const exportedNames = new Set<string>();
  const classInstances = new Map<string, string>();
  let defaultExportName: string | null = null;

  const visit = (node: ts.Node) => {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const hasExport = mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const hasDefault = mods?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

    if (hasExport && ts.isFunctionDeclaration(node) && node.name) {
      exportedNames.add(node.name.text);
      if (hasDefault) defaultExportName = node.name.text;
    }

    if (hasExport && ts.isClassDeclaration(node) && node.name) {
      exportedNames.add(node.name.text);
      if (hasDefault) defaultExportName = node.name.text;
    }

    if (hasExport && ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varName = decl.name.text;
          exportedNames.add(varName);
          if (hasDefault) defaultExportName = varName;

          if (decl.initializer && ts.isNewExpression(decl.initializer)) {
            const ctorExpr = decl.initializer.expression;
            if (ts.isIdentifier(ctorExpr)) {
              classInstances.set(varName, ctorExpr.text);
            }
          }
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression)) {
        defaultExportName = node.expression.text;
        exportedNames.add(node.expression.text);
      } else if (ts.isNewExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        defaultExportName = "__default__";
        classInstances.set("__default__", node.expression.expression.text);
      }
    }

    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        exportedNames.add(spec.name.text);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { exportedNames, classInstances, defaultExportName };
}

function extractClassMethods(sourceFile: ts.SourceFile): Map<string, Map<string, HttpCall[]>> {
  const classMethodMap = new Map<string, Map<string, HttpCall[]>>();

  const httpClients = ImportedHttpClients.build(sourceFile);

  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const methods = new Map<string, HttpCall[]>();

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
          const methodName = member.name.text;
          const calls: HttpCall[] = [];
          walkForHttpCalls(member.body, sourceFile, httpClients, methodName, calls);
          if (calls.length > 0) {
            methods.set(methodName, calls);
          }
        }
      }

      const wrapperMethodNames = new Set<string>();
      methods.forEach((_calls, methodName) => {
        wrapperMethodNames.add(methodName);
      });

      if (wrapperMethodNames.size > 0) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
            const methodName = member.name.text;
            if (methods.has(methodName)) continue;
            const syntheticCalls = extractThisWrapperCalls(member.body, sourceFile, methodName, wrapperMethodNames);
            if (syntheticCalls.length > 0) {
              methods.set(methodName, syntheticCalls);
            }
          }
        }
      }

      if (methods.size > 0) {
        classMethodMap.set(className, methods);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return classMethodMap;
}

function extractThisWrapperCalls(body: ts.Node, sourceFile: ts.SourceFile, callerName: string, wrapperMethodNames: Set<string>): HttpCall[] {
  const results: HttpCall[] = [];
  const varMap = buildLocalVarMap(body);

  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isPropertyAccessExpression(expr)) {
        const obj = expr.expression;
        const isThis = obj.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(obj) && obj.text === "this");
        if (isThis && wrapperMethodNames.has(expr.name.text)) {
          if (node.arguments.length > 0) {
            const url = resolveUrlFromExpression(node.arguments[0] as ts.Expression, varMap);
            if (url && url !== "{param}" && url !== "{param}{param}") {
              let method = "GET";
              for (let ai = 1; ai < node.arguments.length; ai++) {
                const arg = node.arguments[ai];
                if (ts.isObjectLiteralExpression(arg)) {
                  for (const prop of arg.properties) {
                    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "method" && ts.isStringLiteral(prop.initializer)) {
                      method = prop.initializer.text.toUpperCase();
                    }
                  }
                }
              }
              const operationHint = extractOperationHint(node, sourceFile, 1);
              results.push({ method, url, lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)), callerFunction: callerName, operationHint });
            }
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  return results;
}

export function buildLocalVarMap(body: ts.Node): Map<string, ts.Expression> {
  const varMap = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      varMap.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return varMap;
}

function resolveUrlFromExpression(expr: ts.Expression, varMap: Map<string, ts.Expression>, depth: number = 0): string | null {
  if (depth > 5) return null;

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }

  if (ts.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const resolved = resolveUrlFromExpression(span.expression as ts.Expression, varMap, depth + 1);
      result += (resolved || "{param}") + span.literal.text;
    }
    return result;
  }

  if (ts.isIdentifier(expr)) {
    const init = varMap.get(expr.text);
    if (init) return resolveUrlFromExpression(init, varMap, depth + 1);
  }

  if (ts.isAwaitExpression(expr) && expr.expression) {
    return resolveUrlFromExpression(expr.expression as ts.Expression, varMap, depth + 1);
  }

  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveUrlFromExpression(expr.left, varMap, depth + 1);
    const right = resolveUrlFromExpression(expr.right, varMap, depth + 1);
    if (left || right) return (left || "{param}") + (right || "{param}");
  }

  if (ts.isCallExpression(expr)) {
    const fnExpr = expr.expression;
    if (ts.isPropertyAccessExpression(fnExpr)) {
      const methodName = fnExpr.name.text;
      if (methodName === "buildEndpoint" || methodName === "buildUrl" || methodName === "getUrl" || methodName === "getEndpoint") {
        const parts: string[] = [];
        for (const arg of expr.arguments) {
          if (ts.isStringLiteral(arg)) parts.push(arg.text);
        }
        if (parts.length > 0) return "{base}/" + parts.join("/");
      }
    }
  }

  return null;
}

function walkForHttpCalls(body: ts.Node, sourceFile: ts.SourceFile, httpClients: ImportedHttpClients, callerName: string, results: HttpCall[]): void {
  const varMap = buildLocalVarMap(body);

  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const httpCall = extractHttpCallFromExpression(node, sourceFile, httpClients, callerName, varMap);
      if (httpCall) {
        results.push(httpCall);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
}

export function extractHttpCallFromExpression(node: ts.CallExpression, sourceFile: ts.SourceFile, httpClients: ImportedHttpClients, callerName: string, varMap?: Map<string, ts.Expression>): HttpCall | null {
  const expr = node.expression;

  // Handle chained calls: api.get("/url").json(), api.post("/url").then(...)
  if (ts.isPropertyAccessExpression(expr)) {
    const chainMethod = expr.name.text.toLowerCase();
    if (["json", "text", "blob", "arrayBuffer", "formData", "then", "catch"].includes(chainMethod)) {
      // The real HTTP call is in the inner expression
      if (ts.isCallExpression(expr.expression)) {
        const innerResult = extractHttpCallFromExpression(expr.expression, sourceFile, httpClients, callerName, varMap);
        if (innerResult) return innerResult;
      }
    }
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const methodName = expr.name.text.toLowerCase();
    const httpMethods = ["get", "post", "put", "delete", "patch"];

    if (httpMethods.includes(methodName)) {
      const calleeObj = expr.expression;
      let isHttp = false;

      if (ts.isIdentifier(calleeObj)) {
        isHttp = httpClients.isHttpClient(calleeObj.text);
      } else {
        const expressionText = calleeObj.getText(sourceFile);
        isHttp = httpClients.isHttpExpression(expressionText);
      }

      if (isHttp && node.arguments.length > 0) {
        const url = varMap
          ? resolveUrlFromExpression(node.arguments[0] as ts.Expression, varMap)
          : extractUrlFromNode(node.arguments[0]);
        if (url) {
          const operationHint = extractOperationHint(node, sourceFile, 1);
          return { method: methodName.toUpperCase(), url, lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)), callerFunction: callerName, operationHint };
        }
      }
    }
  }

  if (ts.isIdentifier(expr) && (expr.text === "fetch" || httpClients.isHttpClient(expr.text))) {
    if (node.arguments.length >= 2) {
      const firstArg = node.arguments[0];
      if (ts.isStringLiteral(firstArg)) {
        const firstVal = firstArg.text.toUpperCase();
        const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
        if (httpMethods.includes(firstVal)) {
          const url = varMap
            ? resolveUrlFromExpression(node.arguments[1] as ts.Expression, varMap)
            : extractUrlFromNode(node.arguments[1]);
          if (url) {
            const operationHint = extractOperationHint(node, sourceFile, 1);
            return { method: firstVal, url, lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)), callerFunction: callerName, operationHint };
          }
        }
      }
    }
    if (node.arguments.length > 0) {
      const url = varMap
        ? resolveUrlFromExpression(node.arguments[0] as ts.Expression, varMap)
        : extractUrlFromNode(node.arguments[0]);
      if (url) {
        let method = "GET";
        if (node.arguments.length > 1 && ts.isObjectLiteralExpression(node.arguments[1])) {
          for (const prop of node.arguments[1].properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "method" && ts.isStringLiteral(prop.initializer)) {
              method = prop.initializer.text.toUpperCase();
            }
          }
        }
        const operationHint = extractOperationHint(node, sourceFile, 1);
        return { method, url, lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)), callerFunction: callerName, operationHint };
      }
    }
  }

  // Handle wrapper functions: apiRequest(method, url), request(method, url)
  const WRAPPER_FN_NAMES = ["apiRequest", "request", "apiCall", "httpRequest", "makeRequest", "callApi"];
  if (ts.isIdentifier(expr) && WRAPPER_FN_NAMES.includes(expr.text)) {
    if (node.arguments.length >= 2) {
      const firstArg = node.arguments[0];
      const secondArg = node.arguments[1];
      if (ts.isStringLiteral(firstArg)) {
        const possibleMethod = firstArg.text.toUpperCase();
        const httpMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
        if (httpMethods.includes(possibleMethod)) {
          const url = varMap
            ? resolveUrlFromExpression(secondArg as ts.Expression, varMap)
            : extractUrlFromNode(secondArg);
          if (url) {
            const operationHint = extractOperationHint(node, sourceFile, 2);
            return { method: possibleMethod, url, lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)), callerFunction: callerName, operationHint };
          }
        }
      }
    }
  }

  return null;
}

interface ClassInheritanceInfo {
  className: string;
  parentClassName: string;
  parentImportPath: string | null;
}

function extractClassInheritance(sourceFile: ts.SourceFile, filePath: string, allFilePaths: string[]): ClassInheritanceInfo[] {
  const result: ClassInheritanceInfo[] = [];
  const importMap = new Map<string, string>();

  ts.forEachChild(sourceFile, node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
      const moduleSpec = node.moduleSpecifier.text;
      const resolved = normalizeModulePath(filePath, moduleSpec, allFilePaths);
      if (node.importClause.name) importMap.set(node.importClause.name.text, resolved || moduleSpec);
      if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const spec of node.importClause.namedBindings.elements) {
          const name = spec.propertyName ? spec.propertyName.text : spec.name.text;
          importMap.set(name, resolved || moduleSpec);
        }
      }
    }
  });

  ts.forEachChild(sourceFile, node => {
    if (ts.isClassDeclaration(node) && node.name && node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0) {
          const parentExpr = clause.types[0].expression;
          if (ts.isIdentifier(parentExpr)) {
            result.push({
              className: node.name!.text,
              parentClassName: parentExpr.text,
              parentImportPath: importMap.get(parentExpr.text) || null,
            });
          }
        }
      }
    }
  });

  return result;
}

function buildHttpServiceMap(files: { filePath: string; content: string }[]): HttpServiceMap {
  const serviceMap: HttpServiceMap = new Map();
  const allFilePaths = files.map(f => f.filePath);
  const inheritanceChains: { filePath: string; className: string; parentClassName: string; parentFilePath: string }[] = [];
  const fileClassInstances = new Map<string, Map<string, string>>();

  for (const file of files) {
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/") || file.filePath.includes("__tests__")) {
      continue;
    }

    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx"].includes(ext)) continue;

    try {
      const sourceFile = parseTypeScript(file.content, file.filePath);
      const { exportedNames, classInstances, defaultExportName } = extractExports(sourceFile);
      const classMethodMap = extractClassMethods(sourceFile);

      fileClassInstances.set(file.filePath, classInstances);

      const inheritanceInfos = extractClassInheritance(sourceFile, file.filePath, allFilePaths);
      for (const info of inheritanceInfos) {
        if (info.parentImportPath) {
          inheritanceChains.push({
            filePath: file.filePath,
            className: info.className,
            parentClassName: info.parentClassName,
            parentFilePath: info.parentImportPath,
          });
        }
      }

      const symbolTable = ScriptSymbolTable.build(sourceFile);
      const allCalls = symbolTable.getAllHttpCalls();

      const funcCalls = new Map<string, HttpCall[]>();
      for (const call of allCalls) {
        if (call.callerFunction) {
          const existing = funcCalls.get(call.callerFunction) || [];
          existing.push(call);
          funcCalls.set(call.callerFunction, existing);
        }
      }

      const topCalls = symbolTable.getTopLevelHttpCalls(sourceFile);
      for (const call of topCalls) {
        if (call.callerFunction && call.callerFunction !== "__top_level__") {
          const existing = funcCalls.get(call.callerFunction) || [];
          existing.push(call);
          funcCalls.set(call.callerFunction, existing);
        }
      }

      const entry: FileServiceEntry = {
        methods: new Map(),
        directFunctions: new Map(),
      };

      let hasContent = false;

      const exportNameArray = Array.from(exportedNames);
      for (const exportName of exportNameArray) {
        if (funcCalls.has(exportName)) {
          entry.directFunctions.set(exportName, funcCalls.get(exportName)!);
          hasContent = true;
        }

        const className = classInstances.get(exportName);
        if (className && classMethodMap.has(className)) {
          const methods = classMethodMap.get(className)!;
          methods.forEach((calls, methodName) => {
            const key = exportName + "." + methodName;
            entry.methods.set(key, { httpCalls: calls });
            hasContent = true;
          });
        }
      }

      if (defaultExportName) {
        if (funcCalls.has(defaultExportName)) {
          entry.directFunctions.set("default", funcCalls.get(defaultExportName)!);
          hasContent = true;
        }

        const className = classInstances.get(defaultExportName) || defaultExportName;
        if (classMethodMap.has(className)) {
          const methods = classMethodMap.get(className)!;
          methods.forEach((calls, methodName) => {
            entry.methods.set("default." + methodName, { httpCalls: calls });
            hasContent = true;
          });
        }
      }

      const classMethodEntries = Array.from(classMethodMap.entries());
      for (const [className, methods] of classMethodEntries) {
        if (exportedNames.has(className)) {
          methods.forEach((calls: HttpCall[], methodName: string) => {
            const key = className + "." + methodName;
            if (!entry.methods.has(key)) {
              entry.methods.set(key, { httpCalls: calls });
              hasContent = true;
            }
          });
        }
      }

      if (hasContent) {
        serviceMap.set(file.filePath, entry);
      }
    } catch (err) {
    }
  }

  const reExportMappings: { fromFile: string; toFile: string; names: { localName: string; originalName: string }[] }[] = [];
  for (const file of files) {
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/") || file.filePath.includes("__tests__")) continue;
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx"].includes(ext)) continue;
    try {
      const sourceFile = parseTypeScript(file.content, file.filePath);
      const visitReExports = (node: ts.Node) => {
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const resolvedTarget = normalizeModulePath(file.filePath, node.moduleSpecifier.text, allFilePaths);
          if (resolvedTarget) {
            const names: { localName: string; originalName: string }[] = [];
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
              for (const spec of node.exportClause.elements) {
                const localName = spec.name.text;
                const originalName = spec.propertyName ? spec.propertyName.text : spec.name.text;
                names.push({ localName, originalName });
              }
            } else if (!node.exportClause) {
              names.push({ localName: "*", originalName: "*" });
            }
            if (names.length > 0) {
              reExportMappings.push({ fromFile: file.filePath, toFile: resolvedTarget, names });
            }
          }
        }
        ts.forEachChild(node, visitReExports);
      };
      visitReExports(sourceFile);
    } catch (err) {
    }
  }

  for (const reExport of reExportMappings) {
    const targetEntry = serviceMap.get(reExport.toFile);
    if (!targetEntry) continue;

    let sourceEntry = serviceMap.get(reExport.fromFile);
    if (!sourceEntry) {
      sourceEntry = { methods: new Map(), directFunctions: new Map() };
    }

    let added = false;
    for (const nameMapping of reExport.names) {
      if (nameMapping.localName === "*") {
        for (const [fnName, httpCalls] of Array.from(targetEntry.directFunctions.entries())) {
          if (!sourceEntry.directFunctions.has(fnName)) {
            sourceEntry.directFunctions.set(fnName, httpCalls);
            added = true;
          }
        }
        for (const [methodKey, methodEntry] of Array.from(targetEntry.methods.entries())) {
          if (!sourceEntry.methods.has(methodKey)) {
            sourceEntry.methods.set(methodKey, methodEntry);
            added = true;
          }
        }
      } else {
        const origName = nameMapping.originalName;
        const localName = nameMapping.localName;
        if (targetEntry.directFunctions.has(origName)) {
          sourceEntry.directFunctions.set(localName, targetEntry.directFunctions.get(origName)!);
          added = true;
        }
        for (const [methodKey, methodEntry] of Array.from(targetEntry.methods.entries())) {
          if (methodKey === origName || methodKey.startsWith(origName + ".")) {
            const newKey = methodKey === origName ? localName : localName + methodKey.substring(origName.length);
            if (!sourceEntry.methods.has(newKey)) {
              sourceEntry.methods.set(newKey, methodEntry);
              added = true;
            }
          }
        }
      }
    }

    if (added) {
      serviceMap.set(reExport.fromFile, sourceEntry);
    }
  }

  for (const chain of inheritanceChains) {
    const parentEntry = serviceMap.get(chain.parentFilePath);
    if (!parentEntry) continue;

    let childEntry = serviceMap.get(chain.filePath);
    if (!childEntry) {
      childEntry = { methods: new Map(), directFunctions: new Map() };
      serviceMap.set(chain.filePath, childEntry);
    }

    const existingMethodNames = new Set<string>();
    for (const k of Array.from(childEntry.methods.keys())) {
      const dot = k.lastIndexOf(".");
      if (dot >= 0) existingMethodNames.add(k.substring(dot + 1));
    }

    const instanceMap = fileClassInstances.get(chain.filePath);
    const exportNames: string[] = [];
    if (instanceMap) {
      for (const [varName, className] of Array.from(instanceMap.entries())) {
        if (className === chain.className) exportNames.push(varName);
      }
    }

    for (const [key, value] of Array.from(parentEntry.methods.entries())) {
      const dot = key.lastIndexOf(".");
      if (dot < 0) continue;
      const methodName = key.substring(dot + 1);
      if (existingMethodNames.has(methodName)) continue;

      childEntry.methods.set(chain.className + "." + methodName, value);
      childEntry.methods.set("default." + methodName, value);
      for (const exportName of exportNames) {
        childEntry.methods.set(exportName + "." + methodName, value);
      }
    }

    for (const [key, value] of Array.from(parentEntry.directFunctions.entries())) {
      if (!childEntry.directFunctions.has(key)) {
        childEntry.directFunctions.set(key, value);
      }
    }
  }

  console.log(`[frontend-analyzer] HttpServiceMap built: ${serviceMap.size} files with HTTP service functions`);
  let totalMethods = 0;
  let totalFunctions = 0;
  serviceMap.forEach((entry) => {
    totalMethods += entry.methods.size;
    totalFunctions += entry.directFunctions.size;
  });
  console.log(`[frontend-analyzer] HttpServiceMap: ${totalFunctions} direct functions, ${totalMethods} class methods`);

  return serviceMap;
}

// Global call graph functions extracted to ./frontend/global-call-graph.ts

// Event graph functions extracted to ./frontend/event-graph.ts

interface StateFieldWrite {
  containerFile: string;
  containerName: string;
  fieldName: string;
  writerFunction: string;
  qualifiedField: string;
}

interface StateFieldRead {
  containerFile: string;
  containerName: string;
  fieldName: string;
  readerFunction: string;
  qualifiedField: string;
  httpCalls: HttpCall[];
}

interface StateFlowGraph {
  writers: Map<string, StateFieldWrite[]>;
  readers: Map<string, StateFieldRead[]>;
  containerFiles: Set<string>;
}

type StateContainerType = "vuex" | "pinia" | "redux" | "angular-service" | "composable" | "singleton-service";

interface DetectedStateContainer {
  type: StateContainerType;
  name: string;
  filePath: string;
  stateFields: string[];
  sourceFile: ts.SourceFile;
}

type ArchitecturalRole = "component" | "facade" | "usecase" | "repository" | "unknown";

interface ArchitecturalLayerGraph {
  roleByFile: Map<string, ArchitecturalRole>;
  importsByFile: Map<string, Set<string>>;
  repositoryHttpCalls: Map<string, HttpCall[]>;
}



export function analyzeFrontend(
  files: { filePath: string; content: string }[],
  graph: ApplicationGraph
): FrontendInteraction[] {
  const interactions: FrontendInteraction[] = [];
  const htmlTemplates = new Map<string, string>();

  const baseURLRegistry = buildBaseURLRegistry(files);
  const serviceMap = buildHttpServiceMap(files);
  const globalCallGraph = buildGlobalCallGraph(files, serviceMap);
  const allFilePaths = files.map(f => f.filePath);
  const eventGraph = buildComponentEventGraph(files, allFilePaths);
  const stateFlowGraph = buildStateFlowGraph(files, serviceMap, globalCallGraph);
  const archLayerGraph = buildArchitecturalLayerGraph(files, serviceMap, allFilePaths);
  const routeMap = buildRouteMap(files);

  for (const file of files) {
    if (file.filePath.endsWith(".html")) {
      htmlTemplates.set(file.filePath, file.content);
    }
  }

  for (const file of files) {
    const fileType = detectFileType(file.filePath);
    if (!fileType) continue;

    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) {
      continue;
    }

    try {
      switch (fileType) {
        case "vue":
          interactions.push(...analyzeVueFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
          break;

        case "react":
          interactions.push(...analyzeReactFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
          break;

        case "javascript":
          if (isAngularComponent(file.content)) {
            interactions.push(...analyzeAngularFile(file.filePath, file.content, graph, htmlTemplates, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
          } else {
            interactions.push(...analyzeReactFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
          }
          break;

        case "html":
          const bindings = parseAngularTemplateAST(file.content);
          const component = getComponentName(file.filePath);
          for (const binding of bindings) {
            interactions.push({
              component,
              elementType: binding.elementType,
              actionName: binding.handlerName,
              httpMethod: null,
              url: null,
              mappedBackendNode: null,
              sourceFile: file.filePath,
              lineNumber: binding.lineNumber,
              resolutionTier: null,
              resolutionStrategy: null,
              resolutionPath: null,
              interactionCategory: "UI_ONLY",
              confidence: 1.0,
            });
          }
          break;
      }
    } catch (err) {
      console.error(`[frontend-analyzer] Error analyzing ${file.filePath}:`, err instanceof Error ? err.message : err);
    }
  }

  if (baseURLRegistry.size > 0) {
    let baseResolved = 0;
    let newMatches = 0;
    for (const interaction of interactions) {
      if (interaction.url && (interaction.url.includes("{base}") || (!interaction.url.startsWith("/") && !interaction.url.startsWith("http")))) {
        const resolved = resolveBaseURL(interaction.url, interaction.sourceFile, baseURLRegistry);
        if (resolved !== interaction.url) {
          interaction.url = resolved;
          baseResolved++;

          if (!interaction.mappedBackendNode && interaction.httpMethod) {
            const backendNode = matchUrlToEndpoint(interaction.httpMethod, resolved, graph);
            if (backendNode) {
              interaction.mappedBackendNode = backendNode;
              newMatches++;
              if (interaction.resolutionPath) {
                interaction.resolutionPath = [...interaction.resolutionPath, { tier: "controller", file: backendNode.className, function: backendNode.methodName, detail: `matched ${interaction.httpMethod} ${resolved} (baseURL resolved)` }];
              } else {
                interaction.resolutionPath = [
                  { tier: "local", file: interaction.sourceFile, function: interaction.actionName, detail: "baseURL resolution" },
                  { tier: "controller", file: backendNode.className, function: backendNode.methodName, detail: `matched ${interaction.httpMethod} ${resolved} (baseURL resolved)` }
                ];
              }
            }
          }
        }
      }
    }
    if (baseResolved > 0) {
      console.log(`[frontend-analyzer] BaseURL resolution: ${baseResolved} URLs resolved, ${newMatches} new controller matches`);
    }
  }

  let serviceBridgeCount = 0;
  let externalServiceCount = 0;
  for (const interaction of interactions) {
    if (interaction.url && isExternalUrl(interaction.url)) {
      interaction.interactionCategory = "EXTERNAL_SERVICE";
      interaction.externalDomain = extractExternalDomain(interaction.url);
      interaction.mappedBackendNode = null;
      if (interaction.resolutionPath) {
        interaction.resolutionPath = interaction.resolutionPath.filter(s => s.tier !== "controller");
        interaction.resolutionPath.push({
          tier: "external_service",
          file: interaction.externalDomain || "unknown",
          function: null,
          detail: `external API call to ${interaction.externalDomain}`
        });
      }
      externalServiceCount++;
    }

    if (isServerSideFile(interaction.sourceFile)) {
      if (interaction.interactionCategory !== "EXTERNAL_SERVICE") {
        interaction.interactionCategory = "SERVICE_BRIDGE";
      }
      serviceBridgeCount++;
    }
  }
  if (serviceBridgeCount > 0) {
    console.log(`[frontend-analyzer] Service bridges: ${serviceBridgeCount} interactions from server-side files`);
  }
  if (externalServiceCount > 0) {
    console.log(`[frontend-analyzer] External services: ${externalServiceCount} interactions calling external APIs`);
  }

  if (routeMap.size > 0) {
    let routeEnriched = 0;
    for (const interaction of interactions) {
      const componentName = interaction.component.toLowerCase();
      const componentNameNoSpaces = componentName.replace(/\s+/g, "");
      let matched = routeMap.get(componentName) || routeMap.get(componentNameNoSpaces);
      if (!matched) {
        const fileName = interaction.sourceFile
          .split("/").pop()
          ?.replace(/\.(vue|tsx|jsx|ts|js)$/, "")
          ?.toLowerCase();
        if (fileName) {
          matched = routeMap.get(fileName) || routeMap.get(fileName.replace(/[-_]/g, ""));
        }
      }
      if (!matched) {
        const pathParts = interaction.sourceFile.replace(/\\/g, "/").split("/");
        const srcIdx = pathParts.findIndex(p => p === "src" || p === "app" || p === "pages" || p === "views");
        if (srcIdx >= 0) {
          const relParts = pathParts.slice(srcIdx + 1);
          const relPath = relParts.join("/").replace(/\.(vue|tsx|jsx|ts|js)$/, "").toLowerCase();
          matched = routeMap.get(relPath);
          if (!matched && relParts.length >= 2) {
            const dirName = relParts[relParts.length - 2].toLowerCase();
            matched = routeMap.get(dirName);
          }
        }
      }
      if (!matched && componentNameNoSpaces.length >= 4) {
        for (const [key, val] of Array.from(routeMap)) {
          if (key === componentNameNoSpaces) continue;
          if (key.length < 4) continue;
          const keyNoSep = key.replace(/[-_\s]/g, "");
          if (keyNoSep === componentNameNoSpaces) {
            matched = val;
            break;
          }
          const suffixes = [/page$/i, /view$/i, /screen$/i, /component$/i, /container$/i];
          for (const suffix of suffixes) {
            if (keyNoSep === componentNameNoSpaces.replace(suffix, "") || componentNameNoSpaces === keyNoSep.replace(suffix, "")) {
              matched = val;
              break;
            }
          }
          if (matched) break;
        }
      }
      if (matched) {
        interaction.frontendRoute = matched.route;
        const existingGuards = interaction.routeGuards || [];
        interaction.routeGuards = Array.from(new Set([...matched.guards, ...existingGuards]));
        routeEnriched++;
      }
    }
    if (routeEnriched > 0) {
      console.log(`[frontend-analyzer] Route enrichment: ${routeEnriched}/${interactions.length} interactions mapped to routes`);
    } else {
      console.log(`[frontend-analyzer] Route enrichment: 0 matches. RouteMap has ${routeMap.size} entries. Sample components: ${interactions.slice(0, 5).map(i => i.component).join(", ")}`);
      const routeEntries = Array.from(routeMap.entries()).slice(0, 5);
      for (const [key, val] of routeEntries) {
        console.log(`[frontend-analyzer]   RouteMap entry: "${key}" → "${val.route}"`);
      }
    }
  } else {
    console.log(`[frontend-analyzer] Route enrichment skipped: no routes found in any file`);
  }

  const fileAuthCache = new Map<string, FileAuthPatterns>();
  let authEnriched = 0;
  for (const interaction of interactions) {
    if (!fileAuthCache.has(interaction.sourceFile)) {
      const fileData = files.find(f => f.filePath === interaction.sourceFile);
      if (fileData) {
        let scriptContent = fileData.content;
        if (fileData.filePath.endsWith(".vue")) {
          scriptContent = extractVueScript(fileData.content);
        }
        try {
          const sf = parseTypeScript(scriptContent, fileData.filePath);
          fileAuthCache.set(interaction.sourceFile, detectFileAuthPatterns(sf, scriptContent));
        } catch {
          fileAuthCache.set(interaction.sourceFile, { guards: [], roles: [], authRequired: false });
        }
      }
    }
    const authPatterns = fileAuthCache.get(interaction.sourceFile);
    if (authPatterns && authPatterns.authRequired) {
      const existing = interaction.routeGuards || [];
      const merged = Array.from(new Set([...existing, ...authPatterns.guards]));
      if (merged.length > 0) {
        interaction.routeGuards = merged;
      }
      if (!interaction.detectedRoles) {
        interaction.detectedRoles = authPatterns.roles;
      }
      authEnriched++;
    }
  }
  if (authEnriched > 0) {
    console.log(`[frontend-analyzer] Auth enrichment: ${authEnriched}/${interactions.length} interactions with detected auth patterns`);
  }

  const withUrls = interactions.filter(i => i.url);
  const withoutUrls = interactions.filter(i => !i.url);
  const matched = interactions.filter(i => i.mappedBackendNode);
  const bridges = interactions.filter(i => i.interactionCategory === "SERVICE_BRIDGE");
  const externals = interactions.filter(i => i.interactionCategory === "EXTERNAL_SERVICE");
  console.log(`[frontend-analyzer] Results: ${interactions.length} interactions, ${withUrls.length} with URLs (${withoutUrls.length} without), ${matched.length} matched to backend, ${bridges.length} service bridges, ${externals.length} external services`);

  const tierCounts = new Map<string, number>();
  for (const i of interactions) {
    const tier = i.resolutionTier || "unresolved";
    tierCounts.set(tier, (tierCounts.get(tier) || 0) + 1);
  }
  const tierEntries = Array.from(tierCounts.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`[frontend-analyzer] Resolution tier distribution:`);
  for (const [tier, count] of tierEntries) {
    console.log(`[frontend-analyzer]   ${tier}: ${count} (${((count / interactions.length) * 100).toFixed(1)}%)`);
  }

  if (withoutUrls.length > 0 && withoutUrls.length <= 20) {
    console.log(`[frontend-analyzer] Unresolved handlers:`);
    for (const i of withoutUrls) {
      console.log(`[frontend-analyzer]   ${i.sourceFile} :: ${i.actionName} (${i.elementType})`);
    }
  } else if (withoutUrls.length > 20) {
    const unresolvedByFile = new Map<string, number>();
    for (const i of withoutUrls) {
      unresolvedByFile.set(i.sourceFile, (unresolvedByFile.get(i.sourceFile) || 0) + 1);
    }
    const topFiles = Array.from(unresolvedByFile.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`[frontend-analyzer] Top files with unresolved handlers (${withoutUrls.length} total):`);
    for (const [file, count] of topFiles) {
      console.log(`[frontend-analyzer]   ${file}: ${count} unresolved`);
    }
  }

  const withRoutes = interactions.filter(i => i.frontendRoute);
  const withGuards = interactions.filter(i => i.routeGuards && i.routeGuards.length > 0);
  const withRoles = interactions.filter(i => i.detectedRoles && i.detectedRoles.length > 0);
  console.log(`[frontend-analyzer] Enrichment: ${withRoutes.length} with routes, ${withGuards.length} with guards, ${withRoles.length} with detected roles`);

  return interactions;
}

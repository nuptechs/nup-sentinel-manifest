import * as ts from "typescript";
import * as vueSfc from "@vue/compiler-sfc";
import * as ngCompiler from "@angular/compiler";
import type { ApplicationGraph, GraphNode } from "./application-graph";

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
}

interface SymbolDeclaration {
  name: string;
  node: ts.Node;
  httpCalls: HttpCall[];
  calledNodes: ts.Node[];
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

class ImportedHttpClients {
  private httpIdentifiers = new Set<string>();
  private fetchIdentifier = "fetch";
  private importSources = new Set<string>();

  static build(sourceFile: ts.SourceFile): ImportedHttpClients {
    const clients = new ImportedHttpClients();
    clients.indexImports(sourceFile);
    return clients;
  }

  private indexImports(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const source = node.moduleSpecifier.text.toLowerCase();
        this.importSources.add(source);

        const httpModules = ["axios", "@angular/common/http", "@angular/http"];
        const isHttpModule = httpModules.some(m => source === m || source.startsWith(m + "/"));

        if (isHttpModule && node.importClause) {
          if (node.importClause.name) {
            this.httpIdentifiers.add(node.importClause.name.text);
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              for (const spec of node.importClause.namedBindings.elements) {
                this.httpIdentifiers.add(spec.name.text);
              }
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              this.httpIdentifiers.add(node.importClause.namedBindings.name.text);
            }
          }
        }

        if (source.includes("api") || source.includes("http") || source.includes("request") || source.includes("service")) {
          if (node.importClause) {
            if (node.importClause.name) {
              this.httpIdentifiers.add(node.importClause.name.text);
            }
            if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
              for (const spec of node.importClause.namedBindings.elements) {
                const lowerName = spec.name.text.toLowerCase();
                if (lowerName.includes("api") || lowerName.includes("http") ||
                    lowerName.includes("request") || lowerName.includes("client") ||
                    lowerName.includes("instance")) {
                  this.httpIdentifiers.add(spec.name.text);
                }
              }
            }
          }
        }
      }

      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isCallExpression(node.initializer)) {
          const callText = node.initializer.expression;
          if (ts.isPropertyAccessExpression(callText) && callText.name.text === "create") {
            const obj = callText.expression;
            if (ts.isIdentifier(obj) && this.httpIdentifiers.has(obj.text)) {
              this.httpIdentifiers.add(node.name.text);
            }
          }
          if (ts.isIdentifier(callText) && this.httpIdentifiers.has(callText.text)) {
            this.httpIdentifiers.add(node.name.text);
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  isHttpClient(identifierText: string): boolean {
    if (this.httpIdentifiers.has(identifierText)) return true;
    if (identifierText === "fetch") return true;
    const lower = identifierText.toLowerCase();
    if (lower === "axios") return true;
    return false;
  }

  isHttpExpression(expressionText: string): boolean {
    const lower = expressionText.toLowerCase();
    if (this.httpIdentifiers.has(expressionText)) return true;
    const idArray = Array.from(this.httpIdentifiers);
    for (let i = 0; i < idArray.length; i++) {
      if (lower === idArray[i].toLowerCase()) return true;
      if (lower.endsWith("." + idArray[i].toLowerCase())) return true;
    }
    if (lower === "this.http" || lower === "this.$http" || lower === "this.httpclient") return true;
    return false;
  }
}

class ScriptSymbolTable {
  private nodeMap = new Map<ts.Node, SymbolDeclaration>();
  private nameIndex = new Map<string, ts.Node>();
  private httpClients: ImportedHttpClients;

  static build(sourceFile: ts.SourceFile): ScriptSymbolTable {
    const table = new ScriptSymbolTable();
    table.httpClients = ImportedHttpClients.build(sourceFile);
    table.indexDeclarations(sourceFile);
    table.extractCallInfo(sourceFile);
    return table;
  }

  private constructor() {
    this.httpClients = new ImportedHttpClients();
  }

  private indexDeclarations(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        this.registerDeclaration(node.name.text, node);
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        this.registerDeclaration(node.name.text, node);
      } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const parent = node.parent;
        let declName: string | null = null;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          declName = parent.name.text;
        } else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
          declName = parent.name.text;
        } else if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
          declName = parent.name.text;
        }
        if (declName) {
          this.registerDeclaration(declName, node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  private registerDeclaration(name: string, node: ts.Node): void {
    const decl: SymbolDeclaration = {
      name,
      node,
      httpCalls: [],
      calledNodes: [],
    };
    this.nodeMap.set(node, decl);
    this.nameIndex.set(name, node);
  }

  private extractCallInfo(sourceFile: ts.SourceFile): void {
    this.nodeMap.forEach((decl) => {
      const body = this.getFunctionBody(decl.node);
      if (!body) return;
      this.walkBodyForCalls(body, sourceFile, decl);
    });
  }

  private getFunctionBody(node: ts.Node): ts.Node | null {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      return node.body || null;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return node.body;
    }
    return null;
  }

  private walkBodyForCalls(body: ts.Node, sourceFile: ts.SourceFile, decl: SymbolDeclaration): void {
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const httpCall = this.tryExtractHttpCall(node, sourceFile, decl.name);
        if (httpCall) {
          decl.httpCalls.push(httpCall);
        } else {
          const targetNode = this.resolveCallTargetNode(node);
          if (targetNode && targetNode !== decl.node) {
            decl.calledNodes.push(targetNode);
          }

          if (ts.isPropertyAccessExpression(node.expression)) {
            const methodName = node.expression.name.text;
            if ((methodName === "then" || methodName === "catch" || methodName === "finally") && node.arguments.length > 0) {
              const callback = node.arguments[0];
              if (ts.isIdentifier(callback)) {
                const cbNode = this.nameIndex.get(callback.text);
                if (cbNode && cbNode !== decl.node) {
                  decl.calledNodes.push(cbNode);
                }
              } else if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
                this.walkBodyForCalls(callback.body, sourceFile, decl);
              }
            }
          }

          for (const arg of node.arguments) {
            if (ts.isIdentifier(arg)) {
              const cbNode = this.nameIndex.get(arg.text);
              if (cbNode && cbNode !== decl.node && !decl.calledNodes.includes(cbNode)) {
                decl.calledNodes.push(cbNode);
              }
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(body);
  }

  private resolveCallTargetNode(node: ts.CallExpression): ts.Node | null {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) {
      const targetNode = this.nameIndex.get(expr.text);
      return targetNode || null;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const obj = expr.expression;
      if (obj.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(obj) && obj.text === "this")) {
        const targetNode = this.nameIndex.get(expr.name.text);
        return targetNode || null;
      }
    }
    return null;
  }

  private tryExtractHttpCall(node: ts.CallExpression, sourceFile: ts.SourceFile, callerName: string): HttpCall | null {
    const expr = node.expression;

    if (ts.isPropertyAccessExpression(expr)) {
      const methodName = expr.name.text.toLowerCase();
      const httpMethods = ["get", "post", "put", "delete", "patch"];

      if (httpMethods.includes(methodName)) {
        const calleeObj = expr.expression;
        let isHttp = false;

        if (ts.isIdentifier(calleeObj)) {
          isHttp = this.httpClients.isHttpClient(calleeObj.text);
        } else {
          const expressionText = calleeObj.getText(sourceFile);
          isHttp = this.httpClients.isHttpExpression(expressionText);
        }

        if (isHttp && node.arguments.length > 0) {
          const url = extractUrlFromNode(node.arguments[0]);
          if (url) {
            const operationHint = extractOperationHint(node, sourceFile, 1);
            return {
              method: methodName.toUpperCase(),
              url,
              lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
              callerFunction: callerName,
              operationHint,
            };
          }
        }
      }
    }

    if (ts.isIdentifier(expr) && expr.text === "fetch") {
      if (node.arguments.length > 0) {
        const url = extractUrlFromNode(node.arguments[0]);
        if (url) {
          let method = "GET";
          if (node.arguments.length > 1 && ts.isObjectLiteralExpression(node.arguments[1])) {
            for (const prop of node.arguments[1].properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === "method" &&
                ts.isStringLiteral(prop.initializer)
              ) {
                method = prop.initializer.text.toUpperCase();
              }
            }
          }
          const operationHint = extractOperationHint(node, sourceFile, 1);
          return {
            method,
            url,
            lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
            callerFunction: callerName,
            operationHint,
          };
        }
      }
    }

    if (ts.isIdentifier(expr) && this.httpClients.isHttpClient(expr.text)) {
      if (node.arguments.length >= 1) {
        const firstArg = node.arguments[0];
        if (ts.isStringLiteral(firstArg) && node.arguments.length >= 2) {
          const possibleUrl = extractUrlFromNode(node.arguments[1]);
          if (possibleUrl) {
            const operationHint = extractOperationHint(node, sourceFile, 2);
            return {
              method: firstArg.text.toUpperCase(),
              url: possibleUrl,
              lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
              callerFunction: callerName,
              operationHint,
            };
          }
        }
        const url = extractUrlFromNode(firstArg);
        if (url && url.startsWith("/")) {
          return {
            method: "GET",
            url,
            lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
            callerFunction: callerName,
          };
        }
      }
    }

    return null;
  }

  resolveHandlerNode(handlerName: string): ts.Node | null {
    return this.nameIndex.get(handlerName) || null;
  }

  getDeclaration(node: ts.Node): SymbolDeclaration | undefined {
    return this.nodeMap.get(node);
  }

  traceHttpCalls(startNode: ts.Node): HttpCall[] {
    const visited = new Set<ts.Node>();
    const results: HttpCall[] = [];

    const trace = (node: ts.Node) => {
      if (visited.has(node)) return;
      visited.add(node);

      const decl = this.nodeMap.get(node);
      if (!decl) return;

      if (decl.httpCalls.length > 0) {
        results.push(...decl.httpCalls);
        return;
      }

      for (const calledNode of decl.calledNodes) {
        trace(calledNode);
      }
    };

    trace(startNode);
    return results;
  }

  getAllHttpCalls(): HttpCall[] {
    const calls: HttpCall[] = [];
    this.nodeMap.forEach((decl) => {
      calls.push(...decl.httpCalls);
    });
    return calls;
  }

  getTopLevelHttpCalls(sourceFile: ts.SourceFile): HttpCall[] {
    const calls: HttpCall[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const enclosingNode = this.getEnclosingDeclNode(node);
        if (!enclosingNode) {
          const httpCall = this.tryExtractHttpCall(node, sourceFile, "__top_level__");
          if (httpCall) {
            calls.push(httpCall);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return calls;
  }

  private getEnclosingDeclNode(node: ts.Node): ts.Node | null {
    let current = node.parent;
    while (current) {
      if (this.nodeMap.has(current)) {
        return current;
      }
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) ||
          ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        if (this.nodeMap.has(current)) return current;
      }
      current = current.parent;
    }
    return null;
  }
}

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

function normalizeModulePath(importerPath: string, moduleSpecifier: string, allFilePaths: string[]): string | null {
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

      if (methods.size > 0) {
        classMethodMap.set(className, methods);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return classMethodMap;
}

function buildLocalVarMap(body: ts.Node): Map<string, ts.Expression> {
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

function extractHttpCallFromExpression(node: ts.CallExpression, sourceFile: ts.SourceFile, httpClients: ImportedHttpClients, callerName: string, varMap?: Map<string, ts.Expression>): HttpCall | null {
  const expr = node.expression;

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

  for (const chain of inheritanceChains) {
    const parentEntry = serviceMap.get(chain.parentFilePath);
    if (!parentEntry) continue;

    let childEntry = serviceMap.get(chain.filePath);
    if (!childEntry) {
      childEntry = { methods: new Map(), directFunctions: new Map() };
      serviceMap.set(chain.filePath, childEntry);
    }

    const existingMethodNames = new Set<string>();
    for (const k of childEntry.methods.keys()) {
      const dot = k.lastIndexOf(".");
      if (dot >= 0) existingMethodNames.add(k.substring(dot + 1));
    }

    const instanceMap = fileClassInstances.get(chain.filePath);
    const exportNames: string[] = [];
    if (instanceMap) {
      for (const [varName, className] of instanceMap.entries()) {
        if (className === chain.className) exportNames.push(varName);
      }
    }

    for (const [key, value] of parentEntry.methods.entries()) {
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

    for (const [key, value] of parentEntry.directFunctions.entries()) {
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

interface GlobalCallGraphNode {
  key: string;
  filePath: string;
  functionName: string;
  httpCalls: HttpCall[];
  callees: Set<string>;
  callers: Set<string>;
  propagatedHttpCalls: HttpCall[] | null;
}

type GlobalCallGraph = Map<string, GlobalCallGraphNode>;

function makeGlobalKey(filePath: string, fnName: string): string {
  return filePath + "::" + fnName;
}

function buildGlobalCallGraph(files: { filePath: string; content: string }[], serviceMap: HttpServiceMap): GlobalCallGraph {
  const graph: GlobalCallGraph = new Map();
  const allFilePaths = files.map(f => f.filePath);

  for (const file of files) {
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/") || file.filePath.includes("__tests__")) {
      continue;
    }
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx", ".vue"].includes(ext)) continue;

    try {
      let scriptContent = file.content;
      if (ext === ".vue") {
        const sfcResult = vueSfc.parse(file.content);
        const descriptor = sfcResult.descriptor;
        if (descriptor.scriptSetup) scriptContent = descriptor.scriptSetup.content;
        else if (descriptor.script) scriptContent = descriptor.script.content;
        else continue;
      }

      const sourceFile = parseTypeScript(scriptContent, file.filePath + (ext === ".vue" ? ".script.ts" : ""));
      const httpClients = ImportedHttpClients.build(sourceFile);
      const importBindings = parseImportBindingsInternal(sourceFile, file.filePath, allFilePaths);

      const localFunctions = new Map<string, { node: ts.Node; name: string }>();
      const classInstanceTypes = new Map<string, string>();
      let currentClassName: string | null = null;

      const indexDecls = (node: ts.Node) => {
        if (ts.isClassDeclaration(node)) {
          const prevClass = currentClassName;
          currentClassName = node.name ? node.name.text : null;
          ts.forEachChild(node, indexDecls);
          currentClassName = prevClass;
          return;
        }
        if (ts.isFunctionDeclaration(node) && node.name) {
          localFunctions.set(node.name.text, { node, name: node.name.text });
        } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
          const methodName = node.name.text;
          localFunctions.set(methodName, { node, name: methodName });
          if (currentClassName) {
            const qualifiedName = currentClassName + "." + methodName;
            localFunctions.set(qualifiedName, { node, name: qualifiedName });
            localFunctions.set("default." + methodName, { node, name: "default." + methodName });
          }
        } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
          let declName: string | null = null;
          if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) declName = node.parent.name.text;
          else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) declName = node.parent.name.text;
          else if (ts.isPropertyDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) declName = node.parent.name.text;
          if (declName) {
            localFunctions.set(declName, { node, name: declName });
            if (currentClassName) {
              localFunctions.set(currentClassName + "." + declName, { node, name: currentClassName + "." + declName });
              localFunctions.set("default." + declName, { node, name: "default." + declName });
            }
          }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer)) {
          const ctorExpr = node.initializer.expression;
          if (ts.isIdentifier(ctorExpr)) classInstanceTypes.set(node.name.text, ctorExpr.text);
        }
        ts.forEachChild(node, indexDecls);
      };
      indexDecls(sourceFile);

      const localFnEntries = Array.from(localFunctions.entries());
      for (const [fnName, fnInfo] of localFnEntries) {
        const key = makeGlobalKey(file.filePath, fnName);
        if (!graph.has(key)) {
          graph.set(key, { key, filePath: file.filePath, functionName: fnName, httpCalls: [], callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
        }
        const gNode = graph.get(key)!;

        const body = getFnBody(fnInfo.node);
        if (!body) continue;

        const varMap = buildLocalVarMap(body);

        const walkCalls = (n: ts.Node) => {
          if (ts.isCallExpression(n)) {
            const httpCall = extractHttpCallFromExpression(n, sourceFile, httpClients, fnName, varMap);
            if (httpCall) {
              gNode.httpCalls.push(httpCall);
            } else {
              const callExpr = n.expression;

              if (ts.isIdentifier(callExpr)) {
                const calledName = callExpr.text;
                if (localFunctions.has(calledName)) {
                  const calleeKey = makeGlobalKey(file.filePath, calledName);
                  gNode.callees.add(calleeKey);
                } else if (importBindings.has(calledName)) {
                  const binding = importBindings.get(calledName)!;
                  const targetName = binding.isDefault ? "default" : binding.originalName;
                  const calleeKey = makeGlobalKey(binding.sourcePath, targetName);
                  gNode.callees.add(calleeKey);
                }
              }

              if (ts.isPropertyAccessExpression(callExpr)) {
                const methodName = callExpr.name.text;
                const obj = callExpr.expression;

                if (obj.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(obj) && obj.text === "this")) {
                  if (localFunctions.has(methodName)) {
                    gNode.callees.add(makeGlobalKey(file.filePath, methodName));
                  }
                } else if (ts.isIdentifier(obj)) {
                  const objName = obj.text;
                  if (importBindings.has(objName)) {
                    const binding = importBindings.get(objName)!;
                    if (binding.originalName === "*") {
                      gNode.callees.add(makeGlobalKey(binding.sourcePath, methodName));
                      gNode.callees.add(makeGlobalKey(binding.sourcePath, "default." + methodName));
                    } else {
                      const calleeKey = makeGlobalKey(binding.sourcePath, binding.originalName + "." + methodName);
                      gNode.callees.add(calleeKey);
                      const altKey = makeGlobalKey(binding.sourcePath, "default." + methodName);
                      gNode.callees.add(altKey);
                      const altKey2 = makeGlobalKey(binding.sourcePath, methodName);
                      gNode.callees.add(altKey2);
                    }
                  }
                  const instanceClass = classInstanceTypes.get(objName);
                  if (instanceClass) {
                    const qualifiedKey = makeGlobalKey(file.filePath, instanceClass + "." + methodName);
                    gNode.callees.add(qualifiedKey);
                    if (localFunctions.has(methodName)) {
                      gNode.callees.add(makeGlobalKey(file.filePath, methodName));
                    }
                  }
                }
              }
            }
          }
          ts.forEachChild(n, walkCalls);
        };
        walkCalls(body);
      }
    } catch (err) {
      console.warn(`[frontend-analyzer] GlobalCallGraph: failed to process ${file.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const serviceMapEntries = Array.from(serviceMap.entries());
  for (const [filePath, entry] of serviceMapEntries) {
    const methodEntries = Array.from(entry.methods.entries());
    for (const [methodKey, methodEntry] of methodEntries) {
      const key = makeGlobalKey(filePath, methodKey);
      if (!graph.has(key)) {
        graph.set(key, { key, filePath, functionName: methodKey, httpCalls: methodEntry.httpCalls, callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
      } else {
        const gNode = graph.get(key)!;
        if (gNode.httpCalls.length === 0 && methodEntry.httpCalls.length > 0) {
          gNode.httpCalls = methodEntry.httpCalls;
        }
      }
    }
    const fnEntries = Array.from(entry.directFunctions.entries());
    for (const [fnName, httpCalls] of fnEntries) {
      const key = makeGlobalKey(filePath, fnName);
      if (!graph.has(key)) {
        graph.set(key, { key, filePath, functionName: fnName, httpCalls, callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
      } else {
        const gNode = graph.get(key)!;
        if (gNode.httpCalls.length === 0 && httpCalls.length > 0) {
          gNode.httpCalls = httpCalls;
        }
      }
    }
  }

  const graphNodes = Array.from(graph.values());
  for (const node of graphNodes) {
    const calleeKeys = Array.from(node.callees);
    for (const calleeKey of calleeKeys) {
      const callee = graph.get(calleeKey);
      if (callee) {
        callee.callers.add(node.key);
      }
    }
  }

  propagateHttpCapability(graph);

  let httpLeaves = 0;
  let propagatedCount = 0;
  const graphNodes2 = Array.from(graph.values());
  for (const node of graphNodes2) {
    if (node.httpCalls.length > 0) httpLeaves++;
    if (node.propagatedHttpCalls && node.propagatedHttpCalls.length > 0) propagatedCount++;
  }
  console.log(`[frontend-analyzer] GlobalCallGraph: ${graph.size} nodes, ${httpLeaves} HTTP leaves, ${propagatedCount} HTTP-capable (propagated)`);

  return graph;
}

function getFnBody(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.body || null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.body;
  return null;
}

function parseImportBindingsInternal(sourceFile: ts.SourceFile, importerPath: string, allFilePaths: string[]): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleSpec = node.moduleSpecifier.text;
      const resolvedPath = normalizeModulePath(importerPath, moduleSpec, allFilePaths);
      if (!resolvedPath) { ts.forEachChild(node, visit); return; }
      if (node.importClause) {
        if (node.importClause.name) {
          bindings.set(node.importClause.name.text, { sourcePath: resolvedPath, originalName: "default", isDefault: true });
        }
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const spec of node.importClause.namedBindings.elements) {
              const localName = spec.name.text;
              const originalName = spec.propertyName ? spec.propertyName.text : localName;
              bindings.set(localName, { sourcePath: resolvedPath, originalName, isDefault: false });
            }
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            bindings.set(node.importClause.namedBindings.name.text, { sourcePath: resolvedPath, originalName: "*", isDefault: false });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function propagateHttpCapability(graph: GlobalCallGraph): void {
  const queue: string[] = [];

  const allEntries = Array.from(graph.entries());
  for (const [key, node] of allEntries) {
    if (node.httpCalls.length > 0) {
      node.propagatedHttpCalls = [...node.httpCalls];
      queue.push(key);
    }
  }

  while (queue.length > 0) {
    const currentKey = queue.shift()!;
    const currentNode = graph.get(currentKey)!;
    const httpCalls = currentNode.propagatedHttpCalls || currentNode.httpCalls;
    if (httpCalls.length === 0) continue;

    const callerKeys = Array.from(currentNode.callers);
    for (const callerKey of callerKeys) {
      const caller = graph.get(callerKey);
      if (!caller) continue;

      if (caller.propagatedHttpCalls === null) {
        caller.propagatedHttpCalls = [...httpCalls];
        queue.push(callerKey);
      } else {
        const existingUrls = new Set(caller.propagatedHttpCalls.map(c => c.method + ":" + c.url));
        let added = false;
        for (const call of httpCalls) {
          const callKey = call.method + ":" + call.url;
          if (!existingUrls.has(callKey)) {
            caller.propagatedHttpCalls.push(call);
            existingUrls.add(callKey);
            added = true;
          }
        }
        if (added) {
          queue.push(callerKey);
        }
      }
    }
  }
}

function lookupGlobalCallGraph(
  globalGraph: GlobalCallGraph,
  filePath: string,
  handlerName: string,
  importBindings?: Map<string, ImportBinding>
): HttpCall[] {
  const directKey = makeGlobalKey(filePath, handlerName);
  const node = globalGraph.get(directKey);
  if (node) {
    if (node.propagatedHttpCalls && node.propagatedHttpCalls.length > 0) return node.propagatedHttpCalls;
    if (node.httpCalls.length > 0) return node.httpCalls;
  }

  if (importBindings) {
    const binding = importBindings.get(handlerName);
    if (binding) {
      const importKey = makeGlobalKey(binding.sourcePath, binding.isDefault ? "default" : binding.originalName);
      const importNode = globalGraph.get(importKey);
      if (importNode) {
        if (importNode.propagatedHttpCalls && importNode.propagatedHttpCalls.length > 0) return importNode.propagatedHttpCalls;
        if (importNode.httpCalls.length > 0) return importNode.httpCalls;
      }
    }
  }

  const allNodes = Array.from(globalGraph.values());
  for (const gNode of allNodes) {
    if (gNode.filePath === filePath && gNode.functionName.endsWith("." + handlerName)) {
      if (gNode.propagatedHttpCalls && gNode.propagatedHttpCalls.length > 0) return gNode.propagatedHttpCalls;
      if (gNode.httpCalls.length > 0) return gNode.httpCalls;
    }
  }

  return [];
}

function toKebabCase(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function toPascalCase(str: string): string {
  return str.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

function isCustomComponentTag(tag: string): boolean {
  if (/^[A-Z]/.test(tag)) return true;
  if (tag.includes("-") && !tag.startsWith("v-") && tag !== "router-link" && tag !== "router-view") return true;
  return false;
}

function buildComponentRegistry(
  files: { filePath: string; content: string }[],
  allFilePaths: string[]
): Map<string, string> {
  const registry = new Map<string, string>();

  for (const file of files) {
    const parts = file.filePath.split("/");
    const fileName = parts[parts.length - 1];
    const baseName = fileName.replace(/\.(vue|jsx|tsx|ts|js)$/, "");

    const pascal = toPascalCase(baseName.replace(/[_]/g, "-"));
    const kebab = toKebabCase(pascal);

    registry.set(pascal, file.filePath);
    registry.set(kebab, file.filePath);
    registry.set(baseName, file.filePath);

    if (file.filePath.endsWith(".vue") || file.filePath.endsWith(".tsx") || file.filePath.endsWith(".jsx")) {
      try {
        const scriptContent = file.filePath.endsWith(".vue") ? extractVueScript(file.content) : file.content;
        const scriptKind = file.filePath.endsWith(".vue") ? ts.ScriptKind.TS : ts.ScriptKind.TSX;
        const sourceFile = ts.createSourceFile(file.filePath + ".reg.ts", scriptContent, ts.ScriptTarget.Latest, true, scriptKind);

        ts.forEachChild(sourceFile, node => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const moduleSpec = node.moduleSpecifier.text;
            const resolvedPath = normalizeModulePath(file.filePath, moduleSpec, allFilePaths);
            if (resolvedPath && node.importClause) {
              if (node.importClause.name) {
                const importName = node.importClause.name.text;
                registry.set(importName, resolvedPath);
                registry.set(toKebabCase(importName), resolvedPath);
              }
              if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
                for (const spec of node.importClause.namedBindings.elements) {
                  const localName = spec.name.text;
                  if (/^[A-Z]/.test(localName)) {
                    registry.set(localName, resolvedPath);
                    registry.set(toKebabCase(localName), resolvedPath);
                  }
                }
              }
            }
          }
        });
      } catch (err) {
      }
    }
  }

  return registry;
}

function extractVueScript(content: string): string {
  const sfcResult = vueSfc.parse(content);
  const descriptor = sfcResult.descriptor;
  if (descriptor.scriptSetup) return descriptor.scriptSetup.content;
  if (descriptor.script) return descriptor.script.content;
  return "";
}

function detectEmitsInVueScript(scriptContent: string, filePath: string): ComponentEmitEntry[] {
  const emits: ComponentEmitEntry[] = [];
  if (!scriptContent.trim()) return emits;

  try {
    const sourceFile = ts.createSourceFile(filePath + ".emit.ts", scriptContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const walk = (node: ts.Node, enclosingFn: string | null) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        ts.forEachChild(node, child => walk(child, node.name!.text));
        return;
      }
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        ts.forEachChild(node, child => walk(child, node.name.getText()));
        return;
      }
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
        let fnName = enclosingFn;
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          fnName = node.parent.name.text;
        } else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
          fnName = node.parent.name.text;
        }
        ts.forEachChild(node, child => walk(child, fnName));
        return;
      }

      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        let isEmit = false;

        if (ts.isPropertyAccessExpression(expr) && expr.name.text === "$emit") {
          isEmit = true;
        }
        if (ts.isIdentifier(expr) && expr.text === "emit") {
          isEmit = true;
        }
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === "emit" &&
            ts.isIdentifier(expr.expression) && (expr.expression.text === "context" || expr.expression.text === "ctx")) {
          isEmit = true;
        }

        if (isEmit && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
          const eventName = node.arguments[0].text;
          if (enclosingFn) {
            emits.push({ eventName, emitterFunction: enclosingFn });
          }
        }
      }

      ts.forEachChild(node, child => walk(child, enclosingFn));
    };

    walk(sourceFile, null);
  } catch (err) {
    console.warn(`[event-graph] Failed to detect emits in Vue script ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return emits;
}

function detectEmitsInReact(content: string, filePath: string): ComponentEmitEntry[] {
  const emits: ComponentEmitEntry[] = [];

  try {
    const scriptKind = filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

    const callbackParams = new Set<string>();

    const collectCallbackParams = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        for (const param of node.parameters) {
          if (ts.isObjectBindingPattern(param.name)) {
            for (const el of param.name.elements) {
              if (ts.isIdentifier(el.name) && /^on[A-Z]/.test(el.name.text)) {
                callbackParams.add(el.name.text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, collectCallbackParams);
    };
    collectCallbackParams(sourceFile);

    const walk = (node: ts.Node, enclosingFn: string | null) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        ts.forEachChild(node, child => walk(child, node.name!.text));
        return;
      }
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        ts.forEachChild(node, child => walk(child, node.name.getText()));
        return;
      }
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
        let fnName = enclosingFn;
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
          fnName = node.parent.name.text;
        } else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
          fnName = node.parent.name.text;
        }
        ts.forEachChild(node, child => walk(child, fnName));
        return;
      }

      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        if (ts.isPropertyAccessExpression(expr) && /^on[A-Z]/.test(expr.name.text) &&
            ts.isIdentifier(expr.expression) && (expr.expression.text === "props" || expr.expression.text === "this.props")) {
          const eventName = expr.name.text;
          if (enclosingFn) {
            emits.push({ eventName, emitterFunction: enclosingFn });
          }
        }

        if (ts.isIdentifier(expr) && callbackParams.has(expr.text)) {
          if (enclosingFn) {
            emits.push({ eventName: expr.text, emitterFunction: enclosingFn });
          }
        }
      }

      ts.forEachChild(node, child => walk(child, enclosingFn));
    };

    walk(sourceFile, null);
  } catch (err) {
    console.warn(`[event-graph] Failed to detect emits in React ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return emits;
}

function detectEmitsInAngular(content: string, filePath: string): ComponentEmitEntry[] {
  const emits: ComponentEmitEntry[] = [];

  try {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    const outputProps = new Set<string>();

    const findOutputs = (node: ts.Node) => {
      if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
        if (decorators) {
          for (const dec of decorators) {
            if (ts.isCallExpression(dec.expression) && ts.isIdentifier(dec.expression.expression) && dec.expression.expression.text === "Output") {
              outputProps.add(node.name.text);
            }
          }
        }
      }
      ts.forEachChild(node, findOutputs);
    };
    findOutputs(sourceFile);

    const walk = (node: ts.Node, enclosingFn: string | null) => {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        ts.forEachChild(node, child => walk(child, node.name.getText()));
        return;
      }
      if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
        let fnName = enclosingFn;
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) fnName = node.parent.name.text;
        ts.forEachChild(node, child => walk(child, fnName));
        return;
      }

      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === "emit") {
          const obj = expr.expression;
          if (ts.isPropertyAccessExpression(obj) && ts.isIdentifier(obj.name) && outputProps.has(obj.name.text)) {
            if (enclosingFn) {
              emits.push({ eventName: obj.name.text, emitterFunction: enclosingFn });
            }
          }
        }
      }

      ts.forEachChild(node, child => walk(child, enclosingFn));
    };

    walk(sourceFile, null);
  } catch (err) {
    console.warn(`[event-graph] Failed to detect emits in Angular ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return emits;
}

function detectVueTemplateListeners(
  content: string,
  filePath: string,
  componentRegistry: Map<string, string>
): EventListenerEntry[] {
  const listeners: EventListenerEntry[] = [];

  try {
    const sfcResult = vueSfc.parse(content);
    const descriptor = sfcResult.descriptor;
    if (!descriptor.template || !descriptor.template.ast) return listeners;

    const walkNode = (nodes: any[]) => {
      for (const node of nodes) {
        if (node.type === 1) {
          const tagName = node.tag || "";

          if (isCustomComponentTag(tagName)) {
            const childFilePath = componentRegistry.get(tagName) ||
              componentRegistry.get(toPascalCase(tagName)) ||
              componentRegistry.get(toKebabCase(tagName)) || null;

            if (node.props) {
              for (const prop of node.props) {
                if (prop.type === 7 && prop.name === "on" && prop.arg) {
                  const eventName = prop.arg.content || "";
                  let handlerName = "";
                  if (prop.exp) {
                    const expContent = (prop.exp.content || "").trim();
                    const cleaned = expContent.replace(/\(.*\)$/, "").trim();
                    const dotIdx = cleaned.lastIndexOf(".");
                    handlerName = dotIdx >= 0 ? cleaned.substring(dotIdx + 1) : cleaned;
                  }
                  if (handlerName && eventName) {
                    listeners.push({
                      childTag: tagName,
                      childFilePath,
                      eventName,
                      parentHandler: handlerName,
                    });
                  }
                }
              }
            }
          }

          if (node.children) {
            walkNode(node.children);
          }
        }
      }
    };

    walkNode(descriptor.template.ast.children);
  } catch (err) {
    console.warn(`[event-graph] Failed to detect Vue template listeners in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return listeners;
}

function detectReactJSXListeners(
  content: string,
  filePath: string,
  componentRegistry: Map<string, string>
): EventListenerEntry[] {
  const listeners: EventListenerEntry[] = [];

  try {
    const scriptKind = filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sourceFile);

        if (/^[A-Z]/.test(tagName)) {
          const childFilePath = componentRegistry.get(tagName) ||
            componentRegistry.get(toKebabCase(tagName)) || null;

          for (const attr of node.attributes.properties) {
            if (ts.isJsxAttribute(attr) && attr.name) {
              const attrName = attr.name.getText(sourceFile);
              if (/^on[A-Z]/.test(attrName) && attr.initializer) {
                let handlerName = "";
                if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
                  const expr = attr.initializer.expression;
                  if (ts.isIdentifier(expr)) {
                    handlerName = expr.text;
                  } else if (ts.isPropertyAccessExpression(expr)) {
                    handlerName = expr.name.text;
                  } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
                    handlerName = extractInlineHandlerTarget(expr);
                  }
                }
                if (handlerName) {
                  listeners.push({
                    childTag: tagName,
                    childFilePath,
                    eventName: attrName,
                    parentHandler: handlerName,
                  });
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  } catch (err) {
    console.warn(`[event-graph] Failed to detect React JSX listeners in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return listeners;
}

function detectAngularTemplateListeners(
  templateContent: string,
  filePath: string,
  componentRegistry: Map<string, string>
): EventListenerEntry[] {
  const listeners: EventListenerEntry[] = [];

  try {
    const result = ngCompiler.parseTemplate(templateContent, "template.html", { preserveWhitespaces: false });

    const walkNodes = (nodes: any[]) => {
      for (const node of nodes) {
        if (node.name !== undefined) {
          const tagName = node.name || "";
          if (isCustomComponentTag(tagName)) {
            const childFilePath = componentRegistry.get(tagName) ||
              componentRegistry.get(toPascalCase(tagName)) ||
              componentRegistry.get(toKebabCase(tagName)) || null;

            if (node.outputs) {
              for (const output of node.outputs) {
                const eventName = output.name || "";
                let handlerName = "";
                if (output.handler) {
                  const source = (output.handler.source || "").trim();
                  const cleaned = source.replace(/\(.*\)$/, "").trim();
                  const dotIdx = cleaned.lastIndexOf(".");
                  handlerName = dotIdx >= 0 ? cleaned.substring(dotIdx + 1) : cleaned;
                }
                if (handlerName && eventName) {
                  listeners.push({ childTag: tagName, childFilePath, eventName, parentHandler: handlerName });
                }
              }
            }
          }

          if (node.children) {
            walkNodes(node.children);
          }
        }
      }
    };

    if (result.nodes) {
      walkNodes(result.nodes);
    }
  } catch (err) {
    console.warn(`[event-graph] Failed to detect Angular template listeners in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return listeners;
}

function buildComponentEventGraph(
  files: { filePath: string; content: string }[],
  allFilePaths: string[]
): ComponentEventGraph {
  const componentRegistry = buildComponentRegistry(files, allFilePaths);
  const emitters = new Map<string, ComponentEmitEntry[]>();
  const listeners = new Map<string, EventListenerEntry[]>();

  for (const file of files) {
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) continue;

    try {
      if (file.filePath.endsWith(".vue")) {
        const scriptContent = extractVueScript(file.content);
        const fileEmits = detectEmitsInVueScript(scriptContent, file.filePath);
        if (fileEmits.length > 0) emitters.set(file.filePath, fileEmits);

        const fileListeners = detectVueTemplateListeners(file.content, file.filePath, componentRegistry);
        if (fileListeners.length > 0) listeners.set(file.filePath, fileListeners);
      } else if (file.filePath.endsWith(".tsx") || file.filePath.endsWith(".jsx")) {
        const fileEmits = detectEmitsInReact(file.content, file.filePath);
        if (fileEmits.length > 0) emitters.set(file.filePath, fileEmits);

        const fileListeners = detectReactJSXListeners(file.content, file.filePath, componentRegistry);
        if (fileListeners.length > 0) listeners.set(file.filePath, fileListeners);
      } else if (file.filePath.endsWith(".ts") || file.filePath.endsWith(".js")) {
        if (isAngularComponent(file.content)) {
          const fileEmits = detectEmitsInAngular(file.content, file.filePath);
          if (fileEmits.length > 0) emitters.set(file.filePath, fileEmits);
        }
      } else if (file.filePath.endsWith(".html")) {
        const fileListeners = detectAngularTemplateListeners(file.content, file.filePath, componentRegistry);
        if (fileListeners.length > 0) listeners.set(file.filePath, fileListeners);
      }
    } catch (err) {
      console.warn(`[event-graph] Failed to process ${file.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const totalEmitters = Array.from(emitters.values()).reduce((sum, e) => sum + e.length, 0);
  const totalListeners = Array.from(listeners.values()).reduce((sum, l) => sum + l.length, 0);
  console.log(`[event-graph] Built: ${componentRegistry.size} component tags, ${totalEmitters} emit sites in ${emitters.size} files, ${totalListeners} listeners in ${listeners.size} parent files`);

  return { emitters, listeners, componentRegistry };
}

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

function detectStateContainers(files: { filePath: string; content: string }[]): DetectedStateContainer[] {
  const containers: DetectedStateContainer[] = [];

  for (const file of files) {
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/") || file.filePath.includes("__tests__")) continue;
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx", ".vue"].includes(ext)) continue;

    try {
      let scriptContent = file.content;
      if (ext === ".vue") {
        scriptContent = extractVueScript(file.content);
      }
      if (!scriptContent.trim()) continue;

      const scriptKind = ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sourceFile = ts.createSourceFile(file.filePath, scriptContent, ts.ScriptTarget.Latest, true, scriptKind);

      detectPiniaStores(sourceFile, file.filePath, containers);
      detectVuexStores(sourceFile, file.filePath, containers);
      detectReduxSlices(sourceFile, file.filePath, containers);
      detectAngularServices(sourceFile, file.filePath, containers);
      detectComposables(sourceFile, file.filePath, containers);
    } catch (err) {
    }
  }

  return containers;
}

function detectPiniaStores(sourceFile: ts.SourceFile, filePath: string, containers: DetectedStateContainer[]): void {
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineStore") {
      const stateFields: string[] = [];
      let storeName = "unknown";

      if (node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
        storeName = node.arguments[0].text;
      }

      const optionsArg = node.arguments.length >= 2 ? node.arguments[1] : node.arguments[0];
      if (optionsArg && ts.isObjectLiteralExpression(optionsArg)) {
        for (const prop of optionsArg.properties) {
          if (ts.isMethodDeclaration(prop) || ts.isPropertyAssignment(prop)) {
            const propName = ts.isIdentifier(prop.name!) ? prop.name.text : "";
            if (propName === "state" && ts.isPropertyAssignment(prop)) {
              const init = prop.initializer;
              if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
                const body = ts.isArrowFunction(init) ? init.body : init.body;
                if (body && ts.isParenthesizedExpression(body)) {
                  const inner = body.expression;
                  if (ts.isObjectLiteralExpression(inner)) {
                    extractObjectFieldNames(inner, stateFields);
                  }
                } else if (body && ts.isObjectLiteralExpression(body)) {
                  extractObjectFieldNames(body, stateFields);
                } else if (body && ts.isBlock(body)) {
                  for (const stmt of body.statements) {
                    if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
                      extractObjectFieldNames(stmt.expression, stateFields);
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (optionsArg && (ts.isArrowFunction(optionsArg) || ts.isFunctionExpression(optionsArg))) {
        const body = ts.isArrowFunction(optionsArg) ? optionsArg.body : optionsArg.body;
        if (body && ts.isBlock(body)) {
          for (const stmt of body.statements) {
            if (ts.isVariableStatement(stmt)) {
              for (const decl of stmt.declarationList.declarations) {
                if (ts.isIdentifier(decl.name) && decl.initializer) {
                  if (ts.isCallExpression(decl.initializer)) {
                    const callName = decl.initializer.expression.getText(sourceFile);
                    if (callName === "ref" || callName === "reactive" || callName === "computed" || callName === "shallowRef") {
                      stateFields.push(decl.name.text);
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (stateFields.length > 0) {
        containers.push({ type: "pinia", name: storeName, filePath, stateFields, sourceFile });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function detectVuexStores(sourceFile: ts.SourceFile, filePath: string, containers: DetectedStateContainer[]): void {
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callText = node.expression.getText(sourceFile);
      if (callText === "createStore" || callText === "new Vuex.Store" || callText === "Vuex.createStore") {
        const stateFields: string[] = [];
        let storeName = getComponentName(filePath);

        if (node.arguments.length >= 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
          for (const prop of node.arguments[0].properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "state") {
              if (ts.isObjectLiteralExpression(prop.initializer)) {
                extractObjectFieldNames(prop.initializer, stateFields);
              } else if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) {
                const body = ts.isArrowFunction(prop.initializer) ? prop.initializer.body : prop.initializer.body;
                if (body && ts.isObjectLiteralExpression(body)) {
                  extractObjectFieldNames(body, stateFields);
                } else if (body && ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
                  extractObjectFieldNames(body.expression, stateFields);
                } else if (body && ts.isBlock(body)) {
                  for (const stmt of body.statements) {
                    if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
                      extractObjectFieldNames(stmt.expression, stateFields);
                    }
                  }
                }
              }
            }
          }
        }

        if (stateFields.length > 0) {
          containers.push({ type: "vuex", name: storeName, filePath, stateFields, sourceFile });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function detectReduxSlices(sourceFile: ts.SourceFile, filePath: string, containers: DetectedStateContainer[]): void {
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createSlice") {
      const stateFields: string[] = [];
      let sliceName = "unknown";

      if (node.arguments.length >= 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const prop of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            if (prop.name.text === "name" && ts.isStringLiteral(prop.initializer)) {
              sliceName = prop.initializer.text;
            }
            if (prop.name.text === "initialState" && ts.isObjectLiteralExpression(prop.initializer)) {
              extractObjectFieldNames(prop.initializer, stateFields);
            }
          }
        }
      }

      if (stateFields.length > 0) {
        containers.push({ type: "redux", name: sliceName, filePath, stateFields, sourceFile });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function detectAngularServices(sourceFile: ts.SourceFile, filePath: string, containers: DetectedStateContainer[]): void {
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      let isInjectable = false;
      if (node.modifiers) {
        for (const mod of node.modifiers) {
          if (ts.isDecorator(mod) && ts.isCallExpression(mod.expression)) {
            const decoratorName = mod.expression.expression.getText(sourceFile);
            if (decoratorName === "Injectable") {
              isInjectable = true;
            }
          }
        }
      }

      if (isInjectable) {
        const stateFields: string[] = [];
        for (const member of node.members) {
          if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
            const memberName = member.name.text;
            const hasHttpType = member.type && member.type.getText(sourceFile).includes("Http");
            if (!hasHttpType) {
              stateFields.push(memberName);
            }
          }
        }
        if (stateFields.length > 0) {
          containers.push({ type: "angular-service", name: node.name.text, filePath, stateFields, sourceFile });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function detectComposables(sourceFile: ts.SourceFile, filePath: string, containers: DetectedStateContainer[]): void {
  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
  const isComposableFile = fileName.startsWith("use") || filePath.includes("/composables/") || filePath.includes("/hooks/");
  if (!isComposableFile) return;

  const stateFields: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text.startsWith("use")) {
      if (node.body) {
        extractReactiveStateFromBlock(node.body, sourceFile, stateFields);
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text.startsWith("use") && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            const body = ts.isArrowFunction(decl.initializer) ? decl.initializer.body : decl.initializer.body;
            if (body && ts.isBlock(body)) {
              extractReactiveStateFromBlock(body, sourceFile, stateFields);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (stateFields.length > 0) {
    const composableName = getComponentName(filePath);
    containers.push({ type: "composable", name: composableName, filePath, stateFields, sourceFile });
  }
}

function extractReactiveStateFromBlock(block: ts.Block, sourceFile: ts.SourceFile, stateFields: string[]): void {
  for (const stmt of block.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && ts.isCallExpression(decl.initializer)) {
          const callName = decl.initializer.expression.getText(sourceFile);
          if (callName === "ref" || callName === "reactive" || callName === "computed" || callName === "shallowRef" ||
              callName === "useState" || callName === "useReducer" || callName === "signal") {
            stateFields.push(decl.name.text);
          }
        }
        if (ts.isArrayBindingPattern(decl.name) && decl.initializer && ts.isCallExpression(decl.initializer)) {
          const callName = decl.initializer.expression.getText(sourceFile);
          if (callName === "useState" || callName === "useReducer") {
            for (const el of decl.name.elements) {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                stateFields.push(el.name.text);
              }
            }
          }
        }
      }
    }
  }
}

function extractObjectFieldNames(obj: ts.ObjectLiteralExpression, fields: string[]): void {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      fields.push(prop.name.text);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      fields.push(prop.name.text);
    } else if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
      fields.push(prop.name.text);
    }
  }
}

function detectStateWrites(
  container: DetectedStateContainer,
  sourceFile: ts.SourceFile
): StateFieldWrite[] {
  const writes: StateFieldWrite[] = [];
  const stateFieldSet = new Set(container.stateFields);

  const visit = (node: ts.Node, enclosingFunction: string | null) => {
    let currentFunction = enclosingFunction;

    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFunction = node.name.text;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      currentFunction = node.name.text;
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
      if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        currentFunction = node.parent.name.text;
      } else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
        currentFunction = node.parent.name.text;
      }
    }

    if (currentFunction && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const fieldName = extractStateFieldFromLHS(node.left, stateFieldSet, sourceFile);
      if (fieldName) {
        writes.push({
          containerFile: container.filePath,
          containerName: container.name,
          fieldName,
          writerFunction: currentFunction,
          qualifiedField: `${container.filePath}::${container.name}.${fieldName}`,
        });
      }
    }

    if (currentFunction && ts.isCallExpression(node)) {
      const callText = node.expression.getText(sourceFile);
      if (callText === "commit" || callText === "store.commit" || callText === "this.$store.commit" || callText === "this.store.commit") {
        if (node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
          const mutationName = node.arguments[0].text;
          writes.push({
            containerFile: container.filePath,
            containerName: container.name,
            fieldName: mutationName,
            writerFunction: currentFunction,
            qualifiedField: `${container.filePath}::${container.name}.${mutationName}`,
          });
        }
      }

      if (callText === "dispatch" || callText === "store.dispatch" || callText === "this.$store.dispatch" || callText === "this.store.dispatch") {
        if (node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
          const actionName = node.arguments[0].text;
          writes.push({
            containerFile: container.filePath,
            containerName: container.name,
            fieldName: actionName,
            writerFunction: currentFunction,
            qualifiedField: `${container.filePath}::${container.name}.${actionName}`,
          });
        }
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const propName = node.expression.name.text;
        const objText = node.expression.expression.getText(sourceFile);
        if (propName === "value" || propName === "set") {
          const baseField = objText.replace(/^this\./, "").replace(/^state\./, "");
          if (stateFieldSet.has(baseField)) {
            writes.push({
              containerFile: container.filePath,
              containerName: container.name,
              fieldName: baseField,
              writerFunction: currentFunction,
              qualifiedField: `${container.filePath}::${container.name}.${baseField}`,
            });
          }
        }
        if (propName === "$patch" || propName === "patch") {
          for (const field of container.stateFields) {
            writes.push({
              containerFile: container.filePath,
              containerName: container.name,
              fieldName: field,
              writerFunction: currentFunction,
              qualifiedField: `${container.filePath}::${container.name}.${field}`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, currentFunction));
  };

  visit(sourceFile, null);
  return writes;
}

function extractStateFieldFromLHS(
  expr: ts.Expression,
  stateFields: Set<string>,
  sourceFile: ts.SourceFile
): string | null {
  if (ts.isPropertyAccessExpression(expr)) {
    const propName = expr.name.text;
    if (stateFields.has(propName)) return propName;

    const objText = expr.expression.getText(sourceFile);
    if (objText === "state" || objText === "this" || objText === "this.state" || objText === "store.state" || objText === "this.$store.state") {
      if (stateFields.has(propName)) return propName;
    }

    if (ts.isPropertyAccessExpression(expr.expression)) {
      const deepProp = expr.expression.name.text;
      if (stateFields.has(deepProp)) return deepProp;
    }
  }

  if (ts.isElementAccessExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const propName = expr.expression.name.text;
    if (stateFields.has(propName)) return propName;
  }

  if (ts.isIdentifier(expr) && stateFields.has(expr.text)) {
    return expr.text;
  }

  return null;
}

function detectStateReadsWithHttp(
  container: DetectedStateContainer,
  sourceFile: ts.SourceFile,
  httpServiceMap: HttpServiceMap,
  globalCallGraph: GlobalCallGraph
): StateFieldRead[] {
  const reads: StateFieldRead[] = [];
  const stateFieldSet = new Set(container.stateFields);

  const functions = new Map<string, { node: ts.Node; readsFields: Set<string>; hasHttp: boolean; httpCalls: HttpCall[] }>();

  const collectFunctions = (node: ts.Node) => {
    let funcName: string | null = null;
    let funcBody: ts.Node | null = null;

    if (ts.isFunctionDeclaration(node) && node.name) {
      funcName = node.name.text;
      funcBody = node.body || null;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      funcName = node.name.text;
      funcBody = node.body || null;
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
      if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        funcName = node.parent.name.text;
      } else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
        funcName = node.parent.name.text;
      }
      funcBody = ts.isArrowFunction(node) ? node.body : node.body;
    }

    if (funcName && funcBody) {
      const readsFields = new Set<string>();
      const httpCalls: HttpCall[] = [];

      const scanBody = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
          const propName = n.name.text;
          if (stateFieldSet.has(propName)) {
            if (!ts.isBinaryExpression(n.parent) || n.parent.left !== n || n.parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
              readsFields.add(propName);
            }
          }
        }
        if (ts.isIdentifier(n) && stateFieldSet.has(n.text)) {
          if (!ts.isPropertyAccessExpression(n.parent) || n.parent.name !== n) {
            if (!ts.isBinaryExpression(n.parent) || n.parent.left !== n || n.parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
              readsFields.add(n.text);
            }
          }
        }

        if (ts.isCallExpression(n)) {
          const callText = n.expression.getText(sourceFile);
          if (isHttpCallExpression(callText)) {
            const urlArg = n.arguments.length > 0 ? n.arguments[0] : null;
            if (urlArg && ts.isStringLiteral(urlArg)) {
              httpCalls.push({
                method: inferHttpMethod(callText),
                url: urlArg.text,
                lineNumber: sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1,
                callerFunction: funcName,
              });
            }
          }
        }

        ts.forEachChild(n, scanBody);
      };
      scanBody(funcBody);

      const gcgNode = globalCallGraph.get(`${container.filePath}::${funcName}`);
      if (gcgNode) {
        if (gcgNode.httpCalls.length > 0) httpCalls.push(...gcgNode.httpCalls);
        if (gcgNode.propagatedHttpCalls && gcgNode.propagatedHttpCalls.length > 0) httpCalls.push(...gcgNode.propagatedHttpCalls);
      }

      functions.set(funcName, {
        node,
        readsFields,
        hasHttp: httpCalls.length > 0,
        httpCalls,
      });
    }

    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(sourceFile);

  for (const [funcName, info] of Array.from(functions.entries())) {
    if (info.hasHttp && info.readsFields.size > 0) {
      for (const fieldName of Array.from(info.readsFields)) {
        reads.push({
          containerFile: container.filePath,
          containerName: container.name,
          fieldName,
          readerFunction: funcName,
          qualifiedField: `${container.filePath}::${container.name}.${fieldName}`,
          httpCalls: info.httpCalls,
        });
      }
    }
  }

  return reads;
}

function isHttpCallExpression(callText: string): boolean {
  const httpPatterns = [
    "fetch", "axios", "axios.get", "axios.post", "axios.put", "axios.delete", "axios.patch",
    "http.get", "http.post", "http.put", "http.delete", "http.patch",
    "this.http.get", "this.http.post", "this.http.put", "this.http.delete", "this.http.patch",
    "$http.get", "$http.post", "$http.put", "$http.delete", "$http.patch",
    "api.get", "api.post", "api.put", "api.delete", "api.patch",
    "request", "apiRequest", "apiCall",
  ];
  const lowerCall = callText.toLowerCase();
  return httpPatterns.some(p => lowerCall === p.toLowerCase() || lowerCall.endsWith("." + p.toLowerCase()));
}

function inferHttpMethod(callText: string): string {
  const lower = callText.toLowerCase();
  if (lower.includes("post")) return "POST";
  if (lower.includes("put")) return "PUT";
  if (lower.includes("delete")) return "DELETE";
  if (lower.includes("patch")) return "PATCH";
  return "GET";
}

function buildStateFlowGraph(
  files: { filePath: string; content: string }[],
  httpServiceMap: HttpServiceMap,
  globalCallGraph: GlobalCallGraph
): StateFlowGraph {
  const writers = new Map<string, StateFieldWrite[]>();
  const readers = new Map<string, StateFieldRead[]>();
  const containerFiles = new Set<string>();

  const containers = detectStateContainers(files);

  for (const container of containers) {
    containerFiles.add(container.filePath);

    const containerWrites = detectStateWrites(container, container.sourceFile);
    for (const write of containerWrites) {
      const key = write.qualifiedField;
      if (!writers.has(key)) writers.set(key, []);
      writers.get(key)!.push(write);
    }

    const containerReads = detectStateReadsWithHttp(container, container.sourceFile, httpServiceMap, globalCallGraph);
    for (const read of containerReads) {
      const key = read.qualifiedField;
      if (!readers.has(key)) readers.set(key, []);
      readers.get(key)!.push(read);
    }
  }

  for (const file of files) {
    if (containerFiles.has(file.filePath)) continue;
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) continue;

    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx", ".vue"].includes(ext)) continue;

    try {
      let scriptContent = file.content;
      if (ext === ".vue") {
        scriptContent = extractVueScript(file.content);
      }
      if (!scriptContent.trim()) continue;

      const scriptKind = ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sourceFile = ts.createSourceFile(file.filePath, scriptContent, ts.ScriptTarget.Latest, true, scriptKind);

      detectWritesInConsumerFile(sourceFile, file.filePath, containers, writers);
      detectReadsInConsumerFile(sourceFile, file.filePath, containers, readers, globalCallGraph);
    } catch (err) {
    }
  }

  const writerCount = Array.from(writers.values()).reduce((sum, w) => sum + w.length, 0);
  const readerCount = Array.from(readers.values()).reduce((sum, r) => sum + r.length, 0);
  const fieldsWithBoth = Array.from(writers.keys()).filter(k => readers.has(k)).length;
  console.log(`[state-flow] Built: ${containers.length} containers, ${writers.size} written fields (${writerCount} writes), ${readers.size} read fields (${readerCount} reads), ${fieldsWithBoth} fields with both write+read`);

  return { writers, readers, containerFiles };
}

function detectWritesInConsumerFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  containers: DetectedStateContainer[],
  writers: Map<string, StateFieldWrite[]>
): void {
  const storeUsages = detectStoreUsagesInFile(sourceFile, containers);

  const visit = (node: ts.Node, enclosingFunction: string | null) => {
    let currentFunction = enclosingFunction;

    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFunction = node.name.text;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      currentFunction = node.name.text;
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
      if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        currentFunction = node.parent.name.text;
      } else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
        currentFunction = node.parent.name.text;
      }
    }

    if (currentFunction && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      for (const [storeVarName, container] of Array.from(storeUsages.entries())) {
        const fieldName = extractStoreFieldWrite(node.left, storeVarName, container.stateFields, sourceFile);
        if (fieldName) {
          const qualifiedField = `${container.filePath}::${container.name}.${fieldName}`;
          if (!writers.has(qualifiedField)) writers.set(qualifiedField, []);
          writers.get(qualifiedField)!.push({
            containerFile: container.filePath,
            containerName: container.name,
            fieldName,
            writerFunction: currentFunction,
            qualifiedField,
          });
        }
      }
    }

    if (currentFunction && ts.isCallExpression(node)) {
      const callText = node.expression.getText(sourceFile);
      for (const [storeVarName, container] of Array.from(storeUsages.entries())) {
        if (callText.startsWith(storeVarName + ".")) {
          const methodName = callText.substring(storeVarName.length + 1);
          if (methodName === "$patch" || methodName === "patch") {
            for (const field of container.stateFields) {
              const qualifiedField = `${container.filePath}::${container.name}.${field}`;
              if (!writers.has(qualifiedField)) writers.set(qualifiedField, []);
              writers.get(qualifiedField)!.push({
                containerFile: container.filePath,
                containerName: container.name,
                fieldName: field,
                writerFunction: currentFunction,
                qualifiedField,
              });
            }
          }
          if (methodName === "commit" || methodName === "dispatch") {
            if (node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0])) {
              const targetName = node.arguments[0].text;
              const qualifiedField = `${container.filePath}::${container.name}.${targetName}`;
              if (!writers.has(qualifiedField)) writers.set(qualifiedField, []);
              writers.get(qualifiedField)!.push({
                containerFile: container.filePath,
                containerName: container.name,
                fieldName: targetName,
                writerFunction: currentFunction,
                qualifiedField,
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, currentFunction));
  };

  visit(sourceFile, null);
}

function detectReadsInConsumerFile(
  sourceFile: ts.SourceFile,
  filePath: string,
  containers: DetectedStateContainer[],
  readers: Map<string, StateFieldRead[]>,
  globalCallGraph: GlobalCallGraph
): void {
  const storeUsages = detectStoreUsagesInFile(sourceFile, containers);

  const functions = new Map<string, { readsFields: { field: string; container: DetectedStateContainer }[]; httpCalls: HttpCall[] }>();

  const collectFunctions = (node: ts.Node) => {
    let funcName: string | null = null;
    let funcBody: ts.Node | null = null;

    if (ts.isFunctionDeclaration(node) && node.name) {
      funcName = node.name.text;
      funcBody = node.body || null;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      funcName = node.name.text;
      funcBody = node.body || null;
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
      if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
        funcName = node.parent.name.text;
      } else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
        funcName = node.parent.name.text;
      }
      funcBody = ts.isArrowFunction(node) ? node.body : node.body;
    }

    if (funcName && funcBody) {
      const readsFields: { field: string; container: DetectedStateContainer }[] = [];
      const httpCalls: HttpCall[] = [];

      const scanBody = (n: ts.Node) => {
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)) {
          for (const [storeVarName, container] of Array.from(storeUsages.entries())) {
            const objText = n.expression.getText(sourceFile);
            if (objText === storeVarName || objText.startsWith(storeVarName + ".")) {
              if (container.stateFields.includes(n.name.text)) {
                if (!ts.isBinaryExpression(n.parent) || n.parent.left !== n || n.parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
                  readsFields.push({ field: n.name.text, container });
                }
              }
            }
          }
        }

        if (ts.isCallExpression(n)) {
          const callText = n.expression.getText(sourceFile);
          if (isHttpCallExpression(callText)) {
            const urlArg = n.arguments.length > 0 ? n.arguments[0] : null;
            if (urlArg && ts.isStringLiteral(urlArg)) {
              httpCalls.push({
                method: inferHttpMethod(callText),
                url: urlArg.text,
                lineNumber: sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1,
                callerFunction: funcName,
              });
            }
          }
        }

        ts.forEachChild(n, scanBody);
      };
      scanBody(funcBody);

      const gcgNode = globalCallGraph.get(`${filePath}::${funcName}`);
      if (gcgNode) {
        if (gcgNode.httpCalls.length > 0) httpCalls.push(...gcgNode.httpCalls);
        if (gcgNode.propagatedHttpCalls && gcgNode.propagatedHttpCalls.length > 0) httpCalls.push(...gcgNode.propagatedHttpCalls);
      }

      if (readsFields.length > 0 && httpCalls.length > 0) {
        functions.set(funcName, { readsFields, httpCalls });
      }
    }

    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(sourceFile);

  for (const [funcName, info] of Array.from(functions.entries())) {
    for (const { field, container } of info.readsFields) {
      const qualifiedField = `${container.filePath}::${container.name}.${field}`;
      if (!readers.has(qualifiedField)) readers.set(qualifiedField, []);
      readers.get(qualifiedField)!.push({
        containerFile: container.filePath,
        containerName: container.name,
        fieldName: field,
        readerFunction: funcName,
        qualifiedField,
        httpCalls: info.httpCalls,
      });
    }
  }
}

function detectStoreUsagesInFile(
  sourceFile: ts.SourceFile,
  containers: DetectedStateContainer[]
): Map<string, DetectedStateContainer> {
  const storeUsages = new Map<string, DetectedStateContainer>();

  const containersByName = new Map<string, DetectedStateContainer>();
  const containersByFile = new Map<string, DetectedStateContainer>();
  for (const c of containers) {
    containersByName.set(c.name, c);
    containersByFile.set(c.filePath, c);
    const fileName = c.filePath.substring(c.filePath.lastIndexOf("/") + 1).replace(/\.(ts|js|tsx|jsx|vue)$/, "");
    containersByName.set(fileName, c);
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = node.moduleSpecifier.text;
      for (const container of containers) {
        const containerBase = container.filePath.replace(/\.(ts|js|tsx|jsx|vue)$/, "");
        if (modulePath.includes(containerBase) || containerBase.endsWith(modulePath.replace(/^\.\/|^@\//, ""))) {
          if (node.importClause) {
            if (node.importClause.name) {
              storeUsages.set(node.importClause.name.text, container);
            }
            if (node.importClause.namedBindings) {
              if (ts.isNamedImports(node.importClause.namedBindings)) {
                for (const spec of node.importClause.namedBindings.elements) {
                  storeUsages.set(spec.name.text, container);
                }
              }
            }
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callName = node.initializer.expression.getText(sourceFile);
      for (const container of containers) {
        if (callName.includes(container.name) || callName.includes("use" + container.name.charAt(0).toUpperCase() + container.name.slice(1))) {
          storeUsages.set(node.name.text, container);
        }
      }
      if (callName === "useStore" || callName === "inject" || callName === "useSelector" || callName === "useDispatch") {
        for (const container of containers) {
          storeUsages.set(node.name.text, container);
          break;
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return storeUsages;
}

function extractStoreFieldWrite(
  expr: ts.Expression,
  storeVarName: string,
  stateFields: string[],
  sourceFile: ts.SourceFile
): string | null {
  if (ts.isPropertyAccessExpression(expr)) {
    const objText = expr.expression.getText(sourceFile);
    const propName = expr.name.text;
    if (objText === storeVarName && stateFields.includes(propName)) {
      return propName;
    }
    if (objText === storeVarName + ".state" && stateFields.includes(propName)) {
      return propName;
    }
    if (ts.isPropertyAccessExpression(expr.expression)) {
      const deepObj = expr.expression.expression.getText(sourceFile);
      if (deepObj === storeVarName && stateFields.includes(expr.expression.name.text)) {
        return expr.expression.name.text;
      }
    }
  }
  return null;
}

function lookupStateFlowGraph(
  stateFlowGraph: StateFlowGraph,
  handlerName: string,
  filePath: string,
  symbolTable: ScriptSymbolTable,
  globalCallGraph?: GlobalCallGraph,
  importBindings?: Map<string, ImportBinding>
): HttpCall[] {
  const calledFunctions = new Set<string>([handlerName]);
  const handlerNode = symbolTable.resolveHandlerNode(handlerName);
  if (handlerNode) {
    const visited = new Set<ts.Node>();
    const collect = (node: ts.Node) => {
      if (visited.has(node)) return;
      visited.add(node);
      const decl = symbolTable.getDeclaration(node);
      if (decl && decl.name) {
        calledFunctions.add(decl.name);
        for (const calledNode of decl.calledNodes) {
          collect(calledNode);
        }
      }
    };
    collect(handlerNode);
  }

  if (globalCallGraph) {
    const directKey = `${filePath}::${handlerName}`;
    const gcgNode = globalCallGraph.get(directKey);
    if (gcgNode) {
      const visited = new Set<string>();
      const collectCallees = (key: string) => {
        if (visited.has(key)) return;
        visited.add(key);
        const node = globalCallGraph.get(key);
        if (!node) return;
        const funcPart = key.split("::")[1];
        if (funcPart) {
          const simpleName = funcPart.includes(".") ? funcPart.split(".").pop()! : funcPart;
          calledFunctions.add(simpleName);
        }
        for (const calleeKey of Array.from(node.callees)) {
          collectCallees(calleeKey);
        }
      };
      collectCallees(directKey);
    }
  }

  const writtenFields = new Set<string>();
  for (const funcName of Array.from(calledFunctions)) {
    for (const [qualifiedField, fieldWriters] of Array.from(stateFlowGraph.writers.entries())) {
      for (const w of fieldWriters) {
        if (w.writerFunction === funcName) {
          writtenFields.add(qualifiedField);
        }
      }
    }
  }

  if (writtenFields.size === 0) return [];

  const results: HttpCall[] = [];
  const seen = new Set<string>();

  for (const qualifiedField of Array.from(writtenFields)) {
    const fieldReaders = stateFlowGraph.readers.get(qualifiedField);
    if (!fieldReaders) continue;

    for (const reader of fieldReaders) {
      for (const httpCall of reader.httpCalls) {
        const key = `${httpCall.method}:${httpCall.url}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(httpCall);
        }
      }
    }
  }

  return results;
}

type ArchitecturalRole = "component" | "facade" | "usecase" | "repository" | "unknown";

interface ArchitecturalLayerGraph {
  roleByFile: Map<string, ArchitecturalRole>;
  importsByFile: Map<string, Set<string>>;
  repositoryHttpCalls: Map<string, HttpCall[]>;
}

function classifyFileRole(
  filePath: string,
  content: string,
  serviceMap: HttpServiceMap,
  allFilePaths: string[]
): ArchitecturalRole {
  const ext = filePath.substring(filePath.lastIndexOf("."));

  if (ext === ".vue") return "component";

  const fileEntry = serviceMap.get(filePath);
  const hasHttpCalls = fileEntry && (
    fileEntry.directFunctions.size > 0 ||
    Array.from(fileEntry.methods.values()).some(m => m.httpCalls.length > 0)
  );

  if (hasHttpCalls) return "repository";

  if (![".ts", ".js", ".tsx", ".jsx"].includes(ext)) return "unknown";

  try {
    const scriptKind = (ext === ".tsx" || ext === ".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

    let hasJSX = false;
    let hasAngularComponent = false;
    let exportedFunctionCount = 0;
    let classCount = 0;
    let importCount = 0;
    let hasReturnJSX = false;

    const walk = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        hasJSX = true;
      }
      if (ts.isDecorator(node)) {
        const text = node.getText(sourceFile);
        if (text.includes("@Component") || text.includes("@NgModule")) {
          hasAngularComponent = true;
        }
      }
      if (ts.isClassDeclaration(node)) {
        classCount++;
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("~/")) {
          importCount++;
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) {
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          exportedFunctionCount++;
        }
      }
      if (ts.isVariableStatement(node)) {
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const decl of node.declarationList.declarations) {
            if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
              exportedFunctionCount++;
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);

    if (hasJSX || hasAngularComponent) return "component";

    if (importCount === 0) return "unknown";

    const lowerPath = filePath.toLowerCase();
    const isRepoName = /\/(api|repository|client|service|http|request|resource)[\/\.\-]/i.test(lowerPath);
    const isFacadeName = /\/(facade|gateway|mediator|orchestrator|proxy)[\/\.\-]/i.test(lowerPath);
    const isUseCaseName = /\/(usecase|use-case|interactor|handler|command|action|business)[\/\.\-]/i.test(lowerPath);

    if (isRepoName && !hasHttpCalls) return "usecase";
    if (isFacadeName) return "facade";
    if (isUseCaseName) return "usecase";

    if (exportedFunctionCount > 0 && importCount >= 2 && classCount === 0) {
      return "facade";
    }
    if (classCount > 0 && importCount >= 2) {
      return "usecase";
    }
    if (exportedFunctionCount > 0 && importCount >= 1) {
      return "facade";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

function buildArchitecturalLayerGraph(
  files: { filePath: string; content: string }[],
  serviceMap: HttpServiceMap,
  allFilePaths: string[]
): ArchitecturalLayerGraph {
  const roleByFile = new Map<string, ArchitecturalRole>();
  const importsByFile = new Map<string, Set<string>>();
  const repositoryHttpCalls = new Map<string, HttpCall[]>();

  for (const file of files) {
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) {
      continue;
    }
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx", ".vue"].includes(ext)) continue;

    const role = classifyFileRole(file.filePath, file.content, serviceMap, allFilePaths);
    roleByFile.set(file.filePath, role);

    if (role === "repository") {
      const allCalls: HttpCall[] = [];
      const fileEntry = serviceMap.get(file.filePath);
      if (fileEntry) {
        for (const calls of Array.from(fileEntry.directFunctions.values())) {
          allCalls.push(...calls);
        }
        for (const entry of Array.from(fileEntry.methods.values())) {
          allCalls.push(...entry.httpCalls);
        }
      }
      if (allCalls.length > 0) {
        repositoryHttpCalls.set(file.filePath, allCalls);
      }
    }

    try {
      let scriptContent = file.content;
      if (ext === ".vue") {
        scriptContent = extractVueScript(file.content);
      }
      if (!scriptContent.trim()) continue;

      const scriptKind = (ext === ".tsx" || ext === ".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sourceFile = ts.createSourceFile(file.filePath + ".arch.ts", scriptContent, ts.ScriptTarget.Latest, true, scriptKind);
      const imports = new Set<string>();

      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const resolved = normalizeModulePath(file.filePath, node.moduleSpecifier.text, allFilePaths);
          if (resolved) {
            imports.add(resolved);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      if (imports.size > 0) {
        importsByFile.set(file.filePath, imports);
      }
    } catch {
    }
  }

  const roleStats = { component: 0, facade: 0, usecase: 0, repository: 0, unknown: 0 };
  for (const role of Array.from(roleByFile.values())) {
    roleStats[role]++;
  }
  console.log(`[arch-layer] Built: ${roleByFile.size} files classified — ${roleStats.component} components, ${roleStats.facade} facades, ${roleStats.usecase} usecases, ${roleStats.repository} repositories, ${roleStats.unknown} unknown`);

  return { roleByFile, importsByFile, repositoryHttpCalls };
}

function lookupArchitecturalLayerGraph(
  archGraph: ArchitecturalLayerGraph,
  filePath: string,
  handlerName: string,
  symbolTable: ScriptSymbolTable,
  externalCalls: ExternalCall[] | null,
  importBindings?: Map<string, ImportBinding>
): HttpCall[] {
  if (!externalCalls || !importBindings || importBindings.size === 0) return [];

  const relevantFunctions = new Set<string>([handlerName]);
  const handlerNode = symbolTable.resolveHandlerNode(handlerName);
  if (handlerNode) {
    const visited = new Set<ts.Node>();
    const collectCalled = (node: ts.Node) => {
      if (visited.has(node)) return;
      visited.add(node);
      const decl = symbolTable.getDeclaration(node);
      if (decl && decl.name) {
        relevantFunctions.add(decl.name);
        for (const calledNode of decl.calledNodes) {
          collectCalled(calledNode);
        }
      }
    };
    collectCalled(handlerNode);
  }

  const handlerExternalCalls = externalCalls.filter(
    ec => relevantFunctions.has(ec.callerFunction)
  );
  if (handlerExternalCalls.length === 0) return [];

  const targetFiles = new Set<string>();
  for (const ec of handlerExternalCalls) {
    const binding = importBindings.get(ec.importedName);
    if (binding) {
      targetFiles.add(binding.sourcePath);
    }
  }
  if (targetFiles.size === 0) return [];

  const roleOrder: ArchitecturalRole[] = ["component", "facade", "usecase", "repository"];

  const results: HttpCall[] = [];
  const seen = new Set<string>();

  const traverseArch = (
    currentFile: string, minRoleIdx: number, depth: number,
    visitedFiles: Set<string>
  ): void => {
    if (depth > 4 || visitedFiles.has(currentFile)) return;
    visitedFiles.add(currentFile);

    const currentRole = archGraph.roleByFile.get(currentFile);
    if (!currentRole) return;
    const currentIdx = roleOrder.indexOf(currentRole);
    if (currentIdx < 0) return;

    if (currentIdx < minRoleIdx) return;

    if (currentRole === "repository") {
      const httpCalls = archGraph.repositoryHttpCalls.get(currentFile);
      if (httpCalls) {
        for (const call of httpCalls) {
          const key = `${call.method}:${call.url}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(call);
          }
        }
      }
      return;
    }

    const imports = archGraph.importsByFile.get(currentFile);
    if (!imports) return;

    for (const importedFile of Array.from(imports)) {
      if (visitedFiles.has(importedFile)) continue;

      const importedRole = archGraph.roleByFile.get(importedFile);
      if (!importedRole || importedRole === "component" || importedRole === "unknown") continue;

      const importedRoleIdx = roleOrder.indexOf(importedRole);
      if (importedRoleIdx < 0) continue;

      if (importedRoleIdx >= currentIdx) {
        traverseArch(importedFile, currentIdx, depth + 1, visitedFiles);
      }
    }
  };

  for (const targetFile of Array.from(targetFiles)) {
    const targetRole = archGraph.roleByFile.get(targetFile);
    if (!targetRole || targetRole === "component" || targetRole === "unknown") continue;

    const visitedFiles = new Set<string>();
    visitedFiles.add(filePath);

    const targetRoleIdx = roleOrder.indexOf(targetRole);
    traverseArch(targetFile, targetRoleIdx, 1, visitedFiles);
  }

  return results;
}

function lookupEventGraph(
  eventGraph: ComponentEventGraph,
  handlerName: string,
  filePath: string
): { parentFilePath: string; parentHandler: string }[] {
  const fileEmits = eventGraph.emitters.get(filePath);
  if (!fileEmits) return [];

  const emittedEvents = fileEmits.filter(e => e.emitterFunction === handlerName);
  if (emittedEvents.length === 0) return [];

  const results: { parentFilePath: string; parentHandler: string }[] = [];

  for (const emit of emittedEvents) {
    for (const [parentFile, parentListeners] of Array.from(eventGraph.listeners.entries())) {
      for (const listener of parentListeners) {
        if (listener.childFilePath === filePath && normalizeEventName(listener.eventName) === normalizeEventName(emit.eventName)) {
          results.push({ parentFilePath: parentFile, parentHandler: listener.parentHandler });
        }
      }
    }
  }

  return results;
}

function normalizeEventName(name: string): string {
  return name.replace(/^on/, "").replace(/[-_]/g, "").toLowerCase();
}

function parseImportBindings(sourceFile: ts.SourceFile, importerPath: string, allFilePaths: string[]): Map<string, ImportBinding> {
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

function extractExternalCalls(body: ts.Node, localNames: Set<string>): ExternalCall[] {
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

function resolveExternalCallsToHttpCalls(
  externalCalls: ExternalCall[],
  importBindings: Map<string, ImportBinding>,
  serviceMap: HttpServiceMap,
  handlerName: string,
  symbolTable?: ScriptSymbolTable,
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

function getComponentName(filePath: string): string {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  const name = fileName.replace(/\.(vue|jsx|tsx|ts|js|html)$/, "");
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
}

function parseTypeScript(code: string, fileName: string): ts.SourceFile {
  let scriptKind = ts.ScriptKind.TS;
  if (fileName.endsWith(".tsx") || fileName.endsWith(".jsx")) {
    scriptKind = ts.ScriptKind.TSX;
  } else if (fileName.endsWith(".js")) {
    scriptKind = ts.ScriptKind.JS;
  }
  return ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, scriptKind);
}

function getLineNumber(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function extractUrlFromNode(node: ts.Node): string | null {
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
  "service", "action", "command", "operation", "type", "query", "method",
  "operationName", "serviceName", "actionName", "commandName", "queryName",
  "rpc", "endpoint", "handler", "procedure", "topic",
]);

function extractOperationHint(
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

function extractOperationFromObject(obj: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): string | null {
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

function traceLocalConstant(id: ts.Identifier): string | null {
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

function tracePropertyConstant(node: ts.PropertyAccessExpression): string | null {
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

function parseVueTemplateAST(content: string): { bindings: TemplateBinding[]; scriptContent: string; scriptOffset: number } {
  const sfcResult = vueSfc.parse(content);
  const descriptor = sfcResult.descriptor;

  const bindings: TemplateBinding[] = [];

  if (descriptor.template && descriptor.template.ast) {
    walkVueASTNode(descriptor.template.ast.children, bindings);
  }

  let scriptContent = "";
  let scriptOffset = 0;
  if (descriptor.scriptSetup) {
    scriptContent = descriptor.scriptSetup.content;
    scriptOffset = descriptor.scriptSetup.loc.start.line - 1;
  } else if (descriptor.script) {
    scriptContent = descriptor.script.content;
    scriptOffset = descriptor.script.loc.start.line - 1;
  }

  return { bindings, scriptContent, scriptOffset };
}

function walkVueASTNode(nodes: any[], bindings: TemplateBinding[]): void {
  for (const node of nodes) {
    if (node.type === 1) {
      const tagName = node.tag || "";
      const elementType = classifyElement(tagName);

      if (node.props) {
        for (const prop of node.props) {
          if (prop.type === 7 && prop.name === "on" && prop.arg) {
            const eventType = prop.arg.content || "";
            let handlerName = "";

            if (prop.exp) {
              const expContent = (prop.exp.content || "").trim();
              const cleaned = expContent.replace(/\(.*\)$/, "").trim();
              const dotIdx = cleaned.lastIndexOf(".");
              handlerName = dotIdx >= 0 ? cleaned.substring(dotIdx + 1) : cleaned;
            }

            if (handlerName) {
              bindings.push({
                elementType,
                eventType,
                handlerName,
                lineNumber: node.loc?.start?.line || 1,
              });
            }
          }
        }
      }

      if (node.children) {
        walkVueASTNode(node.children, bindings);
      }
    }
  }
}

function parseAngularTemplateAST(templateContent: string): TemplateBinding[] {
  const result = ngCompiler.parseTemplate(templateContent, "template.html", {
    preserveWhitespaces: false,
  });

  const bindings: TemplateBinding[] = [];

  function walkNodes(nodes: any[]): void {
    for (const node of nodes) {
      if (node.name !== undefined) {
        const tagName = node.name || "";
        const elementType = classifyElement(tagName);

        if (node.outputs) {
          for (const output of node.outputs) {
            const eventType = output.name || "";
            let handlerName = "";

            if (output.handler) {
              const source = (output.handler.source || "").trim();
              const cleaned = source.replace(/\(.*\)$/, "").trim();
              const dotIdx = cleaned.lastIndexOf(".");
              handlerName = dotIdx >= 0 ? cleaned.substring(dotIdx + 1) : cleaned;
            }

            if (handlerName) {
              bindings.push({
                elementType,
                eventType,
                handlerName,
                lineNumber: output.sourceSpan?.start?.line != null
                  ? output.sourceSpan.start.line + 1
                  : 1,
              });
            }
          }
        }

        if (node.children) {
          walkNodes(node.children);
        }
      }
    }
  }

  if (result.nodes) {
    walkNodes(result.nodes);
  }

  return bindings;
}

function parseJSXTemplate(sourceFile: ts.SourceFile): TemplateBinding[] {
  const bindings: TemplateBinding[] = [];

  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile).toLowerCase();
      const elementType = classifyElement(tagName);

      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && attr.name) {
          const attrName = attr.name.getText(sourceFile);
          const eventMap: Record<string, string> = {
            onClick: "click",
            onSubmit: "submit",
            onChange: "change",
            onDoubleClick: "dblclick",
            onMouseDown: "mousedown",
          };

          const eventType = eventMap[attrName];
          if (eventType && attr.initializer) {
            let handlerName = "";
            if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
              const expr = attr.initializer.expression;
              if (ts.isIdentifier(expr)) {
                handlerName = expr.text;
              } else if (ts.isPropertyAccessExpression(expr)) {
                handlerName = expr.name.text;
              } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
                handlerName = extractInlineHandlerTarget(expr);
              } else if (ts.isCallExpression(expr)) {
                if (ts.isIdentifier(expr.expression)) {
                  handlerName = expr.expression.text;
                } else if (ts.isPropertyAccessExpression(expr.expression)) {
                  handlerName = expr.expression.name.text;
                }
              }
            }

            if (handlerName) {
              bindings.push({
                elementType,
                eventType,
                handlerName,
                lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return bindings;
}

function extractInlineHandlerTarget(node: ts.ArrowFunction | ts.FunctionExpression): string {
  let result = "";
  function visit(n: ts.Node) {
    if (result) return;
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        result = n.expression.text;
      } else if (ts.isPropertyAccessExpression(n.expression)) {
        result = n.expression.name.text;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node.body);
  return result || "__inline_handler__";
}

function classifyElement(tagName: string): string {
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

function normalizeUrl(url: string): string {
  return url
    .replace(/\$\{[^}]+\}/g, "{param}")
    .replace(/`/g, "")
    .replace(/\+\s*\w+/g, "")
    .replace(/\/+/g, "/")
    .trim();
}

function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function extractExternalDomain(url: string): string | null {
  const match = url.match(/^https?:\/\/([^\/]+)/i);
  return match ? match[1] : null;
}

function isServerSideFile(filePath: string): boolean {
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

function extractOperationNameFromUrl(url: string): string | null {
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

function normalizeClassName(className: string): string {
  return className
    .replace(/(?:WsV\d+|ServiceV\d+|Ws|Handler|Action|Command|Controller|Resource|Endpoint)$/i, "")
    .toLowerCase();
}

function operationNameMatchScore(operationName: string, className: string): number {
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

function matchUrlToEndpoint(
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

function normalizeSegment(seg: string): string {
  return seg.replace(/\.v\d+$/, "").replace(/\.(json|xml|html|csv|pdf)$/i, "");
}

function isParamSegment(seg: string): boolean {
  return seg === "{param}" || seg.startsWith("{") || seg.startsWith(":");
}

function endpointMatchScore(frontendUrl: string, backendPath: string): number {
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

function detectHandlerSecurityGuards(
  handlerName: string,
  symbolTable: ScriptSymbolTable,
  sourceFile: ts.SourceFile
): string[] {
  const guards: string[] = [];
  const handlerNode = symbolTable.resolveHandlerNode(handlerName);
  if (!handlerNode) return guards;

  const seen = new Set<string>();

  const ROLE_KEYWORDS = /\b(role|roles|permission|permissions|authority|authorities|access|privilege|admin|moderator|editor|viewer|manager|superadmin)\b/i;
  const ROLE_LITERALS = /['"`](ROLE_\w+|ADMIN|MODERATOR|EDITOR|VIEWER|MANAGER|SUPER_ADMIN|admin|moderator|editor|viewer|manager|user|guest|operator)['"`]/g;

  const walk = (node: ts.Node) => {
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      const condText = condition.getText(sourceFile);

      if (condText.match(/\.hasRole\s*\(/i) || condText.match(/\.hasAuthority\s*\(/i) || condText.match(/\.hasPermission\s*\(/i)) {
        const match = condText.match(/\.(hasRole|hasAuthority|hasPermission)\s*\(\s*['"`]([^'"` ]+)['"`]\s*\)/i);
        if (match) {
          const guard = `${match[1]}:${match[2]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }

      if (condText.match(/\.includes\s*\(/) && ROLE_KEYWORDS.test(condText)) {
        const roleMatches = Array.from(condText.matchAll(ROLE_LITERALS));
        for (const m of roleMatches) {
          const guard = `includes:${m[1]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }

      if (condText.match(/===?\s*['"`]/) && ROLE_KEYWORDS.test(condText)) {
        const roleMatches = Array.from(condText.matchAll(ROLE_LITERALS));
        for (const m of roleMatches) {
          const guard = `equals:${m[1]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }

      if (condText.match(/isAdmin|isAuthenticated|isLoggedIn|isAuthorized|canAccess|canEdit|canDelete|canCreate|hasAccess/i)) {
        const match = condText.match(/(isAdmin|isAuthenticated|isLoggedIn|isAuthorized|canAccess|canEdit|canDelete|canCreate|hasAccess)/i);
        if (match) {
          const guard = `check:${match[1]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callText = node.expression.getText(sourceFile);
      if (callText.match(/requireAuth|requireRole|checkPermission|guardRoute|authorize/i)) {
        const guard = `call:${callText}`;
        if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(handlerNode);
  return guards;
}

function resolveBindingsViaNodes(
  bindings: TemplateBinding[],
  symbolTable: ScriptSymbolTable,
  component: string,
  filePath: string,
  graph: ApplicationGraph,
  crossFileContext?: { sourceFile: ts.SourceFile; importBindings: Map<string, ImportBinding>; serviceMap: HttpServiceMap },
  globalCallGraph?: GlobalCallGraph,
  eventGraph?: ComponentEventGraph,
  allFiles?: { filePath: string; content: string }[],
  serviceMap?: HttpServiceMap,
  allFilePaths?: string[],
  stateFlowGraph?: StateFlowGraph,
  archLayerGraph?: ArchitecturalLayerGraph
): FrontendInteraction[] {
  const interactions: FrontendInteraction[] = [];

  let externalCalls: ExternalCall[] | null = null;
  if (crossFileContext) {
    const localNames = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) localNames.add(node.name.text);
      else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) localNames.add(node.name.text);
      else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
        if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) localNames.add(node.parent.name.text);
        else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) localNames.add(node.parent.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(crossFileContext.sourceFile);
    externalCalls = extractExternalCalls(crossFileContext.sourceFile, localNames);
  }

  const scriptSourceFile = crossFileContext?.sourceFile;

  for (const binding of bindings) {
    const resolvedCalls = resolveHandlerHttpCalls(
      binding.handlerName, symbolTable, filePath, graph,
      externalCalls, crossFileContext, globalCallGraph,
      eventGraph, allFiles, serviceMap, allFilePaths,
      stateFlowGraph, archLayerGraph
    );

    const handlerGuards = scriptSourceFile
      ? detectHandlerSecurityGuards(binding.handlerName, symbolTable, scriptSourceFile)
      : [];

    if (resolvedCalls.length > 0) {
      for (const call of resolvedCalls) {
        const resolution: ResolutionMetadata | null = (call as any).__resolution || null;
        const backendNode = matchUrlToEndpoint(call.method, call.url, graph);
        let resPath = resolution?.resolutionPath || null;
        if (backendNode && resPath) {
          resPath = [...resPath, { tier: "controller", file: backendNode.className, function: backendNode.methodName, detail: `matched ${call.method} ${call.url}` }];
        }
        interactions.push({
          component,
          elementType: binding.elementType,
          actionName: binding.handlerName,
          httpMethod: call.method,
          url: call.url,
          mappedBackendNode: backendNode,
          sourceFile: filePath,
          lineNumber: binding.lineNumber,
          resolutionTier: resolution?.tier || null,
          resolutionStrategy: resolution?.tier || null,
          resolutionPath: resPath,
          interactionCategory: "HTTP",
          confidence: tierToConfidence(resolution?.tier || null),
          routeGuards: handlerGuards.length > 0 ? handlerGuards : undefined,
          operationHint: call.operationHint || null,
        });
      }
    } else {
      interactions.push({
        component,
        elementType: binding.elementType,
        actionName: binding.handlerName,
        httpMethod: null,
        url: null,
        mappedBackendNode: null,
        sourceFile: filePath,
        lineNumber: binding.lineNumber,
        resolutionTier: null,
        resolutionStrategy: null,
        resolutionPath: null,
        interactionCategory: "UI_ONLY",
        confidence: 1.0,
        routeGuards: handlerGuards.length > 0 ? handlerGuards : undefined,
      });
    }
  }

  return interactions;
}

function tierToConfidence(tier: string | null): number {
  switch (tier) {
    case "local": return 1.0;
    case "serviceMap": return 0.95;
    case "globalCallGraph": return 0.85;
    case "eventGraph": return 0.80;
    case "eventGraph+serviceMap": return 0.75;
    case "eventGraph+globalCallGraph": return 0.70;
    case "stateFlowGraph": return 0.65;
    case "architecturalLayerGraph": return 0.55;
    default: return 0.5;
  }
}

function resolveHandlerHttpCalls(
  handlerName: string,
  symbolTable: ScriptSymbolTable,
  filePath: string,
  graph: ApplicationGraph,
  externalCalls: ExternalCall[] | null,
  crossFileContext?: { sourceFile: ts.SourceFile; importBindings: Map<string, ImportBinding>; serviceMap: HttpServiceMap },
  globalCallGraph?: GlobalCallGraph,
  eventGraph?: ComponentEventGraph,
  allFiles?: { filePath: string; content: string }[],
  serviceMap?: HttpServiceMap,
  allFilePaths?: string[],
  stateFlowGraph?: StateFlowGraph,
  archLayerGraph?: ArchitecturalLayerGraph
): HttpCall[] {
  function tagResolution(calls: HttpCall[], tier: string, path: ResolutionStep[]): HttpCall[] {
    for (const call of calls) {
      (call as any).__resolution = { tier, resolutionPath: path } as ResolutionMetadata;
    }
    return calls;
  }

  const handlerNode = symbolTable.resolveHandlerNode(handlerName);

  if (handlerNode) {
    const httpCalls = symbolTable.traceHttpCalls(handlerNode);
    if (httpCalls.length > 0) return tagResolution(httpCalls, "local", [
      { tier: "local", file: filePath, function: handlerName, detail: "direct HTTP call in handler" }
    ]);
  }

  if (externalCalls && crossFileContext) {
    const resolved = resolveExternalCallsToHttpCalls(
      externalCalls, crossFileContext.importBindings, crossFileContext.serviceMap, handlerName, symbolTable
    );
    if (resolved.length > 0) {
      const callerFn = resolved[0].callerFunction;
      return tagResolution(resolved, "serviceMap", [
        { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
        { tier: "serviceMap", file: filePath, function: callerFn, detail: "resolved via importBindings + HttpServiceMap" }
      ]);
    }
  }

  if (globalCallGraph) {
    const importBindings = crossFileContext?.importBindings;
    const graphCalls = lookupGlobalCallGraph(globalCallGraph, filePath, handlerName, importBindings);
    if (graphCalls.length > 0) return tagResolution(graphCalls, "globalCallGraph", [
      { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
      { tier: "globalCallGraph", file: filePath, function: handlerName, detail: "cross-file function call propagation" }
    ]);
  }

  if (eventGraph && allFiles && allFilePaths) {
    const parentMappings = lookupEventGraph(eventGraph, handlerName, filePath);
    for (const mapping of parentMappings) {
      const parentFile = allFiles.find(f => f.filePath === mapping.parentFilePath);
      if (!parentFile) continue;

      try {
        let parentScript = parentFile.content;
        if (parentFile.filePath.endsWith(".vue")) {
          parentScript = extractVueScript(parentFile.content);
        }
        if (!parentScript.trim()) continue;

        const scriptKind = parentFile.filePath.endsWith(".tsx") || parentFile.filePath.endsWith(".jsx")
          ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const parentSource = ts.createSourceFile(parentFile.filePath + ".event.ts", parentScript, ts.ScriptTarget.Latest, true, scriptKind);
        const parentSymbolTable = ScriptSymbolTable.build(parentSource);

        const parentHandlerNode = parentSymbolTable.resolveHandlerNode(mapping.parentHandler);
        if (parentHandlerNode) {
          const httpCalls = parentSymbolTable.traceHttpCalls(parentHandlerNode);
          if (httpCalls.length > 0) return tagResolution(httpCalls, "eventGraph", [
            { tier: "local", file: filePath, function: handlerName, detail: "child component handler" },
            { tier: "eventGraph", file: mapping.parentFilePath, function: mapping.parentHandler, detail: "event propagation from child component" },
            { tier: "local", file: mapping.parentFilePath, function: mapping.parentHandler, detail: "direct HTTP call in parent handler" }
          ]);
        }

        if (serviceMap) {
          const parentImportBindings = parseImportBindings(parentSource, mapping.parentFilePath, allFilePaths);
          const parentLocalNames = new Set<string>();
          const visitP = (node: ts.Node) => {
            if (ts.isFunctionDeclaration(node) && node.name) parentLocalNames.add(node.name.text);
            else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) parentLocalNames.add(node.name.text);
            else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
              if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) parentLocalNames.add(node.parent.name.text);
              else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) parentLocalNames.add(node.parent.name.text);
            }
            ts.forEachChild(node, visitP);
          };
          visitP(parentSource);
          const parentExternalCalls = extractExternalCalls(parentSource, parentLocalNames);
          const resolved = resolveExternalCallsToHttpCalls(
            parentExternalCalls, parentImportBindings, serviceMap, mapping.parentHandler, parentSymbolTable
          );
          if (resolved.length > 0) return tagResolution(resolved, "eventGraph+serviceMap", [
            { tier: "local", file: filePath, function: handlerName, detail: "child component handler" },
            { tier: "eventGraph", file: mapping.parentFilePath, function: mapping.parentHandler, detail: "event propagation from child component" },
            { tier: "serviceMap", file: mapping.parentFilePath, function: resolved[0].callerFunction, detail: "resolved via parent importBindings + HttpServiceMap" }
          ]);
        }

        if (globalCallGraph) {
          const parentImportBindings = parseImportBindings(parentSource, mapping.parentFilePath, allFilePaths);
          const graphCalls = lookupGlobalCallGraph(globalCallGraph, mapping.parentFilePath, mapping.parentHandler, parentImportBindings);
          if (graphCalls.length > 0) return tagResolution(graphCalls, "eventGraph+globalCallGraph", [
            { tier: "local", file: filePath, function: handlerName, detail: "child component handler" },
            { tier: "eventGraph", file: mapping.parentFilePath, function: mapping.parentHandler, detail: "event propagation from child component" },
            { tier: "globalCallGraph", file: mapping.parentFilePath, function: mapping.parentHandler, detail: "cross-file call propagation from parent" }
          ]);
        }
      } catch (err) {
        console.warn(`[event-graph] Failed to resolve parent handler ${mapping.parentHandler} in ${mapping.parentFilePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (stateFlowGraph) {
    const importBindings = crossFileContext?.importBindings;
    const stateCalls = lookupStateFlowGraph(stateFlowGraph, handlerName, filePath, symbolTable, globalCallGraph, importBindings);
    if (stateCalls.length > 0) return tagResolution(stateCalls, "stateFlowGraph", [
      { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
      { tier: "stateFlowGraph", file: filePath, function: handlerName, detail: "state write→read chain to HTTP-calling function" }
    ]);
  }

  if (archLayerGraph) {
    const importBindings = crossFileContext?.importBindings;
    const archCalls = lookupArchitecturalLayerGraph(archLayerGraph, filePath, handlerName, symbolTable, externalCalls, importBindings);
    if (archCalls.length > 0) return tagResolution(archCalls, "architecturalLayerGraph", [
      { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
      { tier: "architecturalLayerGraph", file: filePath, function: handlerName, detail: "symbol-first architectural traversal to repository HTTP calls" }
    ]);
  }

  return [];
}

function analyzeVueFile(
  filePath: string,
  content: string,
  graph: ApplicationGraph,
  serviceMap?: HttpServiceMap,
  allFilePaths?: string[],
  globalCallGraph?: GlobalCallGraph,
  eventGraph?: ComponentEventGraph,
  allFiles?: { filePath: string; content: string }[],
  stateFlowGraph?: StateFlowGraph,
  archLayerGraph?: ArchitecturalLayerGraph
): FrontendInteraction[] {
  const component = getComponentName(filePath);
  const { bindings: templateBindings, scriptContent } = parseVueTemplateAST(content);

  let symbolTable: ScriptSymbolTable | null = null;
  let allHttpCalls: HttpCall[] = [];
  let crossFileContext: { sourceFile: ts.SourceFile; importBindings: Map<string, ImportBinding>; serviceMap: HttpServiceMap } | undefined;

  if (scriptContent.trim()) {
    const scriptSource = parseTypeScript(scriptContent, filePath + ".script.ts");
    symbolTable = ScriptSymbolTable.build(scriptSource);
    allHttpCalls = [...symbolTable.getAllHttpCalls(), ...symbolTable.getTopLevelHttpCalls(scriptSource)];

    if (serviceMap && allFilePaths) {
      const importBindings = parseImportBindings(scriptSource, filePath, allFilePaths);
      crossFileContext = { sourceFile: scriptSource, importBindings, serviceMap };
    }
  }

  const interactions = symbolTable
    ? resolveBindingsViaNodes(templateBindings, symbolTable, component, filePath, graph, crossFileContext, globalCallGraph, eventGraph, allFiles, serviceMap, allFilePaths, stateFlowGraph, archLayerGraph)
    : templateBindings.map(b => ({
        component,
        elementType: b.elementType,
        actionName: b.handlerName,
        httpMethod: null as string | null,
        url: null as string | null,
        mappedBackendNode: null as GraphNode | null,
        sourceFile: filePath,
        lineNumber: b.lineNumber,
        resolutionTier: null as string | null,
        resolutionStrategy: null as string | null,
        resolutionPath: null as ResolutionStep[] | null,
        interactionCategory: "UI_ONLY" as const,
        confidence: 1.0,
      }));

  addUnmappedHttpCalls(interactions, allHttpCalls, component, filePath, graph);

  return interactions;
}

function analyzeReactFile(
  filePath: string,
  content: string,
  graph: ApplicationGraph,
  serviceMap?: HttpServiceMap,
  allFilePaths?: string[],
  globalCallGraph?: GlobalCallGraph,
  eventGraph?: ComponentEventGraph,
  allFiles?: { filePath: string; content: string }[],
  stateFlowGraph?: StateFlowGraph,
  archLayerGraph?: ArchitecturalLayerGraph
): FrontendInteraction[] {
  const component = getComponentName(filePath);
  const sourceFile = parseTypeScript(content, filePath);
  const symbolTable = ScriptSymbolTable.build(sourceFile);
  const jsxBindings = parseJSXTemplate(sourceFile);
  const allHttpCalls = [...symbolTable.getAllHttpCalls(), ...symbolTable.getTopLevelHttpCalls(sourceFile)];

  let crossFileContext: { sourceFile: ts.SourceFile; importBindings: Map<string, ImportBinding>; serviceMap: HttpServiceMap } | undefined;
  if (serviceMap && allFilePaths) {
    const importBindings = parseImportBindings(sourceFile, filePath, allFilePaths);
    crossFileContext = { sourceFile, importBindings, serviceMap };
  }

  const interactions = resolveBindingsViaNodes(
    jsxBindings, symbolTable, component, filePath, graph, crossFileContext, globalCallGraph, eventGraph, allFiles, serviceMap, allFilePaths, stateFlowGraph, archLayerGraph
  );

  addUnmappedHttpCalls(interactions, allHttpCalls, component, filePath, graph);

  return interactions;
}

function analyzeAngularFile(
  filePath: string,
  content: string,
  graph: ApplicationGraph,
  htmlTemplates: Map<string, string>,
  serviceMap?: HttpServiceMap,
  allFilePaths?: string[],
  globalCallGraph?: GlobalCallGraph,
  eventGraph?: ComponentEventGraph,
  allFiles?: { filePath: string; content: string }[],
  stateFlowGraph?: StateFlowGraph,
  archLayerGraph?: ArchitecturalLayerGraph
): FrontendInteraction[] {
  const component = getComponentName(filePath);
  const interactions: FrontendInteraction[] = [];

  if (filePath.endsWith(".html")) {
    const bindings = parseAngularTemplateAST(content);
    for (const binding of bindings) {
      interactions.push({
        component,
        elementType: binding.elementType,
        actionName: binding.handlerName,
        httpMethod: null,
        url: null,
        mappedBackendNode: null,
        sourceFile: filePath,
        lineNumber: binding.lineNumber,
        resolutionTier: null,
        resolutionStrategy: null,
        resolutionPath: null,
        interactionCategory: "UI_ONLY",
        confidence: 1.0,
      });
    }
    return interactions;
  }

  const sourceFile = parseTypeScript(content, filePath);
  const symbolTable = ScriptSymbolTable.build(sourceFile);
  const allHttpCalls = [...symbolTable.getAllHttpCalls(), ...symbolTable.getTopLevelHttpCalls(sourceFile)];

  let templateContent = "";

  const templateUrlNode = findDecoratorProperty(sourceFile, "templateUrl");
  if (templateUrlNode && ts.isStringLiteral(templateUrlNode)) {
    const templatePath = templateUrlNode.text;
    const resolvedPath = resolveTemplatePath(filePath, templatePath);
    templateContent = htmlTemplates.get(resolvedPath) || "";
  }

  if (!templateContent) {
    const templateNode = findDecoratorProperty(sourceFile, "template");
    if (templateNode) {
      if (ts.isNoSubstitutionTemplateLiteral(templateNode)) {
        templateContent = templateNode.text;
      } else if (ts.isStringLiteral(templateNode)) {
        templateContent = templateNode.text;
      } else if (ts.isTemplateExpression(templateNode)) {
        templateContent = templateNode.getText(sourceFile).replace(/^`|`$/g, "");
      }
    }
  }

  let crossFileContext: { sourceFile: ts.SourceFile; importBindings: Map<string, ImportBinding>; serviceMap: HttpServiceMap } | undefined;
  if (serviceMap && allFilePaths) {
    const importBindings = parseImportBindings(sourceFile, filePath, allFilePaths);
    crossFileContext = { sourceFile, importBindings, serviceMap };
  }

  if (templateContent) {
    const templateBindings = parseAngularTemplateAST(templateContent);
    const resolved = resolveBindingsViaNodes(
      templateBindings, symbolTable, component, filePath, graph, crossFileContext, globalCallGraph, eventGraph, allFiles, serviceMap, allFilePaths, stateFlowGraph, archLayerGraph
    );
    interactions.push(...resolved);
  }

  addUnmappedHttpCalls(interactions, allHttpCalls, component, filePath, graph);

  return interactions;
}

function findDecoratorProperty(sourceFile: ts.SourceFile, propertyName: string): ts.Expression | null {
  let result: ts.Expression | null = null;

  function visit(node: ts.Node) {
    if (result) return;

    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const decoratorName = node.expression.expression.getText(sourceFile);
      if (decoratorName === "Component") {
        for (const arg of node.expression.arguments) {
          if (ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === propertyName) {
                result = prop.initializer;
                return;
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function resolveTemplatePath(componentPath: string, templateUrl: string): string {
  const dir = componentPath.substring(0, componentPath.lastIndexOf("/"));
  if (templateUrl.startsWith("./")) {
    return dir + "/" + templateUrl.substring(2);
  }
  if (templateUrl.startsWith("../")) {
    const parentDir = dir.substring(0, dir.lastIndexOf("/"));
    return parentDir + "/" + templateUrl.substring(3);
  }
  return templateUrl;
}

function addUnmappedHttpCalls(
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

function detectFileType(filePath: string): "vue" | "react" | "angular" | "javascript" | "html" | null {
  if (filePath.endsWith(".vue")) return "vue";
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return "react";
  if (filePath.endsWith(".html") && !filePath.includes("index.html")) return "html";
  if (filePath.endsWith(".ts") || filePath.endsWith(".js")) {
    return "javascript";
  }
  return null;
}

function isAngularComponent(content: string): boolean {
  return content.includes("@Component") || content.includes("@NgModule") || content.includes("@Injectable");
}

interface RouteDefinition {
  path: string;
  component: string;
  guards: string[];
  meta?: Record<string, unknown>;
  children?: RouteDefinition[];
}

type RouteMap = Map<string, { route: string; guards: string[] }>;

function buildRouteMap(files: { filePath: string; content: string }[]): RouteMap {
  const routeMap: RouteMap = new Map();
  const allRoutes: RouteDefinition[] = [];

  for (const file of files) {
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx", ".vue"].includes(ext)) continue;
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) continue;

    const isRouterFile = file.filePath.toLowerCase().includes("router") ||
      file.filePath.toLowerCase().includes("routes") ||
      file.filePath.toLowerCase().includes("routing");
    const hasRouterImport = file.content.includes("createRouter") ||
      file.content.includes("vue-router") ||
      file.content.includes("react-router") ||
      file.content.includes("@angular/router") ||
      file.content.includes("createBrowserRouter") ||
      file.content.includes("RouterModule");

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
      allRoutes.push(...routes);
    } catch (err) {
      // skip unparseable files
    }
  }

  const flatten = (routes: RouteDefinition[], parentPath: string = "", parentGuards: string[] = []) => {
    for (const route of routes) {
      const fullPath = route.path.startsWith("/")
        ? route.path
        : parentPath.endsWith("/")
          ? parentPath + route.path
          : parentPath + "/" + route.path;
      const mergedGuards = [...parentGuards, ...route.guards];
      const componentName = route.component;

      if (componentName) {
        const normalizedName = componentName.replace(/\.(vue|tsx|jsx|ts|js)$/, "");
        const baseName = normalizedName.split("/").pop() || normalizedName;
        routeMap.set(baseName.toLowerCase(), { route: fullPath, guards: mergedGuards });
        routeMap.set(normalizedName.toLowerCase(), { route: fullPath, guards: mergedGuards });
      }

      if (route.children && route.children.length > 0) {
        flatten(route.children, fullPath, mergedGuards);
      }
    }
  };

  flatten(allRoutes);

  if (allRoutes.length > 0) {
    console.log(`[frontend-analyzer] Router extraction: ${allRoutes.length} routes found, ${routeMap.size} component mappings`);
  }

  return routeMap;
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
            if ((attrName === "element" || attrName === "component") && attr.initializer) {
              if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
                component = attr.initializer.expression.getText(sourceFile).replace(/<|\/>/g, "").trim();
              }
            }
          }
        }

        if (path) {
          routes.push({ path, component, guards: [], children: [] });
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
  const guards: string[] = [];
  const children: RouteDefinition[] = [];

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const name = prop.name.text;

    if (name === "path") {
      if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
        path = prop.initializer.text;
      }
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

  if (!path && !component) return null;
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
      const routeInfo = routeMap.get(componentName);
      if (routeInfo) {
        interaction.frontendRoute = routeInfo.route;
        const existingGuards = interaction.routeGuards || [];
        interaction.routeGuards = Array.from(new Set([...routeInfo.guards, ...existingGuards]));
        routeEnriched++;
      } else {
        const fileName = interaction.sourceFile
          .split("/").pop()
          ?.replace(/\.(vue|tsx|jsx|ts|js)$/, "")
          ?.toLowerCase();
        if (fileName) {
          const routeInfoByFile = routeMap.get(fileName);
          if (routeInfoByFile) {
            interaction.frontendRoute = routeInfoByFile.route;
            const existingGuards = interaction.routeGuards || [];
            interaction.routeGuards = Array.from(new Set([...routeInfoByFile.guards, ...existingGuards]));
            routeEnriched++;
          }
        }
      }
    }
    if (routeEnriched > 0) {
      console.log(`[frontend-analyzer] Route enrichment: ${routeEnriched}/${interactions.length} interactions mapped to routes`);
    }
  }

  const withUrls = interactions.filter(i => i.url);
  const withoutUrls = interactions.filter(i => !i.url);
  const matched = interactions.filter(i => i.mappedBackendNode);
  const bridges = interactions.filter(i => i.interactionCategory === "SERVICE_BRIDGE");
  const externals = interactions.filter(i => i.interactionCategory === "EXTERNAL_SERVICE");
  console.log(`[frontend-analyzer] Results: ${interactions.length} interactions, ${withUrls.length} with URLs (${withoutUrls.length} without), ${matched.length} matched to backend, ${bridges.length} service bridges, ${externals.length} external services`);

  return interactions;
}

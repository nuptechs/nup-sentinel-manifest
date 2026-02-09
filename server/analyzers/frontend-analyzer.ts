import * as ts from "typescript";
import * as vueSfc from "@vue/compiler-sfc";
import * as ngCompiler from "@angular/compiler";
import type { ApplicationGraph, GraphNode } from "./application-graph";

export interface FrontendInteraction {
  component: string;
  elementType: string;
  actionName: string;
  httpMethod: string | null;
  url: string | null;
  mappedBackendNode: GraphNode | null;
  sourceFile: string;
  lineNumber: number;
}

interface HttpCall {
  method: string;
  url: string;
  lineNumber: number;
  callerFunction: string | null;
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
            return {
              method: methodName.toUpperCase(),
              url,
              lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
              callerFunction: callerName,
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
          return {
            method,
            url,
            lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
            callerFunction: callerName,
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
            return {
              method: firstArg.text.toUpperCase(),
              url: possibleUrl,
              lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
              callerFunction: callerName,
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
    const extensions = [".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"];
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
    const extensions = ["", ".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"];
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
          return { method: methodName.toUpperCase(), url, lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)), callerFunction: callerName };
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
        return { method, url, lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)), callerFunction: callerName };
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
      result += "{param}" + span.literal.text;
    }
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

function matchUrlToEndpoint(
  httpMethod: string,
  url: string,
  graph: ApplicationGraph
): GraphNode | null {
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

function endpointMatchScore(frontendUrl: string, backendPath: string): number {
  const normFront = frontendUrl.replace(/\/+/g, "/").replace(/\/$/, "");
  const normBack = backendPath.replace(/\/+/g, "/").replace(/\/$/, "");

  if (normFront === normBack) return 100;

  const frontParts = normFront.split("/").filter(Boolean);
  const backParts = normBack.split("/").filter(Boolean);

  if (frontParts.length !== backParts.length) {
    if (normFront.includes(normBack) || normBack.includes(normFront)) return 60;
    return 0;
  }

  let matchCount = 0;
  for (let i = 0; i < frontParts.length; i++) {
    const fp = frontParts[i];
    const bp = backParts[i];
    if (fp === bp) {
      matchCount++;
    } else if (bp.startsWith("{") || fp === "{param}" || fp.startsWith(":")) {
      matchCount += 0.8;
    }
  }

  return (matchCount / frontParts.length) * 100;
}

function resolveBindingsViaNodes(
  bindings: TemplateBinding[],
  symbolTable: ScriptSymbolTable,
  component: string,
  filePath: string,
  graph: ApplicationGraph,
  crossFileContext?: { sourceFile: ts.SourceFile; importBindings: Map<string, ImportBinding>; serviceMap: HttpServiceMap },
  globalCallGraph?: GlobalCallGraph
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

  for (const binding of bindings) {
    const resolvedCalls = resolveHandlerHttpCalls(
      binding.handlerName, symbolTable, filePath, graph,
      externalCalls, crossFileContext, globalCallGraph
    );

    if (resolvedCalls.length > 0) {
      for (const call of resolvedCalls) {
        const backendNode = matchUrlToEndpoint(call.method, call.url, graph);
        interactions.push({
          component,
          elementType: binding.elementType,
          actionName: binding.handlerName,
          httpMethod: call.method,
          url: call.url,
          mappedBackendNode: backendNode,
          sourceFile: filePath,
          lineNumber: binding.lineNumber,
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
      });
    }
  }

  return interactions;
}

function resolveHandlerHttpCalls(
  handlerName: string,
  symbolTable: ScriptSymbolTable,
  filePath: string,
  graph: ApplicationGraph,
  externalCalls: ExternalCall[] | null,
  crossFileContext?: { sourceFile: ts.SourceFile; importBindings: Map<string, ImportBinding>; serviceMap: HttpServiceMap },
  globalCallGraph?: GlobalCallGraph
): HttpCall[] {
  const handlerNode = symbolTable.resolveHandlerNode(handlerName);

  if (handlerNode) {
    const httpCalls = symbolTable.traceHttpCalls(handlerNode);
    if (httpCalls.length > 0) return httpCalls;
  }

  if (externalCalls && crossFileContext) {
    const resolved = resolveExternalCallsToHttpCalls(
      externalCalls, crossFileContext.importBindings, crossFileContext.serviceMap, handlerName, symbolTable
    );
    if (resolved.length > 0) return resolved;
  }

  if (globalCallGraph) {
    const importBindings = crossFileContext?.importBindings;
    const graphCalls = lookupGlobalCallGraph(globalCallGraph, filePath, handlerName, importBindings);
    if (graphCalls.length > 0) return graphCalls;
  }

  return [];
}

function analyzeVueFile(
  filePath: string,
  content: string,
  graph: ApplicationGraph,
  serviceMap?: HttpServiceMap,
  allFilePaths?: string[],
  globalCallGraph?: GlobalCallGraph
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
    ? resolveBindingsViaNodes(templateBindings, symbolTable, component, filePath, graph, crossFileContext, globalCallGraph)
    : templateBindings.map(b => ({
        component,
        elementType: b.elementType,
        actionName: b.handlerName,
        httpMethod: null as string | null,
        url: null as string | null,
        mappedBackendNode: null as GraphNode | null,
        sourceFile: filePath,
        lineNumber: b.lineNumber,
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
  globalCallGraph?: GlobalCallGraph
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
    jsxBindings, symbolTable, component, filePath, graph, crossFileContext, globalCallGraph
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
  globalCallGraph?: GlobalCallGraph
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
      templateBindings, symbolTable, component, filePath, graph, crossFileContext, globalCallGraph
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
      interactions.push({
        component,
        elementType: "http_call",
        actionName: call.callerFunction || "anonymous",
        httpMethod: call.method,
        url: call.url,
        mappedBackendNode: backendNode,
        sourceFile: filePath,
        lineNumber: call.lineNumber,
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

export function analyzeFrontend(
  files: { filePath: string; content: string }[],
  graph: ApplicationGraph
): FrontendInteraction[] {
  const interactions: FrontendInteraction[] = [];
  const htmlTemplates = new Map<string, string>();

  const serviceMap = buildHttpServiceMap(files);
  const globalCallGraph = buildGlobalCallGraph(files, serviceMap);
  const allFilePaths = files.map(f => f.filePath);

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
          interactions.push(...analyzeVueFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph));
          break;

        case "react":
          interactions.push(...analyzeReactFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph));
          break;

        case "javascript":
          if (isAngularComponent(file.content)) {
            interactions.push(...analyzeAngularFile(file.filePath, file.content, graph, htmlTemplates, serviceMap, allFilePaths, globalCallGraph));
          } else {
            interactions.push(...analyzeReactFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph));
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
            });
          }
          break;
      }
    } catch (err) {
      console.error(`[frontend-analyzer] Error analyzing ${file.filePath}:`, err instanceof Error ? err.message : err);
    }
  }

  const withUrls = interactions.filter(i => i.url);
  const withoutUrls = interactions.filter(i => !i.url);
  const matched = interactions.filter(i => i.mappedBackendNode);
  console.log(`[frontend-analyzer] Results: ${interactions.length} interactions, ${withUrls.length} with URLs (${withoutUrls.length} without), ${matched.length} matched to backend`);

  return interactions;
}

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
    for (const id of this.httpIdentifiers) {
      if (lower === id.toLowerCase()) return true;
      if (lower.endsWith("." + id.toLowerCase())) return true;
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
  graph: ApplicationGraph
): FrontendInteraction[] {
  const interactions: FrontendInteraction[] = [];

  for (const binding of bindings) {
    const handlerNode = symbolTable.resolveHandlerNode(binding.handlerName);

    if (handlerNode) {
      const httpCalls = symbolTable.traceHttpCalls(handlerNode);
      if (httpCalls.length > 0) {
        for (const call of httpCalls) {
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

function analyzeVueFile(
  filePath: string,
  content: string,
  graph: ApplicationGraph
): FrontendInteraction[] {
  const component = getComponentName(filePath);
  const { bindings: templateBindings, scriptContent } = parseVueTemplateAST(content);

  let symbolTable: ScriptSymbolTable | null = null;
  let allHttpCalls: HttpCall[] = [];

  if (scriptContent.trim()) {
    const scriptSource = parseTypeScript(scriptContent, filePath + ".script.ts");
    symbolTable = ScriptSymbolTable.build(scriptSource);
    allHttpCalls = [...symbolTable.getAllHttpCalls(), ...symbolTable.getTopLevelHttpCalls(scriptSource)];
  }

  const interactions = symbolTable
    ? resolveBindingsViaNodes(templateBindings, symbolTable, component, filePath, graph)
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
  graph: ApplicationGraph
): FrontendInteraction[] {
  const component = getComponentName(filePath);
  const sourceFile = parseTypeScript(content, filePath);
  const symbolTable = ScriptSymbolTable.build(sourceFile);
  const jsxBindings = parseJSXTemplate(sourceFile);
  const allHttpCalls = [...symbolTable.getAllHttpCalls(), ...symbolTable.getTopLevelHttpCalls(sourceFile)];

  const interactions = resolveBindingsViaNodes(
    jsxBindings, symbolTable, component, filePath, graph
  );

  addUnmappedHttpCalls(interactions, allHttpCalls, component, filePath, graph);

  return interactions;
}

function analyzeAngularFile(
  filePath: string,
  content: string,
  graph: ApplicationGraph,
  htmlTemplates: Map<string, string>
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

  if (templateContent) {
    const templateBindings = parseAngularTemplateAST(templateContent);
    const resolved = resolveBindingsViaNodes(
      templateBindings, symbolTable, component, filePath, graph
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
          interactions.push(...analyzeVueFile(file.filePath, file.content, graph));
          break;

        case "react":
          interactions.push(...analyzeReactFile(file.filePath, file.content, graph));
          break;

        case "javascript":
          if (isAngularComponent(file.content)) {
            interactions.push(...analyzeAngularFile(file.filePath, file.content, graph, htmlTemplates));
          } else {
            interactions.push(...analyzeReactFile(file.filePath, file.content, graph));
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

  return interactions;
}

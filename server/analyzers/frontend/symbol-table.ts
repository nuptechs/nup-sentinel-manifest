import _ts from "typescript";
import type { SymbolDeclaration, DestructuredBinding, VariableOrigin, HttpCall } from "./types";
import { ImportedHttpClients } from "./http-clients";
import { getLineNumber } from "./parsers";
import { extractUrlFromNode, extractOperationHint } from "./utils";

import ts = _ts;

export class ScriptSymbolTable {
  private nodeMap = new Map<ts.Node, SymbolDeclaration>();
  private nameIndex = new Map<string, ts.Node>();
  private httpClients: ImportedHttpClients;
  private destructuredBindings = new Map<string, DestructuredBinding>();
  private variableOrigins = new Map<string, VariableOrigin>();
  private localHttpClients = new Set<string>();

  static build(sourceFile: ts.SourceFile): ScriptSymbolTable {
    const table = new ScriptSymbolTable();
    table.httpClients = ImportedHttpClients.build(sourceFile);
    table.indexDeclarations(sourceFile);
    table.indexDestructuredBindings(sourceFile);
    table.detectLocalHttpClients(sourceFile);
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

  private indexDestructuredBindings(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
        const callExpr = node.initializer.expression;
        let callName = "";
        if (ts.isIdentifier(callExpr)) {
          callName = callExpr.text;
        } else if (ts.isPropertyAccessExpression(callExpr)) {
          callName = callExpr.name.text;
        }

        if (!callName) { ts.forEachChild(node, visit); return; }

        const isHook = callName.startsWith("use") && callName.length > 3 && callName[3] === callName[3].toUpperCase();

        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              this.destructuredBindings.set(el.name.text, {
                name: el.name.text,
                sourceCallName: callName,
                sourceIsHook: isHook,
              });
            }
          }
        } else if (ts.isIdentifier(node.name) && isHook) {
          this.variableOrigins.set(node.name.text, {
            varName: node.name.text,
            sourceCallName: callName,
            sourceIsHook: true,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  getDestructuredBinding(name: string): DestructuredBinding | undefined {
    return this.destructuredBindings.get(name);
  }

  getVariableOrigin(name: string): VariableOrigin | undefined {
    return this.variableOrigins.get(name);
  }

  private detectLocalHttpClients(sourceFile: ts.SourceFile): void {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init: ts.Expression = node.initializer;
        if (ts.isAwaitExpression(init)) init = init.expression;

        if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression)) {
          const obj = init.expression.expression;
          const method = init.expression.name.text;
          if (method === "create" && ts.isIdentifier(obj) && this.httpClients.isHttpClient(obj.text)) {
            this.localHttpClients.add(node.name.text);
          }
        }

        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
          const fnName = init.expression.text.toLowerCase();
          if (fnName.includes("axios") || fnName.includes("http") || fnName.includes("api") || fnName.includes("client") || fnName.includes("request")) {
            this.localHttpClients.add(node.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
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
      if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
        walk(node.expression);
        return;
      }
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
      const methodName = expr.name.text;
      if (ts.isIdentifier(obj)) {
        const compoundKey = obj.text + "." + methodName;
        const compoundNode = this.nameIndex.get(compoundKey);
        if (compoundNode) return compoundNode;
      }
      const methodNode = this.nameIndex.get(methodName);
      if (methodNode) return methodNode;
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
          if (!isHttp) {
            isHttp = this.localHttpClients.has(calleeObj.text);
          }
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

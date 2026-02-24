import _ts from "typescript";
import ts = _ts;

import type {
  StateFieldWrite,
  StateFieldRead,
  StateFlowGraph,
  StateContainerType,
  DetectedStateContainer,
  HttpCall,
  HttpServiceMap,
  GlobalCallGraph,
  GlobalCallGraphNode,
  ImportBinding,
  SymbolDeclaration,
} from "./types";
import { parseTypeScript, getLineNumber, extractVueScript } from "./parsers";

interface SymbolTableLike {
  resolveHandlerNode(handlerName: string): ts.Node | null;
  getDeclaration(node: ts.Node): SymbolDeclaration | undefined;
}

function getComponentName(filePath: string): string {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  const name = fileName.replace(/\.(vue|jsx|tsx|ts|js|html)$/, "");
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]/g, " ");
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

export function buildStateFlowGraph(
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

export function lookupStateFlowGraph(
  stateFlowGraph: StateFlowGraph,
  handlerName: string,
  filePath: string,
  symbolTable: SymbolTableLike,
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

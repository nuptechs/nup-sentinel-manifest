import _ts from "typescript";
import * as vueSfc from "@vue/compiler-sfc";
import type { HttpCall, GlobalCallGraphNode, GlobalCallGraph, HttpServiceMap, ImportBinding, DestructuredBinding, VariableOrigin, HookBinding } from "./types";
import { parseTypeScript, getLineNumber } from "./parsers";
import { ImportedHttpClients } from "./http-clients";
import { normalizeModulePath } from "./http-service-map";
import { extractHttpCallFromExpression, buildLocalVarMap } from "../frontend-analyzer";

import ts = _ts;

export function makeGlobalKey(filePath: string, fnName: string): string {
  return filePath + "::" + fnName;
}

export function buildGlobalCallGraph(files: { filePath: string; content: string }[], serviceMap: HttpServiceMap): GlobalCallGraph {
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

      const detectReactQueryHooks = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
          const callExpr = node.initializer.expression;
          let hookName = "";
          if (ts.isIdentifier(callExpr)) hookName = callExpr.text;
          
          if (hookName === "useMutation" || hookName === "useQuery") {
            const destructuredNames: string[] = [];
            if (ts.isObjectBindingPattern(node.name)) {
              for (const el of node.name.elements) {
                if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                  destructuredNames.push(el.name.text);
                }
              }
            } else if (ts.isIdentifier(node.name)) {
              destructuredNames.push(node.name.text);
            }

            const hookHttpCalls: HttpCall[] = [];

            if (hookName === "useQuery" && node.initializer.arguments.length > 0) {
              const arg = node.initializer.arguments[0];
              if (ts.isObjectLiteralExpression(arg)) {
                for (const prop of arg.properties) {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "queryKey") {
                    if (ts.isArrayLiteralExpression(prop.initializer) && prop.initializer.elements.length > 0) {
                      const firstEl = prop.initializer.elements[0];
                      if (ts.isStringLiteral(firstEl)) {
                        const url = firstEl.text;
                        if (url.startsWith("/") || url.startsWith("http")) {
                          hookHttpCalls.push({
                            method: "GET", url,
                            lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
                            callerFunction: hookName, operationHint: null
                          });
                        }
                      }
                    } else if (ts.isArrayLiteralExpression(prop.initializer) && prop.initializer.elements.length > 1) {
                      for (const el of prop.initializer.elements) {
                        if (ts.isStringLiteral(el) && (el.text.startsWith("/api") || el.text.startsWith("http"))) {
                          hookHttpCalls.push({
                            method: "GET", url: el.text,
                            lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
                            callerFunction: hookName, operationHint: null
                          });
                          break;
                        }
                      }
                    }
                  }
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "queryFn") {
                    if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) {
                      const visitQfn = (n: ts.Node) => {
                        if (ts.isCallExpression(n)) {
                          const hc = extractHttpCallFromExpression(n, sourceFile, httpClients, hookName, undefined);
                          if (hc) hookHttpCalls.push(hc);
                        }
                        ts.forEachChild(n, visitQfn);
                      };
                      visitQfn(prop.initializer.body);
                    }
                  }
                }
              }
            }

            if (hookName === "useMutation" && node.initializer.arguments.length > 0) {
              const arg = node.initializer.arguments[0];
              if (ts.isObjectLiteralExpression(arg)) {
                for (const prop of arg.properties) {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "mutationFn") {
                    if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) {
                      const visitMfn = (n: ts.Node) => {
                        if (ts.isCallExpression(n)) {
                          const hc = extractHttpCallFromExpression(n, sourceFile, httpClients, hookName, undefined);
                          if (hc) hookHttpCalls.push(hc);
                          if (!hc) {
                            if (ts.isIdentifier(n.expression)) {
                              const calledName = n.expression.text;
                              if (localFunctions.has(calledName)) {
                                const calleeKey = makeGlobalKey(file.filePath, calledName);
                                for (const dName of destructuredNames) {
                                  const dKey = makeGlobalKey(file.filePath, dName);
                                  if (!graph.has(dKey)) {
                                    graph.set(dKey, { key: dKey, filePath: file.filePath, functionName: dName, httpCalls: [], callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
                                  }
                                  graph.get(dKey)!.callees.add(calleeKey);
                                }
                              } else if (importBindings.has(calledName)) {
                                const binding = importBindings.get(calledName)!;
                                const targetName = binding.isDefault ? "default" : binding.originalName;
                                const calleeKey = makeGlobalKey(binding.sourcePath, targetName);
                                for (const dName of destructuredNames) {
                                  const dKey = makeGlobalKey(file.filePath, dName);
                                  if (!graph.has(dKey)) {
                                    graph.set(dKey, { key: dKey, filePath: file.filePath, functionName: dName, httpCalls: [], callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
                                  }
                                  graph.get(dKey)!.callees.add(calleeKey);
                                }
                              }
                            } else if (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
                              const objName = n.expression.expression.text;
                              const methodName = n.expression.name.text;
                              if (importBindings.has(objName)) {
                                const binding = importBindings.get(objName)!;
                                for (const dName of destructuredNames) {
                                  const dKey = makeGlobalKey(file.filePath, dName);
                                  if (!graph.has(dKey)) {
                                    graph.set(dKey, { key: dKey, filePath: file.filePath, functionName: dName, httpCalls: [], callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
                                  }
                                  graph.get(dKey)!.callees.add(makeGlobalKey(binding.sourcePath, methodName));
                                  graph.get(dKey)!.callees.add(makeGlobalKey(binding.sourcePath, binding.originalName + "." + methodName));
                                }
                              }
                            }
                          }
                        }
                        ts.forEachChild(n, visitMfn);
                      };
                      visitMfn(prop.initializer.body);
                    }
                  }
                }
              }
              if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
                const visitMfn = (n: ts.Node) => {
                  if (ts.isCallExpression(n)) {
                    const hc = extractHttpCallFromExpression(n, sourceFile, httpClients, hookName, undefined);
                    if (hc) hookHttpCalls.push(hc);
                  }
                  ts.forEachChild(n, visitMfn);
                };
                visitMfn(arg.body);
              }
            }

            if (hookHttpCalls.length > 0) {
              for (const dName of destructuredNames) {
                const dKey = makeGlobalKey(file.filePath, dName);
                if (!graph.has(dKey)) {
                  graph.set(dKey, { key: dKey, filePath: file.filePath, functionName: dName, httpCalls: hookHttpCalls, callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
                } else {
                  const existing = graph.get(dKey)!;
                  if (existing.httpCalls.length === 0) existing.httpCalls = hookHttpCalls;
                }
              }
              const mutateNames = ["mutate", "mutateAsync"];
              for (const mn of mutateNames) {
                if (!destructuredNames.includes(mn)) {
                  const mnKey = makeGlobalKey(file.filePath, mn);
                  if (!graph.has(mnKey)) {
                    graph.set(mnKey, { key: mnKey, filePath: file.filePath, functionName: mn, httpCalls: hookHttpCalls, callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
                  }
                }
              }
            }
          }
        }
        ts.forEachChild(node, detectReactQueryHooks);
      };
      detectReactQueryHooks(sourceFile);

      const hookResultVars = new Map<string, string>();

      const detectCustomHookReturns = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
          const callExpr = node.initializer.expression;
          let hookName = "";
          let hookSourcePath = "";
          if (ts.isIdentifier(callExpr)) {
            hookName = callExpr.text;
          }

          const isReactBuiltIn = !hookName || !hookName.startsWith("use") || hookName === "useMutation" || hookName === "useQuery" || hookName === "useState" || hookName === "useEffect" || hookName === "useRef" || hookName === "useCallback" || hookName === "useMemo" || hookName === "useContext" || hookName === "useReducer" || hookName === "useNavigate" || hookName === "useLocation" || hookName === "useParams" || hookName === "useSearchParams";

          if (isReactBuiltIn) {
            ts.forEachChild(node, detectCustomHookReturns);
            return;
          }

          if (importBindings.has(hookName)) {
            hookSourcePath = importBindings.get(hookName)!.sourcePath;
          } else if (localFunctions.has(hookName)) {
            hookSourcePath = file.filePath;
          }
          if (!hookSourcePath) {
            ts.forEachChild(node, detectCustomHookReturns);
            return;
          }

          if (ts.isObjectBindingPattern(node.name)) {
            const destructuredNames: string[] = [];
            for (const el of node.name.elements) {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                destructuredNames.push(el.name.text);
              }
            }

            for (const dName of destructuredNames) {
              const localKey = makeGlobalKey(file.filePath, dName);
              const hookKey = makeGlobalKey(hookSourcePath, dName);
              if (!graph.has(localKey)) {
                graph.set(localKey, { key: localKey, filePath: file.filePath, functionName: dName, httpCalls: [], callees: new Set(), callers: new Set(), propagatedHttpCalls: null });
              }
              graph.get(localKey)!.callees.add(hookKey);
            }
          } else if (ts.isIdentifier(node.name)) {
            hookResultVars.set(node.name.text, hookSourcePath);
          }
        }
        ts.forEachChild(node, detectCustomHookReturns);
      };
      detectCustomHookReturns(sourceFile);

      // Track variables assigned from imported function/constructor calls
      const functionResultVars = new Map<string, string>(); // varName -> sourcePath
      const detectFunctionResults = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          let init = node.initializer;
          if (ts.isAwaitExpression(init)) init = init.expression;
          if (ts.isCallExpression(init)) {
            const callExpr = init.expression;
            if (ts.isIdentifier(callExpr) && importBindings.has(callExpr.text)) {
              const binding = importBindings.get(callExpr.text)!;
              functionResultVars.set(node.name.text, binding.sourcePath);
            }
          }
          if (ts.isNewExpression(init)) {
            const ctorExpr = init.expression;
            if (ts.isIdentifier(ctorExpr) && importBindings.has(ctorExpr.text)) {
              const binding = importBindings.get(ctorExpr.text)!;
              functionResultVars.set(node.name.text, binding.sourcePath);
            }
          }
        }
        ts.forEachChild(node, detectFunctionResults);
      };
      detectFunctionResults(sourceFile);

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
                } else {
                  const sameFileKey = makeGlobalKey(file.filePath, calledName);
                  if (graph.has(sameFileKey)) {
                    gNode.callees.add(sameFileKey);
                  }
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
                  if (hookResultVars.has(objName)) {
                    const hookSrcPath = hookResultVars.get(objName)!;
                    gNode.callees.add(makeGlobalKey(hookSrcPath, methodName));
                    gNode.callees.add(makeGlobalKey(hookSrcPath, "default." + methodName));
                  }
                  if (functionResultVars.has(objName)) {
                    const srcPath = functionResultVars.get(objName)!;
                    gNode.callees.add(makeGlobalKey(srcPath, methodName));
                    gNode.callees.add(makeGlobalKey(srcPath, "default." + methodName));
                  }
                }
              }

              // Handle optional chaining: obj?.method()
              if (ts.isPropertyAccessExpression(callExpr) && (n as any).questionDotToken !== undefined) {
                const methodName = callExpr.name.text;
                const obj = callExpr.expression;
                if (ts.isIdentifier(obj)) {
                  const objName = obj.text;
                  if (importBindings.has(objName)) {
                    const binding = importBindings.get(objName)!;
                    if (binding.originalName === "*") {
                      gNode.callees.add(makeGlobalKey(binding.sourcePath, methodName));
                      gNode.callees.add(makeGlobalKey(binding.sourcePath, "default." + methodName));
                    } else {
                      gNode.callees.add(makeGlobalKey(binding.sourcePath, binding.originalName + "." + methodName));
                      gNode.callees.add(makeGlobalKey(binding.sourcePath, "default." + methodName));
                      gNode.callees.add(makeGlobalKey(binding.sourcePath, methodName));
                    }
                  }
                  if (hookResultVars.has(objName)) {
                    const hookSrcPath = hookResultVars.get(objName)!;
                    gNode.callees.add(makeGlobalKey(hookSrcPath, methodName));
                    gNode.callees.add(makeGlobalKey(hookSrcPath, "default." + methodName));
                  }
                  if (functionResultVars.has(objName)) {
                    const srcPath = functionResultVars.get(objName)!;
                    gNode.callees.add(makeGlobalKey(srcPath, methodName));
                    gNode.callees.add(makeGlobalKey(srcPath, "default." + methodName));
                  }
                }
              }

              // Also track calls inside arrow function arguments
              for (const arg of n.arguments) {
                if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
                  const walkCallbackCalls = (cbNode: ts.Node) => {
                    if (ts.isCallExpression(cbNode)) {
                      const cbCallExpr = cbNode.expression;
                      if (ts.isIdentifier(cbCallExpr)) {
                        const calledName = cbCallExpr.text;
                        if (localFunctions.has(calledName)) {
                          gNode.callees.add(makeGlobalKey(file.filePath, calledName));
                        } else if (importBindings.has(calledName)) {
                          const binding = importBindings.get(calledName)!;
                          const targetName = binding.isDefault ? "default" : binding.originalName;
                          gNode.callees.add(makeGlobalKey(binding.sourcePath, targetName));
                        }
                      }
                      if (ts.isPropertyAccessExpression(cbCallExpr) && ts.isIdentifier(cbCallExpr.expression)) {
                        const objName = cbCallExpr.expression.text;
                        const methodName = cbCallExpr.name.text;
                        if (importBindings.has(objName)) {
                          const binding = importBindings.get(objName)!;
                          gNode.callees.add(makeGlobalKey(binding.sourcePath, methodName));
                          gNode.callees.add(makeGlobalKey(binding.sourcePath, binding.originalName + "." + methodName));
                          gNode.callees.add(makeGlobalKey(binding.sourcePath, "default." + methodName));
                        }
                        if (hookResultVars.has(objName)) {
                          const hookSrcPath = hookResultVars.get(objName)!;
                          gNode.callees.add(makeGlobalKey(hookSrcPath, methodName));
                          gNode.callees.add(makeGlobalKey(hookSrcPath, "default." + methodName));
                        }
                      }
                    }
                    ts.forEachChild(cbNode, walkCallbackCalls);
                  };
                  walkCallbackCalls(arg.body);
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

export function getFnBody(node: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.body || null;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.body;
  return null;
}

export function parseImportBindingsInternal(sourceFile: ts.SourceFile, importerPath: string, allFilePaths: string[]): Map<string, ImportBinding> {
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

export function propagateHttpCapability(graph: GlobalCallGraph): void {
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

export function lookupGlobalCallGraph(
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

  if (node && !node.propagatedHttpCalls && !node.httpCalls.length && node.callees.size > 0) {
    const visited = new Set<string>();
    const queue = Array.from(node.callees);
    let depth = 0;
    while (queue.length > 0 && depth < 5) {
      const batch = [...queue];
      queue.length = 0;
      for (const k of batch) {
        if (visited.has(k)) continue;
        visited.add(k);
        const callee = globalGraph.get(k);
        if (!callee) continue;
        if (callee.propagatedHttpCalls?.length) return callee.propagatedHttpCalls;
        if (callee.httpCalls.length) return callee.httpCalls;
        for (const ck of Array.from(callee.callees)) queue.push(ck);
      }
      depth++;
    }
  }

  if (importBindings) {
    const binding = importBindings.get(handlerName);
    if (binding) {
      const altKeys = [
        makeGlobalKey(binding.sourcePath, handlerName),
        makeGlobalKey(binding.sourcePath, "default"),
      ];
      for (const altKey of altKeys) {
        const altNode = globalGraph.get(altKey);
        if (altNode) {
          if (altNode.propagatedHttpCalls?.length) return altNode.propagatedHttpCalls;
          if (altNode.httpCalls.length > 0) return altNode.httpCalls;
        }
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

  if (importBindings) {
    for (const [importName, binding] of Array.from(importBindings.entries())) {
      if (importName === handlerName) continue;
      const srcNode = globalGraph.get(makeGlobalKey(binding.sourcePath, handlerName));
      if (srcNode) {
        if (srcNode.propagatedHttpCalls?.length) return srcNode.propagatedHttpCalls;
        if (srcNode.httpCalls.length > 0) return srcNode.httpCalls;
      }
    }
  }

  return [];
}

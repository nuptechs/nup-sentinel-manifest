import _ts from "typescript";
import type { ApplicationGraph, GraphNode } from "../application-graph";
import type {
  FrontendInteraction,
  HttpCall,
  HttpServiceMap,
  GlobalCallGraph,
  ImportBinding,
  TemplateBinding,
  ResolutionStep,
  ResolutionMetadata,
  StateFlowGraph,
  ArchitecturalLayerGraph,
  ComponentEventGraph,
  ExternalCall,
  HookBinding,
  DynamicImportBinding,
} from "./types";
import { extractVueScript, parseTypeScript } from "./parsers";
import { ScriptSymbolTable } from "./symbol-table";
import { makeGlobalKey, lookupGlobalCallGraph } from "./global-call-graph";
import { lookupEventGraph } from "./event-graph";
import { lookupStateFlowGraph } from "./state-flow-graph";
import { lookupArchitecturalLayerGraph } from "./architectural-layer-graph";
import { detectHandlerSecurityGuards } from "./auth-detection";
import {
  matchUrlToEndpoint,
  extractExternalCalls,
  resolveExternalCallsToHttpCalls,
  parseImportBindings,
  normalizeModulePath,
} from "./utils";

import ts = _ts;

export function resolveBindingsViaNodes(
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
      stateFlowGraph, archLayerGraph, binding.objectName
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

export function tierToConfidence(tier: string | null): number {
  switch (tier) {
    case "local": return 1.0;
    case "serviceMap": return 0.95;
    case "objectMethodImport": return 0.93;
    case "hookMethodBridge": return 0.90;
    case "destructuredBinding": return 0.88;
    case "destructuredHookBridge": return 0.87;
    case "contextHook": return 0.90;
    case "dynamicImport": return 0.88;
    case "globalCallGraph": return 0.85;
    case "serviceMapBroadSearch": return 0.82;
    case "eventGraph": return 0.80;
    case "eventGraph+serviceMap": return 0.75;
    case "eventGraph+globalCallGraph": return 0.70;
    case "dispatchAction": return 0.82;
    case "crossFileNameMatch": return 0.50;
    case "stateFlowGraph": return 0.65;
    case "architecturalLayerGraph": return 0.55;
    case "fuzzyGlobalMatch": return 0.45;
    default: return 0.5;
  }
}

export function resolveHandlerHttpCalls(
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
  archLayerGraph?: ArchitecturalLayerGraph,
  objectName?: string
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

  if (objectName && crossFileContext && crossFileContext.importBindings) {
    const importBindings = crossFileContext.importBindings;
    const binding = importBindings.get(objectName);
    if (binding) {
      const fileEntry = crossFileContext.serviceMap.get(binding.sourcePath);
      if (fileEntry) {
        const lookupKeys = [
          binding.originalName + "." + handlerName,
          "default." + handlerName,
          objectName + "." + handlerName,
          handlerName,
        ];
        for (const key of lookupKeys) {
          const methodEntry = fileEntry.methods.get(key);
          if (methodEntry && methodEntry.httpCalls.length > 0) {
            return tagResolution(methodEntry.httpCalls, "objectMethodImport", [
              { tier: "local", file: filePath, function: objectName + "." + handlerName, detail: "method call on imported object" },
              { tier: "objectMethodImport", file: binding.sourcePath, function: key, detail: "resolved via import binding + method lookup" }
            ]);
          }
          const funcCalls = fileEntry.directFunctions.get(key);
          if (funcCalls && funcCalls.length > 0) {
            return tagResolution(funcCalls, "objectMethodImport", [
              { tier: "local", file: filePath, function: objectName + "." + handlerName, detail: "function call on imported object" },
              { tier: "objectMethodImport", file: binding.sourcePath, function: key, detail: "resolved via import binding + function lookup" }
            ]);
          }
        }
      }
    }

    const varOrigin = symbolTable.getVariableOrigin(objectName);
    if (varOrigin && globalCallGraph) {
      const hookBinding = importBindings?.get(varOrigin.sourceCallName);
      const hookSourcePath = hookBinding ? hookBinding.sourcePath : filePath;
      const lookupKeys = [
        makeGlobalKey(hookSourcePath, handlerName),
        makeGlobalKey(hookSourcePath, "default." + handlerName),
        makeGlobalKey(filePath, objectName + "." + handlerName),
      ];
      for (const lk of lookupKeys) {
        const gNode = globalCallGraph.get(lk);
        if (gNode) {
          const calls = gNode.propagatedHttpCalls || (gNode.httpCalls.length > 0 ? gNode.httpCalls : null);
          if (calls && calls.length > 0) {
            return tagResolution(calls, "hookMethodBridge", [
              { tier: "local", file: filePath, function: objectName + "." + handlerName, detail: "method call on hook-returned object" },
              { tier: "hookMethodBridge", file: hookSourcePath, function: handlerName, detail: `resolved via hook ${varOrigin.sourceCallName} return value` }
            ]);
          }
        }
      }
    }
  }

  {
    const destructured = symbolTable.getDestructuredBinding(handlerName);
    if (destructured && globalCallGraph) {
      const gcgKey = makeGlobalKey(filePath, handlerName);
      const gNode = globalCallGraph.get(gcgKey);
      if (gNode) {
        const calls = gNode.propagatedHttpCalls || (gNode.httpCalls.length > 0 ? gNode.httpCalls : null);
        if (calls && calls.length > 0) {
          return tagResolution(calls, "destructuredBinding", [
            { tier: "local", file: filePath, function: handlerName, detail: `destructured from ${destructured.sourceCallName}()` },
            { tier: "destructuredBinding", file: filePath, function: handlerName, detail: "resolved via GCG node for destructured binding" }
          ]);
        }
      }

      if (destructured.sourceIsHook && crossFileContext && crossFileContext.importBindings) {
        const hookBinding = crossFileContext.importBindings.get(destructured.sourceCallName);
        if (hookBinding) {
          const hookKey = makeGlobalKey(hookBinding.sourcePath, handlerName);
          const hookNode = globalCallGraph.get(hookKey);
          if (hookNode) {
            const calls = hookNode.propagatedHttpCalls || (hookNode.httpCalls.length > 0 ? hookNode.httpCalls : null);
            if (calls && calls.length > 0) {
              return tagResolution(calls, "destructuredHookBridge", [
                { tier: "local", file: filePath, function: handlerName, detail: `destructured from ${destructured.sourceCallName}()` },
                { tier: "destructuredHookBridge", file: hookBinding.sourcePath, function: handlerName, detail: `resolved in hook source file` }
              ]);
            }
          }
        }
      }
    }
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

  if (globalCallGraph) {
    const FUZZY_COMMON_NAMES = new Set(["load", "submit", "save", "delete", "update", "create", "get", "set", "fetch", "handle", "init", "reset", "close", "open", "toggle", "render", "refresh", "send", "remove", "add", "change", "click", "press"]);
    const handlerNodeFuzzy = symbolTable.resolveHandlerNode(handlerName);
    if (handlerNodeFuzzy) {
      const declFuzzy = symbolTable.getDeclaration(handlerNodeFuzzy);
      if (declFuzzy) {
        const visitedFuzzy = new Set<ts.Node>();
        const fuzzyQueue = [...declFuzzy.calledNodes];
        let fuzzyDepth = 0;
        while (fuzzyQueue.length > 0 && fuzzyDepth < 3) {
          const batch = [...fuzzyQueue];
          fuzzyQueue.length = 0;
          for (const calledNode of batch) {
            if (visitedFuzzy.has(calledNode)) continue;
            visitedFuzzy.add(calledNode);
            const calledDecl = symbolTable.getDeclaration(calledNode);
            if (calledDecl) {
              if (calledDecl.name.length >= 5 && !FUZZY_COMMON_NAMES.has(calledDecl.name.toLowerCase())) {
                const candidates: { gNode: any; calls: any[] }[] = [];
                for (const [, gNode] of Array.from(globalCallGraph)) {
                  if (gNode.functionName === calledDecl.name || gNode.functionName.endsWith("." + calledDecl.name)) {
                    const calls = gNode.propagatedHttpCalls || (gNode.httpCalls.length > 0 ? gNode.httpCalls : null);
                    if (calls && calls.length > 0) {
                      candidates.push({ gNode, calls });
                    }
                  }
                }
                if (candidates.length === 1) {
                  const { gNode, calls } = candidates[0];
                  return tagResolution(calls, "fuzzyGlobalMatch", [
                    { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" + (fuzzyDepth > 0 ? ` (depth ${fuzzyDepth + 1})` : "") },
                    { tier: "fuzzyGlobalMatch", file: gNode.filePath, function: gNode.functionName, detail: "unique function name match across project" }
                  ]);
                }
              }
              for (const nextNode of calledDecl.calledNodes) {
                fuzzyQueue.push(nextNode);
              }
            }
          }
          fuzzyDepth++;
        }
      }
    }
  }

  if (globalCallGraph && crossFileContext) {
    const handlerNodeDispatch = symbolTable.resolveHandlerNode(handlerName);
    if (handlerNodeDispatch) {
      const dispatchCalls = extractDispatchedActions(handlerNodeDispatch, crossFileContext.sourceFile, crossFileContext.importBindings);
      for (const actionName of dispatchCalls) {
        const binding = crossFileContext.importBindings.get(actionName);
        if (binding) {
          const actionKey = makeGlobalKey(binding.sourcePath, binding.isDefault ? "default" : binding.originalName);
          const actionNode = globalCallGraph.get(actionKey);
          if (actionNode) {
            const calls = actionNode.propagatedHttpCalls || (actionNode.httpCalls.length > 0 ? actionNode.httpCalls : null);
            if (calls && calls.length > 0) {
              return tagResolution(calls, "dispatchAction", [
                { tier: "local", file: filePath, function: handlerName, detail: "handler dispatches action" },
                { tier: "dispatchAction", file: binding.sourcePath, function: actionName, detail: "action creator contains HTTP call" }
              ]);
            }
          }
        }
        const directKey = makeGlobalKey(filePath, actionName);
        const directNode = globalCallGraph.get(directKey);
        if (directNode) {
          const calls = directNode.propagatedHttpCalls || (directNode.httpCalls.length > 0 ? directNode.httpCalls : null);
          if (calls && calls.length > 0) {
            return tagResolution(calls, "dispatchAction", [
              { tier: "local", file: filePath, function: handlerName, detail: "handler dispatches action" },
              { tier: "dispatchAction", file: filePath, function: actionName, detail: "local action function contains HTTP call" }
            ]);
          }
        }
      }
    }
  }

  if (archLayerGraph) {
    const importBindings = crossFileContext?.importBindings;
    const archCalls = lookupArchitecturalLayerGraph(archLayerGraph, filePath, handlerName, symbolTable, externalCalls, importBindings);
    if (archCalls.length > 0) return tagResolution(archCalls, "architecturalLayerGraph", [
      { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
      { tier: "architecturalLayerGraph", file: filePath, function: handlerName, detail: "symbol-first architectural traversal to repository HTTP calls" }
    ]);
  }

  if (crossFileContext && serviceMap && allFiles && allFilePaths) {
    const hookCalls = resolveViaContextHooks(
      handlerName, symbolTable, crossFileContext.sourceFile, crossFileContext.importBindings,
      serviceMap, allFiles, allFilePaths, filePath
    );
    if (hookCalls.length > 0) return tagResolution(hookCalls, "contextHook", [
      { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
      { tier: "contextHook", file: filePath, function: handlerName, detail: "resolved via React context hook provider" }
    ]);
  }

  if (crossFileContext && serviceMap && allFiles && allFilePaths) {
    const dynCalls = resolveViaDynamicImport(
      handlerName, symbolTable, crossFileContext.sourceFile,
      serviceMap, allFiles, allFilePaths, filePath
    );
    if (dynCalls.length > 0) return tagResolution(dynCalls, "dynamicImport", [
      { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
      { tier: "dynamicImport", file: filePath, function: handlerName, detail: "resolved via dynamic import()" }
    ]);
  }

  if (serviceMap) {
    const handlerNode2 = symbolTable.resolveHandlerNode(handlerName);
    if (handlerNode2) {
      const decl = symbolTable.getDeclaration(handlerNode2);
      if (decl) {
        const visited = new Set<ts.Node>();
        const queue = [...decl.calledNodes];
        let depth = 0;
        while (queue.length > 0 && depth < 3) {
          const batch = [...queue];
          queue.length = 0;
          for (const calledNode of batch) {
            if (visited.has(calledNode)) continue;
            visited.add(calledNode);
            const calledDecl = symbolTable.getDeclaration(calledNode);
            if (calledDecl) {
              const calledName = calledDecl.name;
              for (const [smPath, smEntry] of Array.from(serviceMap)) {
                if (smPath === filePath) continue;
                const methodEntry = smEntry.methods.get(calledName) || smEntry.methods.get("default." + calledName);
                if (methodEntry && methodEntry.httpCalls.length > 0) {
                  return tagResolution(methodEntry.httpCalls, "serviceMapBroadSearch", [
                    { tier: "local", file: filePath, function: handlerName, detail: "handler calls " + calledName + (depth > 0 ? ` (depth ${depth + 1})` : "") },
                    { tier: "serviceMapBroadSearch", file: smPath, function: calledName, detail: "broad serviceMap method name match" }
                  ]);
                }
                const fnCalls = smEntry.directFunctions.get(calledName);
                if (fnCalls && fnCalls.length > 0) {
                  return tagResolution(fnCalls, "serviceMapBroadSearch", [
                    { tier: "local", file: filePath, function: handlerName, detail: "handler calls " + calledName + (depth > 0 ? ` (depth ${depth + 1})` : "") },
                    { tier: "serviceMapBroadSearch", file: smPath, function: calledName, detail: "broad serviceMap function name match" }
                  ]);
                }
              }
              for (const nextNode of calledDecl.calledNodes) {
                queue.push(nextNode);
              }
            }
          }
          depth++;
        }
      }
    }

    if (objectName) {
      const fullMethodName = objectName + "." + handlerName;
      for (const [smPath, smEntry] of Array.from(serviceMap)) {
        const lookups = [handlerName, fullMethodName, "default." + handlerName];
        for (const lookup of lookups) {
          const me = smEntry.methods.get(lookup);
          if (me && me.httpCalls.length > 0) {
            return tagResolution(me.httpCalls, "serviceMapBroadSearch", [
              { tier: "local", file: filePath, function: fullMethodName, detail: "object.method call" },
              { tier: "serviceMapBroadSearch", file: smPath, function: lookup, detail: "broad serviceMap method match for object.method" }
            ]);
          }
        }
      }
    }
  }

  if (globalCallGraph) {
    const allGcgNodes = Array.from(globalCallGraph.values());
    for (const gNode of allGcgNodes) {
      if (gNode.filePath === filePath) continue;
      if (gNode.functionName === handlerName) {
        const calls = gNode.propagatedHttpCalls || (gNode.httpCalls.length > 0 ? gNode.httpCalls : null);
        if (calls && calls.length > 0) {
          return tagResolution(calls, "crossFileNameMatch", [
            { tier: "local", file: filePath, function: handlerName, detail: "handler entry point" },
            { tier: "crossFileNameMatch", file: gNode.filePath, function: gNode.functionName, detail: "same-name function found in another file with HTTP calls" }
          ]);
        }
      }
    }
  }

  return [];
}

function extractDispatchedActions(
  handlerNode: ts.Node,
  sourceFile: ts.SourceFile,
  importBindings: Map<string, ImportBinding>
): string[] {
  const actions: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callText = n.expression.getText(sourceFile);
      if (callText === "dispatch" || callText === "store.dispatch" || callText === "this.store.dispatch" || callText === "this.$store.dispatch") {
        for (const arg of n.arguments) {
          if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
            actions.push(arg.expression.text);
          } else if (ts.isIdentifier(arg)) {
            actions.push(arg.text);
          }
        }
      }
      if (ts.isIdentifier(n.expression)) {
        const fnName = n.expression.text;
        if (fnName === "emit" || fnName === "$emit") {
          const firstArg = n.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            const eventName = firstArg.text;
            const handlerCandidate = "on" + eventName.charAt(0).toUpperCase() + eventName.slice(1);
            actions.push(handlerCandidate);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(handlerNode);
  return actions;
}

function detectHookBindings(sourceFile: ts.SourceFile, importBindings: Map<string, ImportBinding>): HookBinding[] {
  const results: HookBinding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callExpr = node.initializer.expression;
      if (ts.isIdentifier(callExpr) && callExpr.text.startsWith("use")) {
        const hookName = callExpr.text;
        const binding = importBindings.get(hookName);
        if (binding && ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              results.push({
                destructuredName: el.name.text,
                hookName,
                hookSourcePath: binding.sourcePath,
              });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function resolveViaContextHooks(
  handlerName: string,
  symbolTable: ScriptSymbolTable,
  sourceFile: ts.SourceFile,
  importBindings: Map<string, ImportBinding>,
  serviceMap: HttpServiceMap,
  allFiles: { filePath: string; content: string }[],
  allFilePaths: string[],
  filePath: string,
): HttpCall[] {
  const hookBindings = detectHookBindings(sourceFile, importBindings);
  if (hookBindings.length === 0) return [];

  const handlerNode = symbolTable.resolveHandlerNode(handlerName);
  if (!handlerNode) return [];

  const calledNames = new Set<string>();
  const collectCallNames = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calledNames.add(node.expression.text);
    }
    ts.forEachChild(node, collectCallNames);
  };
  const body = handlerNode;
  collectCallNames(body);

  for (const hb of hookBindings) {
    if (!calledNames.has(hb.destructuredName)) continue;

    const hookFile = allFiles.find(f => f.filePath === hb.hookSourcePath);
    if (!hookFile) continue;

    try {
      let hookScript = hookFile.content;
      if (hookFile.filePath.endsWith(".vue")) {
        hookScript = extractVueScript(hookFile.content);
      }
      if (!hookScript.trim()) continue;

      const scriptKind = hookFile.filePath.endsWith(".tsx") || hookFile.filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const hookSource = ts.createSourceFile(hookFile.filePath + ".hook.ts", hookScript, ts.ScriptTarget.Latest, true, scriptKind);
      const hookSymbolTable = ScriptSymbolTable.build(hookSource);

      const fnNode = hookSymbolTable.resolveHandlerNode(hb.destructuredName);
      if (fnNode) {
        const directCalls = hookSymbolTable.traceHttpCalls(fnNode);
        if (directCalls.length > 0) return directCalls;

        const hookImportBindings = parseImportBindings(hookSource, hb.hookSourcePath, allFilePaths);
        const hookLocalNames = new Set<string>();
        const visitH = (node: ts.Node) => {
          if (ts.isFunctionDeclaration(node) && node.name) hookLocalNames.add(node.name.text);
          else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) hookLocalNames.add(node.name.text);
          else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
            if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) hookLocalNames.add(node.parent.name.text);
            else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) hookLocalNames.add(node.parent.name.text);
          }
          ts.forEachChild(node, visitH);
        };
        visitH(hookSource);
        const hookExtCalls = extractExternalCalls(hookSource, hookLocalNames);
        const resolved = resolveExternalCallsToHttpCalls(hookExtCalls, hookImportBindings, serviceMap, hb.destructuredName, hookSymbolTable);
        if (resolved.length > 0) return resolved;
      }
    } catch (err) {
      // silently continue
    }
  }

  return [];
}

function detectDynamicImports(sourceFile: ts.SourceFile, allFilePaths: string[], importerPath: string): DynamicImportBinding[] {
  const results: DynamicImportBinding[] = [];
  const visit = (node: ts.Node, enclosingFn: string | null) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      ts.forEachChild(node, child => visit(child, node.name!.text));
      return;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      ts.forEachChild(node, child => visit(child, node.name.getText()));
      return;
    }
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parent) {
      let fnName = enclosingFn;
      if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) fnName = node.parent.name.text;
      else if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) fnName = node.parent.name.text;
      ts.forEachChild(node, child => visit(child, fnName));
      return;
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      let importCall: ts.CallExpression | null = null;
      let init = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword) {
        importCall = init;
      }

      if (importCall && importCall.arguments.length > 0 && ts.isStringLiteral(importCall.arguments[0])) {
        const moduleSpec = importCall.arguments[0].text;
        const resolvedPath = normalizeModulePath(importerPath, moduleSpec, allFilePaths);
        if (resolvedPath && ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              results.push({
                localName: el.name.text,
                modulePath: resolvedPath,
                enclosingFunction: enclosingFn,
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, child => visit(child, enclosingFn));
  };
  visit(sourceFile, null);
  return results;
}

function resolveViaDynamicImport(
  handlerName: string,
  symbolTable: ScriptSymbolTable,
  sourceFile: ts.SourceFile,
  serviceMap: HttpServiceMap,
  allFiles: { filePath: string; content: string }[],
  allFilePaths: string[],
  filePath: string,
): HttpCall[] {
  const dynImports = detectDynamicImports(sourceFile, allFilePaths, filePath);
  if (dynImports.length === 0) return [];

  const relevantImports = dynImports.filter(d => d.enclosingFunction === handlerName || d.enclosingFunction === null);
  if (relevantImports.length === 0) return [];

  const handlerNode = symbolTable.resolveHandlerNode(handlerName);
  if (!handlerNode) return [];

  const methodCalls: { objectName: string; methodName: string }[] = [];
  const collectCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const obj = node.expression.expression;
      if (ts.isIdentifier(obj)) {
        methodCalls.push({ objectName: obj.text, methodName: node.expression.name.text });
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(handlerNode);

  for (const mc of methodCalls) {
    const dynBinding = relevantImports.find(d => d.localName === mc.objectName);
    if (!dynBinding) continue;

    const fileEntry = serviceMap.get(dynBinding.modulePath);
    if (!fileEntry) continue;

    const lookupKeys = [
      mc.objectName + "." + mc.methodName,
      "default." + mc.methodName,
      dynBinding.localName + "." + mc.methodName,
    ];
    for (const key of lookupKeys) {
      const methodEntry = fileEntry.methods.get(key);
      if (methodEntry && methodEntry.httpCalls.length > 0) {
        return methodEntry.httpCalls;
      }
    }
  }

  return [];
}

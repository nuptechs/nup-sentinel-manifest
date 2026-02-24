import _ts from "typescript";
import * as vueSfc from "@vue/compiler-sfc";
import * as ngCompiler from "@angular/compiler";
import type {
  FrontendInteraction,
  HttpCall,
  TemplateBinding,
  HttpServiceMap,
  GlobalCallGraph,
  ComponentEventGraph,
  StateFlowGraph,
  ArchitecturalLayerGraph,
  ImportBinding,
  ResolutionStep,
} from "./types";
import { parseTypeScript, getLineNumber, extractVueScript, parseVueTemplateAST } from "./parsers";
import { ScriptSymbolTable } from "./symbol-table";
import { ImportedHttpClients } from "./http-clients";
import {
  getComponentName,
  parseImportBindings,
  addUnmappedHttpCalls,
  classifyElement,
  extractInlineHandlerTarget,
  matchUrlToEndpoint,
} from "./utils";
import { resolveBindingsViaNodes } from "./http-resolution";
import type { ApplicationGraph, GraphNode } from "../application-graph";

import ts = _ts;

export function parseAngularTemplateAST(templateContent: string): TemplateBinding[] {
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

export function parseJSXTemplate(sourceFile: ts.SourceFile): TemplateBinding[] {
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
            let objectName: string | undefined;
            if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) {
              const expr = attr.initializer.expression;
              if (ts.isIdentifier(expr)) {
                handlerName = expr.text;
              } else if (ts.isPropertyAccessExpression(expr)) {
                handlerName = expr.name.text;
                if (ts.isIdentifier(expr.expression)) {
                  objectName = expr.expression.text;
                }
              } else if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
                const inlineResult = extractInlineHandlerTarget(expr);
                handlerName = inlineResult.handlerName;
                objectName = inlineResult.objectName;
              } else if (ts.isCallExpression(expr)) {
                if (ts.isIdentifier(expr.expression)) {
                  handlerName = expr.expression.text;
                } else if (ts.isPropertyAccessExpression(expr.expression)) {
                  handlerName = expr.expression.name.text;
                  if (ts.isIdentifier(expr.expression.expression)) {
                    objectName = expr.expression.expression.text;
                  }
                }
              }
            }

            if (handlerName) {
              bindings.push({
                elementType,
                eventType,
                handlerName,
                lineNumber: getLineNumber(sourceFile, node.getStart(sourceFile)),
                objectName,
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

export function findDecoratorProperty(sourceFile: ts.SourceFile, propertyName: string): ts.Expression | null {
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

export function resolveTemplatePath(componentPath: string, templateUrl: string): string {
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

export function analyzeVueFile(
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

export function analyzeReactFile(
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

export function analyzeAngularFile(
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

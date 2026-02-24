import _ts from "typescript";
import * as vueSfc from "@vue/compiler-sfc";
import * as ngCompiler from "@angular/compiler";

import ts = _ts;

import type { ComponentEmitEntry, EventListenerEntry, ComponentEventGraph } from "./types";
import { extractVueScript } from "./parsers";
import { normalizeModulePath } from "./http-service-map";

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

function extractInlineHandlerTarget(node: ts.ArrowFunction | ts.FunctionExpression): { handlerName: string; objectName?: string } {
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
                    handlerName = extractInlineHandlerTarget(expr).handlerName;
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

function isAngularComponent(content: string): boolean {
  return content.includes("@Component") || content.includes("@NgModule") || content.includes("@Injectable");
}

export function buildComponentEventGraph(
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

export function lookupEventGraph(
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

export function normalizeEventName(name: string): string {
  return name.replace(/^on/, "").replace(/[-_]/g, "").toLowerCase();
}

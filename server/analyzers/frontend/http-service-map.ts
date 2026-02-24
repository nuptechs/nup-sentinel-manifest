import _ts from "typescript";
import type { HttpCall, ImportBinding, FileServiceEntry, HttpServiceMap, ClassInheritanceInfo, ServiceMethodEntry } from "./types";
import { ImportedHttpClients } from "./http-clients";
import { parseTypeScript, getLineNumber } from "./parsers";
import { ScriptSymbolTable } from "./symbol-table";
import { extractUrlFromNode, extractOperationHint } from "./utils";

import ts = _ts;

export function normalizeModulePath(importerPath: string, moduleSpecifier: string, allFilePaths: string[]): string | null {
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

export function extractExports(sourceFile: ts.SourceFile): { exportedNames: Set<string>; classInstances: Map<string, string>; defaultExportName: string | null } {
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

  return null;
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

export function buildHttpServiceMap(files: { filePath: string; content: string }[]): HttpServiceMap {
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

import _ts from "typescript";
import type { ArchitecturalRole, ArchitecturalLayerGraph, HttpCall, HttpServiceMap, ImportBinding, ExternalCall } from "./types";
import { extractVueScript } from "./parsers";
import { normalizeModulePath } from "./http-service-map";
import { ScriptSymbolTable } from "./symbol-table";

import ts = _ts;

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

export function buildArchitecturalLayerGraph(
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

export function lookupArchitecturalLayerGraph(
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

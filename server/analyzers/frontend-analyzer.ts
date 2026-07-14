import _ts from "typescript";
import type { ApplicationGraph, GraphNode } from "./application-graph";
import type { GlobalCallGraphNode, GlobalCallGraph, FileAuthPatterns } from "./frontend/types";
import { makeGlobalKey, buildGlobalCallGraph, propagateHttpCapability, lookupGlobalCallGraph, getFnBody, parseImportBindingsInternal } from "./frontend/global-call-graph";
import { ImportedHttpClients } from "./frontend/http-clients";
import { ScriptSymbolTable } from "./frontend/symbol-table";
import { buildComponentEventGraph, lookupEventGraph } from "./frontend/event-graph";
import { extractVueScript, parseTypeScript, getLineNumber } from "./frontend/parsers";
import { buildStateFlowGraph, lookupStateFlowGraph } from "./frontend/state-flow-graph";
import { readMultistackFlags } from "../config/multistack";
import { extractRestExpressInteractions } from "./frontend/rest-express-template";
import {
  getComponentName,
  extractUrlFromNode,
  extractOperationHint,
  normalizeUrl,
  isExternalUrl,
  extractExternalDomain,
  isServerSideFile,
  matchUrlToEndpoint,
  parseImportBindings,
  extractExternalCalls,
  resolveExternalCallsToHttpCalls,
  normalizeModulePath,
  isAngularComponent,
  detectFileType,
} from "./frontend/utils";
export { extractUrlFromNode, extractOperationHint } from "./frontend/utils";
import { buildArchitecturalLayerGraph, lookupArchitecturalLayerGraph } from "./frontend/architectural-layer-graph";
import { buildRouteMap, inferRoutesFromFilePaths } from "./frontend/route-extraction";
import { detectFileAuthPatterns } from "./frontend/auth-detection";
import { analyzeVueFile, analyzeReactFile, analyzeAngularFile, parseAngularTemplateAST, parseJSXTemplate } from "./frontend/file-analyzers";
import { buildHttpServiceMap } from "./frontend/http-service-map";
export { extractHttpCallFromExpression, buildLocalVarMap } from "./frontend/http-service-map";

import ts = _ts;

export interface ResolutionStep {
  tier: string;
  file: string;
  function: string | null;
  detail: string | null;
}

export interface ResolutionMetadata {
  tier: string;
  resolutionPath: ResolutionStep[];
}

export interface FrontendInteraction {
  component: string;
  elementType: string;
  actionName: string;
  httpMethod: string | null;
  url: string | null;
  mappedBackendNode: GraphNode | null;
  sourceFile: string;
  lineNumber: number;
  resolutionTier: string | null;
  resolutionStrategy: string | null;
  resolutionPath: ResolutionStep[] | null;
  interactionCategory: "HTTP" | "UI_ONLY" | "STATE_ONLY" | "SERVICE_BRIDGE" | "EXTERNAL_SERVICE";
  confidence: number;
  frontendRoute?: string | null;
  routeGuards?: string[];
  detectedRoles?: string[];
  externalDomain?: string | null;
  operationHint?: string | null;
}

type BaseURLRegistry = Map<string, string>;

function buildBaseURLRegistry(files: { filePath: string; content: string }[]): BaseURLRegistry {
  const registry: BaseURLRegistry = new Map();

  for (const file of files) {
    const ext = file.filePath.substring(file.filePath.lastIndexOf("."));
    if (![".ts", ".js", ".tsx", ".jsx"].includes(ext)) continue;
    if (file.filePath.includes("node_modules") || file.filePath.includes("dist/") || file.filePath.includes("build/")) continue;

    try {
      const sourceFile = parseTypeScript(file.content, file.filePath);
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const name = node.name.text;
          const nameLower = name.toLowerCase();

          if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
            const value = node.initializer.text;
            if ((nameLower.includes("base") || nameLower.includes("prefix") || nameLower.includes("api_url") || nameLower.includes("apiurl")) && value.startsWith("/")) {
              registry.set(`${file.filePath}::${name}`, value);
            }
          }

          if (ts.isCallExpression(node.initializer)) {
            const callExpr = node.initializer.expression;
            if (ts.isPropertyAccessExpression(callExpr) && callExpr.name.text === "create") {
              const args = node.initializer.arguments;
              if (args.length > 0 && ts.isObjectLiteralExpression(args[0])) {
                for (const prop of args[0].properties) {
                  if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "baseURL") {
                    if (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer)) {
                      registry.set(`${file.filePath}::${name}`, prop.initializer.text);
                    }
                  }
                }
              }
            }
          }
        }

        if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
          const bin = node.expression;
          if (bin.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const leftText = bin.left.getText(sourceFile);
            if (leftText.includes("defaults.baseURL") || leftText.includes("defaults.baseUrl")) {
              if (ts.isStringLiteral(bin.right) || ts.isNoSubstitutionTemplateLiteral(bin.right)) {
                registry.set(`${file.filePath}::__defaults__`, bin.right.text);
              }
            }
          }
        }

        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    } catch (err) {
    }
  }

  if (registry.size > 0) {
    console.log(`[frontend-analyzer] BaseURLRegistry: ${registry.size} entries found`);
    registry.forEach((value, key) => {
      console.log(`[frontend-analyzer]   ${key} → ${value}`);
    });
  }

  return registry;
}

function resolveBaseURL(url: string, filePath: string, baseURLRegistry: BaseURLRegistry): string {
  if (!url || url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) return url;

  if (url.startsWith("{base}/") || url.startsWith("{base}")) {
    const suffix = url.replace(/^\{base\}\/?/, "");
    for (const [key, base] of Array.from(baseURLRegistry.entries())) {
      if (key.startsWith(filePath + "::") || key.includes("::__defaults__")) {
        const resolved = base.replace(/\/$/, "") + "/" + suffix;
        return resolved.replace(/\/+/g, "/");
      }
    }
    for (const [, base] of Array.from(baseURLRegistry.entries())) {
      const resolved = base.replace(/\/$/, "") + "/" + suffix;
      return resolved.replace(/\/+/g, "/");
    }
  }

  if (!url.startsWith("/") && !url.startsWith("http")) {
    for (const [key, base] of Array.from(baseURLRegistry.entries())) {
      if (key.startsWith(filePath + "::") || key.includes("::__defaults__")) {
        const resolved = base.replace(/\/$/, "") + "/" + url;
        return resolved.replace(/\/+/g, "/");
      }
    }
    for (const [, base] of Array.from(baseURLRegistry.entries())) {
      const resolved = base.replace(/\/$/, "") + "/" + url;
      return resolved.replace(/\/+/g, "/");
    }
  }

  return url;
}

export function analyzeFrontend(
  files: { filePath: string; content: string }[],
  graph: ApplicationGraph
): FrontendInteraction[] {
  const interactions: FrontendInteraction[] = [];
  const htmlTemplates = new Map<string, string>();

  const baseURLRegistry = buildBaseURLRegistry(files);
  const serviceMap = buildHttpServiceMap(files);
  const globalCallGraph = buildGlobalCallGraph(files, serviceMap);
  const allFilePaths = files.map(f => f.filePath);
  const eventGraph = buildComponentEventGraph(files, allFilePaths);
  const stateFlowGraph = buildStateFlowGraph(files, serviceMap, globalCallGraph);
  const archLayerGraph = buildArchitecturalLayerGraph(files, serviceMap, allFilePaths);
  const routeMap = buildRouteMap(files);

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
          interactions.push(...analyzeVueFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
          break;

        case "react":
          interactions.push(...analyzeReactFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
          break;

        case "javascript":
          if (isAngularComponent(file.content)) {
            interactions.push(...analyzeAngularFile(file.filePath, file.content, graph, htmlTemplates, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
          } else {
            interactions.push(...analyzeReactFile(file.filePath, file.content, graph, serviceMap, allFilePaths, globalCallGraph, eventGraph, files, stateFlowGraph, archLayerGraph));
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
              resolutionTier: null,
              resolutionStrategy: null,
              resolutionPath: null,
              interactionCategory: "UI_ONLY",
              confidence: 1.0,
            });
          }
          break;
      }
    } catch (err) {
      console.error(`[frontend-analyzer] Error analyzing ${file.filePath}:`, err instanceof Error ? err.message : err);
    }
  }

  if (baseURLRegistry.size > 0) {
    let baseResolved = 0;
    let newMatches = 0;
    for (const interaction of interactions) {
      if (interaction.url && (interaction.url.includes("{base}") || (!interaction.url.startsWith("/") && !interaction.url.startsWith("http")))) {
        const resolved = resolveBaseURL(interaction.url, interaction.sourceFile, baseURLRegistry);
        if (resolved !== interaction.url) {
          interaction.url = resolved;
          baseResolved++;

          if (!interaction.mappedBackendNode && interaction.httpMethod) {
            const backendNode = matchUrlToEndpoint(interaction.httpMethod, resolved, graph);
            if (backendNode) {
              interaction.mappedBackendNode = backendNode;
              newMatches++;
              if (interaction.resolutionPath) {
                interaction.resolutionPath = [...interaction.resolutionPath, { tier: "controller", file: backendNode.className, function: backendNode.methodName, detail: `matched ${interaction.httpMethod} ${resolved} (baseURL resolved)` }];
              } else {
                interaction.resolutionPath = [
                  { tier: "local", file: interaction.sourceFile, function: interaction.actionName, detail: "baseURL resolution" },
                  { tier: "controller", file: backendNode.className, function: backendNode.methodName, detail: `matched ${interaction.httpMethod} ${resolved} (baseURL resolved)` }
                ];
              }
            }
          }
        }
      }
    }
    if (baseResolved > 0) {
      console.log(`[frontend-analyzer] BaseURL resolution: ${baseResolved} URLs resolved, ${newMatches} new controller matches`);
    }
  }

  let serviceBridgeCount = 0;
  let externalServiceCount = 0;
  for (const interaction of interactions) {
    if (interaction.url && isExternalUrl(interaction.url)) {
      interaction.interactionCategory = "EXTERNAL_SERVICE";
      interaction.externalDomain = extractExternalDomain(interaction.url);
      interaction.mappedBackendNode = null;
      if (interaction.resolutionPath) {
        interaction.resolutionPath = interaction.resolutionPath.filter(s => s.tier !== "controller");
        interaction.resolutionPath.push({
          tier: "external_service",
          file: interaction.externalDomain || "unknown",
          function: null,
          detail: `external API call to ${interaction.externalDomain}`
        });
      }
      externalServiceCount++;
    }

    if (isServerSideFile(interaction.sourceFile)) {
      if (interaction.interactionCategory !== "EXTERNAL_SERVICE") {
        interaction.interactionCategory = "SERVICE_BRIDGE";
      }
      serviceBridgeCount++;
    }
  }
  if (serviceBridgeCount > 0) {
    console.log(`[frontend-analyzer] Service bridges: ${serviceBridgeCount} interactions from server-side files`);
  }
  if (externalServiceCount > 0) {
    console.log(`[frontend-analyzer] External services: ${externalServiceCount} interactions calling external APIs`);
  }

  if (routeMap.size > 0) {
    let routeEnriched = 0;
    for (const interaction of interactions) {
      const componentName = interaction.component.toLowerCase();
      const componentNameNoSpaces = componentName.replace(/\s+/g, "");
      let matched = routeMap.get(componentName) || routeMap.get(componentNameNoSpaces);
      if (!matched) {
        const fileName = interaction.sourceFile
          .split("/").pop()
          ?.replace(/\.(vue|tsx|jsx|ts|js)$/, "")
          ?.toLowerCase();
        if (fileName) {
          matched = routeMap.get(fileName) || routeMap.get(fileName.replace(/[-_]/g, ""));
        }
      }
      if (!matched) {
        const pathParts = interaction.sourceFile.replace(/\\/g, "/").split("/");
        const srcIdx = pathParts.findIndex(p => p === "src" || p === "app" || p === "pages" || p === "views");
        if (srcIdx >= 0) {
          const relParts = pathParts.slice(srcIdx + 1);
          const relPath = relParts.join("/").replace(/\.(vue|tsx|jsx|ts|js)$/, "").toLowerCase();
          matched = routeMap.get(relPath);
          if (!matched && relParts.length >= 2) {
            const dirName = relParts[relParts.length - 2].toLowerCase();
            matched = routeMap.get(dirName);
          }
        }
      }
      if (!matched && componentNameNoSpaces.length >= 4) {
        for (const [key, val] of Array.from(routeMap)) {
          if (key === componentNameNoSpaces) continue;
          if (key.length < 4) continue;
          const keyNoSep = key.replace(/[-_\s]/g, "");
          if (keyNoSep === componentNameNoSpaces) {
            matched = val;
            break;
          }
          const suffixes = [/page$/i, /view$/i, /screen$/i, /component$/i, /container$/i];
          for (const suffix of suffixes) {
            if (keyNoSep === componentNameNoSpaces.replace(suffix, "") || componentNameNoSpaces === keyNoSep.replace(suffix, "")) {
              matched = val;
              break;
            }
          }
          if (matched) break;
        }
      }
      if (matched) {
        interaction.frontendRoute = matched.route;
        const existingGuards = interaction.routeGuards || [];
        interaction.routeGuards = Array.from(new Set([...matched.guards, ...existingGuards]));
        routeEnriched++;
      }
    }
    if (routeEnriched > 0) {
      console.log(`[frontend-analyzer] Route enrichment: ${routeEnriched}/${interactions.length} interactions mapped to routes`);
    } else {
      console.log(`[frontend-analyzer] Route enrichment: 0 matches. RouteMap has ${routeMap.size} entries. Sample components: ${interactions.slice(0, 5).map(i => i.component).join(", ")}`);
      const routeEntries = Array.from(routeMap.entries()).slice(0, 5);
      for (const [key, val] of routeEntries) {
        console.log(`[frontend-analyzer]   RouteMap entry: "${key}" → "${val.route}"`);
      }
    }
  } else {
    console.log(`[frontend-analyzer] Route enrichment skipped: no routes found in any file`);
  }

  const fileAuthCache = new Map<string, FileAuthPatterns>();
  let authEnriched = 0;
  for (const interaction of interactions) {
    if (!fileAuthCache.has(interaction.sourceFile)) {
      const fileData = files.find(f => f.filePath === interaction.sourceFile);
      if (fileData) {
        let scriptContent = fileData.content;
        if (fileData.filePath.endsWith(".vue")) {
          scriptContent = extractVueScript(fileData.content);
        }
        try {
          const sf = parseTypeScript(scriptContent, fileData.filePath);
          fileAuthCache.set(interaction.sourceFile, detectFileAuthPatterns(sf, scriptContent));
        } catch {
          fileAuthCache.set(interaction.sourceFile, { guards: [], roles: [], authRequired: false });
        }
      }
    }
    const authPatterns = fileAuthCache.get(interaction.sourceFile);
    if (authPatterns && authPatterns.authRequired) {
      const existing = interaction.routeGuards || [];
      const merged = Array.from(new Set([...existing, ...authPatterns.guards]));
      if (merged.length > 0) {
        interaction.routeGuards = merged;
      }
      if (!interaction.detectedRoles) {
        interaction.detectedRoles = authPatterns.roles;
      }
      authEnriched++;
    }
  }
  if (authEnriched > 0) {
    console.log(`[frontend-analyzer] Auth enrichment: ${authEnriched}/${interactions.length} interactions with detected auth patterns`);
  }

  // Multistack (ADR-0015 Onda 1 D6): captura HTTP do template rest-express
  // (queryKey-como-URL + apiRequest). Atrás de MANIFEST_MULTISTACK_HTTP_TEMPLATE
  // — OFF ⇒ nada muda (byte-a-byte, G2); ON ⇒ superset estrito de interações (G3).
  if (readMultistackFlags().frontendHttpTemplate) {
    const templateInteractions = extractRestExpressInteractions(files, graph);
    if (templateInteractions.length > 0) {
      interactions.push(...templateInteractions);
      console.log(`[frontend-analyzer] rest-express template (D6): +${templateInteractions.length} interactions (queryKey/apiRequest)`);
    }
  }

  const withUrls = interactions.filter(i => i.url);
  const withoutUrls = interactions.filter(i => !i.url);
  const matched = interactions.filter(i => i.mappedBackendNode);
  const bridges = interactions.filter(i => i.interactionCategory === "SERVICE_BRIDGE");
  const externals = interactions.filter(i => i.interactionCategory === "EXTERNAL_SERVICE");
  console.log(`[frontend-analyzer] Results: ${interactions.length} interactions, ${withUrls.length} with URLs (${withoutUrls.length} without), ${matched.length} matched to backend, ${bridges.length} service bridges, ${externals.length} external services`);

  const tierCounts = new Map<string, number>();
  for (const i of interactions) {
    const tier = i.resolutionTier || "unresolved";
    tierCounts.set(tier, (tierCounts.get(tier) || 0) + 1);
  }
  const tierEntries = Array.from(tierCounts.entries()).sort((a, b) => b[1] - a[1]);
  console.log(`[frontend-analyzer] Resolution tier distribution:`);
  for (const [tier, count] of tierEntries) {
    console.log(`[frontend-analyzer]   ${tier}: ${count} (${((count / interactions.length) * 100).toFixed(1)}%)`);
  }

  if (withoutUrls.length > 0 && withoutUrls.length <= 20) {
    console.log(`[frontend-analyzer] Unresolved handlers:`);
    for (const i of withoutUrls) {
      console.log(`[frontend-analyzer]   ${i.sourceFile} :: ${i.actionName} (${i.elementType})`);
    }
  } else if (withoutUrls.length > 20) {
    const unresolvedByFile = new Map<string, number>();
    for (const i of withoutUrls) {
      unresolvedByFile.set(i.sourceFile, (unresolvedByFile.get(i.sourceFile) || 0) + 1);
    }
    const topFiles = Array.from(unresolvedByFile.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`[frontend-analyzer] Top files with unresolved handlers (${withoutUrls.length} total):`);
    for (const [file, count] of topFiles) {
      console.log(`[frontend-analyzer]   ${file}: ${count} unresolved`);
    }
  }

  const withRoutes = interactions.filter(i => i.frontendRoute);
  const withGuards = interactions.filter(i => i.routeGuards && i.routeGuards.length > 0);
  const withRoles = interactions.filter(i => i.detectedRoles && i.detectedRoles.length > 0);
  console.log(`[frontend-analyzer] Enrichment: ${withRoutes.length} with routes, ${withGuards.length} with guards, ${withRoles.length} with detected roles`);

  return interactions;
}

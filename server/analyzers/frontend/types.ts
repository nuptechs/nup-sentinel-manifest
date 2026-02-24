import _ts from "typescript";
import type { GraphNode } from "../application-graph";

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

export interface HttpCall {
  method: string;
  url: string;
  lineNumber: number;
  callerFunction: string | null;
  operationHint?: string | null;
}

export interface TemplateBinding {
  elementType: string;
  eventType: string;
  handlerName: string;
  lineNumber: number;
  objectName?: string;
}

export interface SymbolDeclaration {
  name: string;
  node: ts.Node;
  httpCalls: HttpCall[];
  calledNodes: ts.Node[];
}

export interface DestructuredBinding {
  name: string;
  sourceCallName: string;
  sourceIsHook: boolean;
}

export interface VariableOrigin {
  varName: string;
  sourceCallName: string;
  sourceIsHook: boolean;
}

export interface ComponentEmitEntry {
  eventName: string;
  emitterFunction: string;
}

export interface EventListenerEntry {
  childTag: string;
  childFilePath: string | null;
  eventName: string;
  parentHandler: string;
}

export interface ComponentEventGraph {
  emitters: Map<string, ComponentEmitEntry[]>;
  listeners: Map<string, EventListenerEntry[]>;
  componentRegistry: Map<string, string>;
}

export type BaseURLRegistry = Map<string, string>;

export interface ExternalCall {
  importedName: string;
  methodName: string | null;
  callerFunction: string;
}

export interface ServiceMethodEntry {
  httpCalls: HttpCall[];
}

export interface FileServiceEntry {
  methods: Map<string, ServiceMethodEntry>;
  directFunctions: Map<string, HttpCall[]>;
}

export type HttpServiceMap = Map<string, FileServiceEntry>;

export interface ImportBinding {
  sourcePath: string;
  originalName: string;
  isDefault: boolean;
}

export interface ClassInheritanceInfo {
  className: string;
  parentClassName: string;
  parentImportPath: string | null;
}

export interface GlobalCallGraphNode {
  key: string;
  filePath: string;
  functionName: string;
  httpCalls: HttpCall[];
  callees: Set<string>;
  callers: Set<string>;
  propagatedHttpCalls: HttpCall[] | null;
}

export type GlobalCallGraph = Map<string, GlobalCallGraphNode>;

export interface StateFieldWrite {
  containerFile: string;
  containerName: string;
  fieldName: string;
  writerFunction: string;
  qualifiedField: string;
}

export interface StateFieldRead {
  containerFile: string;
  containerName: string;
  fieldName: string;
  readerFunction: string;
  qualifiedField: string;
  httpCalls: HttpCall[];
}

export interface StateFlowGraph {
  writers: Map<string, StateFieldWrite[]>;
  readers: Map<string, StateFieldRead[]>;
  containerFiles: Set<string>;
}

export type StateContainerType = "vuex" | "pinia" | "redux" | "angular-service" | "composable" | "singleton-service";

export interface DetectedStateContainer {
  type: StateContainerType;
  name: string;
  filePath: string;
  stateFields: string[];
  sourceFile: ts.SourceFile;
}

export type ArchitecturalRole = "component" | "facade" | "usecase" | "repository" | "unknown";

export interface ArchitecturalLayerGraph {
  roleByFile: Map<string, ArchitecturalRole>;
  importsByFile: Map<string, Set<string>>;
  repositoryHttpCalls: Map<string, HttpCall[]>;
}

export interface HookBinding {
  destructuredName: string;
  hookName: string;
  hookSourcePath: string;
}

export interface DynamicImportBinding {
  localName: string;
  modulePath: string;
  enclosingFunction: string | null;
}

export interface FileAuthPatterns {
  guards: string[];
  roles: string[];
  authRequired: boolean;
}

export interface RouteDefinition {
  path: string;
  component: string;
  guards: string[];
  meta?: Record<string, unknown>;
  children?: RouteDefinition[];
}

export type RouteMap = Map<string, { route: string; guards: string[] }>;

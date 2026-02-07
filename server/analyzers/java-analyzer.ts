export interface JavaEndpoint {
  className: string;
  methodName: string;
  httpMethod: string;
  path: string;
  fullPath: string;
  serviceCalls: string[];
  repositoryCalls: string[];
  entitiesTouched: string[];
  fullCallChain: string[];
  persistenceOperations: string[];
  sourceFile: string;
  lineNumber: number;
}

export interface JavaServiceMethod {
  className: string;
  methodName: string;
  repositoryCalls: string[];
  entitiesTouched: string[];
  nestedServiceCalls: string[];
  sourceFile: string;
}

export interface JavaEntity {
  className: string;
  tableName: string;
  fields: string[];
  sourceFile: string;
}

interface ClassIndex {
  className: string;
  packageName: string;
  annotations: string[];
  injectedFields: Map<string, string>;
  methods: MethodIndex[];
  sourceFile: string;
  isController: boolean;
  isService: boolean;
  isRepository: boolean;
  isEntity: boolean;
  basePath: string;
  tableName: string;
  entityFields: string[];
  extendsClass: string | null;
}

interface MethodIndex {
  className: string;
  methodName: string;
  visibility: string;
  returnType: string;
  params: string;
  body: string;
  lineNumber: number;
  httpMapping: { method: string; path: string } | null;
  methodCalls: MethodCallRef[];
}

interface MethodCallRef {
  targetVariable: string;
  methodName: string;
  raw: string;
}

interface CallChainResult {
  fullCallChain: string[];
  entitiesTouched: string[];
  persistenceOperations: string[];
  repositoryCalls: string[];
  serviceMethods: string[];
}

const PERSISTENCE_SAVE = ["save", "saveAll", "saveAndFlush", "persist", "merge", "saveAllAndFlush", "insert", "create"];
const PERSISTENCE_DELETE = ["delete", "deleteById", "deleteAll", "deleteAllById", "deleteAllInBatch", "remove", "deleteByOrderId", "deleteByUserId", "removeAll"];
const PERSISTENCE_READ = ["findById", "findAll", "findOne", "getById", "getOne", "existsById", "count", "findAllById", "getReferenceById", "findByStatus", "findByName", "findByEmail", "existsByEmail"];
const PERSISTENCE_UPDATE = ["update", "updateAll", "flush"];
const STATE_CHANGE_PATTERNS = /\.set\w+\s*\(/;

function extractPackageName(content: string): string {
  const match = content.match(/package\s+([\w.]+)\s*;/);
  return match ? match[1] : "";
}

function getClassName(content: string): string {
  const match = content.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/);
  return match ? match[1] : "Unknown";
}

function getExtendsClass(content: string): string | null {
  const match = content.match(/class\s+\w+\s+extends\s+(\w+)/);
  return match ? match[1] : null;
}

function extractAnnotations(content: string): string[] {
  const annotations: string[] = [];
  const regex = /@(\w+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    annotations.push(match[1]);
  }
  return Array.from(new Set(annotations));
}

function getLineNumber(content: string, index: number): number {
  return content.substring(0, index).split("\n").length;
}

function extractMethodBody(content: string, startIndex: number): string {
  let braceCount = 0;
  let foundFirstBrace = false;
  let bodyStart = startIndex;

  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{") {
      if (!foundFirstBrace) {
        foundFirstBrace = true;
        bodyStart = i;
      }
      braceCount++;
    } else if (content[i] === "}") {
      braceCount--;
      if (foundFirstBrace && braceCount === 0) {
        return content.substring(bodyStart, i + 1);
      }
    }
  }
  return content.substring(bodyStart, Math.min(bodyStart + 2000, content.length));
}

function extractInjectedFields(content: string, className: string): Map<string, string> {
  const fields = new Map<string, string>();

  const fieldPatterns = [
    /@Autowired\s+(?:private\s+)?(?:final\s+)?(\w+)\s+(\w+)/g,
    /private\s+(?:final\s+)?(\w+)\s+(\w+)\s*;/g,
    /(?:@Inject|@Resource)\s+(?:private\s+)?(\w+)\s+(\w+)/g,
  ];

  for (const pattern of fieldPatterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(content)) !== null) {
      const typeName = match[1];
      const fieldName = match[2];
      if (
        typeName.endsWith("Service") ||
        typeName.endsWith("Repository") ||
        typeName.endsWith("Repo") ||
        typeName.endsWith("Dao") ||
        typeName.endsWith("Helper") ||
        typeName.endsWith("Manager") ||
        typeName.endsWith("Client")
      ) {
        fields.set(fieldName, typeName);
      }
    }
  }

  const constructorRegex = new RegExp(
    `(?:public\\s+)?${className}\\s*\\(([^)]*)\\)`,
    "g"
  );
  let ctorMatch;
  while ((ctorMatch = constructorRegex.exec(content)) !== null) {
    const params = ctorMatch[1];
    const paramRegex = /(\w+)\s+(\w+)/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(params)) !== null) {
      const typeName = paramMatch[1];
      const fieldName = paramMatch[2];
      if (
        typeName.endsWith("Service") ||
        typeName.endsWith("Repository") ||
        typeName.endsWith("Repo") ||
        typeName.endsWith("Dao") ||
        typeName.endsWith("Helper") ||
        typeName.endsWith("Manager") ||
        typeName.endsWith("Client")
      ) {
        fields.set(fieldName, typeName);
      }
    }
  }

  return fields;
}

function extractEntityFields(content: string): string[] {
  const fields: string[] = [];
  const fieldRegex = /(?:@Column|@Id|@JoinColumn|private|protected)\s+(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*[;=]/g;
  let match;
  while ((match = fieldRegex.exec(content)) !== null) {
    fields.push(match[1]);
  }
  return fields;
}

function extractMethodCalls(methodBody: string): MethodCallRef[] {
  const calls: MethodCallRef[] = [];
  const callRegex = /(\w+)\s*\.\s*(\w+)\s*\(/g;
  let match;
  while ((match = callRegex.exec(methodBody)) !== null) {
    const target = match[1];
    const method = match[2];
    if (
      !["System", "String", "Integer", "Long", "Double", "Boolean", "Math",
        "Arrays", "Collections", "List", "Map", "Set", "Optional", "Stream",
        "log", "logger", "LOG", "LOGGER", "ResponseEntity", "Objects"].includes(target) &&
      !target.startsWith("\"") &&
      target !== "this"
    ) {
      calls.push({ targetVariable: target, methodName: method, raw: `${target}.${method}` });
    }
  }

  const thisCallRegex = /(?:this\s*\.\s*)?(\w+)\s*\(/g;
  while ((match = thisCallRegex.exec(methodBody)) !== null) {
    const methodName = match[1];
    if (
      !["if", "for", "while", "switch", "catch", "return", "throw", "new", "super",
        "get", "set", "put", "add", "remove", "contains", "size", "isEmpty",
        "toString", "valueOf", "equals", "hashCode", "println", "print", "format",
        "ok", "build", "orElseThrow", "orElse", "map", "filter", "stream",
        "collect", "of", "asList", "emptyList", "singletonList"].includes(methodName) &&
      /^[a-z]/.test(methodName) &&
      methodName.length > 2
    ) {
      calls.push({ targetVariable: "this", methodName, raw: `this.${methodName}` });
    }
  }

  return calls;
}

function extractMethods(content: string, className: string): MethodIndex[] {
  const methods: MethodIndex[] = [];

  const methodRegex = /((?:@\w+(?:\([^)]*\))?[\s\n]*)*)(public|private|protected)\s+(?:static\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\(([^)]*)\)/g;
  let match;

  while ((match = methodRegex.exec(content)) !== null) {
    const annotations = match[1] || "";
    const visibility = match[2];
    const returnType = match[3];
    const methodName = match[4];
    const params = match[5];

    if (methodName === className) continue;

    const body = extractMethodBody(content, match.index + match[0].length);
    const lineNumber = getLineNumber(content, match.index);
    const methodCalls = extractMethodCalls(body);

    let httpMapping: { method: string; path: string } | null = null;

    const mappings: { pattern: RegExp; method: string }[] = [
      { pattern: /@GetMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/, method: "GET" },
      { pattern: /@PostMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/, method: "POST" },
      { pattern: /@PutMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/, method: "PUT" },
      { pattern: /@DeleteMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/, method: "DELETE" },
      { pattern: /@PatchMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']\s*\)/, method: "PATCH" },
      { pattern: /@GetMapping\s*(?:\(\s*\))?/, method: "GET" },
      { pattern: /@PostMapping\s*(?:\(\s*\))?/, method: "POST" },
      { pattern: /@PutMapping\s*(?:\(\s*\))?/, method: "PUT" },
      { pattern: /@DeleteMapping\s*(?:\(\s*\))?/, method: "DELETE" },
      { pattern: /@PatchMapping\s*(?:\(\s*\))?/, method: "PATCH" },
    ];

    for (const m of mappings) {
      const annotMatch = annotations.match(m.pattern);
      if (annotMatch) {
        httpMapping = { method: m.method, path: annotMatch[1] || "" };
        break;
      }
    }

    if (!httpMapping) {
      const rmMatch = annotations.match(
        /@RequestMapping\s*\([^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH)[^)]*value\s*=\s*["']([^"']+)["']/
      );
      const rmMatchAlt = annotations.match(
        /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/
      );
      if (rmMatch) {
        httpMapping = { method: rmMatch[1], path: rmMatch[2] };
      } else if (rmMatchAlt) {
        httpMapping = { method: rmMatchAlt[2], path: rmMatchAlt[1] };
      }
    }

    methods.push({
      className,
      methodName,
      visibility,
      returnType,
      params,
      body,
      lineNumber,
      httpMapping,
      methodCalls,
    });
  }

  return methods;
}

function buildClassIndex(filePath: string, content: string): ClassIndex | null {
  const className = getClassName(content);
  if (className === "Unknown") return null;

  const packageName = extractPackageName(content);
  const annotations = extractAnnotations(content);
  const injectedFields = extractInjectedFields(content, className);
  const methods = extractMethods(content, className);
  const extendsClass = getExtendsClass(content);

  const isController = annotations.includes("RestController") || annotations.includes("Controller");
  const isService = annotations.includes("Service") || annotations.includes("Component");
  const isRepository = annotations.includes("Repository") ||
    /extends\s+(?:JpaRepository|CrudRepository|PagingAndSortingRepository|MongoRepository)/.test(content);
  const isEntity = annotations.includes("Entity");

  let basePath = "";
  const basePathMatch = content.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
  if (basePathMatch) basePath = basePathMatch[1];

  let tableName = "";
  let entityFields: string[] = [];
  if (isEntity) {
    const tableMatch = content.match(/@Table\s*\(\s*name\s*=\s*["']([^"']+)["']/);
    tableName = tableMatch ? tableMatch[1] : className.toLowerCase();
    entityFields = extractEntityFields(content);
  }

  return {
    className,
    packageName,
    annotations,
    injectedFields,
    methods,
    sourceFile: filePath,
    isController,
    isService,
    isRepository,
    isEntity,
    basePath,
    tableName,
    entityFields,
    extendsClass,
  };
}

function detectPersistenceOp(methodName: string): string | null {
  if (PERSISTENCE_SAVE.some((s) => methodName.toLowerCase() === s.toLowerCase() || methodName.toLowerCase().startsWith(s.toLowerCase()))) {
    return "save";
  }
  if (PERSISTENCE_DELETE.some((d) => methodName.toLowerCase() === d.toLowerCase() || methodName.toLowerCase().startsWith(d.toLowerCase()))) {
    return "delete";
  }
  if (PERSISTENCE_UPDATE.some((u) => methodName.toLowerCase() === u.toLowerCase() || methodName.toLowerCase().startsWith(u.toLowerCase()))) {
    return "update";
  }
  return null;
}

function detectStateChange(methodBody: string): boolean {
  return STATE_CHANGE_PATTERNS.test(methodBody);
}

function resolveMethodTarget(
  call: MethodCallRef,
  currentClass: ClassIndex,
  classMap: Map<string, ClassIndex>
): ClassIndex | null {
  if (call.targetVariable === "this") {
    return currentClass;
  }

  const fieldType = currentClass.injectedFields.get(call.targetVariable);
  if (fieldType) {
    return classMap.get(fieldType) || null;
  }

  const allClasses = Array.from(classMap.values());
  for (const cls of allClasses) {
    if (cls.className === call.targetVariable) {
      return cls;
    }
  }

  return null;
}

function traceCallGraph(
  startClass: ClassIndex,
  startMethod: MethodIndex,
  classMap: Map<string, ClassIndex>,
  maxDepth: number = 15
): CallChainResult {
  const fullCallChain: string[] = [];
  const entitiesTouched = new Set<string>();
  const persistenceOperations = new Set<string>();
  const repositoryCalls: string[] = [];
  const serviceMethods: string[] = [];
  const visited = new Set<string>();

  function trace(cls: ClassIndex, method: MethodIndex, depth: number) {
    if (depth > maxDepth) return;

    const signature = `${cls.className}.${method.methodName}`;
    if (visited.has(signature)) return;
    visited.add(signature);

    fullCallChain.push(signature);

    if (detectStateChange(method.body)) {
      persistenceOperations.add("state_change");
    }

    for (const call of method.methodCalls) {
      const targetClass = resolveMethodTarget(call, cls, classMap);

      if (targetClass && targetClass.isRepository) {
        const repoCall = `${targetClass.className}.${call.methodName}`;
        repositoryCalls.push(repoCall);
        fullCallChain.push(repoCall);

        const entityName = targetClass.className
          .replace(/Repository$/, "")
          .replace(/Repo$/, "");
        if (entityName) entitiesTouched.add(entityName);

        if (targetClass.extendsClass) {
          const repoEntityMatch = targetClass.extendsClass.match(
            /(?:JpaRepository|CrudRepository|PagingAndSortingRepository)<(\w+)/
          );
        }

        const op = detectPersistenceOp(call.methodName);
        if (op) persistenceOperations.add(op);

      } else if (targetClass) {
        if (targetClass.isService || targetClass.className !== cls.className) {
          serviceMethods.push(`${targetClass.className}.${call.methodName}`);
        }

        const targetMethod = targetClass.methods.find(
          (m) => m.methodName === call.methodName
        );
        if (targetMethod) {
          trace(targetClass, targetMethod, depth + 1);
        }
      } else if (call.targetVariable === "this") {
        const sameClassMethod = cls.methods.find(
          (m) => m.methodName === call.methodName
        );
        if (sameClassMethod) {
          trace(cls, sameClassMethod, depth + 1);
        }
      } else {
        const varType = cls.injectedFields.get(call.targetVariable);
        if (varType && (varType.endsWith("Repository") || varType.endsWith("Repo"))) {
          const repoCall = `${varType}.${call.methodName}`;
          repositoryCalls.push(repoCall);
          fullCallChain.push(repoCall);

          const entityName = varType
            .replace(/Repository$/, "")
            .replace(/Repo$/, "");
          if (entityName) entitiesTouched.add(entityName);

          const op = detectPersistenceOp(call.methodName);
          if (op) persistenceOperations.add(op);
        }
      }
    }
  }

  trace(startClass, startMethod, 0);

  return {
    fullCallChain,
    entitiesTouched: Array.from(entitiesTouched),
    persistenceOperations: Array.from(persistenceOperations),
    repositoryCalls: Array.from(new Set(repositoryCalls)),
    serviceMethods: Array.from(new Set(serviceMethods)),
  };
}

export function analyzeJavaFiles(files: { filePath: string; content: string }[]) {
  const javaFiles = files.filter((f) => f.filePath.endsWith(".java"));

  const classMap = new Map<string, ClassIndex>();
  const allClasses: ClassIndex[] = [];

  for (const file of javaFiles) {
    const cls = buildClassIndex(file.filePath, file.content);
    if (cls) {
      classMap.set(cls.className, cls);
      allClasses.push(cls);
    }
  }

  const endpoints: JavaEndpoint[] = [];
  const serviceMethods: JavaServiceMethod[] = [];
  const entities: JavaEntity[] = [];

  for (const cls of allClasses) {
    if (cls.isEntity) {
      entities.push({
        className: cls.className,
        tableName: cls.tableName,
        fields: cls.entityFields,
        sourceFile: cls.sourceFile,
      });
    }

    if (cls.isService) {
      for (const method of cls.methods) {
        const repoCalls: string[] = [];
        const entityNames: string[] = [];
        const nestedCalls: string[] = [];

        for (const call of method.methodCalls) {
          const fieldType = cls.injectedFields.get(call.targetVariable);
          if (fieldType) {
            if (fieldType.endsWith("Repository") || fieldType.endsWith("Repo")) {
              repoCalls.push(`${fieldType}.${call.methodName}`);
              const entityName = fieldType.replace(/Repository$/, "").replace(/Repo$/, "");
              if (entityName && !entityNames.includes(entityName)) entityNames.push(entityName);
            } else if (fieldType.endsWith("Service")) {
              nestedCalls.push(`${fieldType}.${call.methodName}`);
            }
          }
        }

        if (repoCalls.length > 0 || nestedCalls.length > 0) {
          serviceMethods.push({
            className: cls.className,
            methodName: method.methodName,
            repositoryCalls: Array.from(new Set(repoCalls)),
            entitiesTouched: Array.from(new Set(entityNames)),
            nestedServiceCalls: Array.from(new Set(nestedCalls)),
            sourceFile: cls.sourceFile,
          });
        }
      }
    }

    if (cls.isController) {
      for (const method of cls.methods) {
        if (!method.httpMapping) continue;

        const fullPath = `${cls.basePath}${method.httpMapping.path}`.replace(/\/+/g, "/") || cls.basePath || "/";

        const result = traceCallGraph(cls, method, classMap);

        endpoints.push({
          className: cls.className,
          methodName: method.methodName,
          httpMethod: method.httpMapping.method,
          path: method.httpMapping.path,
          fullPath,
          serviceCalls: result.serviceMethods,
          repositoryCalls: result.repositoryCalls,
          entitiesTouched: result.entitiesTouched,
          fullCallChain: result.fullCallChain,
          persistenceOperations: result.persistenceOperations,
          sourceFile: cls.sourceFile,
          lineNumber: method.lineNumber,
        });
      }
    }
  }

  return { endpoints, serviceMethods, entities };
}

import {
  ApplicationGraph,
  GraphNode,
  GraphEdge,
  type NodeType,
  type EndpointImpact,
  analyzeEndpoints as graphAnalyzeEndpoints,
} from "./application-graph";

export { ApplicationGraph, GraphNode, GraphEdge };
export type { EndpointImpact };

export function buildApplicationGraph(
  files: { filePath: string; content: string }[]
): ApplicationGraph {
  const javaFiles = files.filter((f) => f.filePath.endsWith(".java"));
  const graph = new ApplicationGraph();

  const classMap = new Map<string, ClassIndex>();
  const allClasses: ClassIndex[] = [];

  for (const file of javaFiles) {
    const cls = buildClassIndex(file.filePath, file.content);
    if (cls) {
      classMap.set(cls.className, cls);
      allClasses.push(cls);
    }
  }

  for (const cls of allClasses) {
    if (cls.isEntity) {
      graph.addNode(
        new GraphNode("ENTITY", cls.className, null, {
          tableName: cls.tableName,
          fields: cls.entityFields,
          sourceFile: cls.sourceFile,
        })
      );
    }

    if (cls.isRepository) {
      for (const method of cls.methods) {
        graph.addNode(
          new GraphNode("REPOSITORY", cls.className, method.methodName, {
            sourceFile: cls.sourceFile,
            lineNumber: method.lineNumber,
          })
        );
        const entityName = cls.className
          .replace(/Repository$/, "")
          .replace(/Repo$/, "");
        const entityNodeId = `ENTITY:${entityName}`;
        if (graph.getNode(entityNodeId)) {
          const op = detectPersistenceOp(method.methodName);
          if (op && (op === "save" || op === "update" || op === "delete")) {
            graph.addEdge(
              new GraphEdge(
                `REPOSITORY:${cls.className}.${method.methodName}`,
                entityNodeId,
                "WRITES_ENTITY",
                { operation: op }
              )
            );
          } else {
            graph.addEdge(
              new GraphEdge(
                `REPOSITORY:${cls.className}.${method.methodName}`,
                entityNodeId,
                "READS_ENTITY",
                { operation: op || "read" }
              )
            );
          }
        }
      }
    }

    if (cls.isService) {
      for (const method of cls.methods) {
        graph.addNode(
          new GraphNode("SERVICE", cls.className, method.methodName, {
            visibility: method.visibility,
            sourceFile: cls.sourceFile,
            lineNumber: method.lineNumber,
          })
        );
      }
    }

    if (cls.isController) {
      for (const method of cls.methods) {
        if (!method.httpMapping) continue;
        const fullPath =
          `${cls.basePath}${method.httpMapping.path}`.replace(/\/+/g, "/") ||
          cls.basePath ||
          "/";
        graph.addNode(
          new GraphNode("CONTROLLER", cls.className, method.methodName, {
            httpMethod: method.httpMapping.method,
            path: method.httpMapping.path,
            fullPath,
            sourceFile: cls.sourceFile,
            lineNumber: method.lineNumber,
          })
        );
      }
    }
  }

  for (const cls of allClasses) {
    if (cls.isEntity) continue;

    const nodeType: "CONTROLLER" | "SERVICE" | "REPOSITORY" =
      cls.isController ? "CONTROLLER" : cls.isService ? "SERVICE" : "REPOSITORY";

    for (const method of cls.methods) {
      if (cls.isController && !method.httpMapping) continue;

      const fromId = `${nodeType}:${cls.className}.${method.methodName}`;
      if (!graph.getNode(fromId)) continue;

      for (const call of method.methodCalls) {
        const targetClass = resolveMethodTarget(call, cls, classMap);

        if (targetClass && targetClass.isRepository) {
          const repoNodeId = `REPOSITORY:${targetClass.className}.${call.methodName}`;
          if (!graph.getNode(repoNodeId)) {
            graph.addNode(
              new GraphNode("REPOSITORY", targetClass.className, call.methodName, {
                sourceFile: targetClass.sourceFile,
                synthetic: true,
              })
            );
            const entityName = targetClass.className
              .replace(/Repository$/, "")
              .replace(/Repo$/, "");
            const entityNodeId = `ENTITY:${entityName}`;
            if (graph.getNode(entityNodeId)) {
              const op = detectPersistenceOp(call.methodName);
              if (op && (op === "save" || op === "update" || op === "delete")) {
                graph.addEdge(
                  new GraphEdge(repoNodeId, entityNodeId, "WRITES_ENTITY", { operation: op })
                );
              } else {
                graph.addEdge(
                  new GraphEdge(repoNodeId, entityNodeId, "READS_ENTITY", { operation: op || "read" })
                );
              }
            }
          }
          graph.addEdge(new GraphEdge(fromId, repoNodeId, "CALLS"));
        } else if (targetClass) {
          const targetMethod = targetClass.methods.find(
            (m) => m.methodName === call.methodName
          );
          if (targetMethod) {
            const targetType: NodeType = targetClass.isController
              ? "CONTROLLER"
              : targetClass.isService
              ? "SERVICE"
              : "REPOSITORY";
            const toId = `${targetType}:${targetClass.className}.${call.methodName}`;
            if (graph.getNode(toId)) {
              graph.addEdge(new GraphEdge(fromId, toId, "CALLS"));
            }
          }
        } else if (call.targetVariable === "this") {
          const sameClassMethod = cls.methods.find(
            (m) => m.methodName === call.methodName
          );
          if (sameClassMethod) {
            const toId = `${nodeType}:${cls.className}.${call.methodName}`;
            if (graph.getNode(toId)) {
              graph.addEdge(new GraphEdge(fromId, toId, "CALLS"));
            }
          }
        } else {
          const varType = cls.injectedFields.get(call.targetVariable);
          if (varType && (varType.endsWith("Repository") || varType.endsWith("Repo"))) {
            const repoNodeId = `REPOSITORY:${varType}.${call.methodName}`;
            if (!graph.getNode(repoNodeId)) {
              graph.addNode(
                new GraphNode("REPOSITORY", varType, call.methodName, { synthetic: true })
              );
              const entityName = varType.replace(/Repository$/, "").replace(/Repo$/, "");
              const entityNodeId = `ENTITY:${entityName}`;
              if (graph.getNode(entityNodeId)) {
                const op = detectPersistenceOp(call.methodName);
                if (op && (op === "save" || op === "update" || op === "delete")) {
                  graph.addEdge(
                    new GraphEdge(repoNodeId, entityNodeId, "WRITES_ENTITY", { operation: op })
                  );
                } else {
                  graph.addEdge(
                    new GraphEdge(repoNodeId, entityNodeId, "READS_ENTITY", { operation: op || "read" })
                  );
                }
              }
            }
            graph.addEdge(new GraphEdge(fromId, repoNodeId, "CALLS"));
          }
        }
      }

      if (detectStateChange(method.body)) {
        const entityRefs = new Set<string>();
        for (const call of method.methodCalls) {
          const tc = resolveMethodTarget(call, cls, classMap);
          if (tc && tc.isRepository) {
            const entityName = tc.className.replace(/Repository$/, "").replace(/Repo$/, "");
            if (entityName) entityRefs.add(entityName);
          }
        }
        for (const varType of Array.from(cls.injectedFields.values())) {
          if (varType.endsWith("Repository") || varType.endsWith("Repo")) {
            const entityName = varType.replace(/Repository$/, "").replace(/Repo$/, "");
            if (entityName) entityRefs.add(entityName);
          }
        }
        for (const entityName of Array.from(entityRefs)) {
          const entityNodeId = `ENTITY:${entityName}`;
          if (graph.getNode(entityNodeId)) {
            graph.addEdge(
              new GraphEdge(fromId, entityNodeId, "WRITES_ENTITY", { operation: "state_change" })
            );
          }
        }
      }
    }
  }

  return graph;
}

export function analyzeGraphEndpoints(graph: ApplicationGraph): EndpointImpact[] {
  return graphAnalyzeEndpoints(graph);
}

export function inferOperationType(
  serviceCalls: string[],
  repositoryCalls: string[],
  httpMethod: string | null,
  persistenceOps?: string[]
): string {
  if (persistenceOps && persistenceOps.length > 0) {
    if (persistenceOps.includes("delete")) return "DELETE";
    if (persistenceOps.includes("state_change")) return "STATE_CHANGE";
    if (persistenceOps.includes("save") || persistenceOps.includes("update")) {
      if (httpMethod === "PUT" || httpMethod === "PATCH") return "STATE_CHANGE";
      return "WRITE";
    }
  }

  for (const call of repositoryCalls) {
    const methodName = call.split(".").pop() || "";
    if (PERSISTENCE_DELETE.some((d) => methodName.toLowerCase().includes(d.toLowerCase()))) {
      return "DELETE";
    }
    if (PERSISTENCE_SAVE.some((s) => methodName.toLowerCase().includes(s.toLowerCase()))) {
      if (httpMethod === "PUT" || httpMethod === "PATCH") return "STATE_CHANGE";
      return "WRITE";
    }
    if (PERSISTENCE_READ.some((r) => methodName.toLowerCase().includes(r.toLowerCase()))) {
      return "READ";
    }
  }

  if (httpMethod) {
    const methodMap: Record<string, string> = {
      GET: "READ", POST: "WRITE", PUT: "STATE_CHANGE",
      PATCH: "STATE_CHANGE", DELETE: "DELETE",
    };
    return methodMap[httpMethod] || "READ";
  }

  return "READ";
}

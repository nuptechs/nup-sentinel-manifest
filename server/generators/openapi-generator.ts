import type { ManifestData } from "./manifest-generator";

interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
    "x-generated-by": string;
    "x-generated-at": string;
  };
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components: {
    schemas: Record<string, any>;
    securitySchemes: Record<string, any>;
  };
  security: { [key: string]: string[] }[];
}

interface OpenAPIOperation {
  summary: string;
  operationId: string;
  tags: string[];
  security?: { [key: string]: string[] }[];
  "x-manifest": {
    technicalOperation: string;
    criticalityScore: number;
    entitiesTouched: string[];
    sensitiveFieldsAccessed: string[];
    serviceMethods: string[];
    repositoryMethods: string[];
    fullCallChain: string[];
  };
  responses: Record<string, { description: string }>;
}

export function generateOpenAPISpec(manifest: ManifestData): OpenAPISpec {
  const paths: Record<string, Record<string, OpenAPIOperation>> = {};

  for (const ep of manifest.endpoints) {
    const pathKey = convertToOpenAPIPath(ep.path);
    if (!paths[pathKey]) paths[pathKey] = {};

    const method = ep.method.toLowerCase();
    const operationId = buildOperationId(ep.controller, ep.controllerMethod, method, ep.path);
    const tags = ep.controller ? [ep.controller.replace(/Controller$/, "")] : [extractTagFromPath(ep.path)];

    const operation: OpenAPIOperation = {
      summary: buildSummary(ep.technicalOperation, ep.path, ep.controllerMethod),
      operationId,
      tags,
      "x-manifest": {
        technicalOperation: ep.technicalOperation,
        criticalityScore: ep.criticalityScore,
        entitiesTouched: ep.entitiesTouched,
        sensitiveFieldsAccessed: ep.sensitiveFieldsAccessed,
        serviceMethods: ep.serviceMethods,
        repositoryMethods: ep.repositoryMethods,
        fullCallChain: [],
      },
      responses: {
        "200": { description: "Successful operation" },
      },
    };

    if (ep.requiredRoles.length > 0) {
      operation.security = [{ bearerAuth: ep.requiredRoles }];
    }

    if (method === "delete") {
      operation.responses["204"] = { description: "Resource deleted" };
    }
    if (method === "post" || method === "put") {
      operation.responses["201"] = { description: "Resource created/updated" };
      operation.responses["400"] = { description: "Invalid request" };
    }
    if (ep.requiredRoles.length > 0) {
      operation.responses["401"] = { description: "Authentication required" };
      operation.responses["403"] = { description: `Forbidden — requires: ${ep.requiredRoles.join(", ")}` };
    }

    paths[pathKey][method] = operation;
  }

  const entitySchemas: Record<string, any> = {};
  for (const entity of manifest.entities) {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    if (entity.fieldMetadata.length > 0) {
      for (const field of entity.fieldMetadata) {
        properties[field.name] = {
          type: mapJavaTypeToOpenAPI(field.type),
          ...(field.isId ? { "x-primary-key": true } : {}),
          ...(field.isSensitive ? { "x-sensitive": true, description: "Sensitive field — contains PII or credentials" } : {}),
          ...(field.validations && field.validations.length > 0 ? { "x-validations": field.validations } : {}),
        };
        if (field.isId) required.push(field.name);
      }
    } else {
      properties["id"] = { type: "integer", "x-primary-key": true };
    }

    entitySchemas[entity.name] = {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      "x-manifest": {
        operations: entity.operations,
        sensitiveFields: entity.sensitiveFields,
      },
    };
  }

  const securitySchemes: Record<string, any> = {};
  if (manifest.roles.length > 0) {
    securitySchemes["bearerAuth"] = {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description: `Roles available: ${manifest.roles.map(r => r.name).join(", ")}`,
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: `${manifest.project.name} — API Specification`,
      description: `Auto-generated OpenAPI specification derived from static code analysis by Manifest.\n\nSecurity Coverage: ${manifest.summary.securityCoverage}% of endpoints have explicit security annotations.\nAverage Criticality: ${manifest.summary.averageCriticality}/100.`,
      version: manifest.version,
      "x-generated-by": "Manifest",
      "x-generated-at": manifest.generatedAt,
    },
    paths,
    components: {
      schemas: entitySchemas,
      securitySchemes,
    },
    security: manifest.roles.length > 0 ? [{ bearerAuth: [] }] : [],
  };
}

function convertToOpenAPIPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, "{$1}");
}

function buildOperationId(controller: string, method: string, httpMethod: string, path: string): string {
  if (controller && method) {
    return `${controller}.${method}`;
  }
  const segments = path.split("/").filter(Boolean).map(s => s.replace(/[{}]/g, ""));
  const meaningful = segments.filter(s => s !== "api" && s !== "param");
  const base = meaningful.length > 0 ? meaningful.join("_") : segments.join("_") || "root";
  return `${httpMethod}_${base}`;
}

function buildSummary(operation: string, path: string, method: string): string {
  if (method) return `${operation}: ${method}`;
  const segments = path.split("/").filter(s => s && s !== "api" && !s.startsWith("{"));
  const resource = segments[segments.length - 1] || path;
  return `${operation} ${resource}`;
}

function extractTagFromPath(path: string): string {
  const segments = path.split("/").filter(s => s && s !== "api" && !s.startsWith("{"));
  if (segments.length > 0) {
    const tag = segments[0];
    return tag.charAt(0).toUpperCase() + tag.slice(1);
  }
  return "default";
}

function mapJavaTypeToOpenAPI(javaType: string): string {
  const lower = javaType.toLowerCase();
  if (lower.includes("string") || lower.includes("char")) return "string";
  if (lower.includes("long") || lower.includes("bigint")) return "integer";
  if (lower.includes("int") || lower.includes("short")) return "integer";
  if (lower.includes("double") || lower.includes("float") || lower.includes("decimal") || lower.includes("bigdecimal")) return "number";
  if (lower.includes("bool")) return "boolean";
  if (lower.includes("date") || lower.includes("time") || lower.includes("instant")) return "string";
  if (lower.includes("list") || lower.includes("set") || lower.includes("collection")) return "array";
  return "string";
}

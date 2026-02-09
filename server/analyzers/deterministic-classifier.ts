import type { InsertCatalogEntry } from "@shared/schema";

export function classifyEntriesDeterministic(
  entries: InsertCatalogEntry[]
): InsertCatalogEntry[] {
  return entries.map((entry) => {
    const technicalOperation = entry.technicalOperation || inferFromHttp(entry.httpMethod ?? null);
    const criticalityScore = computeCriticality(technicalOperation, entry);
    const suggestedMeaning = buildSuggestedMeaning(entry, technicalOperation);

    return {
      ...entry,
      technicalOperation,
      criticalityScore,
      suggestedMeaning,
    };
  });
}

function inferFromHttp(httpMethod: string | null): string {
  switch (httpMethod?.toUpperCase()) {
    case "GET": return "READ";
    case "POST": return "WRITE";
    case "PUT": return "WRITE";
    case "PATCH": return "STATE_CHANGE";
    case "DELETE": return "DELETE";
    default: return "NAVIGATION";
  }
}

function computeCriticality(
  operation: string,
  entry: InsertCatalogEntry
): number {
  let score = 0;

  switch (operation) {
    case "DELETE":
      score = 60;
      break;
    case "WRITE":
    case "CREATE":
      score = 40;
      break;
    case "UPDATE":
      score = 45;
      break;
    case "STATE_CHANGE":
      score = 50;
      break;
    case "AUTHENTICATION":
      score = 80;
      break;
    case "EXTERNAL_INTEGRATION":
      score = 70;
      break;
    case "FILE_IO":
      score = 55;
      break;
    case "EXPORT":
      score = 30;
      break;
    case "READ":
      score = 10;
      break;
    case "NAVIGATION":
      score = 5;
      break;
    default:
      score = 20;
      break;
  }

  const entities = (entry.entitiesTouched as string[]) || [];
  if (entities.length > 0) {
    score += Math.min(entities.length * 5, 15);
  }

  const sensitive = [
    "user", "auth", "token", "password", "credential",
    "payment", "invoice", "order", "transaction",
    "role", "permission", "session",
  ];
  for (const entity of entities) {
    if (sensitive.some((s) => entity.toLowerCase().includes(s))) {
      score += 15;
      break;
    }
  }

  const persistenceOps = (entry.persistenceOperations as string[]) || [];
  if (persistenceOps.some((op) => op.toLowerCase().includes("delete"))) {
    score = Math.max(score, 60);
  }
  if (persistenceOps.some((op) => op.toLowerCase().includes("save"))) {
    score = Math.max(score, 35);
  }

  return Math.min(100, Math.max(0, score));
}

function buildSuggestedMeaning(
  entry: InsertCatalogEntry,
  operation: string
): string {
  const entities = (entry.entitiesTouched as string[]) || [];
  const entityStr = entities.length > 0 ? entities.join(", ") : null;

  const verb = operationVerb(operation);

  if (entry.controllerMethod && entityStr) {
    return `${verb} ${entityStr} via ${entry.controllerMethod}`;
  }
  if (entityStr) {
    return `${verb} ${entityStr}`;
  }
  if (entry.endpoint) {
    return `${verb} ${entry.endpoint}`;
  }
  return `${entry.interaction} on ${entry.screen}`;
}

function operationVerb(operation: string): string {
  switch (operation) {
    case "READ": return "View";
    case "WRITE": return "Create";
    case "CREATE": return "Create";
    case "UPDATE": return "Update";
    case "DELETE": return "Delete";
    case "STATE_CHANGE": return "Modify";
    case "EXPORT": return "Export";
    case "FILE_IO": return "Process file for";
    case "EXTERNAL_INTEGRATION": return "Integrate with";
    case "AUTHENTICATION": return "Authenticate";
    case "NAVIGATION": return "Navigate to";
    default: return "Access";
  }
}

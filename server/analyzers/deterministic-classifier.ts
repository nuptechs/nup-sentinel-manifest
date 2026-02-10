import type { InsertCatalogEntry } from "@shared/schema";

export function classifyEntriesDeterministic(
  entries: InsertCatalogEntry[]
): InsertCatalogEntry[] {
  return entries.map((entry) => {
    let technicalOperation = entry.technicalOperation || "UNKNOWN";
    if (technicalOperation === "UNKNOWN") {
      technicalOperation = inferFromContext(entry);
    }
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

function inferFromContext(entry: InsertCatalogEntry): string {
  if (entry.httpMethod) {
    return inferFromHttp(entry.httpMethod);
  }

  const interaction = entry.interaction || "";
  const actionName = extractActionName(interaction);
  const actionLower = actionName.toLowerCase();
  const interLower = interaction.toLowerCase();

  if (isClientStatePattern(actionName)) {
    return "CLIENT_STATE";
  }

  if (isAuthPattern(actionLower)) {
    return "AUTHENTICATION";
  }

  if (isNavigationPattern(actionLower, interLower)) {
    return "NAVIGATION";
  }

  if (isFilePattern(actionLower)) {
    return "FILE_IO";
  }

  return "NAVIGATION";
}

function extractActionName(interaction: string): string {
  const match = interaction.match(/:\s*(\w+)/);
  return match ? match[1] : interaction;
}

function isNavigationPattern(actionName: string, interaction: string): boolean {
  const navPatterns = [
    "navigate", "redirect", "goto", "goback", "pushstate", "replacestate",
    "window.location", "router.push", "router.replace", "history.push",
    "openurl", "openlink", "opentab",
  ];
  if (navPatterns.some(p => actionName.includes(p))) return true;
  if (interaction.includes("window.location") || interaction.includes("router.")) return true;
  if (interaction.includes("href") || interaction.includes("routerlink")) return true;
  return false;
}

function isClientStatePattern(actionName: string): boolean {
  const camelCasePatterns = [
    /^set[A-Z]/, /^toggle[A-Z]/, /^reset[A-Z]/, /^clear[A-Z]/,
    /^show[A-Z]/, /^hide[A-Z]/, /^open[A-Z]/, /^close[A-Z]/,
    /^enable[A-Z]/, /^disable[A-Z]/, /^expand[A-Z]/, /^collapse[A-Z]/,
  ];
  if (camelCasePatterns.some(p => p.test(actionName))) return true;

  const lower = actionName.toLowerCase();
  const prefixes = ["set", "toggle", "reset", "clear", "show", "hide", "open", "close", "enable", "disable", "expand", "collapse"];
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix) && lower.length > prefix.length) return true;
  }

  return false;
}

function isAuthPattern(actionName: string): boolean {
  const authPatterns = [
    "login", "logout", "signin", "signout", "signup", "register",
    "authenticate", "authorize", "resetpassword", "forgotpassword",
    "changepassword", "verifyemail", "confirmemail", "resendemail",
    "refreshtoken",
  ];
  return authPatterns.some(p => actionName.includes(p));
}

function isFilePattern(actionName: string): boolean {
  const filePatterns = [
    "upload", "download", "import", "export",
    "selectfile", "choosefile", "openfile", "savefile",
  ];
  return filePatterns.some(p => actionName.includes(p));
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
    case "CLIENT_STATE":
      score = 2;
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
    case "CLIENT_STATE": return "Toggle";
    case "EXPORT": return "Export";
    case "FILE_IO": return "Process file for";
    case "EXTERNAL_INTEGRATION": return "Integrate with";
    case "AUTHENTICATION": return "Authenticate";
    case "NAVIGATION": return "Navigate to";
    default: return "Access";
  }
}

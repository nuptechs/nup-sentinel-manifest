import _ts from "typescript";
import type { FileAuthPatterns } from "./types";
import type { ScriptSymbolTable } from "./symbol-table";

import ts = _ts;

export function detectFileAuthPatterns(sourceFile: ts.SourceFile, content: string): FileAuthPatterns {
  const guards: string[] = [];
  const roles: string[] = [];
  let authRequired = false;

  const AUTH_HOOK_PATTERNS = /\b(useAuth|useAuthentication|useSession|useUser|usePermission|useAuthorization|useLogin|useCurrentUser)\b/;
  const AUTH_HOC_PATTERNS = /\b(withAuth|withAuthentication|withSession|withUser|withPermission|requireAuth)\b/;
  const AUTH_HEADER_PATTERNS = /['"`]Authorization['"`]|Bearer\s|X-API-Key|x-auth-token/i;
  const TOKEN_PATTERNS = /localStorage\s*\.\s*getItem\s*\(\s*['"`](token|access_token|auth_token|jwt|session|sessionId)['"`]\s*\)|sessionStorage\s*\.\s*getItem/i;

  if (AUTH_HOOK_PATTERNS.test(content)) {
    const match = content.match(AUTH_HOOK_PATTERNS);
    if (match) {
      guards.push(`hook:${match[1]}`);
      authRequired = true;
    }
  }

  if (AUTH_HOC_PATTERNS.test(content)) {
    const match = content.match(AUTH_HOC_PATTERNS);
    if (match) {
      guards.push(`hoc:${match[1]}`);
      authRequired = true;
    }
  }

  if (AUTH_HEADER_PATTERNS.test(content)) {
    guards.push("auth:header");
    authRequired = true;
  }

  if (TOKEN_PATTERNS.test(content)) {
    guards.push("auth:token");
    authRequired = true;
  }

  const ROLE_EXTRACT = /['"`](ADMIN|ROLE_ADMIN|admin|MANAGER|MODERATOR|EDITOR|VIEWER|SUPER_ADMIN|OPERATOR|USER|AUTHENTICATED)['"`]/g;
  const roleMatches = Array.from(content.matchAll(ROLE_EXTRACT));
  for (const m of roleMatches) {
    const role = m[1].toUpperCase();
    if (!roles.includes(role)) roles.push(role);
  }

  const CONDITIONAL_AUTH = /\{.*\b(isAdmin|isAuthenticated|isLoggedIn|isAuthorized|user\.role|currentUser)\b.*&&/;
  if (CONDITIONAL_AUTH.test(content)) {
    authRequired = true;
    const match = content.match(/(isAdmin|isAuthenticated|isLoggedIn|isAuthorized)/i);
    if (match) guards.push(`conditional:${match[1]}`);
  }

  if (authRequired && roles.length === 0) {
    roles.push("AUTHENTICATED");
  }

  return { guards, roles, authRequired };
}

export function detectHandlerSecurityGuards(
  handlerName: string,
  symbolTable: ScriptSymbolTable,
  sourceFile: ts.SourceFile
): string[] {
  const guards: string[] = [];
  const handlerNode = symbolTable.resolveHandlerNode(handlerName);
  if (!handlerNode) return guards;

  const seen = new Set<string>();

  const ROLE_KEYWORDS = /\b(role|roles|permission|permissions|authority|authorities|access|privilege|admin|moderator|editor|viewer|manager|superadmin)\b/i;
  const ROLE_LITERALS = /['"`](ROLE_\w+|ADMIN|MODERATOR|EDITOR|VIEWER|MANAGER|SUPER_ADMIN|admin|moderator|editor|viewer|manager|user|guest|operator)['"`]/g;

  const walk = (node: ts.Node) => {
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      const condText = condition.getText(sourceFile);

      if (condText.match(/\.hasRole\s*\(/i) || condText.match(/\.hasAuthority\s*\(/i) || condText.match(/\.hasPermission\s*\(/i)) {
        const match = condText.match(/\.(hasRole|hasAuthority|hasPermission)\s*\(\s*['"`]([^'"` ]+)['"`]\s*\)/i);
        if (match) {
          const guard = `${match[1]}:${match[2]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }

      if (condText.match(/\.includes\s*\(/) && ROLE_KEYWORDS.test(condText)) {
        const roleMatches = Array.from(condText.matchAll(ROLE_LITERALS));
        for (const m of roleMatches) {
          const guard = `includes:${m[1]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }

      if (condText.match(/===?\s*['"`]/) && ROLE_KEYWORDS.test(condText)) {
        const roleMatches = Array.from(condText.matchAll(ROLE_LITERALS));
        for (const m of roleMatches) {
          const guard = `equals:${m[1]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }

      if (condText.match(/isAdmin|isAuthenticated|isLoggedIn|isAuthorized|canAccess|canEdit|canDelete|canCreate|hasAccess/i)) {
        const match = condText.match(/(isAdmin|isAuthenticated|isLoggedIn|isAuthorized|canAccess|canEdit|canDelete|canCreate|hasAccess)/i);
        if (match) {
          const guard = `check:${match[1]}`;
          if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callText = node.expression.getText(sourceFile);
      if (callText.match(/requireAuth|requireRole|checkPermission|guardRoute|authorize/i)) {
        const guard = `call:${callText}`;
        if (!seen.has(guard)) { seen.add(guard); guards.push(guard); }
      }
    }

    ts.forEachChild(node, walk);
  };

  walk(handlerNode);
  return guards;
}

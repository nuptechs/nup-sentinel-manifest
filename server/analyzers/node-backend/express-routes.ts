// ─────────────────────────────────────────────
// Parser de rotas Express — ADR-0015 Onda 1, D1 (balde node-backend).
//
// Extrai a SUPERFÍCIE DE API de um backend Node/Express: cada
// `router.<verbo>('/path', ...middleware, handler)` vira um endpoint real,
// com o prefixo do `app.use('/prefix', router)` composto no path completo e
// as roles derivadas do middleware de permissão (`requirePermission('x')`).
//
// Vive ATRÁS da flag MANIFEST_MULTISTACK_NODE (server/config/multistack.ts).
// DEFAULT OFF: nenhum chamador invoca este módulo sem `nodeBackend` ligado,
// então o pipeline atual (stack Java/WsV1) segue byte-a-byte idêntico (G2).
// Com a flag ON, a saída é SUPERSET estrito — só ENTRA endpoint novo, nada
// some (G3). Canário do gate: `webhookRouter.get('/inbound/:id', requirePermission('webhooks.read'))`
// montado em `app.use('/webhooks', webhookRouter)` ⇒ endpoint
// `GET /webhooks/inbound/:id` com requiredRoles=['webhooks.read'].
//
// Extração por regex determinística (mesmo estilo de extractGatewayPrefixes),
// sem AST: o motor AST próprio é Java-only. Escopo do D1: rotas em router/app
// declarados por `express()` / `express.Router()` / `Router()`, mount de um
// nível. Cadeia de chamada → Drizzle → entidade é entrega posterior (D4/D5).
// ─────────────────────────────────────────────

import type { InsertCatalogEntry } from "@shared/schema";
import {
  extractDrizzleEntities,
  drizzleSymbolIndex,
  type DrizzleEntity,
} from "./drizzle-schema";
import { buildBackendCallChain, resolveTouches } from "./call-chain";

export interface ExpressRoute {
  /** Verbo HTTP em maiúsculas: GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD, ALL. */
  method: string;
  /** Path completo já com o prefixo do mount composto (ex.: /webhooks/inbound/:id). */
  path: string;
  /** Variável do router/app onde a rota foi registrada (ex.: webhookRouter). */
  routerVar: string;
  /** Roles exigidas, extraídas do middleware de permissão do próprio callsite. */
  requiredRoles: string[];
  /** Texto do middleware de permissão reconhecido (para securityAnnotations). */
  permissionExpression: string | null;
  /** Entidades Drizzle tocadas pelo handler (nome de tabela), ordenadas. */
  entitiesTouched: string[];
  /** Operações de persistência do handler: read/write/delete, ordenadas. */
  persistenceOperations: string[];
  /**
   * Cadeia multi-hop até o 1º toque Drizzle (Onda 2 D9): ["file::fn", ...],
   * começando no handler. Vazia quando o toque é same-file ou não há toque.
   */
  callChain: string[];
  sourceFile: string;
  lineNumber: number;
}

// Verbos de rota do Express (router.get, router.post, ...). `use` fica de fora
// de propósito — é mount, não rota.
const HTTP_VERBS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "all",
]);

// Middleware de autorização cujo 1º+ argumento string é a role exigida.
// Cobre os nomes convencionais; ampliável sem quebrar o contrato do gate.
const PERMISSION_FNS = [
  "requirePermission",
  "requirePermissions",
  "requireRole",
  "requireRoles",
  "requireAnyRole",
  "hasPermission",
  "hasRole",
  "hasAnyRole",
  "authorize",
  "checkPermission",
  "ensurePermission",
  "can",
];

// `const app = express()` / `const r = express.Router()` / `const r = Router()`.
const ROUTER_DECL_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:express\s*\(\s*\)|express\s*\.\s*Router\s*\(\s*\)|Router\s*\(\s*\))/g;

// `app.use('/prefix', routerVar)` — mount de um router sob um prefixo.
const MOUNT_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*use\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;

// `<var>.<verbo>('<path>'` — abre o callsite de uma rota. Os argumentos
// (middleware + handler) são lidos por varredura balanceada a partir do `(`.
const ROUTE_OPEN_RE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*([a-z]+)\s*\(\s*['"`]([^'"`]*)['"`]/g;

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

/** Junta prefixo + path colapsando barras duplicadas; sem barra final (exceto raiz). */
function joinPath(prefix: string, path: string): string {
  const raw = `${prefix || ""}/${path || ""}`.replace(/\/{2,}/g, "/");
  if (raw === "/") return "/";
  return raw.replace(/\/$/, "") || "/";
}

/**
 * A partir do índice logo após o `(` de abertura do callsite, varre os
 * argumentos até o parêntese que fecha a chamada, respeitando aspas e parênteses
 * aninhados (dos próprios middlewares). Devolve o texto cru dos argumentos.
 */
function readCallArgs(content: string, openParenIdx: number): string {
  let depth = 1;
  let i = openParenIdx + 1;
  let quote: string | null = null;
  const start = i;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === "\\") {
        i++; // escapa o próximo char
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  return content.slice(start, i);
}

/**
 * Resolve as entidades Drizzle tocadas pelo handler (dentro dos args da rota) e
 * a operação de persistência de cada uma. Reconhece os padrões do query-builder:
 *   .from(sym) / db.query.sym         → read
 *   insert(sym) / update(sym)          → write
 *   delete(sym)                        → delete
 *   referência nua a um símbolo conhecido → read (fallback)
 * Símbolos casados por nome (assume nomes únicos no backend Node — limite do D4).
 */
function resolveHandlerEntities(
  args: string,
  drizzle: Map<string, DrizzleEntity>,
): { entities: string[]; operations: string[] } {
  const entities = new Set<string>();
  const operations = new Set<string>();

  for (const [symbol, ent] of Array.from(drizzle.entries())) {
    const wordRe = new RegExp(`\\b${symbol}\\b`);
    if (!wordRe.test(args)) continue;

    let op: string;
    if (new RegExp(`\\bdelete\\s*\\(\\s*${symbol}\\b`).test(args)) {
      op = "delete";
    } else if (new RegExp(`\\b(?:insert|update)\\s*\\(\\s*${symbol}\\b`).test(args)) {
      op = "write";
    } else {
      // .from(sym), db.query.sym, ou referência nua ⇒ leitura.
      op = "read";
    }
    entities.add(ent.entity);
    operations.add(op);
  }

  return {
    entities: Array.from(entities).sort(),
    operations: Array.from(operations).sort(),
  };
}

/** Divide os args no nível superior (vírgulas fora de aspas/parênteses/chaves). */
function splitTopLevelArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return parts;
}

const BARE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Extrai (roles, expressão) do 1º middleware de permissão reconhecido nos args. */
function extractPermission(args: string): { roles: string[]; expression: string | null } {
  for (const fn of PERMISSION_FNS) {
    const callRe = new RegExp(`\\b${fn}\\s*\\(`, "g");
    const m = callRe.exec(args);
    if (!m) continue;
    const openIdx = m.index + m[0].length - 1;
    const inner = readCallArgs(args, openIdx);
    const roles: string[] = [];
    const strRe = /['"`]([^'"`]+)['"`]/g;
    let s: RegExpExecArray | null;
    while ((s = strRe.exec(inner)) !== null) roles.push(s[1]);
    if (roles.length > 0) {
      return { roles, expression: `${fn}(${inner.trim()})` };
    }
  }
  return { roles: [], expression: null };
}

/**
 * Varre os arquivos (não-.java) e extrai as rotas Express. Determinístico e
 * ordenado (method, path, routerVar). Sem router/app declarado por
 * express()/Router(), o arquivo é ignorado — evita falso-positivo em TS genérico.
 */
export function extractExpressRoutes(
  files: { filePath: string; content: string }[],
): ExpressRoute[] {
  const routes: ExpressRoute[] = [];
  // Índice de entidades Drizzle do backend inteiro (resolve refs de handler).
  const drizzle = drizzleSymbolIndex(extractDrizzleEntities(files));

  const EXPRESS_GUARD = /\bexpress\s*\(|\bexpress\s*\.\s*Router\s*\(|\bRouter\s*\(/;

  // Call-chain multi-hop (Onda 2 D8): grafo de chamadas do backend restrito ao
  // fecho de imports dos arquivos com rotas. Resolve handler → service → repo →
  // tabela quando o acesso Drizzle NÃO está no call-site (o scan same-file do
  // D4 continua cobrindo o caso local — os dois resultados são unidos).
  const routeFiles = files
    .filter((f) => !f.filePath.endsWith(".java") && EXPRESS_GUARD.test(f.content))
    .map((f) => f.filePath);
  const callChain =
    routeFiles.length > 0
      ? buildBackendCallChain(files, drizzle, { entryFiles: routeFiles })
      : null;

  for (const file of files) {
    if (file.filePath.endsWith(".java")) continue;
    const content = file.content;
    // Guarda barata: só arquivos que criam router/app entram no parser caro.
    if (!EXPRESS_GUARD.test(content)) {
      continue;
    }

    // 1) router/app declarados neste arquivo.
    const routerVars = new Set<string>();
    ROUTER_DECL_RE.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = ROUTER_DECL_RE.exec(content)) !== null) routerVars.add(d[1]);
    if (routerVars.size === 0) continue;

    // 2) mounts: routerVar → prefixo (um nível).
    const mountPrefix = new Map<string, string>();
    MOUNT_RE.lastIndex = 0;
    let mt: RegExpExecArray | null;
    while ((mt = MOUNT_RE.exec(content)) !== null) {
      const [, , prefix, mounted] = mt;
      if (!mountPrefix.has(mounted)) mountPrefix.set(mounted, prefix);
    }

    // 3) rotas: <routerVar>.<verbo>('<path>', ...args).
    ROUTE_OPEN_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = ROUTE_OPEN_RE.exec(content)) !== null) {
      const [, varName, verb, routePath] = r;
      if (!routerVars.has(varName)) continue;
      if (!HTTP_VERBS.has(verb)) continue;

      const openParenIdx = content.indexOf("(", r.index);
      const args = openParenIdx >= 0 ? readCallArgs(content, openParenIdx) : "";
      const { roles, expression } = extractPermission(args);
      const { entities, operations } = resolveHandlerEntities(args, drizzle);

      // Multi-hop (D8/D9): funções chamadas nos args E handlers passados por
      // referência (identificador nu, local ou importado) viram seeds da
      // travessia; toques a N arquivos de distância se unem ao scan same-file.
      let chain: string[] = [];
      if (callChain) {
        const seeds = callChain.seedsFor(file.filePath, args);
        for (const arg of splitTopLevelArgs(args)) {
          if (!BARE_IDENT_RE.test(arg)) continue;
          const seed = callChain.seedForName(file.filePath, arg);
          if (seed && !seeds.includes(seed)) seeds.push(seed);
        }
        if (seeds.length > 0) {
          const resolved = resolveTouches(seeds, callChain.graph);
          for (const touch of resolved.touches) {
            if (!entities.includes(touch.entity)) entities.push(touch.entity);
            if (!operations.includes(touch.op)) operations.push(touch.op);
          }
          entities.sort();
          operations.sort();
          // Telemetria (D9): cadeia começa no handler. Handler inline (arrow)
          // não tem chave própria — prefixa o call-site como origem.
          if (resolved.chain.length > 0) {
            chain = resolved.chain[0].startsWith(`${file.filePath}::`)
              ? resolved.chain
              : [`${file.filePath}::handler`, ...resolved.chain];
          }
        }
      }

      const prefix = mountPrefix.get(varName) || "";
      routes.push({
        method: verb.toUpperCase(),
        path: joinPath(prefix, routePath),
        routerVar: varName,
        requiredRoles: roles,
        permissionExpression: expression,
        entitiesTouched: entities,
        persistenceOperations: operations,
        callChain: chain,
        sourceFile: file.filePath,
        lineNumber: lineAt(content, r.index),
      });
    }
  }

  routes.sort((a, b) =>
    `${a.method} ${a.path} ${a.routerVar}`.localeCompare(
      `${b.method} ${b.path} ${b.routerVar}`,
    ),
  );
  return routes;
}

/** GET→READ, POST→CREATE, PUT/PATCH→UPDATE, DELETE→DELETE (espelha inferOperationType). */
function operationOf(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "READ";
    case "POST":
      return "CREATE";
    case "PUT":
      return "UPDATE";
    case "PATCH":
      return "UPDATE";
    case "DELETE":
      return "DELETE";
    default:
      return "UNKNOWN";
  }
}

/**
 * Materializa rotas Express como catalog entries no MESMO formato dos endpoints
 * WsV1/Java (screen "API: <router>", interactionCategory HTTP), pra fluírem pelo
 * classificador determinístico e aparecerem no catálogo como endpoints reais.
 */
/**
 * ADR-0018 (pronto-pra-cliente): rotas Express → entradas do espelho RICO
 * `impactEndpoints` do snapshot — o formato que o impact-diff PREFERE. Sem
 * isto, as cadeias Node do call-chain (Onda 2) ficavam só no catálogo curado
 * (que o impact-diff ignora quando o espelho existe) e TODA rota Node era
 * "rasa" na análise de impacto. Entradas de cadeia normalizadas ao formato
 * `arquivo-base.fn` (mesma convenção Classe.metodo do Java — o casamento por
 * ENTRADA INTEIRA da Onda 2 funciona sem mudança). Puro.
 */
export function expressRoutesToImpactEndpoints(routes: ExpressRoute[]): {
  path: string;
  method: string;
  controller: string;
  controllerMethod: string;
  fullCallChain: string[];
  entitiesTouched: string[];
  persistenceOperations: string[];
  runtime: "node";
}[] {
  const baseNoExt = (f: string) => {
    const b = (f || "").split("/").pop() || f;
    return b.replace(/\.(ts|js|mjs|cjs|tsx|jsx)$/i, "");
  };
  const fnOf = (key: string) => key.split("::")[1] ?? key;
  const fileOf = (key: string) => key.split("::")[0] ?? key;
  return routes.map((r) => {
    const chain = r.callChain || [];
    const head = chain[0] ?? "";
    return {
      path: r.path,
      method: r.method,
      controller: head ? baseNoExt(fileOf(head)) : r.routerVar,
      controllerMethod: head ? fnOf(head) : "(handler)",
      fullCallChain: chain.map((k) => `${baseNoExt(fileOf(k))}.${fnOf(k)}`),
      entitiesTouched: r.entitiesTouched || [],
      persistenceOperations: r.persistenceOperations || [],
      runtime: "node",
    };
  });
}

export function expressRoutesToCatalogEntries(
  routes: ExpressRoute[],
  analysisRunId: number,
  projectId: number,
): InsertCatalogEntry[] {
  return routes.map((route) => {
    const hasRoles = route.requiredRoles.length > 0;
    const securityAnnotations = hasRoles
      ? [
          {
            type: "express-middleware",
            expression: route.permissionExpression || route.requiredRoles.join(", "),
            roles: route.requiredRoles,
          },
        ]
      : [];

    // Telemetria da cadeia (D9): [handler, ...intermediários, quem-toca].
    // Heurística de camada (espelha o Java): hop intermediário = service,
    // hop final (o que faz o acesso Drizzle) = repository.
    const fnOf = (key: string) => key.split("::")[1] ?? key;
    const fileOf = (key: string) => key.split("::")[0] ?? key;
    const chain = route.callChain;
    const serviceMethods = chain.length > 2 ? chain.slice(1, -1).map(fnOf) : [];
    const repositoryMethods = chain.length >= 2 ? [fnOf(chain[chain.length - 1])] : [];
    const resolutionPath = [
      {
        tier: "backend_only",
        file: route.sourceFile || route.routerVar,
        function: "handler",
        detail: "Express route (multistack node-backend, ADR-0015 D1)",
      },
      ...(chain.length >= 2
        ? [
            {
              tier: "call_chain",
              file: fileOf(chain[chain.length - 1]),
              function: fnOf(chain[chain.length - 1]),
              detail: `Express call-chain multi-hop, ${chain.length - 1} hop(s) (ADR-0015 Onda 2 D8/D9)`,
            },
          ]
        : []),
    ];

    return {
      analysisRunId,
      projectId,
      screen: `API: ${route.routerVar}`,
      interaction: `${route.method} ${route.path}`,
      interactionType: "endpoint",
      endpoint: route.path,
      httpMethod: route.method,
      controllerClass: route.routerVar,
      controllerMethod: null,
      serviceMethods,
      repositoryMethods,
      entitiesTouched: route.entitiesTouched,
      fullCallChain: route.callChain,
      persistenceOperations: route.persistenceOperations,
      technicalOperation: operationOf(route.method),
      criticalityScore: null,
      suggestedMeaning: null,
      humanClassification: null,
      sourceFile: route.sourceFile,
      lineNumber: route.lineNumber,
      resolutionPath,
      architectureType: "REST_CONTROLLER",
      interactionCategory: "HTTP",
      confidence: 1.0,
      requiredRoles: route.requiredRoles,
      securityAnnotations,
      entityFieldsMetadata: [],
      sensitiveFieldsAccessed: [],
      frontendRoute: null,
      routeGuards: [],
      duplicateCount: 1,
      operationHint: null,
      dataSource: {
        endpoint: "extracted" as const,
        httpMethod: "extracted" as const,
        controllerClass: "extracted" as const,
        ...(route.entitiesTouched.length > 0 ? { entitiesTouched: "extracted" as const } : {}),
        ...(hasRoles
          ? { requiredRoles: "extracted" as const, securityAnnotations: "extracted" as const }
          : {}),
      },
    };
  });
}

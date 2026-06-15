/**
 * NuPtechs convention-aware endpoint inventory.
 *
 * The generic Java analyzer only recognizes Spring `@*Mapping`/`@RestController`
 * endpoints, and the frontend analyzer treats the Node gateway as "frontend".
 * NuPtechs platforms (EasyNuP et al.) expose their HTTP surface in two ways the
 * generic analyzer is blind to:
 *
 *   (B) Spring "WsV1" services — a CloudSupport convention where each operation
 *       lives at `.../services/web/<area>/<operation>/v<N>/<Class>WsV1.java`
 *       and is reachable at `/easynup/<operation>.v<N>` (no `@*Mapping`). A few
 *       declare an explicit absolute path via `@Ws("/api/...")`.
 *
 *   (A) The Node gateway (Express) that the SPA actually talks to — routes are
 *       declared as `router.get/post(...)` and mounted with `app.use('<prefix>',
 *       ...)`, plus pass-through proxies to Spring (`/easynup`, `/api/v1/admin`,
 *       `/api/webhooks/inbound`).
 *
 * Without this inventory the frontend↔backend consistency detector self-suppresses
 * (zero backend endpoints ⇒ every call is trivially "unmapped", so the pipeline
 * skips it). With it, real "screen calls a dead endpoint" findings surface while
 * legitimate calls map cleanly.
 *
 * Design (precision-first, no false positives):
 *   - (B) WsV1 → exact CONTROLLER nodes (`/easynup/<op>.v<N>` or explicit `@Ws`),
 *     so a typo'd/renamed/removed operation does NOT match and IS flagged.
 *   - (A) gateway → coarse PREFIX coverage. There is no generic `/api` catch-all
 *     (verified: `app.use('/api/', apiLimiter)` is a rate limiter, not a proxy),
 *     so a call under a known mount prefix is "covered" while a call outside every
 *     prefix (and not a WsV1) is a real break. Prefixes the WsV1 side already
 *     covers precisely (`/easynup`, `/api/v1/admin`) and over-broad mounts
 *     (`/api`, `/api/`) are excluded so they never mask a real break.
 *
 * Pure + additive: activates only for files matching the patterns, so non-NuPtechs
 * projects are unaffected. No I/O.
 */
import { ApplicationGraph, GraphNode, GraphEdge } from "./application-graph";
import type { FrontendInteraction } from "./frontend-analyzer";

export interface SyntheticEndpoint {
  fullPath: string;
  httpMethod: string;
  className: string;
  sourceFile: string;
  lineNumber: number;
  origin: "wsv1" | "wsv1-explicit";
}

/** Mount prefixes the WsV1 inventory already covers precisely, or that are too
 *  broad to be a meaningful "covered" signal. Never registered as coarse nodes. */
const GATEWAY_PREFIX_EXCLUDES = new Set<string>([
  "/api",
  "/api/",
  "/easynup",
  "/easynup/",
  "/api/v1/admin", // explicit @Ws endpoints — WsV1 side covers these precisely
]);

const WSV1_FILE_RE = /(?:^|\/)services\/web\/.+\/([^/]+)\/v(\d+)\/[^/]+\.java$/;
const WS_EXPLICIT_RE = /@Ws\(\s*"([^"]+)"\s*\)/;

/**
 * Extract the WsV1 endpoint inventory (B) from Java source files.
 * Convention: `.../services/web/<area>/<operation>/v<N>/<Class>WsV1.java`
 *   → `/easynup/<operation>.v<N>`.
 * Override: a bare `@Ws("/absolute/path")` annotation wins (the handful of
 *   admin/webhook/internal endpoints that declare an explicit path).
 * Method defaults to POST (the CloudSupport RPC convention); the consistency
 * matcher falls back to path-only matching so a GET caller still maps.
 */
export function extractWsV1Endpoints(
  fileData: { filePath: string; content: string }[],
): SyntheticEndpoint[] {
  const out: SyntheticEndpoint[] = [];
  const seen = new Set<string>();

  for (const file of fileData) {
    if (!file.filePath.endsWith(".java")) continue;
    if (!/Ws\d*\.java$|WsV\d+\.java$/.test(file.filePath)) continue;

    const convMatch = file.filePath.match(WSV1_FILE_RE);
    const explicitMatch = file.content.match(WS_EXPLICIT_RE);

    let fullPath: string | null = null;
    let origin: SyntheticEndpoint["origin"] = "wsv1";

    if (explicitMatch && explicitMatch[1].startsWith("/")) {
      fullPath = explicitMatch[1];
      origin = "wsv1-explicit";
    } else if (convMatch) {
      const [, operation, version] = convMatch;
      fullPath = `/easynup/${operation}.v${version}`;
      origin = "wsv1";
    }

    if (!fullPath) continue;
    if (seen.has(fullPath)) continue;
    seen.add(fullPath);

    const className =
      file.filePath
        .split("/")
        .pop()
        ?.replace(/\.java$/, "") || fullPath;
    const lineNumber = lineOf(file.content, explicitMatch?.[0] ?? "@Ws");

    out.push({ fullPath, httpMethod: "POST", className, sourceFile: file.filePath, lineNumber, origin });
  }

  return out;
}

/**
 * Extract the Node gateway mount prefixes (A) from Express source files.
 * Returns the set of mount prefixes that count as "covered" — excluding
 * WsV1-covered and over-broad mounts (see GATEWAY_PREFIX_EXCLUDES).
 *
 * Two declaration styles are recognized:
 *   - direct:  `app.use('<prefix>', router)`
 *   - factory: a route-registry config entry `{ ..., mount: '<prefix>', ... }`
 *     that a loader later mounts (the dominant pattern in larger gateways —
 *     e.g. EasyNuP registers ~47 routers this way). Missing these is exactly
 *     what false-flagged `/api/chat-ia/messages` in the first validation run.
 *
 * Longest-first so prefix matching is deterministic.
 */
export function extractGatewayPrefixes(
  fileData: { filePath: string; content: string }[],
): string[] {
  const prefixes = new Set<string>();
  const mountRe = /app\.use\(\s*['"`](\/[a-zA-Z0-9/_-]+)['"`]/g;
  const factoryRe = /\bmount:\s*['"`](\/[a-zA-Z0-9/_-]+)['"`]/g;

  const add = (raw: string) => {
    const prefix = raw.replace(/\/$/, ""); // normalize trailing slash
    if (!prefix) return;
    if (GATEWAY_PREFIX_EXCLUDES.has(prefix) || GATEWAY_PREFIX_EXCLUDES.has(prefix + "/")) return;
    prefixes.add(prefix);
  };

  for (const file of fileData) {
    if (file.filePath.endsWith(".java")) continue;
    const hasDirect = file.content.includes("app.use(");
    const hasFactory = file.content.includes("mount:");
    if (!hasDirect && !hasFactory) continue;

    let m: RegExpExecArray | null;
    if (hasDirect) {
      mountRe.lastIndex = 0;
      while ((m = mountRe.exec(file.content)) !== null) add(m[1]);
    }
    if (hasFactory) {
      factoryRe.lastIndex = 0;
      while ((m = factoryRe.exec(file.content)) !== null) add(m[1]);
    }
  }

  return Array.from(prefixes).sort((a, b) => b.length - a.length);
}

/**
 * Add the WsV1 inventory to the application graph as CONTROLLER nodes so that
 * (1) `analyzeEndpoints` reports them (flips backend coverage > 0, un-gating the
 * consistency detector) and (2) `matchUrlToEndpoint` resolves real calls exactly.
 * Idempotent by node id. Returns the number of endpoints added.
 */
export function augmentGraphWithWsV1(
  graph: ApplicationGraph,
  fileData: { filePath: string; content: string }[],
): number {
  const endpoints = extractWsV1Endpoints(fileData);
  let added = 0;

  // Índice de entidades por nome normalizado (lc + sem plural) → id do nó.
  // Permite ligar o endpoint WsV1 à entidade que ele opera (convenção easynup:
  // verbo+entidade, ex. findContract → Contract), completando o chain
  // endpoint→entidade que o analisador Java não monta (WsV1 usa @Ws, não @*Mapping).
  const entityIndex = new Map<string, string>();
  for (const en of graph.getNodesByType("ENTITY")) {
    const norm = normalizeEntityName(en.className);
    if (norm && !entityIndex.has(norm)) entityIndex.set(norm, en.id);
  }

  for (const ep of endpoints) {
    const id = `wsv1:${ep.httpMethod}:${ep.fullPath}`;
    if (!graph.getNode(id)) {
      graph.addNode(
        new GraphNode(id, "CONTROLLER", ep.className, "execute", null, {
          httpMethod: ep.httpMethod,
          fullPath: ep.fullPath,
          sourceFile: ep.sourceFile,
          lineNumber: ep.lineNumber,
          synthetic: true,
          convention: ep.origin,
        }),
      );
      added++;
    }

    // Liga o endpoint à entidade pela convenção verbo+entidade.
    const op = operationOf(ep.fullPath); // ex. "findContract" / "createAcceptance"
    if (!op || entityIndex.size === 0) continue;
    const { entityCandidate, write } = parseOperation(op);
    if (!entityCandidate) continue;
    const norm = normalizeEntityName(entityCandidate);
    const entityNodeId = entityIndex.get(norm);
    if (!entityNodeId) continue;
    graph.addEdge(
      new GraphEdge(id, entityNodeId, write ? "WRITES_ENTITY" : "READS_ENTITY", {
        synthetic: true,
        wsOperation: op,
        convention: "wsv1-name",
      }),
    );
  }

  return added;
}

const WRITE_VERBS = /^(create|update|delete|remove|save|insert|add|set|cancel|approve|reject|submit|process|apply|bulk|register|deactivate|activate|reactivate|close|open|finish|start|import|sync|upsert|patch|put|post|generate|recalculate|move|assign|unassign|link|unlink|reorder)/i;
const READ_VERBS = /^(find|get|list|search|read|fetch|count|export|validate|resolve|calculate|analyze|preview|check|download|view|suggest|score|simulate)/i;

/** "/easynup/findContract.v1" → "findContract". null pra paths não-easynup. */
function operationOf(fullPath: string): string | null {
  const m = fullPath.match(/^\/easynup\/([^/.]+)\.v\d+$/i);
  return m ? m[1] : null;
}

/** Separa o verbo da operação → entidade candidata + se é escrita. */
function parseOperation(op: string): { entityCandidate: string; write: boolean } {
  const w = WRITE_VERBS.exec(op);
  if (w) return { entityCandidate: op.slice(w[0].length), write: true };
  const r = READ_VERBS.exec(op);
  if (r) return { entityCandidate: op.slice(r[0].length), write: false };
  return { entityCandidate: "", write: false };
}

/** Normaliza nome de entidade p/ casar: minúsculo, sem plural simples, sem separadores. */
function normalizeEntityName(name: string): string {
  let s = (name || "").toLowerCase().replace(/[_\s-]/g, "");
  if (s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.endsWith("ses") || s.endsWith("xes") || s.endsWith("zes")) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

/**
 * True when `url` is served by one of the gateway mount `prefixes` — exact match
 * or a strict path-segment descendant (`/api/invite` covers `/api/invite/x`, not
 * `/api/inviteother`). Used to mark gateway-native calls as covered so they are
 * not false-flagged once WsV1 endpoints un-gate the detector.
 */
export function isCoveredByGatewayPrefix(url: string, prefixes: string[]): boolean {
  const path = stripUrl(url);
  if (!path) return false;
  for (const prefix of prefixes) {
    if (path === prefix) return true;
    if (path.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * Post-pass: mark unmapped internal HTTP interactions whose URL falls under a
 * known gateway mount prefix as covered (synthetic mappedBackendNode). Prevents
 * false positives on gateway-native `/api/*` and `/auth/*` calls. Returns the
 * count newly covered.
 */
export function mapInteractionsToGatewayPrefixes(
  interactions: FrontendInteraction[],
  prefixes: string[],
): number {
  if (!prefixes.length) return 0;
  let covered = 0;

  for (const it of interactions || []) {
    if (it.interactionCategory !== "HTTP") continue;
    if (!it.url) continue;
    if (it.mappedBackendNode) continue;
    if (!isCoveredByGatewayPrefix(it.url, prefixes)) continue;

    it.mappedBackendNode = new GraphNode(
      `gateway-prefix:${it.url}`,
      "CONTROLLER",
      "GatewayRoute",
      null,
      null,
      { synthetic: true, convention: "express-prefix" },
    );
    covered++;
  }

  return covered;
}

function stripUrl(url: string): string {
  return url
    .replace(/\?.*$/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
}

function lineOf(content: string, needle: string): number {
  const idx = content.indexOf(needle);
  if (idx < 0) return 1;
  return content.slice(0, idx).split("\n").length;
}

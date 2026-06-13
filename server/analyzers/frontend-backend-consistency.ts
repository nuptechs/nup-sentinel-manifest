/**
 * Frontend↔Backend consistency detector.
 *
 * Consumes the FrontendInteraction[] that `analyzeFrontend` already produces
 * (it parses real API calls — fetch/axios/httpClient AND the BaseApiService
 * `buildEndpoint` pattern — and tries to resolve each to a backend GraphNode
 * via `matchUrlToEndpoint`). An interaction that is an internal HTTP call with
 * a concrete URL but resolved to NO backend node (`mappedBackendNode == null`)
 * is the signal we want: the screen calls an endpoint the backend does not
 * expose → a 404 waiting to happen in runtime.
 *
 * This is DETERMINISTIC — it needs neither the runtime Probe nor traffic. It is
 * the "inconsistency" finding type that the Sentinel schema reserved but had no
 * emitter for. Catches the class of bug found by hand on EasyNuP:
 *   - Users screen → POST/PUT updateUser.v1 (backend has no updateUser)
 *   - Permissions screen → create/update/deletePermission.v1 (inexistent)
 *   - SLA Categories / Severity → create/update/delete*.v1 (only find* exists)
 *
 * IMPORTANT (false-positive guard): only meaningful when the backend side was
 * actually analyzed. If the run has zero backend endpoints, EVERY HTTP call is
 * trivially "unmapped" — the caller (pipeline) must gate on backend coverage.
 * EXTERNAL_SERVICE / SERVICE_BRIDGE / UI_ONLY / STATE_ONLY interactions are
 * excluded here because they legitimately have no backend node.
 */
import type { FrontendInteraction } from "./frontend-analyzer";

export interface ConsistencyFinding {
  id: string;
  subtype: "missing_backend_endpoint";
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  url: string;
  httpMethod: string | null;
  component: string;
  sourceFile: string;
  lineNumber: number;
  declaredRoles: string[];
}

export interface DetectOptions {
  /** Below this confidence the interaction is ignored (avoids noisy guesses). */
  minConfidence?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Returns one ConsistencyFinding per unique (method, url) that the frontend
 * calls but the backend does not expose. Pure; no I/O.
 */
export function detectFrontendBackendInconsistencies(
  interactions: FrontendInteraction[],
  opts: DetectOptions = {},
): ConsistencyFinding[] {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const findings: ConsistencyFinding[] = [];
  const seen = new Set<string>();

  for (const it of interactions || []) {
    // Only internal HTTP calls. EXTERNAL_SERVICE/SERVICE_BRIDGE/UI_ONLY/
    // STATE_ONLY legitimately have no backend node.
    if (it.interactionCategory !== "HTTP") continue;
    if (!it.url) continue;
    // Resolved to a backend endpoint → consistent, skip.
    if (it.mappedBackendNode) continue;
    if (typeof it.confidence === "number" && it.confidence < minConfidence) continue;

    const method = (it.httpMethod || "ANY").toUpperCase();
    const key = `${method} ${it.url}`;
    if (seen.has(key)) continue; // dedup: many components may call the same dead endpoint
    seen.add(key);

    // Writes (POST/PUT/PATCH/DELETE) to a missing endpoint are higher impact
    // than a missing GET (data simply fails to load vs. an action silently 404s).
    const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

    findings.push({
      id: `fe-be-missing:${key}`,
      subtype: "missing_backend_endpoint",
      severity: isWrite ? "high" : "medium",
      title: `Frontend chama endpoint inexistente: ${key}`,
      description:
        `O componente "${it.component}" (${it.sourceFile}:${it.lineNumber}) faz ` +
        `${method} ${it.url}, mas nenhum endpoint de backend corresponde a essa chamada. ` +
        `Provável 404 em runtime — endpoint nunca implementado, renomeado ou removido. ` +
        `A tela oferece a ação mas o backend não a atende.`,
      url: it.url,
      httpMethod: it.httpMethod,
      component: it.component,
      sourceFile: it.sourceFile,
      lineNumber: it.lineNumber,
      declaredRoles: it.detectedRoles || [],
    });
  }

  return findings;
}

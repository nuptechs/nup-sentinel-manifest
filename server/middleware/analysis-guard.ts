import type { Request, Response, NextFunction, RequestHandler } from "express";

// ─── Analysis concurrency guard (ADR-0014 D0) ─────────────────────
//
// Each analysis route spawns a ~2 GB JVM (JavaParser + SymbolSolver).
// Without a cap, a caller can trivially DoS the box by firing many
// analyses in parallel. This in-process guard bounds concurrency:
//   - at most 1 in-flight analysis PER PROJECT (serialize a project's
//     own re-analyses instead of stacking JVMs), and
//   - at most MAX_GLOBAL in-flight analyses per instance.
// Over the limit → 429 with a Retry-After hint, no JVM launched.
//
// No new dependency: a per-key counter released on response finish.

const MAX_GLOBAL = parseInt(process.env.MANIFEST_MAX_CONCURRENT_ANALYSES || "2", 10);

let globalInFlight = 0;
const perProjectInFlight = new Set<string>();

/** Derive a stable project key from the route params (falls back to a global bucket). */
function projectKey(req: Request): string {
  const id = (req.params.projectId || req.params.id) as string | undefined;
  return id ? `project:${id}` : "anonymous";
}

/**
 * Middleware factory guarding the heavyweight analysis routes.
 * Releases its slot exactly once, whether the response finishes or the
 * connection closes early.
 */
export function analysisConcurrencyGuard(): RequestHandler {
  return function guard(req: Request, res: Response, next: NextFunction) {
    const key = projectKey(req);

    if (globalInFlight >= MAX_GLOBAL) {
      res.setHeader("Retry-After", "30");
      return res.status(429).json({
        message: "Analysis capacity reached; retry shortly.",
        maxConcurrent: MAX_GLOBAL,
      });
    }
    if (perProjectInFlight.has(key)) {
      res.setHeader("Retry-After", "30");
      return res.status(429).json({
        message: "An analysis is already running for this project; retry when it finishes.",
      });
    }

    globalInFlight += 1;
    perProjectInFlight.add(key);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      globalInFlight = Math.max(0, globalInFlight - 1);
      perProjectInFlight.delete(key);
    };

    res.once("finish", release);
    res.once("close", release);

    next();
  };
}

/** Test-only: reset the counters between cases. */
export function __resetAnalysisGuard(): void {
  globalInFlight = 0;
  perProjectInFlight.clear();
}

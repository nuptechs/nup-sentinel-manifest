import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "./db";
import {
  analysisRuns,
  manifestComposables,
  manifestEntities,
  manifestI18nKeys,
  manifestPages,
  manifestRoutes,
  type ManifestComposable,
  type ManifestEntity,
  type ManifestI18nKey,
  type ManifestPage,
  type ManifestRoute,
} from "@shared/schema";
import { codelensExtractionSchema, type CodelensExtractionPayload } from "./manifest-lookup-schema";

export { codelensExtractionSchema, type CodelensExtractionPayload };

/**
 * Codelens-sourced catálogo (ADR-044 Onda 1 PR 1.3).
 *
 * Codelens roda no CI ou local-dev, extrai shapes Java + Vue via AST, e POSTa
 * o payload abaixo para `POST /api/projects/:id/codelens-extraction`. Esse
 * módulo (a) valida via zod, (b) cria um analysisRun, (c) atomicamente popula
 * as 5 tabelas dedicadas, e (d) expõe lookups ergonômicos para o MCP server
 * (PR 1.4) consumir.
 *
 * Separation of concerns: Codelens é cliente; Manifest server é catálogo.
 * Sem invocação cross-process — a stack de IA externa (Claude Code, Cursor)
 * lê via /api/projects/:id/lookup, sempre lendo a última analysisRun.
 */

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface IngestResult {
  analysisRunId: number;
  entities: number;
  pages: number;
  composables: number;
  routes: number;
  i18nKeys: number;
}

/** Cap arrays at this size per request to avoid runaway payloads. */
const MAX_ITEMS_PER_KIND = 10_000;

/**
 * Ingest a Codelens extraction payload. Creates a new analysisRun and writes
 * to the 5 manifest_* tables in a single transaction. Returns counts so the
 * caller can confirm what was persisted.
 *
 * Idempotency: not enforced at the row level — each call creates a fresh
 * analysisRun. Callers running on a cron should accept that "latest run wins"
 * is the lookup semantics.
 */
export async function ingestCodelensExtraction(
  projectId: number,
  payload: CodelensExtractionPayload,
): Promise<IngestResult> {
  assertSize(payload);

  return await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(analysisRuns)
      .values({
        projectId,
        status: "completed",
        totalEntities: payload.entities.length,
        totalEndpoints: 0,
        totalInteractions: payload.pages.length + payload.routes.length,
        completedAt: new Date(),
      })
      .returning({ id: analysisRuns.id });

    if (!run) throw new Error("failed to create analysisRun for codelens-extraction");

    const runId = run.id;

    let entityCount = 0;
    if (payload.entities.length) {
      await tx.insert(manifestEntities).values(
        payload.entities.map((e) => ({
          analysisRunId: runId,
          projectId,
          name: e.name,
          package: e.package,
          tableName: e.tableName ?? null,
          extendsClass: e.extendsClass ?? null,
          sourcePath: e.sourcePath,
          fields: e.fields,
        })),
      );
      entityCount = payload.entities.length;
    }

    let pageCount = 0;
    if (payload.pages.length) {
      await tx.insert(manifestPages).values(
        payload.pages.map((p) => ({
          analysisRunId: runId,
          projectId,
          name: p.name,
          sourcePath: p.sourcePath,
          imports: p.imports,
          props: p.props,
          emits: p.emits,
          composables: p.composables,
          i18nKeys: p.i18nKeys,
        })),
      );
      pageCount = payload.pages.length;
    }

    let composableCount = 0;
    if (payload.composables.length) {
      await tx.insert(manifestComposables).values(
        payload.composables.map((c) => ({
          analysisRunId: runId,
          projectId,
          name: c.name,
          sourcePath: c.sourcePath,
          returns: c.returns,
          dependencies: c.dependencies,
        })),
      );
      composableCount = payload.composables.length;
    }

    let routeCount = 0;
    if (payload.routes.length) {
      await tx.insert(manifestRoutes).values(
        payload.routes.map((r) => ({
          analysisRunId: runId,
          projectId,
          routePath: r.routePath,
          name: r.name ?? null,
          component: r.component ?? null,
          paletteLabel: r.paletteLabel ?? null,
          paletteCategory: r.paletteCategory ?? null,
          permissions: r.permissions,
          hasPaletteMeta: r.hasPaletteMeta,
          sourcePath: r.sourcePath,
        })),
      );
      routeCount = payload.routes.length;
    }

    let i18nCount = 0;
    if (payload.i18nKeys.length) {
      await tx.insert(manifestI18nKeys).values(
        payload.i18nKeys.map((k) => ({
          analysisRunId: runId,
          projectId,
          key: k.key,
          usageCount: k.usageCount,
          sampleFiles: k.sampleFiles,
        })),
      );
      i18nCount = payload.i18nKeys.length;
    }

    return {
      analysisRunId: runId,
      entities: entityCount,
      pages: pageCount,
      composables: composableCount,
      routes: routeCount,
      i18nKeys: i18nCount,
    };
  });
}

function assertSize(payload: CodelensExtractionPayload): void {
  for (const [k, arr] of Object.entries(payload)) {
    if (Array.isArray(arr) && arr.length > MAX_ITEMS_PER_KIND) {
      throw new Error(`codelens-extraction: ${k} exceeds ${MAX_ITEMS_PER_KIND} items (got ${arr.length})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Lookup — always reads from the latest analysisRun for the given project.
// ---------------------------------------------------------------------------

export type LookupType = "entity" | "page" | "composable" | "route" | "i18n";

export interface LookupQuery {
  projectId: number;
  type: LookupType;
  /** Used for entity/page/composable. Case-insensitive substring match. */
  name?: string;
  /** Used for route. Substring match against routePath. */
  path?: string;
  /** Used for i18n. Substring match against key. */
  key?: string;
  limit?: number;
}

export interface LookupResult {
  type: LookupType;
  analysisRunId: number | null;
  matches: Array<ManifestEntity | ManifestPage | ManifestComposable | ManifestRoute | ManifestI18nKey>;
}

export async function lookupManifest(query: LookupQuery): Promise<LookupResult> {
  const limit = Math.min(query.limit ?? 25, 100);

  const latestRun = await db
    .select({ id: analysisRuns.id })
    .from(analysisRuns)
    .where(eq(analysisRuns.projectId, query.projectId))
    .orderBy(desc(analysisRuns.id))
    .limit(1);

  const runId = latestRun[0]?.id ?? null;
  if (runId === null) {
    return { type: query.type, analysisRunId: null, matches: [] };
  }

  switch (query.type) {
    case "entity": {
      const rows = await db
        .select()
        .from(manifestEntities)
        .where(
          and(
            eq(manifestEntities.analysisRunId, runId),
            query.name ? ilike(manifestEntities.name, `%${query.name}%`) : undefined,
          ),
        )
        .limit(limit);
      return { type: "entity", analysisRunId: runId, matches: rows };
    }
    case "page": {
      const rows = await db
        .select()
        .from(manifestPages)
        .where(
          and(
            eq(manifestPages.analysisRunId, runId),
            query.name ? ilike(manifestPages.name, `%${query.name}%`) : undefined,
          ),
        )
        .limit(limit);
      return { type: "page", analysisRunId: runId, matches: rows };
    }
    case "composable": {
      const rows = await db
        .select()
        .from(manifestComposables)
        .where(
          and(
            eq(manifestComposables.analysisRunId, runId),
            query.name ? ilike(manifestComposables.name, `%${query.name}%`) : undefined,
          ),
        )
        .limit(limit);
      return { type: "composable", analysisRunId: runId, matches: rows };
    }
    case "route": {
      const rows = await db
        .select()
        .from(manifestRoutes)
        .where(
          and(
            eq(manifestRoutes.analysisRunId, runId),
            query.path ? ilike(manifestRoutes.routePath, `%${query.path}%`) : undefined,
          ),
        )
        .limit(limit);
      return { type: "route", analysisRunId: runId, matches: rows };
    }
    case "i18n": {
      const rows = await db
        .select()
        .from(manifestI18nKeys)
        .where(
          and(
            eq(manifestI18nKeys.analysisRunId, runId),
            query.key ? ilike(manifestI18nKeys.key, `%${query.key}%`) : undefined,
          ),
        )
        .limit(limit);
      return { type: "i18n", analysisRunId: runId, matches: rows };
    }
  }
}

/**
 * Postgres ILIKE wrapper. Drizzle has `ilike` in `drizzle-orm` but we keep an
 * inline helper here so the file is self-contained and doesn't pull more
 * symbols into the top imports than necessary.
 */
function ilike(col: ReturnType<typeof sql.identifier> | unknown, pattern: string) {
  return sql`${col} ILIKE ${pattern}`;
}

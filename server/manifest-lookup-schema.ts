import { z } from "zod";

/**
 * Codelens extraction payload schema (ADR-044 Onda 1 PR 1.3).
 *
 * Standalone — does NOT import from server/db.ts, so unit tests can import
 * this without provisioning a Postgres instance. The runtime ingest logic in
 * server/manifest-lookup.ts re-exports this schema via dynamic re-export.
 */

const fieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  column: z.string().optional(),
  isId: z.boolean(),
  relationship: z.enum(["OneToMany", "ManyToOne", "OneToOne", "ManyToMany"]).optional(),
  annotations: z.array(z.string()).default([]),
});

const entityPayloadSchema = z.object({
  name: z.string().min(1),
  package: z.string().default(""),
  tableName: z.string().optional(),
  extendsClass: z.string().optional(),
  sourcePath: z.string().min(1),
  fields: z.array(fieldSchema).default([]),
});

const pagePayloadSchema = z.object({
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  imports: z.array(z.string()).default([]),
  props: z.array(z.string()).default([]),
  emits: z.array(z.string()).default([]),
  composables: z.array(z.string()).default([]),
  i18nKeys: z.array(z.string()).default([]),
});

const composablePayloadSchema = z.object({
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  returns: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
});

const routePayloadSchema = z.object({
  routePath: z.string().min(1),
  name: z.string().optional(),
  component: z.string().optional(),
  paletteLabel: z.string().optional(),
  paletteCategory: z.string().optional(),
  permissions: z.array(z.string()).default([]),
  hasPaletteMeta: z.boolean().default(false),
  sourcePath: z.string().min(1),
});

export const codelensExtractionSchema = z.object({
  entities: z.array(entityPayloadSchema).default([]),
  pages: z.array(pagePayloadSchema).default([]),
  composables: z.array(composablePayloadSchema).default([]),
  routes: z.array(routePayloadSchema).default([]),
  /** key → { usageCount, sampleFiles }. Aggregation done client-side. */
  i18nKeys: z
    .array(
      z.object({
        key: z.string().min(1),
        usageCount: z.number().int().positive().default(1),
        sampleFiles: z.array(z.string()).max(5).default([]),
      }),
    )
    .default([]),
});

export type CodelensExtractionPayload = z.infer<typeof codelensExtractionSchema>;

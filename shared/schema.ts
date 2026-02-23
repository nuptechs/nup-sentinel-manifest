import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, jsonb, real, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("pending"),
  fileCount: integer("file_count").default(0),
  gitProvider: text("git_provider"),
  gitRepoUrl: text("git_repo_url"),
  gitDefaultBranch: text("git_default_branch"),
  gitTokenRef: text("git_token_ref"),
  webhookSecret: text("webhook_secret"),
  webhookEnabled: boolean("webhook_enabled").default(false),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  status: true,
  fileCount: true,
});

export const connectGitSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  repoUrl: z.string().url(),
  token: z.string().min(1),
  defaultBranch: z.string().optional(),
});

export type ConnectGitInput = z.infer<typeof connectGitSchema>;

export const analyzePRSchema = z.object({
  prNumber: z.number().int().positive(),
});

export type AnalyzePRInput = z.infer<typeof analyzePRSchema>;

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;

export const sourceFiles = pgTable("source_files", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  fileType: text("file_type").notNull(),
  content: text("content").notNull(),
  contentHash: text("content_hash"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSourceFileSchema = createInsertSchema(sourceFiles).omit({
  id: true,
  createdAt: true,
});

export type SourceFile = typeof sourceFiles.$inferSelect;
export type InsertSourceFile = z.infer<typeof insertSourceFileSchema>;

export const analysisRuns = pgTable("analysis_runs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  totalInteractions: integer("total_interactions").default(0),
  totalEndpoints: integer("total_endpoints").default(0),
  totalEntities: integer("total_entities").default(0),
  startedAt: timestamp("started_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at"),
  errorMessage: text("error_message"),
});

export const insertAnalysisRunSchema = createInsertSchema(analysisRuns).omit({
  id: true,
  startedAt: true,
  completedAt: true,
  status: true,
  totalInteractions: true,
  totalEndpoints: true,
  totalEntities: true,
  errorMessage: true,
});

export type AnalysisRun = typeof analysisRuns.$inferSelect;
export type InsertAnalysisRun = z.infer<typeof insertAnalysisRunSchema>;

export const catalogEntries = pgTable("catalog_entries", {
  id: serial("id").primaryKey(),
  analysisRunId: integer("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  screen: text("screen").notNull(),
  interaction: text("interaction").notNull(),
  interactionType: text("interaction_type").notNull(),
  endpoint: text("endpoint"),
  httpMethod: text("http_method"),
  controllerClass: text("controller_class"),
  controllerMethod: text("controller_method"),
  serviceMethods: jsonb("service_methods").$type<string[]>().default([]),
  repositoryMethods: jsonb("repository_methods").$type<string[]>().default([]),
  entitiesTouched: jsonb("entities_touched").$type<string[]>().default([]),
  fullCallChain: jsonb("full_call_chain").$type<string[]>().default([]),
  persistenceOperations: jsonb("persistence_operations").$type<string[]>().default([]),
  technicalOperation: text("technical_operation"),
  criticalityScore: integer("criticality_score").default(0),
  suggestedMeaning: text("suggested_meaning"),
  humanClassification: text("human_classification"),
  sourceFile: text("source_file"),
  lineNumber: integer("line_number"),
  resolutionPath: jsonb("resolution_path").$type<{ tier: string; file: string; function: string | null; detail: string | null }[]>(),
  architectureType: text("architecture_type"),
  interactionCategory: text("interaction_category"),
  confidence: real("confidence"),
  requiredRoles: jsonb("required_roles").$type<string[]>().default([]),
  securityAnnotations: jsonb("security_annotations").$type<{ type: string; expression: string; roles: string[] }[]>().default([]),
  entityFieldsMetadata: jsonb("entity_fields_metadata").$type<{ entity: string; fields: { name: string; type: string; isId: boolean; isSensitive: boolean; validations?: string[] }[] }[]>().default([]),
  sensitiveFieldsAccessed: jsonb("sensitive_fields_accessed").$type<string[]>().default([]),
  frontendRoute: text("frontend_route"),
  routeGuards: jsonb("route_guards").$type<string[]>().default([]),
  duplicateCount: integer("duplicate_count").default(1),
  operationHint: text("operation_hint"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertCatalogEntrySchema = createInsertSchema(catalogEntries).omit({
  id: true,
  createdAt: true,
});

export type CatalogEntry = typeof catalogEntries.$inferSelect;
export type InsertCatalogEntry = z.infer<typeof insertCatalogEntrySchema>;

export const analysisSnapshots = pgTable("analysis_snapshots", {
  id: serial("id").primaryKey(),
  analysisRunId: integer("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  manifestJson: jsonb("manifest_json").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertAnalysisSnapshotSchema = createInsertSchema(analysisSnapshots).omit({
  id: true,
  createdAt: true,
});

export type AnalysisSnapshot = typeof analysisSnapshots.$inferSelect;
export type InsertAnalysisSnapshot = z.infer<typeof insertAnalysisSnapshotSchema>;

export const apiKeys = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  projectScope: integer("project_scope").references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  lastUsedAt: timestamp("last_used_at"),
});

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;

export const securityFindings = pgTable("security_findings", {
  id: serial("id").primaryKey(),
  analysisRunId: integer("analysis_run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  projectId: integer("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  findingId: text("finding_id").notNull(),
  findingType: text("finding_type").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  evidence: jsonb("evidence"),
  recommendation: text("recommendation").notNull(),
  affectedEndpoints: jsonb("affected_endpoints"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSecurityFindingSchema = createInsertSchema(securityFindings).omit({
  id: true,
  createdAt: true,
});

export type SecurityFindingRecord = typeof securityFindings.$inferSelect;
export type InsertSecurityFinding = z.infer<typeof insertSecurityFindingSchema>;

export const technicalOperations = [
  "READ",
  "WRITE",
  "DELETE",
  "STATE_CHANGE",
  "FILE_IO",
  "EXTERNAL_INTEGRATION",
  "NAVIGATION",
  "AUTHENTICATION",
] as const;

export type TechnicalOperation = typeof technicalOperations[number];

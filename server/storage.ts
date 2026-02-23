import { db } from "./db";
import { eq, desc, sql, and, gt } from "drizzle-orm";
import {
  projects,
  sourceFiles,
  analysisRuns,
  catalogEntries,
  analysisSnapshots,
  apiKeys,
  securityFindings,
  type Project,
  type InsertProject,
  type SourceFile,
  type InsertSourceFile,
  type AnalysisRun,
  type InsertAnalysisRun,
  type CatalogEntry,
  type InsertCatalogEntry,
  type AnalysisSnapshot,
  type InsertAnalysisSnapshot,
  type ApiKey,
  type InsertApiKey,
  type SecurityFindingRecord,
  type InsertSecurityFinding,
  users,
  type User,
  type InsertUser,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getProjects(): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(project: InsertProject): Promise<Project>;
  updateProjectStatus(id: number, status: string, fileCount?: number): Promise<void>;
  updateProjectGitConfig(id: number, config: { gitProvider: string; gitRepoUrl: string; gitDefaultBranch: string; gitTokenRef: string }): Promise<void>;
  updateProjectWebhookConfig(id: number, config: { webhookSecret: string | null; webhookEnabled: boolean }): Promise<void>;
  getProjectByGitRepoUrl(repoUrl: string): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;

  getSourceFiles(projectId: number): Promise<SourceFile[]>;
  createSourceFile(file: InsertSourceFile): Promise<SourceFile>;
  deleteSourceFilesByProject(projectId: number): Promise<void>;

  getAnalysisRuns(projectId: number): Promise<AnalysisRun[]>;
  getRecentAnalysisRuns(): Promise<AnalysisRun[]>;
  createAnalysisRun(run: InsertAnalysisRun): Promise<AnalysisRun>;
  updateAnalysisRun(id: number, data: Partial<AnalysisRun>): Promise<void>;

  getCatalogEntries(projectId: number): Promise<CatalogEntry[]>;
  getCatalogEntry(id: number): Promise<CatalogEntry | undefined>;
  createCatalogEntry(entry: InsertCatalogEntry): Promise<CatalogEntry>;
  createCatalogEntries(entries: InsertCatalogEntry[]): Promise<CatalogEntry[]>;
  updateCatalogEntry(id: number, data: Partial<CatalogEntry>): Promise<void>;
  deleteCatalogEntriesByRun(runId: number): Promise<void>;
  deleteCatalogEntriesByProject(projectId: number): Promise<void>;

  createAnalysisSnapshot(snapshot: InsertAnalysisSnapshot): Promise<AnalysisSnapshot>;
  getAnalysisSnapshot(analysisRunId: number): Promise<AnalysisSnapshot | undefined>;
  getAnalysisSnapshots(projectId: number): Promise<AnalysisSnapshot[]>;
  getLastTwoSnapshots(projectId: number): Promise<AnalysisSnapshot[]>;

  createSecurityFindings(findings: InsertSecurityFinding[]): Promise<SecurityFindingRecord[]>;
  getSecurityFindings(projectId: number, analysisRunId?: number): Promise<SecurityFindingRecord[]>;
  deleteSecurityFindingsByRun(runId: number): Promise<void>;

  createApiKey(key: InsertApiKey): Promise<ApiKey>;
  getApiKeys(): Promise<ApiKey[]>;
  getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined>;
  deleteApiKey(id: number): Promise<void>;
  updateApiKeyLastUsed(id: number): Promise<void>;

  getStats(): Promise<{
    totalProjects: number;
    totalRuns: number;
    totalCatalogEntries: number;
    criticalActions: number;
  }>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async getProjects(): Promise<Project[]> {
    return db.select().from(projects).orderBy(desc(projects.createdAt));
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    return project;
  }

  async createProject(project: InsertProject): Promise<Project> {
    const [created] = await db.insert(projects).values(project).returning();
    return created;
  }

  async updateProjectStatus(id: number, status: string, fileCount?: number): Promise<void> {
    const updates: Partial<Project> = { status };
    if (fileCount !== undefined) updates.fileCount = fileCount;
    await db.update(projects).set(updates).where(eq(projects.id, id));
  }

  async updateProjectGitConfig(id: number, config: { gitProvider: string; gitRepoUrl: string; gitDefaultBranch: string; gitTokenRef: string }): Promise<void> {
    await db.update(projects).set({
      gitProvider: config.gitProvider,
      gitRepoUrl: config.gitRepoUrl,
      gitDefaultBranch: config.gitDefaultBranch,
      gitTokenRef: config.gitTokenRef,
    }).where(eq(projects.id, id));
  }

  async updateProjectWebhookConfig(id: number, config: { webhookSecret: string | null; webhookEnabled: boolean }): Promise<void> {
    await db.update(projects).set({
      webhookSecret: config.webhookSecret,
      webhookEnabled: config.webhookEnabled,
    }).where(eq(projects.id, id));
  }

  async getProjectByGitRepoUrl(repoUrl: string): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.gitRepoUrl, repoUrl));
    return project;
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async getSourceFiles(projectId: number): Promise<SourceFile[]> {
    return db.select().from(sourceFiles).where(eq(sourceFiles.projectId, projectId));
  }

  async createSourceFile(file: InsertSourceFile): Promise<SourceFile> {
    const [created] = await db.insert(sourceFiles).values(file).returning();
    return created;
  }

  async deleteSourceFilesByProject(projectId: number): Promise<void> {
    await db.delete(sourceFiles).where(eq(sourceFiles.projectId, projectId));
  }

  async getAnalysisRuns(projectId: number): Promise<AnalysisRun[]> {
    return db.select().from(analysisRuns).where(eq(analysisRuns.projectId, projectId)).orderBy(desc(analysisRuns.startedAt));
  }

  async getRecentAnalysisRuns(): Promise<AnalysisRun[]> {
    return db.select().from(analysisRuns).orderBy(desc(analysisRuns.startedAt)).limit(10);
  }

  async createAnalysisRun(run: InsertAnalysisRun): Promise<AnalysisRun> {
    const [created] = await db.insert(analysisRuns).values(run).returning();
    return created;
  }

  async updateAnalysisRun(id: number, data: Partial<AnalysisRun>): Promise<void> {
    await db.update(analysisRuns).set(data).where(eq(analysisRuns.id, id));
  }

  async getCatalogEntries(projectId: number): Promise<CatalogEntry[]> {
    return db.select().from(catalogEntries).where(eq(catalogEntries.projectId, projectId)).orderBy(desc(catalogEntries.criticalityScore));
  }

  async getCatalogEntry(id: number): Promise<CatalogEntry | undefined> {
    const [entry] = await db.select().from(catalogEntries).where(eq(catalogEntries.id, id));
    return entry;
  }

  async createCatalogEntry(entry: InsertCatalogEntry): Promise<CatalogEntry> {
    const [created] = await db.insert(catalogEntries).values(entry).returning();
    return created;
  }

  async createCatalogEntries(entries: InsertCatalogEntry[]): Promise<CatalogEntry[]> {
    if (entries.length === 0) return [];
    const BATCH_SIZE = 500;
    const results: CatalogEntry[] = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const created = await db.insert(catalogEntries).values(batch).returning();
      results.push(...created);
    }
    return results;
  }

  async updateCatalogEntry(id: number, data: Partial<CatalogEntry>): Promise<void> {
    await db.update(catalogEntries).set(data).where(eq(catalogEntries.id, id));
  }

  async deleteCatalogEntriesByRun(runId: number): Promise<void> {
    await db.delete(catalogEntries).where(eq(catalogEntries.analysisRunId, runId));
  }

  async deleteCatalogEntriesByProject(projectId: number): Promise<void> {
    await db.delete(catalogEntries).where(eq(catalogEntries.projectId, projectId));
  }

  async createAnalysisSnapshot(snapshot: InsertAnalysisSnapshot): Promise<AnalysisSnapshot> {
    const [created] = await db.insert(analysisSnapshots).values(snapshot).returning();
    return created;
  }

  async getAnalysisSnapshot(analysisRunId: number): Promise<AnalysisSnapshot | undefined> {
    const [snapshot] = await db.select().from(analysisSnapshots).where(eq(analysisSnapshots.analysisRunId, analysisRunId));
    return snapshot;
  }

  async getAnalysisSnapshots(projectId: number): Promise<AnalysisSnapshot[]> {
    return db.select().from(analysisSnapshots).where(eq(analysisSnapshots.projectId, projectId)).orderBy(desc(analysisSnapshots.createdAt));
  }

  async getLastTwoSnapshots(projectId: number): Promise<AnalysisSnapshot[]> {
    return db.select().from(analysisSnapshots).where(eq(analysisSnapshots.projectId, projectId)).orderBy(desc(analysisSnapshots.createdAt)).limit(2);
  }

  async getStats() {
    const [projectCount] = await db.select({ count: sql<number>`count(*)::int` }).from(projects);
    const [runCount] = await db.select({ count: sql<number>`count(*)::int` }).from(analysisRuns);
    const [entryCount] = await db.select({ count: sql<number>`count(*)::int` }).from(catalogEntries);
    const [criticalCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(catalogEntries)
      .where(gt(catalogEntries.criticalityScore, 70));

    return {
      totalProjects: projectCount.count,
      totalRuns: runCount.count,
      totalCatalogEntries: entryCount.count,
      criticalActions: criticalCount.count,
    };
  }

  async createApiKey(key: InsertApiKey): Promise<ApiKey> {
    const [created] = await db.insert(apiKeys).values(key).returning();
    return created;
  }

  async getApiKeys(): Promise<ApiKey[]> {
    return db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
  }

  async getApiKeyByHash(keyHash: string): Promise<ApiKey | undefined> {
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
    return key;
  }

  async deleteApiKey(id: number): Promise<void> {
    await db.delete(apiKeys).where(eq(apiKeys.id, id));
  }

  async updateApiKeyLastUsed(id: number): Promise<void> {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
  }

  async createSecurityFindings(findings: InsertSecurityFinding[]): Promise<SecurityFindingRecord[]> {
    if (findings.length === 0) return [];
    return db.insert(securityFindings).values(findings).returning();
  }

  async getSecurityFindings(projectId: number, analysisRunId?: number): Promise<SecurityFindingRecord[]> {
    if (analysisRunId) {
      return db.select().from(securityFindings)
        .where(and(eq(securityFindings.projectId, projectId), eq(securityFindings.analysisRunId, analysisRunId)))
        .orderBy(securityFindings.id);
    }
    const latestRun = await db.select().from(analysisRuns)
      .where(and(eq(analysisRuns.projectId, projectId), eq(analysisRuns.status, "completed")))
      .orderBy(desc(analysisRuns.id))
      .limit(1);
    if (latestRun.length === 0) return [];
    return db.select().from(securityFindings)
      .where(and(eq(securityFindings.projectId, projectId), eq(securityFindings.analysisRunId, latestRun[0].id)))
      .orderBy(securityFindings.id);
  }

  async deleteSecurityFindingsByRun(runId: number): Promise<void> {
    await db.delete(securityFindings).where(eq(securityFindings.analysisRunId, runId));
  }
}

export const storage = new DatabaseStorage();

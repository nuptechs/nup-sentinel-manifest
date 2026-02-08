import { db } from "./db";
import { eq, desc, sql, and, gt } from "drizzle-orm";
import {
  projects,
  sourceFiles,
  analysisRuns,
  catalogEntries,
  type Project,
  type InsertProject,
  type SourceFile,
  type InsertSourceFile,
  type AnalysisRun,
  type InsertAnalysisRun,
  type CatalogEntry,
  type InsertCatalogEntry,
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
  deleteProject(id: number): Promise<void>;

  getSourceFiles(projectId: number): Promise<SourceFile[]>;
  createSourceFile(file: InsertSourceFile): Promise<SourceFile>;

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
    return db.insert(catalogEntries).values(entries).returning();
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
}

export const storage = new DatabaseStorage();

import OpenAI from "openai";
import type { InsertCatalogEntry } from "@shared/schema";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

interface SemanticClassification {
  technicalOperation: string;
  criticalityScore: number;
  suggestedMeaning: string;
}

export async function classifyEntries(
  entries: InsertCatalogEntry[]
): Promise<InsertCatalogEntry[]> {
  const batchSize = 10;
  const totalBatches = Math.ceil(entries.length / batchSize);
  const classified: InsertCatalogEntry[] = [];
  const llmStart = Date.now();

  for (let i = 0; i < entries.length; i += batchSize) {
    const batchNum = Math.floor(i / batchSize) + 1;
    const batch = entries.slice(i, i + batchSize);
    console.log(`[analysis] LLM batch ${batchNum}/${totalBatches} (entries ${i + 1}-${Math.min(i + batchSize, entries.length)})...`);
    const batchStart = Date.now();
    const classifiedBatch = await classifyBatch(batch);
    console.log(`[analysis] LLM batch ${batchNum}/${totalBatches} done in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`);
    classified.push(...classifiedBatch);
  }

  console.log(`[analysis] LLM classification total: ${((Date.now() - llmStart) / 1000).toFixed(1)}s for ${entries.length} entries`);
  return classified;
}

async function classifyBatch(
  entries: InsertCatalogEntry[]
): Promise<InsertCatalogEntry[]> {
  const summaries = entries.map((e, idx) => ({
    index: idx,
    screen: e.screen,
    interaction: e.interaction,
    interactionType: e.interactionType,
    endpoint: e.endpoint || "none",
    httpMethod: e.httpMethod || "none",
    controllerClass: e.controllerClass || "none",
    controllerMethod: e.controllerMethod || "none",
    serviceMethods: e.serviceMethods || [],
    repositoryMethods: e.repositoryMethods || [],
    entitiesTouched: e.entitiesTouched || [],
    inferredOperation: e.technicalOperation || "unknown",
  }));

  const prompt = `You are a code intelligence engine classifying technical actions for an IAM (Identity and Access Management) system.

For each action below, provide:
1. technicalOperation: One of READ, WRITE, DELETE, STATE_CHANGE, FILE_IO, EXTERNAL_INTEGRATION, NAVIGATION, AUTHENTICATION
2. criticalityScore: 0-100 integer. Higher means more critical/dangerous for security:
   - 0-20: Read-only, navigation, non-sensitive
   - 21-40: Basic data reads with some sensitivity
   - 41-60: Write operations, state changes on non-critical data
   - 61-80: Critical writes, deletes, status changes on business data
   - 81-100: Authentication, authorization, financial operations, external system integration
3. suggestedMeaning: A concise human-readable description of what this action does in business terms (for IAM permission naming)

Actions to classify:
${JSON.stringify(summaries, null, 2)}

Respond ONLY with valid JSON array of objects with fields: index, technicalOperation, criticalityScore, suggestedMeaning`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 4096,
    });

    const content = response.choices[0]?.message?.content || "[]";
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return entries.map((e) => ({
        ...e,
        criticalityScore: estimateCriticality(e),
        suggestedMeaning: `${e.interaction} on ${e.screen}`,
      }));
    }

    const classifications: SemanticClassification[] = JSON.parse(jsonMatch[0]);

    return entries.map((entry, idx) => {
      const classification = classifications.find((c: any) => c.index === idx);
      if (classification) {
        return {
          ...entry,
          technicalOperation: classification.technicalOperation || entry.technicalOperation,
          criticalityScore: Math.min(100, Math.max(0, classification.criticalityScore)),
          suggestedMeaning: classification.suggestedMeaning,
        };
      }
      return {
        ...entry,
        criticalityScore: estimateCriticality(entry),
        suggestedMeaning: `${entry.interaction} on ${entry.screen}`,
      };
    });
  } catch (error) {
    console.error("LLM classification failed, using fallback:", error);
    return entries.map((e) => ({
      ...e,
      criticalityScore: estimateCriticality(e),
      suggestedMeaning: `${e.interaction} on ${e.screen}`,
    }));
  }
}

function estimateCriticality(entry: InsertCatalogEntry): number {
  let score = 10;

  switch (entry.technicalOperation) {
    case "DELETE":
      score += 40;
      break;
    case "WRITE":
      score += 25;
      break;
    case "STATE_CHANGE":
      score += 35;
      break;
    case "EXTERNAL_INTEGRATION":
      score += 45;
      break;
    case "AUTHENTICATION":
      score += 50;
      break;
    case "FILE_IO":
      score += 30;
      break;
    case "READ":
      score += 5;
      break;
    case "NAVIGATION":
      score += 0;
      break;
  }

  const entities = entry.entitiesTouched as string[] || [];
  if (entities.length > 0) score += entities.length * 5;

  const sensitive = ["user", "auth", "token", "password", "payment", "order", "invoice", "role", "permission"];
  for (const entity of entities) {
    if (sensitive.some((s) => entity.toLowerCase().includes(s))) {
      score += 15;
    }
  }

  return Math.min(100, score);
}

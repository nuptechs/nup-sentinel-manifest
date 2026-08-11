// ─────────────────────────────────────────────
// Reasoner — helper de LLM GOVERNADO, único e reusável (acima do SOTA).
//
// Centraliza o padrão BOM que já existia em `narrative-llm.ts` (import dinâmico do
// SDK, chave resolvida por env, fail-soft → fallback determinístico) num único
// ponto que TODA feature do Reasoner usa. Assim o LLM entra no sistema por uma
// porta só, sempre com a mesma disciplina:
//
//   1. O LLM é OPCIONAL — sem chave, `resolveReasonerLLM()` devolve null e o
//      chamador cai no caminho determinístico (o produto funciona byte-a-byte
//      sem IA).
//   2. O LLM nunca é fonte-da-verdade — ele só PROPÕE texto. Quem valida é o
//      `grounding.ts` (a lei), que descarta qualquer claim sem âncora provada.
//   3. Fail-soft — LLM indisponível/erro → null, nunca derruba a requisição.
//
// NÃO é um wrapper novo por vaidade: substitui a duplicação (narrative-llm bom +
// semantic-engine cru) por um caminho governado só.
// ─────────────────────────────────────────────

/** Uma chamada de completude: recebe system+user, devolve o texto cru ou null. */
export type ReasonerLLM = (system: string, user: string) => Promise<string | null>;

function apiKey(): string | undefined {
  return process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || undefined;
}

/** Está a IA ligada? (a superfície mostra "modo determinístico" quando não). */
export function reasonerLlmEnabled(): boolean {
  return !!apiKey();
}

/**
 * Resolve um chamador de LLM, OU null quando não há chave (→ o Reasoner usa o
 * caminho determinístico). Import dinâmico do SDK para não pesar o boot nem
 * exigir a dependência quando desligado. Fail-soft: qualquer erro → null.
 */
export function resolveReasonerLLM(): ReasonerLLM | null {
  const key = apiKey();
  if (!key) return null;
  const model = process.env.AI_INTEGRATIONS_OPENAI_MODEL || "gpt-4o-mini";
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  return async (system, user) => {
    try {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: key, baseURL });
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_completion_tokens: 2048,
      });
      return resp.choices[0]?.message?.content ?? null;
    } catch (err) {
      console.error("[reasoner] chamada ao LLM falhou (fallback determinístico):", err);
      return null;
    }
  };
}

/**
 * Extrai defensivamente o PRIMEIRO array JSON do texto do LLM (que às vezes
 * embrulha em prosa/```json). Nunca lança — texto inválido → []. O grounding a
 * jusante ainda descarta objeto sem âncora, então isto é só conveniência.
 */
export function parseJsonArray(content: string | null | undefined): unknown[] {
  if (!content || typeof content !== "string") return [];
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

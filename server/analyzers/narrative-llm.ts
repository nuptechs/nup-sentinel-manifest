// ─────────────────────────────────────────────
// Adaptador de LLM para a narrativa — ADR-0033 §4 pilar 5 (o LLM EMBELEZA, nunca
// inventa aresta). Isolado do núcleo puro (`narrative.ts`) para: (a) manter o gate
// testável sem I/O; (b) o LLM ficar FORA do caminho crítico — sem chave, o
// chamador nem instancia isto e cai na narrativa-template determinística.
//
// O contrato com o LLM: ele recebe SÓ as arestas VERIFICADAS do subgrafo (com seus
// `edgeId`) e devolve, por aresta, uma frase que NOMEIA a intenção — referenciando
// o `edgeId` dado. Ainda que o modelo invente um `edgeId`, o gate determinístico
// (`applyGroundingGate`) o DESCARTA a jusante: aqui é conveniência, lá é a lei.
// ─────────────────────────────────────────────

import type { NarrativeSubgraph } from "./narrative-subgraph";
import type { EdgeClaim } from "./narrative";

/** Um gerador de frases de aresta (a busca ao LLM); null quando não há chave. */
export type EdgeClaimGenerator = (sub: NarrativeSubgraph) => Promise<EdgeClaim[]>;

function apiKey(): string | undefined {
  return process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || undefined;
}

/**
 * Resolve um gerador de frases via OpenAI, OU null se não houver chave (→ o
 * chamador usa o template determinístico). Import dinâmico do SDK para não pesar
 * o boot nem exigir a dependência quando desligado.
 */
export function resolveEdgeClaimGenerator(): EdgeClaimGenerator | null {
  const key = apiKey();
  if (!key) return null;
  return async (sub) => {
    if (sub.edges.length === 0) return [];
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: key, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
    const model = process.env.AI_INTEGRATIONS_OPENAI_MODEL || "gpt-4o-mini";

    // O material do LLM é EXCLUSIVAMENTE o subgrafo verificado (§4 pilar 1).
    const edges = sub.edges.slice(0, 40).map((e) => ({
      edgeId: e.edgeId,
      from: e.fromLabel,
      to: e.toLabel,
      relation: e.relationType,
      method: e.method,
      provenance: e.provenance,
    }));

    const prompt = `Você é um motor de intelligence de código que EXPLICA arquitetura em português do Brasil.

Recebe uma lista de ARESTAS VERIFICADAS de um grafo de dependências (cada uma com um edgeId estável). Para CADA aresta, escreva UMA frase curta que NOMEIA a intenção técnica/de negócio da relação — o que aquela chamada/acesso significa no sistema.

REGRAS INVIOLÁVEIS:
- Use SOMENTE os edgeId fornecidos. NUNCA invente uma aresta, um símbolo ou uma relação que não esteja na lista.
- Não afirme nada além do que a relação diz; não deduza comportamento não listado.
- Uma frase por aresta, objetiva, sem repetir "esta aresta".

Arestas verificadas:
${JSON.stringify(edges, null, 2)}

Responda SOMENTE com um array JSON de objetos { "edgeId": string, "text": string }.`;

    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        max_completion_tokens: 2048,
      });
      const content = resp.choices[0]?.message?.content || "[]";
      const match = content.match(/\[[\s\S]*\]/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];
      // shape defensivo — o gate a jusante ainda descarta edgeId inexistente.
      return parsed
        .filter((c: unknown): c is EdgeClaim => !!c && typeof (c as any).edgeId === "string" && typeof (c as any).text === "string")
        .map((c: any) => ({ edgeId: c.edgeId, text: String(c.text).trim() }));
    } catch (err) {
      // fail-soft: LLM indisponível → sem frases → o chamador usa o template.
      console.error("[narrative] geração de frases via LLM falhou (fallback template):", err);
      return [];
    }
  };
}

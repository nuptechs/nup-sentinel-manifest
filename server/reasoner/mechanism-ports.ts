// ─────────────────────────────────────────────
// Reasoner — PORTAS do Mecanismo (arquitetura hexagonal).
//
// O núcleo do mecanismo (`mechanism.ts`) depende de INTERFACES, não de Jaeger/scip/
// storage concretos. Cada fonte de evidência é uma PORTA; os adapters (em
// `adapters/`) as implementam. Isto mantém o núcleo puro e testável, e deixa o
// Sentinel ORQUESTRAR qualquer ferramenta (própria — manifest/codelens/scip — ou
// não — OTel/Jaeger) trocando o adapter, sem tocar a lógica.
// ─────────────────────────────────────────────

/** Uma operação observada em runtime, com sua posição REAL na execução. */
export interface RuntimeOp {
  /** tabela/entidade tocada (normalizada) — a granularidade que o OTel dá de graça. */
  table: string;
  /** natureza da operação, inferida do db.statement (SELECT vs INSERT/UPDATE/DELETE). */
  op: "read" | "write" | "touch";
  /** posição na ordem REAL de execução (0 = primeiro span DB da requisição). */
  rank: number;
}

/**
 * PORTA de ORDEM DE RUNTIME: devolve a sequência REAL de operações de uma feature,
 * ordenada por tempo de span (o que nem o agente cru nem o grafo colapsado têm).
 * Fail-soft: sem fonte (JAEGER_QUERY_URL ausente/erro) → `[]` (o mecanismo cai na
 * ordem por alcance). NÃO é a granularidade de método — é a de tabela/operação, que
 * é o que o OTel instrumenta de fato.
 */
export interface RuntimeOrderPort {
  orderedOpsFor(entryHint: string): Promise<RuntimeOp[]>;
}

/** Porta nula (o padrão determinístico: sem runtime, ordem por alcance). */
export const nullRuntimeOrderPort: RuntimeOrderPort = {
  async orderedOpsFor() {
    return [];
  },
};

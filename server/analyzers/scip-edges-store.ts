// ─────────────────────────────────────────────────────────────────────────
// Store multi-fonte das arestas SCIP por projeto (ADR-0031 / ADR-0035 F1).
//
// POR QUE EXISTE: um projeto pode ter MAIS DE UM emissor compiler-accurate. O
// easynup (projeto 27) tem DOIS: o workflow `scip-java-index.yml` (STATIC_PROVEN
// Java) e, a partir de agora, o `scip-typescript-index.yml` do front (Vue+TS).
// O handler antigo de `POST /scip-edges` fazia `storage.updateProjectScipEdges`
// = SOBRESCREVE a coluna inteira. Com dois emissores no MESMO projeto, cada POST
// apagava as arestas do outro (Java zera o TS; o próximo push de TS zera o Java).
//
// SOLUÇÃO: guardar as arestas em BALDES por FONTE (`_bySource`) e manter o
// top-level FLAT (`edges`/`dataAccess`/`imports`/`entryFiles`/`ingestedAt`) como
// a UNIÃO de todos os baldes. Os 3 leitores (graph-overlays, reasoner/graph-load,
// evidence-health) continuam lendo o top-level flat SEM mudança (retrocompat).
// Re-POST de uma fonte substitui SÓ o balde dela; as outras ficam intactas.
//
// RETROCOMPAT: um store LEGADO (flat, sem `_bySource` — como o que já existe hoje
// nos projetos que só tinham o workflow Java, e o identify projeto 38) é migrado
// para o balde `default` na primeira escrita multi-fonte. Como tanto o Java quanto
// o identify POSTam na rota FLAT (sem fonte → `default`), o re-POST deles substitui
// o próprio balde `default` — nunca duplica, nunca apaga o balde `typescript`.
//
// PURO e testável (nenhum I/O). Fail-soft: entrada malformada degrada p/ vazio.
// ─────────────────────────────────────────────────────────────────────────

/** Nome de fonte canônico: minúsculo, [a-z0-9_-], 1..40 chars. */
export const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const DEFAULT_SOURCE = "default";

/** Um balde = o payload (validado pelo `scipEdgesSchema`) de UMA fonte. */
export interface ScipSourceBucket {
  tool?: string;
  schema?: string;
  counts?: unknown;
  edges?: unknown[];
  dataAccess?: unknown[];
  imports?: unknown[];
  entryFiles?: unknown[];
  ingestedAt?: string;
}

/** O objeto persistido na coluna `projects.scipEdges` após a migração multi-fonte. */
export interface ScipEdgesStore {
  tool: string;
  schema: string;
  /** baldes por fonte — a verdade; o top-level flat é derivado daqui. */
  _bySource: Record<string, ScipSourceBucket>;
  /** UNIÃO (lida pelos consumidores existentes, sem mudança). */
  edges: unknown[];
  dataAccess: unknown[];
  imports: unknown[];
  entryFiles: unknown[];
  /** ingestão mais recente entre todas as fontes. */
  ingestedAt: string;
  /** contagens por fonte + total, para telemetria/depuração. */
  counts: { total: number; bySource: Record<string, number> };
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Normaliza o store existente em `{ [source]: bucket }`.
 * - já multi-fonte (`_bySource`) → copia os baldes;
 * - legado flat (tem `edges`) → migra o payload inteiro p/ o balde `default`;
 * - null / malformado → vazio.
 */
export function bucketsOf(existing: unknown): Record<string, ScipSourceBucket> {
  if (existing && typeof existing === "object") {
    const e = existing as Record<string, unknown>;
    if (e._bySource && typeof e._bySource === "object") {
      return { ...(e._bySource as Record<string, ScipSourceBucket>) };
    }
    if (Array.isArray(e.edges)) {
      // Legado flat (um único emissor, pré-multi-fonte) → balde `default`.
      const { _bySource, ...flat } = e; // descarta campo _bySource ausente/ruído
      void _bySource;
      return { [DEFAULT_SOURCE]: flat as ScipSourceBucket };
    }
  }
  return {};
}

/** Payload de UMA fonte que o handler recebe (já validado pelo schema). */
export interface IncomingScipPayload {
  tool?: string;
  schema?: string;
  counts?: unknown;
  edges: unknown[];
  dataAccess?: unknown[];
  imports?: unknown[];
  entryFiles?: unknown[];
}

/**
 * Mescla `incoming` da fonte `source` no `existing`, retornando o novo objeto a
 * persistir. Substitui APENAS o balde de `source`; une tudo no top-level flat.
 * `now` é injetado para teste determinístico.
 */
export function mergeScipEdgesStore(
  existing: unknown,
  incoming: IncomingScipPayload,
  source: string,
  now: string = new Date().toISOString(),
): ScipEdgesStore {
  const src = SOURCE_RE.test(source) ? source : DEFAULT_SOURCE;
  const buckets = bucketsOf(existing);

  buckets[src] = {
    ...(incoming.tool ? { tool: incoming.tool } : {}),
    ...(incoming.schema ? { schema: incoming.schema } : {}),
    ...(incoming.counts !== undefined ? { counts: incoming.counts } : {}),
    edges: arr(incoming.edges),
    ...(incoming.dataAccess ? { dataAccess: arr(incoming.dataAccess) } : {}),
    ...(incoming.imports ? { imports: arr(incoming.imports) } : {}),
    ...(incoming.entryFiles ? { entryFiles: arr(incoming.entryFiles) } : {}),
    ingestedAt: now,
  };

  const edges: unknown[] = [];
  const dataAccess: unknown[] = [];
  const imports: unknown[] = [];
  const entryFiles: unknown[] = [];
  const bySource: Record<string, number> = {};
  let latest = "";
  for (const [name, b] of Object.entries(buckets)) {
    const be = arr(b.edges);
    edges.push(...be);
    dataAccess.push(...arr(b.dataAccess));
    imports.push(...arr(b.imports));
    entryFiles.push(...arr(b.entryFiles));
    bySource[name] = be.length;
    if (typeof b.ingestedAt === "string" && b.ingestedAt > latest) latest = b.ingestedAt;
  }

  return {
    tool: "scip (multi-source)",
    schema: "scip-edges.multi-source.v1",
    _bySource: buckets,
    edges,
    dataAccess,
    imports,
    entryFiles,
    ingestedAt: latest || now,
    counts: { total: edges.length, bySource },
  };
}

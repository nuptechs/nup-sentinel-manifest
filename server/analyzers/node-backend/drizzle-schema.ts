// ─────────────────────────────────────────────
// Parser de schema Drizzle — ADR-0015 Onda 1, D4/D5 (balde node-backend).
//
// Extrai as entidades persistentes de um backend Node que usa Drizzle ORM:
// `export const webhookEvents = pgTable("webhook_event", { ...colunas })`.
// A identidade da entidade é o NOME DA TABELA (1º arg do pgTable) — a chave
// persistente, análoga ao @Table(name=...) do JPA no lado Java. O SÍMBOLO
// exportado (webhookEvents) é o que o handler da rota referencia; guardamos o
// mapa símbolo→entidade pra resolver `entitiesTouched` a partir do call-site.
//
// Vive atrás da flag MANIFEST_MULTISTACK_NODE (só o parser Express o invoca).
// Regex determinística, sem AST (o motor AST próprio é Java-only). Cobre
// pgTable/pgView, sqliteTable e mysqlTable. Colunas por parsing raso do corpo.
// ─────────────────────────────────────────────

export interface DrizzleColumn {
  /** Nome do campo no código (chave do objeto de colunas). */
  name: string;
  /** Tipo Drizzle da coluna (text, integer, varchar, ...). */
  type: string;
  /** Nome da coluna no banco, quando dado como 1º arg (ex.: text("payload")). */
  column: string | null;
  isId: boolean;
}

export interface DrizzleEntity {
  /** Símbolo exportado (ex.: webhookEvents) — o que o handler referencia. */
  symbol: string;
  /** Nome da tabela no banco (1º arg do pgTable) — identidade da entidade. */
  entity: string;
  columns: DrizzleColumn[];
  sourceFile: string;
}

// `export const SYMBOL = pgTable("table", { ... })` (também sqlite/mysql/View).
const TABLE_DECL_RE =
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgTable|sqliteTable|mysqlTable|pgView)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g;

// Uma coluna: `name: text("col").primaryKey()...` — captura nome, tipo e (opcional) col.
const COLUMN_RE =
  /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*\(\s*(?:['"`]([^'"`]+)['"`])?/g;

/** A partir do `{` de abertura do objeto de colunas, lê o corpo balanceado. */
function readObjectBody(content: string, openBraceIdx: number): string {
  let depth = 1;
  let i = openBraceIdx + 1;
  let quote: string | null = null;
  const start = i;
  for (; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return content.slice(start, i);
}

function parseColumns(body: string): DrizzleColumn[] {
  const cols: DrizzleColumn[] = [];
  COLUMN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COLUMN_RE.exec(body)) !== null) {
    const [full, name, type, column] = m;
    // O ponto de match tem que ser um verdadeiro `<ident>(` (construtor de coluna).
    const isId = /\.\s*primaryKey\s*\(/.test(
      body.slice(m.index, m.index + full.length + 40),
    );
    cols.push({ name, type, column: column ?? null, isId });
  }
  return cols;
}

/**
 * Varre os arquivos (não-.java) e extrai as entidades Drizzle. Determinístico,
 * ordenado por símbolo. Sem `pgTable`/`sqliteTable`/`mysqlTable` no arquivo,
 * ele é ignorado (guarda barata).
 */
export function extractDrizzleEntities(
  files: { filePath: string; content: string }[],
): DrizzleEntity[] {
  const entities: DrizzleEntity[] = [];
  for (const file of files) {
    if (file.filePath.endsWith(".java")) continue;
    const content = file.content;
    if (!/\b(?:pgTable|sqliteTable|mysqlTable|pgView)\s*\(/.test(content)) continue;

    TABLE_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TABLE_DECL_RE.exec(content)) !== null) {
      const [, symbol, entity] = m;
      const braceIdx = content.indexOf("{", m.index + m[0].length - 1);
      const body = braceIdx >= 0 ? readObjectBody(content, braceIdx) : "";
      entities.push({
        symbol,
        entity,
        columns: parseColumns(body),
        sourceFile: file.filePath,
      });
    }
  }
  entities.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return entities;
}

/** Índice símbolo→entidade para resolver referências de handler em O(1). */
export function drizzleSymbolIndex(entities: DrizzleEntity[]): Map<string, DrizzleEntity> {
  const idx = new Map<string, DrizzleEntity>();
  for (const e of entities) if (!idx.has(e.symbol)) idx.set(e.symbol, e);
  return idx;
}

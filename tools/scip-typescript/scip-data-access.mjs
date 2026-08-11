// ─────────────────────────────────────────────────────────────────────────
// Extração COMPILER-ACCURATE de ACESSO A DADOS de um índice SCIP (scip-typescript).
//
// Prova, a partir do índice que o CI do cliente já gera (mesma compilação, custo
// marginal ~zero), quais funções LEEM ou ESCREVEM em quais tabelas — o eixo que
// hoje é heurístico (STATIC_UNRESOLVED) no lado Node/TS. Puro (sem I/O): recebe o
// índice já desserializado e devolve as arestas função→tabela com direção provada.
//
// COMO É PROVADO (verificado contra um index.scip REAL de Express+Drizzle):
//  • VERBO (leitura vs escrita) — o símbolo do método-raiz resolvido pelo checker:
//      drizzle-orm .../PgDatabase#select().  → READ
//      drizzle-orm .../PgDatabase#insert()/#update()/#delete().  → WRITE
//    (idem MySqlDatabase#/BaseSQLiteDatabase# para os outros dialetos.)
//  • TABELA — o símbolo de PROJETO na MESMA linha do verbo cuja DEFINIÇÃO é
//    seguida de `pgTable`/`mysqlTable`/`sqliteTable`/`pgView` (é uma tabela Drizzle).
//  • FUNÇÃO CONTÊINER — a definição de função cujo `enclosing_range` (populado nas
//    DEFs) contém a linha do verbo. (scip-typescript NÃO seta ReadAccess/WriteAccess
//    nos roles — por isso o verbo, não o role, é o oráculo; verificado no índice.)
//
// MURO DE RICE (política CONSERVADORA — solidez acima de precisão): quando a tabela
// não resolve a um símbolo de tabela na linha (parâmetro genérico, tabela escolhida
// em runtime, `sql``` cru), NÃO se inventa a tabela — a aresta é OMITIDA (contada em
// `unresolvedTable`). Direção nunca é chutada: só READ/WRITE quando o verbo é provado;
// efeito misto (INSERT … RETURNING) segue o verbo-raiz = WRITE (o efeito mais forte,
// nunca rebaixado a READ). Fonte: pesquisa 2026 (Drizzle docs, sound static analysis).
// ─────────────────────────────────────────────────────────────────────────

// ── Acessores tolerantes a snake_case (binário) e lowerCamelCase (--json) ──
const rolesOf = (o) => (o.symbol_roles ?? o.symbolRoles ?? 0) | 0;
const relPathOf = (d) => d.relative_path ?? d.relativePath ?? null;
const rangeArrOf = (tr) => {
  if (!tr) return null;
  const s = tr.SingleLineRange;
  if (s) return [s.line, s.start_character, s.end_character];
  const m = tr.MultiLineRange;
  if (m) return [m.start_line, m.start_character, m.end_line, m.end_character];
  return null;
};
const rangeOf = (o) => (Array.isArray(o.range) && o.range.length ? o.range : rangeArrOf(o.TypedRange));
const enclOf = (o) => {
  const b = o.enclosing_range ?? o.enclosingRange;
  if (Array.isArray(b) && b.length) return b;
  return rangeArrOf(o.TypedEnclosingRange);
};
const startLineOf = (o) => {
  const r = rangeOf(o);
  return Array.isArray(r) && r.length ? r[0] : NaN;
};

const DEFINITION = 1;
const IMPORT = 2;

// Método SCIP: descriptor termina em `(<disamb>).`. Term (const/tabela): termina em `.` sem `()`.
const isMethodSym = (s) => typeof s === "string" && /\([^)]*\)\.$/.test(s);
const isTermSym = (s) => typeof s === "string" && /(?<!\))\.$/.test(s) && !isMethodSym(s);

// Verbo Drizzle no símbolo do método-raiz → direção. Cobre pg/mysql/sqlite.
const DB_CLASS = /(?:Pg|MySql|BaseSQLite)Database#/;
const verbOf = (sym) => {
  if (typeof sym !== "string" || !DB_CLASS.test(sym)) return null;
  if (/#select\([^)]*\)\.$/.test(sym)) return "read";
  if (/#(?:insert|update|delete)\([^)]*\)\.$/.test(sym)) return "write";
  return null;
};

// Construtor de tabela Drizzle (a ocorrência que SEGUE a def da const de tabela).
const TABLE_CTOR = /\/(?:pgTable|mysqlTable|sqliteTable|pgView)\.$|`(?:pgTable|mysqlTable|sqliteTable|pgView)`/;
const isTableCtorSym = (s) => typeof s === "string" && (/(?:pgTable|mysqlTable|sqliteTable|pgView)\.$/.test(s) || /`table\.d\.ts`\/(?:pgTable|mysqlTable|sqliteTable|pgView)\./.test(s));

/**
 * Conjunto de símbolos que SÃO tabelas Drizzle: uma const de PROJETO cuja
 * DEFINIÇÃO é imediatamente seguida (mesma varredura do documento) por um
 * construtor de tabela. Retorna Map symbol→{file}.
 */
export function findTableSymbols(idx) {
  const tables = new Map();
  for (const d of idx.documents || []) {
    const rel = relPathOf(d);
    const occ = d.occurrences || [];
    for (let i = 0; i < occ.length; i++) {
      const o = occ[i];
      if (!isTermSym(o.symbol)) continue;
      if (!(rolesOf(o) & DEFINITION)) continue;
      // a próxima ocorrência (por ordem do documento) deve ser um construtor de tabela
      const nxt = occ[i + 1];
      if (nxt && isTableCtorSym(nxt.symbol)) tables.set(o.symbol, { file: rel });
    }
  }
  return tables;
}

/** Corpos de função por documento: {sym, bodyStart, bodyEnd, file} via enclosing_range. */
function functionBodies(d) {
  const rel = relPathOf(d);
  const defs = [];
  for (const o of d.occurrences || []) {
    if (!isMethodSym(o.symbol)) continue;
    if (!(rolesOf(o) & DEFINITION)) continue;
    const start = startLineOf(o);
    let bodyStart = start;
    let bodyEnd = Infinity;
    const er = enclOf(o);
    if (Array.isArray(er) && er.length >= 4) {
      bodyStart = er[0];
      bodyEnd = er[2];
    } else if (Array.isArray(er) && er.length === 3) {
      bodyStart = er[0];
      bodyEnd = er[0];
    }
    defs.push({ sym: o.symbol, start, bodyStart, bodyEnd, file: rel });
  }
  defs.sort((a, b) => a.start - b.start);
  // corpo aproximado quando não há enclosing_range: [def.start, próxima-def.start)
  for (let i = 0; i < defs.length; i++)
    if (defs[i].bodyEnd === Infinity) defs[i].bodyEnd = i + 1 < defs.length ? defs[i + 1].start : Infinity;
  return defs;
}

/**
 * Deriva as arestas de acesso a dados função→tabela. PURA.
 * @returns { edges: [{from, to, access, resolution, fromFile, toFile}], stats }
 *   from = símbolo da função; to = símbolo da const de tabela; access = 'read'|'write';
 *   resolution sempre 'compiler' (o checker resolveu verbo, tabela e função).
 */
export function deriveDataAccess(idx) {
  const tables = findTableSymbols(idx);
  const edges = new Map(); // dedup por (from|to|access)
  let verbSites = 0;
  let unresolvedTable = 0; // verbo provado, tabela indecidível → NÃO inventa

  for (const d of idx.documents || []) {
    const rel = relPathOf(d);
    const occ = d.occurrences || [];
    const bodies = functionBodies(d);

    // índice das ocorrências de tabela por LINHA (a tabela fica na mesma linha do verbo)
    const tableByLine = new Map();
    for (const o of occ) {
      if (rolesOf(o) & DEFINITION) continue; // é a definição da própria tabela, não um acesso
      if (!tables.has(o.symbol)) continue;
      const ln = startLineOf(o);
      if (!Number.isFinite(ln)) continue;
      if (!tableByLine.has(ln)) tableByLine.set(ln, o.symbol); // 1ª tabela da linha
    }

    for (const o of occ) {
      const access = verbOf(o.symbol);
      if (!access) continue;
      const roles = rolesOf(o);
      if (roles & DEFINITION || roles & IMPORT) continue; // é uso, não a def do método do ORM
      verbSites++;
      const ln = startLineOf(o);
      // função contêiner: o corpo (mais interno) que contém a linha do verbo
      let fn = null;
      for (const b of bodies) if (ln >= b.bodyStart && ln <= b.bodyEnd) fn = b;
      if (!fn) continue; // verbo fora de qualquer função conhecida — não atribui
      // tabela na MESMA linha do verbo (política conservadora: sem tabela → não emite)
      const tableSym = tableByLine.get(ln);
      if (!tableSym) { unresolvedTable++; continue; }
      const key = fn.sym + "|" + tableSym + "|" + access;
      if (edges.has(key)) continue;
      const e = { from: fn.sym, to: tableSym, access, resolution: "compiler" };
      if (fn.file) e.fromFile = fn.file;
      const t = tables.get(tableSym);
      if (t && t.file) e.toFile = t.file;
      edges.set(key, e);
    }
  }

  return {
    edges: [...edges.values()],
    stats: { tables: tables.size, verbSites, resolved: edges.size, unresolvedTable },
  };
}

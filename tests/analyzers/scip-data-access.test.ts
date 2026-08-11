// ─────────────────────────────────────────────────────────────────────────
// scip-data-access — extração COMPILER-ACCURATE de acesso a dados (função→tabela
// READ/WRITE) de um índice SCIP. O teste-âncora roda contra um índice SCIP **REAL**
// (fixtures/scip/express-drizzle-index.json), gerado por `scip-typescript index`
// sobre um app mínimo Express+Drizzle — não símbolos sintéticos. Os casos de política
// conservadora (muro de Rice) usam índices sintéticos mínimos.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// @ts-expect-error — módulo .mjs puro (roda no CI do cliente, standalone)
import { deriveDataAccess, findTableSymbols } from "../../tools/scip-typescript/scip-data-access.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const realIndex = JSON.parse(
  readFileSync(join(here, "../fixtures/scip/express-drizzle-index.json"), "utf8"),
);

// rótulo curto do símbolo (tira scheme/manager/package/version)
const short = (s: string) => s.split(" ").slice(4).join(" ");
const asRel = (edges: any[]) =>
  edges.map((e) => `${short(e.from)} ${e.access} ${short(e.to)}`).sort();

describe("scip-data-access — índice SCIP REAL (Express+Drizzle)", () => {
  it("prova exatamente as 3 arestas de acesso a dados, com direção correta", () => {
    const { edges, stats } = deriveDataAccess(realIndex);
    assert.equal(stats.unresolvedTable, 0, "toda tabela resolveu (nada de chute)");
    assert.deepEqual(asRel(edges), [
      "src/`handlers.ts`/createUser(). write src/`schema.ts`/users.",
      "src/`handlers.ts`/deletePost(). write src/`schema.ts`/posts.",
      "src/`handlers.ts`/listUsers(). read src/`schema.ts`/users.",
    ]);
  });

  it("todas as arestas são resolution:'compiler' e carregam fromFile/toFile", () => {
    const { edges } = deriveDataAccess(realIndex);
    for (const e of edges) {
      assert.equal(e.resolution, "compiler");
      assert.match(e.fromFile, /handlers\.ts$/);
      assert.match(e.toFile, /schema\.ts$/);
    }
  });

  it("detecta as tabelas Drizzle (const seguida de pgTable): users e posts", () => {
    const tables = findTableSymbols(realIndex);
    assert.deepEqual([...tables.keys()].map(short).sort(), ["src/`schema.ts`/posts.", "src/`schema.ts`/users."]);
  });

  it("SELECT é leitura; INSERT/UPDATE/DELETE são escrita (verbo, não role)", () => {
    const { edges } = deriveDataAccess(realIndex);
    const byFn = (fn: string) => edges.find((e: any) => e.from.includes(fn))?.access;
    assert.equal(byFn("listUsers"), "read");   // db.select().from(users)
    assert.equal(byFn("createUser"), "write"); // db.insert(users)
    assert.equal(byFn("deletePost"), "write"); // db.delete(posts)
  });
});

// ── Casos sintéticos: política conservadora (muro de Rice) ──
// helper: um índice mínimo com 1 doc, 1 função (com enclosing_range) e ocorrências dadas.
function synthDoc(occ: any[]) {
  return { documents: [{ relative_path: "src/h.ts", occurrences: occ }] };
}
const SEL = "scip-typescript npm drizzle-orm 0.36.4 pg-core/`db.d.ts`/PgDatabase#select().";
const INS = "scip-typescript npm drizzle-orm 0.36.4 pg-core/`db.d.ts`/PgDatabase#insert().";
const PGTABLE = "scip-typescript npm drizzle-orm 0.36.4 pg-core/`table.d.ts`/pgTable.";
const FN = "scip-typescript npm p 1 src/`h.ts`/handler().";
const occ = (symbol: string, line: number, col = 0, roles = 0, enclosing_range?: number[]) => ({
  symbol,
  symbol_roles: roles,
  range: [line, col, col + 1],
  ...(enclosing_range ? { enclosing_range } : {}),
});

describe("scip-data-access — política conservadora (nunca inventa)", () => {
  it("verbo provado mas SEM tabela na linha → NÃO emite aresta (conta unresolvedTable)", () => {
    // handler() no corpo linhas 1..3; um insert na linha 2 SEM símbolo de tabela na linha
    const idx = synthDoc([
      occ(FN, 1, 0, 1, [1, 0, 3, 1]), // def da função com enclosing_range
      occ(INS, 2, 4, 0),               // verbo de escrita, mas tabela é dinâmica/ausente
    ]);
    const { edges, stats } = deriveDataAccess(idx);
    assert.equal(edges.length, 0, "sem tabela provada → nenhuma aresta");
    assert.equal(stats.unresolvedTable, 1);
  });

  it("emite READ/WRITE quando a tabela está na MESMA linha do verbo", () => {
    // define a const de tabela `t` (DEF seguida de pgTable) e a usa num insert
    const T = "scip-typescript npm p 1 src/`schema.ts`/t.";
    const idx = {
      documents: [
        { relative_path: "src/schema.ts", occurrences: [occ(T, 0, 6, 1), occ(PGTABLE, 0, 10, 0)] },
        {
          relative_path: "src/h.ts",
          occurrences: [
            occ(FN, 1, 0, 1, [1, 0, 3, 1]),
            occ(INS, 2, 4, 0), // verbo escrita
            occ(T, 2, 12, 0),  // tabela na MESMA linha (2)
          ],
        },
      ],
    };
    const { edges } = deriveDataAccess(idx);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].access, "write");
    assert.equal(edges[0].to, T);
    assert.equal(edges[0].from, FN);
  });

  it("verbo fora de qualquer função conhecida → não atribui (sem aresta)", () => {
    const T = "scip-typescript npm p 1 src/`schema.ts`/t.";
    const idx = {
      documents: [
        { relative_path: "src/schema.ts", occurrences: [occ(T, 0, 6, 1), occ(PGTABLE, 0, 10, 0)] },
        { relative_path: "src/h.ts", occurrences: [occ(SEL, 9, 0, 0), occ(T, 9, 8, 0)] }, // sem def de função
      ],
    };
    assert.equal(deriveDataAccess(idx).edges.length, 0);
  });

  it("dedup: mesma (função, tabela, direção) repetida vira uma aresta só", () => {
    const T = "scip-typescript npm p 1 src/`schema.ts`/t.";
    const idx = {
      documents: [
        { relative_path: "src/schema.ts", occurrences: [occ(T, 0, 6, 1), occ(PGTABLE, 0, 10, 0)] },
        {
          relative_path: "src/h.ts",
          occurrences: [
            occ(FN, 1, 0, 1, [1, 0, 5, 1]),
            occ(SEL, 2, 4, 0), occ(T, 2, 12, 0), // read t
            occ(SEL, 4, 4, 0), occ(T, 4, 12, 0), // read t de novo
          ],
        },
      ],
    };
    assert.equal(deriveDataAccess(idx).edges.length, 1);
  });

  it("índice vazio / sem tabelas → zero arestas, nunca lança", () => {
    assert.doesNotThrow(() => deriveDataAccess({ documents: [] }));
    assert.equal(deriveDataAccess({ documents: [] }).edges.length, 0);
    assert.equal(deriveDataAccess({}).edges.length, 0);
  });
});

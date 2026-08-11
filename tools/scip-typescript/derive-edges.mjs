#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// ADR-0030 P2.2 — Deriva arestas de call-graph COMPILER-ACCURATE de um índice
// SCIP (scip-typescript), para alimentar o eixo STATIC_PROVEN do mapa.
//
// PROVADO ao vivo no NuPIdentify (2026-08-05): index.scip de 21.6MB (410 docs,
// 217.991 occurrences, 3.616 defs de método, 30.204 call-sites, 88 is_impl) →
// 7.308 arestas STATIC_PROVEN + 29 interface-impl (ports→K adapters).
//
// PIPELINE (ADR-0030):
//   CI do repo-alvo:  scip-typescript index --output index.scip
//   Aqui:             node derive-edges.mjs index.scip > edges.json
//   (P2.2 restante):  agregar edges símbolo→símbolo à granularidade de
//                     serviço/endpoint/entidade do system-graph + ingerir com
//                     resolution:'compiler'/'interface-impl' (espelha o
//                     backend-java-client). Ver ADR-0030 §4.
//
// ADR-0035 F1 — cada aresta carrega `fromFile`/`toFile` (arquivo-fonte de DEFINIÇÃO
// de cada ponta). O `toFile` sai de um índice GLOBAL símbolo→documento-de-definição
// (o callee é definido noutro doc). Isso torna a agregação no Manifest AGNÓSTICA à
// linguagem: o símbolo scip-JAVA carrega pacote/classe, não o arquivo — sem estes
// campos, a agregação não conseguia mapear arestas Java a nós de sistema.
//
// O MURO honesto (ADR-0030 §5): o que fica aqui é chamada DIRETA resolvida pelo
// checker + interface→K-candidatos. DI concreta / dispatch dinâmico / reflexão
// NÃO aparecem aqui — ficam com o RUNTIME_OBSERVED (ADR-0029, hub OTel).
//
// Uso: node derive-edges.mjs <index.scip> [--scip-lib <path para scip.js>]
// ─────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import { createRequire } from 'module';
import { deriveDataAccess } from './scip-data-access.mjs';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const indexPath = args.find((a) => !a.startsWith('--'));
if (!indexPath) {
  console.error('uso: node derive-edges.mjs <index.scip> [--scip-lib <scip.js>]');
  process.exit(2);
}
// Duas fontes de índice:
//  (a) BINÁRIO (default): decodifica index.scip via o binding protobuf do
//      scip-typescript (dist/src/scip.js). Campos snake_case.
//  (b) `--json <path>`: lê a saída de `scip print --json` (CLI canônico do
//      sourcegraph/scip). OBRIGATÓRIO p/ scip-JAVA: o binding do scip-typescript
//      decodifica os ranges do índice scip-java como VAZIOS (packed int32
//      incompatível) → NaN; o CLI canônico decodifica certo. Campos lowerCamelCase.
const jsonFlag = args.indexOf('--json');
let idx;
if (jsonFlag >= 0) {
  idx = JSON.parse(fs.readFileSync(args[jsonFlag + 1] || indexPath, 'utf8'));
} else {
  const libFlag = args.indexOf('--scip-lib');
  const scipLib =
    libFlag >= 0
      ? args[libFlag + 1]
      : require.resolve('@sourcegraph/scip-typescript/dist/src/scip.js');
  const scip = require(scipLib);
  idx = scip.scip.Index.deserialize(fs.readFileSync(indexPath));
}

// Acessores tolerantes a snake_case (binário) e lowerCamelCase (protojson/--json).
const rolesOf = (o) => (o.symbol_roles ?? o.symbolRoles ?? 0) | 0;
const enclOf = (o) => {
  const b = o.enclosing_range ?? o.enclosingRange;
  if (Array.isArray(b) && b.length) return b;
  return rangeArr(o.TypedEnclosingRange);
};
// `scip print --json` (CLI Go do sourcegraph/scip) aninha o range num struct
// tipado: TypedRange.{SingleLineRange|MultiLineRange}. Normaliza p/ o array
// [line, sc, ec] (mesma linha) ou [sl, sc, el, ec] (multi-linha) que o `rng` usa.
const rangeArr = (tr) => {
  if (!tr) return null;
  const s = tr.SingleLineRange;
  if (s) return [s.line, s.start_character, s.end_character];
  const m = tr.MultiLineRange;
  if (m) return [m.start_line, m.start_character, m.end_line, m.end_character];
  return null;
};
// range do binário (array direto) OU do JSON do CLI (TypedRange aninhado).
const rangeOf = (o) => (Array.isArray(o.range) && o.range.length ? o.range : rangeArr(o.TypedRange));
const isImpl = (r) => r.is_implementation ?? r.isImplementation;
// Caminho relativo do documento: snake_case (binário) e lowerCamelCase (--json).
const relPathOf = (d) => d.relative_path ?? d.relativePath ?? null;

// SCIP range: [startLine, startChar, endLine, endChar] ou [line, startChar, endChar].
const pos = (l, c) => l * 1_000_000 + c;
const rng = (r) =>
  !Array.isArray(r) || r.length < 2
    ? [NaN, NaN]
    : r.length >= 4
      ? [pos(r[0], r[1]), pos(r[2], r[3])]
      : [pos(r[0], r[1]), pos(r[0], r[2] ?? r[1])];


// Método em SCIP: descriptor `nome(<disambiguator>).`. scip-typescript emite o
// disambiguator VAZIO ("()."); scip-java (semanticdb) emite NÃO-vazio (ex.
// "(+1)." p/ overload, ou assinatura). O regex cobre ambos — backward-compatible
// com o TS. (Antes: `endsWith('().')` casava só TS → 0 arestas no Java.)
const isMethodSym = (s) => typeof s === 'string' && /\([^)]*\)\.$/.test(s);
// SymbolRole (bit flags): Definition=1, Import=2.
const DEFINITION = 1;
const IMPORT = 2;

// interface→impls: `is_implementation` aponta impl→interface; invertemos.
const implsOf = new Map();
for (const d of idx.documents)
  for (const s of d.symbols || [])
    for (const r of s.relationships || [])
      if (isImpl(r) && r.symbol) {
        if (!implsOf.has(r.symbol)) implsOf.set(r.symbol, new Set());
        implsOf.get(r.symbol).add(s.symbol);
      }

// ADR-0035 F1 — índice GLOBAL símbolo→arquivo-de-DEFINIÇÃO. O símbolo scip-JAVA
// carrega pacote/classe, não o arquivo — então a agregação no Manifest precisa do
// arquivo-fonte por ponta da aresta. Varre TODAS as ocorrências de método marcadas
// Definition e mapeia o símbolo ao `relative_path` do documento que o define.
// (scip-typescript também ganha o campo; lá o arquivo coincide com o parse-de-crases.)
const defDoc = new Map(); // symbol → relative_path da def
for (const d of idx.documents) {
  const rel = relPathOf(d);
  if (!rel) continue;
  for (const o of d.occurrences || []) {
    if (!isMethodSym(o.symbol)) continue;
    if (!(rolesOf(o) & DEFINITION)) continue;
    if (!defDoc.has(o.symbol)) defDoc.set(o.symbol, rel);
  }
}

// "A => B" → { from, to, fromFile, toFile } (dedup por chave, preserva o 1º visto).
const proven = new Map(); // chamada direta resolvida pelo checker
const ifaceImpl = new Map(); // via interface, K candidatos

// Diagnóstico multi-linguagem: distingue 0-arestas por MATCHING (0 defs/refs)
// vs por ATRIBUIÇÃO (refs achadas mas fora de qualquer corpo de método).
let nMethodDefs = 0, nMethodRefs = 0, nWithEnclosing = 0, nAttributed = 0, nOrphan = 0;

for (const d of idx.documents) {
  const docRel = relPathOf(d); // arquivo de DEFINIÇÃO do chamador (mesmo doc)
  // Corpos dos métodos (potenciais chamadores). enclosing_range quando há;
  // senão, aproxima o corpo por [def.start, próxima-def.start).
  const defs = [];
  for (const o of d.occurrences) {
    if (!isMethodSym(o.symbol)) continue;
    if (!(rolesOf(o) & DEFINITION)) continue;
    const [s] = rng(rangeOf(o));
    let bodyStart = s;
    let bodyEnd = Infinity;
    const er0 = enclOf(o);
    if (er0 && er0.length >= 4) {
      const er = rng(er0);
      bodyStart = er[0];
      bodyEnd = er[1];
      nWithEnclosing++;
    }
    nMethodDefs++;
    defs.push({ sym: o.symbol, start: s, bodyStart, bodyEnd });
  }
  defs.sort((a, b) => a.start - b.start);
  for (let i = 0; i < defs.length; i++)
    if (defs[i].bodyEnd === Infinity)
      defs[i].bodyEnd = i + 1 < defs.length ? defs[i + 1].start : Infinity;

  // Call-sites: referência (não-def, não-import) a símbolo de método.
  for (const o of d.occurrences) {
    if (!isMethodSym(o.symbol)) continue;
    const roles = rolesOf(o);
    if (roles & DEFINITION || roles & IMPORT) continue;
    nMethodRefs++;
    const [p] = rng(rangeOf(o));
    let caller = null;
    for (const def of defs) if (p >= def.bodyStart && p < def.bodyEnd) caller = def; // o mais interno vence
    if (!caller) { nOrphan++; continue; }
    nAttributed++;
    if (caller.sym === o.symbol) continue;
    const key = caller.sym + ' => ' + o.symbol;
    if (!proven.has(key))
      proven.set(key, { from: caller.sym, to: o.symbol, fromFile: docRel, toFile: defDoc.get(o.symbol) });
    if (implsOf.has(o.symbol))
      for (const impl of implsOf.get(o.symbol)) {
        const ik = caller.sym + ' => ' + impl;
        if (!ifaceImpl.has(ik))
          ifaceImpl.set(ik, { from: caller.sym, to: impl, fromFile: docRel, toFile: defDoc.get(impl) });
      }
  }
}

// Aresta com o arquivo-fonte por ponta (F1). `fromFile`/`toFile` omitidos quando
// desconhecidos (símbolo externo sem def indexada) — a agregação então os trata
// como órfãos (correto: sem arquivo, não há nó de sistema para pendurar).
const toEdge = (rec, resolution) => {
  const e = { from: rec.from, to: rec.to, kind: 'CALLS', resolution };
  if (rec.fromFile) e.fromFile = rec.fromFile;
  if (rec.toFile) e.toFile = rec.toFile;
  return e;
};
const edges = [
  ...[...proven.values()].map((e) => toEdge(e, 'compiler')),
  ...[...ifaceImpl.values()].map((e) => toEdge(e, 'interface-impl')),
];

// ACESSO A DADOS (função→tabela READ/WRITE), compiler-accurate do MESMO índice —
// prova o eixo que hoje é heurístico no lado Node/TS. Fail-soft: um erro aqui nunca
// derruba a derivação de CALLS. `to` = símbolo da const de tabela; a agregação no
// Manifest resolve pro nó de entidade. Ver scip-data-access.mjs.
let dataAccess = [];
let daStats = { tables: 0, verbSites: 0, resolved: 0, unresolvedTable: 0 };
try {
  const da = deriveDataAccess(idx);
  dataAccess = da.edges;
  daStats = da.stats;
} catch (e) {
  console.error(`[derive-edges] data-access falhou (fail-soft, segue só com CALLS): ${e && e.message}`);
}

// Compacto (sem indentação): 338k arestas indentadas passavam de 85MB → 413.
process.stdout.write(
  JSON.stringify({
    tool: 'scip-typescript',
    schema: 'adr-0030.p2.2',
    counts: { proven: proven.size, interfaceImpl: ifaceImpl.size, dataAccess: dataAccess.length },
    edges,
    dataAccess,
  }) + '\n',
);
console.error(
  `[derive-edges] STATIC_PROVEN=${proven.size} interface-impl=${ifaceImpl.size} (de ${idx.documents.length} documentos)` +
    ` | diag: methodDefs=${nMethodDefs} methodRefs=${nMethodRefs} withEnclosing=${nWithEnclosing} attributed=${nAttributed} orphan=${nOrphan}` +
    ` | data-access: tables=${daStats.tables} verbSites=${daStats.verbSites} resolved=${daStats.resolved} unresolvedTable=${daStats.unresolvedTable}`,
);

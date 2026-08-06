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
// O MURO honesto (ADR-0030 §5): o que fica aqui é chamada DIRETA resolvida pelo
// checker + interface→K-candidatos. DI concreta / dispatch dinâmico / reflexão
// NÃO aparecem aqui — ficam com o RUNTIME_OBSERVED (ADR-0029, hub OTel).
//
// Uso: node derive-edges.mjs <index.scip> [--scip-lib <path para scip.js>]
// ─────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const indexPath = args.find((a) => !a.startsWith('--'));
if (!indexPath) {
  console.error('uso: node derive-edges.mjs <index.scip> [--scip-lib <scip.js>]');
  process.exit(2);
}
// O binding protobuf do SCIP vem do próprio scip-typescript (dist/src/scip.js).
const libFlag = args.indexOf('--scip-lib');
const scipLib =
  libFlag >= 0
    ? args[libFlag + 1]
    : require.resolve('@sourcegraph/scip-typescript/dist/src/scip.js');
const scip = require(scipLib);

const idx = scip.scip.Index.deserialize(fs.readFileSync(indexPath));

// SCIP range: [startLine, startChar, endLine, endChar] ou [line, startChar, endChar].
const pos = (l, c) => l * 1_000_000 + c;
const rng = (r) =>
  r.length >= 4 ? [pos(r[0], r[1]), pos(r[2], r[3])] : [pos(r[0], r[1]), pos(r[0], r[2] ?? r[1])];

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
      if (r.is_implementation && r.symbol) {
        if (!implsOf.has(r.symbol)) implsOf.set(r.symbol, new Set());
        implsOf.get(r.symbol).add(s.symbol);
      }

const proven = new Set(); // "A => B" (chamada direta resolvida pelo checker)
const ifaceImpl = new Set(); // "A => impl" (via interface, K candidatos)

// Diagnóstico multi-linguagem: distingue 0-arestas por MATCHING (0 defs/refs)
// vs por ATRIBUIÇÃO (refs achadas mas fora de qualquer corpo de método).
let nMethodDefs = 0, nMethodRefs = 0, nWithEnclosing = 0, nAttributed = 0, nOrphan = 0;

for (const d of idx.documents) {
  // Corpos dos métodos (potenciais chamadores). enclosing_range quando há;
  // senão, aproxima o corpo por [def.start, próxima-def.start).
  const defs = [];
  for (const o of d.occurrences) {
    if (!isMethodSym(o.symbol)) continue;
    if (!((o.symbol_roles | 0) & DEFINITION)) continue;
    const [s] = rng(o.range);
    let bodyStart = s;
    let bodyEnd = Infinity;
    if (o.enclosing_range && o.enclosing_range.length >= 4) {
      const er = rng(o.enclosing_range);
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
    const roles = o.symbol_roles | 0;
    if (roles & DEFINITION || roles & IMPORT) continue;
    nMethodRefs++;
    const [p] = rng(o.range);
    let caller = null;
    for (const def of defs) if (p >= def.bodyStart && p < def.bodyEnd) caller = def; // o mais interno vence
    if (!caller) { nOrphan++; continue; }
    nAttributed++;
    if (caller.sym === o.symbol) continue;
    proven.add(caller.sym + ' => ' + o.symbol);
    if (implsOf.has(o.symbol))
      for (const impl of implsOf.get(o.symbol)) ifaceImpl.add(caller.sym + ' => ' + impl);
  }
}

const toEdge = (line, resolution) => {
  const [from, to] = line.split(' => ');
  return { from, to, kind: 'CALLS', resolution };
};
const edges = [
  ...[...proven].map((e) => toEdge(e, 'compiler')),
  ...[...ifaceImpl].map((e) => toEdge(e, 'interface-impl')),
];

process.stdout.write(
  JSON.stringify(
    { tool: 'scip-typescript', schema: 'adr-0030.p2.2', counts: { proven: proven.size, interfaceImpl: ifaceImpl.size }, edges },
    null,
    2,
  ) + '\n',
);
console.error(
  `[derive-edges] STATIC_PROVEN=${proven.size} interface-impl=${ifaceImpl.size} (de ${idx.documents.length} documentos)` +
    ` | diag: methodDefs=${nMethodDefs} methodRefs=${nMethodRefs} withEnclosing=${nWithEnclosing} attributed=${nAttributed} orphan=${nOrphan}`,
);

# scip-typescript — backbone compiler-accurate de TS (ADR-0030 / P2 da ADR-0028)

Ferramenta da **Engine A de TypeScript**: transforma um índice SCIP (produzido
pelo `scip-typescript`, que usa o *type checker* de verdade) em arestas de
call-graph **`STATIC_PROVEN`** para o mapa epistêmico (ADR-0028).

Hoje o extrator do Manifest, para TS, só roda os analisadores **heurísticos**
(`server/analyzers/node-backend/*`) → tudo `STATIC_UNRESOLVED`. Para Java existe
o motor compiler-accurate (`backend-java-client.ts`, JAR spawnado); este é o
começo do equivalente TS.

## Pipeline
```
# 1) no CI do repo-alvo (onde há tsconfig + node_modules):
npx @sourcegraph/scip-typescript index --no-global-caches --output index.scip

# 2) deriva as arestas compiler-accurate:
node tools/scip-typescript/derive-edges.mjs index.scip > edges.json
```

`edges.json` = `{ counts, edges:[{from, to, kind:'CALLS', resolution:'compiler'|'interface-impl'}] }`.
`resolution` casa direto com o `PRECISE_RESOLUTIONS` do `system-graph.ts:210` →
classifica como `STATIC_PROVEN`.

## Provado ao vivo (NuPIdentify, 2026-08-05)
`index.scip` 21.6 MB · 410 documentos · 217.991 occurrences · 3.616 defs de
método · 30.204 call-sites · 88 `is_implementation` → **7.308 arestas
`STATIC_PROVEN`** + **29 `interface-impl`** (ports→K adapters).

## Como funciona a derivação
- **`STATIC_PROVEN`**: uma *occurrence* de referência (não-Definition, não-Import)
  a um símbolo de **método** (`().`) que cai dentro do corpo de uma definição de
  método → aresta `chamador → chamado`. O símbolo do chamado foi resolvido pelo
  checker do `scip-typescript` → é provado.
- **`interface-impl` (K candidatos)**: se o chamado é método de uma **interface**
  (porta hex), invertemos o `is_implementation` e emitimos uma aresta para cada
  **implementação** (adapter). O runtime (ADR-0029) desambigua qual dos K rodou.

## O muro honesto (ADR-0030 §5)
O que fica aqui: chamada **direta** resolvida por tipo + interface→K. O que **NÃO**
aparece aqui (fica com o `RUNTIME_OBSERVED`, hub OTel/ADR-0029): injeção de
dependência concreta, dispatch dinâmico, `import()` dinâmico, reflexão,
higher-order/event-bus. **PROVEN (estático) + OBSERVED (runtime) convergem** —
nunca fingir PROVEN onde só há candidato.

## O que falta (P2.2 restante → P2.5, ver ADR-0030 §6)
Estas arestas são **símbolo→símbolo**. O **system-graph** do Manifest é no nível
de **serviço/endpoint/entidade**. Falta **agregar** o call-graph a essa
granularidade (qual serviço/rota/entidade cada função sustenta) e **ingerir** no
grafo do projeto com `resolution:'compiler'`, espelhando o `reconstructGraph` do
`backend-java-client`. Só então o `STATIC_PROVEN` do system-graph do identify
sai de 0. Este tool entrega a base provada (P2.1 índice + P2.2 derivação).

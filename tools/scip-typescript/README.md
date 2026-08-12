# scip-typescript — backbone compiler-accurate de TS (ADR-0030 / P2 da ADR-0028)

> **Verificado @ 9a20618 · 2026-08-12.** Se código e este doc divergirem, o código vence — atualize este doc no MESMO PR.
<!-- doc-verify: on -->

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
`resolution` casa direto com o `PRECISE_RESOLUTIONS` do `server/analyzers/system-graph.ts:PRECISE_RESOLUTIONS` →
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

## O motor de agregação (P2.2→P2.5, ADR-0031 — IMPLEMENTADO · A5: granularidade de FUNÇÃO)
Estas arestas são **símbolo→símbolo** (função→função). O **motor de agregação**
(ADR-0031, `server/analyzers/scip-aggregate.ts`) faz a ponte: junta símbolo→
nó-de-sistema e mescla as arestas provadas no `systemGraph` com
`resolution:'compiler'`/'interface-impl' — que o `classifyEdgeEvidence`
(`server/analyzers/system-graph.ts:PRECISE_RESOLUTIONS`) já classifica como `STATIC_PROVEN`, sem tocar a
classificação/rollup/censo.

**A5 — granularidade de FUNÇÃO.** A junção original casava símbolo→nó por
**arquivo**, colapsando a agregação a arquivo→arquivo: das 7.327 arestas do
NuPIdentify, 138 caíam como "intra-nó" (duas funções do MESMO arquivo,
indistinguíveis em `node:<file>`) e só 14 pares arquivo→arquivo sobravam. Agora
o nó-módulo `node:<file>` ganha **sub-nós de FUNÇÃO** `node:<file>::<fn>` (o
símbolo SCIP embute arquivo E função) e a agregação resolve **função→função**.
Os sub-nós são **paren-free** por construção (o sufixo de chamada `().` do SCIP
é removido) → o `classKeyOf` (`system-graph.ts`) os trata **atômicos** sem
qualquer mudança de código lá.

**Leitura-Máxima — a prova órfã não é mais descartada.** Até então, símbolo cujo
arquivo não sustentava nó de sistema (util/helper/lib/middleware) tinha a aresta
DESCARTADA — ~90% da prova do NuPIdentify (6.684 de 7.327 arestas) era jogada
fora. Agora todo arquivo do **PROJETO** que o compilador provou participar de uma
chamada vira um nó de **MÓDULO materializado** (`node:<file>`, tipo `MODULE`,
`materializedFrom:'scip'`) — é FATO (o arquivo existe, a chamada é provada), não
arquitetura inventada (§5). Régua de granularidade:

- **função→função** (`<nodeId>::<fn>`) só entre nós **arquiteturais** — bounded
  por construção, rico p/ mecanismo/dead-code;
- **arquivo→arquivo** no módulo materializado — SEMPRE, independente da ordem
  das arestas (nunca `::fn` sob `MODULE`; num monólito a granularidade de função
  em órfãos explodiria o call-graph em centenas de milhares de arestas).

O que AINDA fica de fora, e por quê: dependência **externa** (`.d.ts`,
`node_modules/`, `dist/` — ruído, não arquitetura do projeto; o eixo DB desse
recorte sobrevive via `dataAccess`, abaixo); **auto-chamada** (mesmo endpoint nas
duas pontas); e o excedente dos tetos (`moduleCap` 8k / `edgeBudget` 30k,
priorizando arestas que tocam nó arquitetural) — sempre CONTADO em
`stats.cappedModules`/`cappedEdges`, nunca silêncio.

**Por que materializar (e não uma camada lateral ou rollup transitivo):** os
consumidores da prova (`impact-confidence.ts`, `narrative-subgraph.ts`) andam
sobre as ARESTAS do `ShapedGraph` com `evidence.method` — nó `MODULE` +
aresta `STATIC_PROVEN` entram direto no raio de impacto e na espinha andável da
narrativa. Uma camada função→função consultável fora do grafo seria invisível
para esses walkers; um rollup transitivo módulo→módulo duplicaria a MESMA prova
em duas granularidades e inflaria o censo (`coverage`).

### Pipeline completo (CI do repo-alvo)
```
scip-typescript index --no-global-caches --output index.scip
node tools/scip-typescript/derive-edges.mjs index.scip > edges.json
curl -X POST "$MANIFEST_URL/api/projects/$PROJECT_ID/scip-edges" \
     -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
     --data-binary @edges.json
```
O `POST /api/projects/:id/scip-edges` guarda as arestas no store lateral
(`projects.scipEdges`, idempotente) e o `GET /graph` as agrega/mescla **na
leitura** (fail-soft: sem POST, byte-a-byte). A agregação é por **função** entre
nós arquiteturais e por **arquivo** nos módulos materializados (Leitura-Máxima,
§ acima); `interface-impl` vira K arestas; auto-chamada (mesmo endpoint) é
descartada. O muro de Rice permanece (§ acima): o dinâmico fica com o
`RUNTIME_OBSERVED`. `materializeOrphanModules:false` restaura o comportamento
antigo (órfão descartado), byte-a-byte.

**Provado ao vivo (NuPIdentify, projeto 38):** com a agregação por **arquivo**
o `STATIC_PROVEN` saiu de **0 → 14**; com a granularidade de **função** (A5)
sobe para **165** (`compiler`; as 138 chamadas função→função do mesmo arquivo —
antes descartadas como intra-nó — passam a contar, mais os pares cross-módulo
abertos por função). Com a **Leitura-Máxima**, o `provenRatio` do NuPIdentify
sobe de **45% → 65%** (easynup/Java: **25% → 76%**) — a medição revelou que ~73%
da "prova órfã" do identify era dependência externa (filtrada como ruído), não
código do projeto. A retenção é travada por teste de regressão fim-a-fim sobre o
fixture real (`tests/fixtures/scip/express-drizzle-index.json` →
`derive-edges.mjs` → agregação): das 9 arestas provadas, a regra antiga retinha
**0**; a atual captura a cadeia `routes.ts → handlers.ts` e deixa fora só as 6
chamadas para os `.d.ts` do drizzle (externas — cujo eixo DB sobrevive como as 3
arestas `dataAccess`).

## Acesso a dados compiler-accurate (`scip-data-access.mjs`) — função→tabela READ/WRITE

Além das arestas de chamada, o deriver extrai, do MESMO índice, quais funções
**leem** ou **escrevem** em quais tabelas — o eixo que hoje é heurístico
(`STATIC_UNRESOLVED`) no lado Node/TS. Sai na chave `dataAccess` do `edges.json`:

```
{ "dataAccess": [ { "from": "<fn-symbol>", "to": "<table-const-symbol>",
                    "access": "read"|"write", "resolution": "compiler",
                    "fromFile": "...", "toFile": "..." } ] }
```

**Como é provado** (verificado contra um `index.scip` REAL de Express+Drizzle —
fixture `tests/fixtures/scip/express-drizzle-index.json`):
- **verbo** = o símbolo do método-raiz resolvido pelo checker: `PgDatabase#select().`
  → READ; `#insert()/#update()/#delete().` → WRITE (idem MySql/Sqlite). O SCIP **não**
  seta os roles `ReadAccess`/`WriteAccess`, então o verbo — não o role — é o oráculo.
- **tabela** = o símbolo de PROJETO na MESMA linha do verbo cuja definição é seguida
  de `pgTable`/`mysqlTable`/`sqliteTable`/`pgView`.
- **função contêiner** = a definição cujo `enclosing_range` contém a linha do verbo.

**Muro de Rice (conservador):** tabela indecidível (parâmetro genérico, tabela de
runtime, `sql``` cru) → aresta OMITIDA (`unresolvedTable`), nunca inventada; direção
nunca chutada; efeito misto (`INSERT … RETURNING`) segue o verbo-raiz = WRITE.

**Estado:** IMPLEMENTADO ponta a ponta. O deriver emite `dataAccess` e o Manifest
agrega na leitura (`server/analyzers/data-access-aggregate.ts`, aplicado por
`graph-overlays.ts` após o merge dos CALLS): símbolo de tabela → nó de entidade,
emitindo `READS_ENTITY`/`WRITES_ENTITY` com `resolution:'compiler'` ⇒
`STATIC_PROVEN` (granularidade arquivo→tabela; reusa o `buildFileNodeIndex` do
scip-aggregate). Fail-soft: erro na extração/agregação de dados nunca derruba os
CALLS.

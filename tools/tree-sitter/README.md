# `tools/tree-sitter` — Produtor poliglota (tree-sitter) · 1ª fatia: imports de `.vue`

Fundação da **ADR-0021** (nup-sentinel) — *análise poliglota via tree-sitter* —
que até aqui tinha **zero código**. Esta é a **1ª fatia concreta**: um produtor
que fecha um ponto-cego real do substrato SCIP do Manifest.

## O problema que fecha

O deriver `tools/scip-typescript/derive-edges.mjs` emite, além do call-graph, o
eixo **import-reachability** (`imports[]`, modelo Knip/ts-prune): *um arquivo só é
"morto" se NEM chamado NEM importado NEM com tráfego*. Mas o `scip-typescript` **não
tem parser de SFC Vue** — os blocos `<script>` dos **521 `.vue`** do easynup são
invisíveis a ele (dito no próprio `scip-typescript-index.yml`). Resultado: `.ts`
importados **só** por `.vue` aparecem sem importador → **falso dead-code advisory**.

Este produtor extrai esses imports e os injeta na **mesma** coluna `projects.scipEdges`,
no balde/fonte **`vue`** do store multi-fonte (`POST /api/projects/:id/scip-edges/vue`).
O reasoner lê `imports[].to` (`server/reasoner/graph-load.ts`) e marca os alvos como
import-reachable — o falso-positivo some.

## Honestidade (guarda-corpo §8 da ADR-0021)

tree-sitter é **sintático**, não semântico. Por isso o produtor:

- emite **`edges: []`** — **nunca** uma aresta de call-graph com `resolution:'compiler'`
  (isso seria heurística carimbada como provada; o schema do Manifest a rejeitaria);
- emite **só `imports[]`** (arquivo→arquivo), que o schema aceita **sem** campo de
  resolução — é um sinal dedicado, não o grafo de chamadas;
- só emite um par quando o especificador **resolve para um arquivo que EXISTE** no
  projeto (`./`, `../`, alias do `tsconfig`); bare imports npm e não-resolvidos são
  **contados e descartados**, nunca chutados.

## Como funciona

1. `@vue/compiler-sfc` (já é dependência do Manifest) separa **ambos** `<script>` e
   `<script setup>` do SFC (split robusto; o `extractVueScript` do analyzer descarta
   um dos dois — não reusado aqui).
2. `web-tree-sitter` (WASM, o mesmo motor já usado no `services/gateway` do easynup,
   `^0.26.11`) parseia o script (gramática `typescript`/`javascript`) e extrai os
   especificadores de `import … from`, `export … from`, `import()` e `require()`.
3. O especificador é resolvido para um arquivo repo-relativo real (alias lido do
   `tsconfig.json`, não cravado).

**O motor é genérico** — a mesma engine estende a outras stacks `parseable:false`
(Python/Go/C#…) trocando a gramática `.wasm` e o passo de split por-linguagem. `.vue`
é o piloto por ser o ponto-cego medido.

### Arquivos

| Arquivo | Papel |
|---|---|
| `vue-imports-lib.mjs` | Funções PURAS (split SFC, resolução de alias/caminho, extração da árvore). Testadas em `tests/tools/tree-sitter-vue-imports.test.ts`. |
| `derive-imports.mjs` | CLI. stdout = JSON do payload; stderr = diagnóstico. Espelha `derive-edges.mjs`. |
| `grammars/*.wasm` + `SHA256SUMS` | Gramáticas tree-sitter fixadas (copiadas do gateway do easynup, ABI do `web-tree-sitter@0.26.11`). |

## Uso

```bash
node tools/tree-sitter/derive-imports.mjs <scanDir> \
  --root <repoRoot> \
  --grammars <wasmDir> \
  [--web-tree-sitter <abs path do pacote web-tree-sitter>] \
  [--tsconfig <scanDir/tsconfig.json>] [--source vue]
```

Caminhos emitidos são relativos a `--root`. Rodar do **repo root** com
`<scanDir>=frontend --root .` produz `frontend/src/...`, casando o `sourceFile`
repo-relativo que o Manifest guarda (idêntico ao `scip-typescript-index.yml`).

### Saída (payload aceito por `POST /scip-edges/vue`)

```jsonc
{
  "tool": "tree-sitter-vue",
  "schema": "adr-0021.vue-imports.v1",
  "counts": { "vueFiles": 521, "scriptBlocks": 527, "specifiers": 4389,
              "imports": 3121, "resolvedProject": 3121, "unresolvedProject": 0,
              "barePackages": 1268, "parseErrors": 0 },
  "edges": [],                                  // SINTÁTICO: sempre vazio
  "imports": [{ "from": "frontend/src/App.vue", "to": "frontend/src/stores/auth.ts" }],
  "entryFiles": []
}
```

## Validação local (medida 2026-11-17, sobre os 521 `.vue` reais do easynup)

| Métrica | Valor |
|---|---|
| `.vue` processados / blocos de script | 521 / 527 |
| Especificadores vistos | 4389 |
| Imports resolvidos p/ arquivo do projeto | **3121** (unresolved project = **0**) |
| Bare npm (corretamente ignorados) | 1268 |
| Erros de parse | **0** |
| Alvos `.ts/.tsx` distintos alcançados | **448** |
| Diff vs compilador TypeScript (`ts.createSourceFile`) nos mesmos blocos | **0 perdidos, 0 extras** |
| `.ts` importados **só** por `.vue` (piso do ponto-cego fechado — proxy sintático) | **114** |

> O número exato de `.ts` que o `scip-typescript` marca como dead-code hoje e que
> este produtor rescue (≈185 citado no briefing) é **NÃO-VERIFICADO**: exige rodar
> o pipeline `scip-typescript` + `derive-edges` do front (deps privadas `@nuptechs`)
> e diferenciar os arquivos sem inbound antes/depois. O **114** é um piso sintático.

## Ativação no CI do easynup (DEFAULT OFF — nada é invocado hoje)

**Esta fatia NÃO cabea nada no easynup** — é aditiva e isolada. O produtor roda
apenas quando o dono colar o workflow abaixo (espelha `scip-typescript-index.yml`:
pós-merge, auxiliar, `continue-on-error`, pula sem o secret, pula em 404). Fixe o
`<COMMIT>` no SHA deste diretório **após o merge** deste PR (como os outros
workflows já fazem com `derive-edges.mjs`).

```yaml
# .github/workflows/scip-vue-imports-index.yml  (easynup) — COLAR APÓS O MERGE
name: SCIP Vue Imports (Manifest)
on:
  workflow_dispatch: {}            # começa manual (OFF por default); adicione push/paths quando validado
concurrency: { group: scip-vue-imports-index, cancel-in-progress: true }
permissions: { contents: read, packages: read }
env:
  MANIFEST_URL: "https://manifest.nuptechs.com"
  MANIFEST_PROJECT_ID: "27"
  MANIFEST_SOURCE: "vue"
  TOOL_BASE: "https://raw.githubusercontent.com/nuptechs/nup-sentinel-manifest/<COMMIT>/tools/tree-sitter"
jobs:
  index:
    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - name: Fetch producer (commit imutável) + verificar wasm (SHA-256)
        id: fetch
        continue-on-error: true
        run: |
          mkdir -p tstool/grammars
          for f in derive-imports.mjs vue-imports-lib.mjs grammars/SHA256SUMS \
                   grammars/tree-sitter-typescript.wasm grammars/tree-sitter-javascript.wasm; do
            curl -fsSL "$TOOL_BASE/$f" -o "tstool/$f"
          done
          ( cd tstool/grammars && sha256sum --check --strict SHA256SUMS )
      - name: Install motor isolado (web-tree-sitter + @vue/compiler-sfc)
        id: deps
        if: steps.fetch.outcome == 'success'
        continue-on-error: true
        run: |
          mkdir -p "$RUNNER_TEMP/vtool" && cd "$RUNNER_TEMP/vtool"
          npm init -y >/dev/null 2>&1
          npm install --ignore-scripts web-tree-sitter@0.26.11 @vue/compiler-sfc@3.5.27
      - name: Derivar imports .vue
        id: derive
        if: steps.deps.outcome == 'success'
        continue-on-error: true
        run: |
          WTS="$RUNNER_TEMP/vtool/node_modules/web-tree-sitter/web-tree-sitter.js"
          node tstool/derive-imports.mjs frontend --root . \
            --grammars tstool/grammars --web-tree-sitter "$WTS" \
            --tsconfig frontend/tsconfig.json > vue-edges.json
          node -e "const e=require('./vue-edges.json'); if(!Array.isArray(e.imports))process.exit(1); console.log('counts:', JSON.stringify(e.counts))"
      - name: POST /scip-edges/vue (pula sem secret; 404 = merge o PR do manifest antes)
        if: steps.derive.outcome == 'success'
        continue-on-error: true
        env: { MANIFEST_API_KEY: "${{ secrets.SENTINEL_MANIFEST_API_KEY }}" }
        run: |
          [ -z "$MANIFEST_API_KEY" ] && { echo "::warning::secret ausente — POST pulado"; exit 0; }
          HTTP=$(curl -sS -o /tmp/o -w '%{http_code}' \
            -X POST "$MANIFEST_URL/api/projects/$MANIFEST_PROJECT_ID/scip-edges/$MANIFEST_SOURCE" \
            -H "x-api-key: $MANIFEST_API_KEY" -H 'content-type: application/json' \
            --data-binary @vue-edges.json)
          echo "POST → HTTP $HTTP"; head -c 400 /tmp/o || true
```

## Limitações conhecidas (honestas)

- **Auto-imports**: o front usa `unplugin-vue-components` (resolver naive-ui) — isso
  auto-registra **componentes no template**, que não têm `import` no `<script>`. Essa
  fração do ponto-cego **continua aberta** (seria um sinal de *template*, não de
  script). Não há `unplugin-auto-import` (composables/APIs) no `vite.config.ts`, então
  imports de `.ts` no script são explícitos e **capturados**.
- **`<script lang="tsx">`**: usa a gramática `typescript` (não a `tsx`); imports no
  topo saem igual, JSX interno pode subparsear. Raro em Vue.
- **Sintático**: imports provam *referência de módulo*, não chamada. É de propósito —
  o eixo semântico é do `scip-typescript`/`scip-java`.

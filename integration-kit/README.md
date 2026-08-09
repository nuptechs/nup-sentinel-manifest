# Integration Kit — pôr um sistema novo no mapa epistêmico

Guia para integrar **um repositório cliente** ao Manifest sem editar código do
Sentinel. Meta: repo novo mapeado em **menos de um dia**.

O mapa tem três eixos de evidência, e cada um vem de um lugar diferente. Nada
aqui é mágico: se um eixo não for alimentado, ele fica **zerado** — e o passo 5
mostra isso explicitamente em vez de fingir cobertura.

| Eixo | De onde vem | Confiança | Passo |
|---|---|---|---|
| `STATIC_PROVEN` | índice SCIP do build real (scip-java / scip-typescript) | 0.80 | [2](#2-índice-estático-static_proven) |
| `CONFIG_PROVEN` | wiring do container lido do fonte (Spring) | 0.78 | [3](#3-wiring-config_proven--só-javaspring) |
| `RUNTIME_OBSERVED` | traços OTel da app **rodando** | 0.95 | [4](#4-runtime-runtime_observed) |

Sobram duas classes que **não** são evidência: `STATIC_UNRESOLVED` (0.40 — o
analisador heurístico achou algo, mas não provou) e `UNKNOWN` (0.20). Ver uma
delas alta é informação, não defeito: é o mapa dizendo onde ele não sabe.

---

## 0. Pré-requisitos

- **Acesso ao Manifest**: URL (ex. `https://manifest.nuptechs.com`) e uma **API
  key** (`pk_...`). Toda rota `/api/*` exige `x-api-key: <chave>` ou
  `Authorization: Bearer <chave|JWT>`.
- **Repo com CI** (GitHub Actions nos templates) e build que **compila**:
  `scip-java` é plugin do `javac` — sem build verde não há índice.
- Opcional (eixo runtime): um **Jaeger/collector OTLP** alcançável pelo Manifest.

Guarde para o resto do guia:

```sh
export MANIFEST_URL=https://manifest.nuptechs.com
export KEY=pk_xxxxxxxx
```

---

## 1. Registrar o projeto

O projeto precisa existir **e ter uma análise** antes de qualquer POST de
arestas: as arestas são um *overlay* mesclado na leitura sobre o `systemGraph`
persistido pela análise. POSTar arestas num projeto sem análise devolve 201 e
`systemEdgesProven: 0` — não é erro, é "não há grafo em que mesclar ainda".

Dois caminhos reais:

### 1a. ZIP (mais direto para o primeiro mapa)

```sh
curl -X POST "$MANIFEST_URL/api/projects/upload-zip" \
  -H "x-api-key: $KEY" \
  -F "zipFile=@/caminho/repo.zip" \
  -F "name=acme-platform"
```

Exclua `node_modules`, `target`, `dist` e binários do ZIP — o limite é 2 GB, mas
lixo de build só dilui o grafo.

### 1b. Git conectado (o modo contínuo)

```sh
# cria o projeto (exige ao menos 1 arquivo no corpo — pode ser um README)
curl -X POST "$MANIFEST_URL/api/projects" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"acme-platform","files":[{"path":"README.md","content":"bootstrap"}]}'
# → { "id": 42, ... }  ← guarde este id

curl -X POST "$MANIFEST_URL/api/projects/42/git/connect" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"provider":"github","repoUrl":"https://github.com/acme/platform","token":"ghp_...","defaultBranch":"main"}'

curl -X POST "$MANIFEST_URL/api/projects/42/analyze-branch" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' -d '{"branch":"main"}'
```

O `id` retornado é o `MANIFEST_PROJECT_ID` de todos os passos seguintes.

> **Token de Git com validade curta:** um `ghs_`/token de app expira em ~1 h. Se
> ele for guardado como secret estático, a re-análise passa a falhar
> silenciosamente semanas depois. Use um token de vida longa ou reconecte.

---

## 2. Índice estático (`STATIC_PROVEN`)

Copie o template da sua stack para `.github/workflows/` **do repo cliente**:

| Stack | Template |
|---|---|
| Java (Maven/Gradle) | [`templates/scip-java-index.yml`](templates/scip-java-index.yml) |
| TypeScript/Node | [`templates/scip-typescript-index.yml`](templates/scip-typescript-index.yml) |

Configure em *Settings → Secrets and variables → Actions*:

| Tipo | Nome | Valor |
|---|---|---|
| Variable | `MANIFEST_PROJECT_ID` | o `id` do passo 1 |
| Variable | `MANIFEST_URL` | opcional; default `https://manifest.nuptechs.com` |
| Variable | `CONFIG_ROOT_PACKAGE` | só Java; ex. `com.acme` (passo 3) |
| Secret | `SENTINEL_MANIFEST_API_KEY` | a API key `pk_...` |

Rode `workflow_dispatch` uma vez. O log deve terminar com
`POST /scip-edges → HTTP 201`.

Os passos são **todos auxiliares** (`continue-on-error`): este workflow nunca
reprova o CI do produto. Mas nunca falha calado — cada saída de exceção emite um
`::warning::` nomeado.

---

## 3. Wiring (`CONFIG_PROVEN`) — só Java/Spring

Por que existe: o muro de Rice diz que dispatch dinâmico é indecidível **em
geral**. Mas `@Autowired MinhaPort` com **uma única** implementação registrada é
decidível lendo o fonte. Essa resolução é uma aresta *provada por configuração*
— nem heurística, nem K-candidatos.

```sh
mkdir -p scripts/config-proven
cp integration-kit/templates/derive-config-edges.mjs scripts/config-proven/
node scripts/config-proven/derive-config-edges.mjs --root com.acme   # smoke local
```

O workflow do passo 2 já chama o resolvedor e POSTa em `/config-edges` (store
**separado** — não sobrescreve as arestas do SCIP).

O que ele **não** emite, de propósito:

- interface com >1 bean e sem `@Primary` → **ambíguo**, contado e pulado (é o
  caso dos *registries* com dispatch por enum);
- interface Spring-Data (proxy gerado em runtime) → a impl não existe no fonte;
- `@Bean` de fábrica cujo corpo não revela o concreto → **opaco**.

Ver o `counts` no stderr: `proven`, `singleBean`, `primary`, `ambiguousSkipped`.
Números pequenos são normais e honestos — 22 arestas num monolito de 4 mil
arquivos foi o resultado real do primeiro sistema integrado, e são exatamente as
portas hexagonais dele.

**Não há equivalente para Node.** DI de TypeScript (InversifyJS, tsyringe,
container à mão) precisaria de um resolvedor próprio, que não existe.

---

## 4. Runtime (`RUNTIME_OBSERVED`)

Sem este eixo, tudo que é dinâmico fica invisível. Siga o guia da stack:

- [`templates/otel-java.md`](templates/otel-java.md) — OTel Java agent (zero-code)
- [`templates/otel-node.md`](templates/otel-node.md) — OTel SDK Node

Além de instrumentar a app, **duas** coisas do lado do Manifest:

1. `JAEGER_QUERY_URL` apontando para a query API do Jaeger (env do processo).
2. `conventionProfile.runtimeOverlay` **no projeto**, dizendo quais
   `OTEL_SERVICE_NAME` consultar. Este é o passo esquecido com mais frequência
   (ver erro nº 3 abaixo).

---

## 5. Verificar

### Saúde da evidência (é aqui que se começa)

```sh
curl -s -H "x-api-key: $KEY" "$MANIFEST_URL/api/projects/42/evidence-health" | jq .
```

Diz, por eixo, **quando** foi a última vez que chegou evidência e se está
`stale`. `overall: "starving"` = o pipeline morreu de fome; `degraded` = um eixo
parou. É o alarme que faltava — sem ele, um serviço fora do ar simplesmente zera
o eixo runtime e ninguém percebe.

A resposta traz também `culprits[]` — quem causou a degradação, já resolvido
pelo servidor (vazio quando `healthy`).

### O mapa cobre o binário que está no ar? (eixo `drift`)

Os quatro eixos acima dizem se a evidência **chega**. O `drift` diz outra coisa:
se o que foi analisado é o que está **rodando**. Um mapa impecável e fresco pode
descrever um commit que o ambiente já deixou para trás.

Exige as duas pontas — sem elas o eixo responde `unknown` com motivo, **nunca**
acusa drift (alarme falso gasta o crédito do alarme verdadeiro):

1. **quem analisa informa o commit** — `POST /api/analyze` com
   `options.gitSha` = SHA **completo** (40 hex). SHA curto é ignorado de
   propósito: dois prefixos iguais de commits diferentes produziriam falso
   drift.
2. **o ambiente informa a versão** — um endpoint que devolva
   `{ "commit": "<40-hex>" }` (ou `null`), registrado no projeto:

```jsonc
// PUT /api/projects/42/convention-profile
{ "version": 1, "rules": [],
  "appInfo": { "healthUrl": "https://app.exemplo/healthz" } }
```

```sh
curl -s -H "x-api-key: $KEY" "$MANIFEST_URL/api/projects/42/evidence-health" | jq .drift
```

| `status` | significa |
|---|---|
| `in-sync` | o mapa descreve o commit que está no ar |
| `drift` | os dois lados foram medidos e **discordam** → re-analise (degrada o `overall`) |
| `unknown` | não deu para comparar — `reason` diz por quê (`health-url-not-configured`, `health-unreachable`, `health-no-commit`, `no-analyzed-sha`). **Nunca** degrada o veredito |

O `gitSha` também entra em cada ponto de `/evidence-history`: a série deixa de
ser "melhorou" e passa a ser "melhorou entre tais commits".

### Censo do grafo

```sh
curl -s -H "x-api-key: $KEY" "$MANIFEST_URL/api/projects/42/graph" | jq .coverage
```

```jsonc
{
  "edges": {
    "byMethod": {
      "RUNTIME_OBSERVED": 0,      // traços OTel
      "STATIC_PROVEN": 3085,      // SCIP (compiler-accurate)
      "CONFIG_PROVEN": 22,        // wiring do Spring
      "STATIC_UNRESOLVED": 1240,  // heurística — NÃO é prova
      "LLM_CONJECTURED": 0,
      "UNKNOWN": 310
    },
    "total": 4657,
    "observedRatio": 0            // RUNTIME_OBSERVED / total
  },
  "nodes": { "observed": 0, "total": 812 }
}
```

Ler isto certo importa: `observedRatio` **não tende a 1.0** nem num sistema
perfeitamente instrumentado — OTel só observa fronteiras (serviço→serviço,
serviço→banco), não o call-graph interno. O número é o teto correto da técnica.

---

## Erros comuns

**1. `STATIC_PROVEN` = 0 num repo Java, sem erro no log.**
O deriver rodou no modo binário. O binding protobuf do `scip-typescript`
decodifica os *ranges* de um índice **scip-java** como vazios (packed int32
incompatível) → zero aresta, silenciosamente. Para Java, `scip print --json` +
`--json` no deriver é **obrigatório** (o template já faz).

**2. `Cannot find module '@sourcegraph/scip-typescript'` no repo TS.**
O deriver foi baixado para `/tmp` e a resolução de módulos parte de lá, onde não
há `node_modules`. Passe `--scip-lib "$(node -p "require.resolve('@sourcegraph/scip-typescript/dist/src/scip.js')")"`
(o template já faz).

**3. `RUNTIME_OBSERVED` = 0 com o Jaeger cheio de traços.**
Quase sempre é a *allowlist de serviço*. Uma instância do Manifest analisa vários
projetos; se a allowlist vier de um env **global** do processo, ela nunca casa o
serviço do segundo projeto e nenhum span é minerado. Configure
`conventionProfile.runtimeOverlay.services` **por projeto**.
A segunda causa é o serviço de entrada faltando na lista: um traço rooteia em
quem **recebe** a requisição; se o tráfego bate direto no backend (cron, robô,
chamada interna) e só o gateway está na allowlist, justamente os traços que
carregam os spans de banco são descartados.

**4. Há traços, mas `anchorableTraces: false`.**
Existe telemetria e nenhum traço ancora numa rota. Um traço só vira aresta quando
tem um span de entrada com `http.route`/`url.path` **e** algum span de banco. Job
de background, health-check e span solto não ancoram. Sintoma típico: o serviço
de fronteira caiu e só sobrou tráfego de fundo. Gere tráfego rota→banco (robô
sintético serve) e reconsulte.

**5. Porta hexagonal sem nó no grafo.**
Uma aresta `CONFIG_PROVEN` interface→impl não aparecia quando a *interface* não
tinha nó de sistema (o analisador só materializava classes concretas). Corrigido
no Manifest — se ainda vir arestas config perdidas, re-rode a análise para
regenerar o snapshot.

**6. Token de CI expirado.**
`ghs_` dura ~1 h. Como secret estático, quebra semanas depois com 401 e o
workflow (que é `continue-on-error`) só emite warning. Cheque
`/evidence-health` periodicamente — é exatamente o buraco que ele fecha.

**7. Amostragem esconde a rota rara.**
Com `traceidratio 0.1` uma rota pouco usada pode nunca cair na janela e ficar
`STATIC_UNRESOLVED` para sempre, sem nenhum alarme. Retenha 100% do tráfego do
robô sintético (tail-sampling por atributo) se a cobertura importa.

---

**6. BIMR "100% cego" num sistema que TEM as entidades modeladas (dogfood NuPIdentify, 2026-08-08).**
Se o analyzer da stack modela entidades com id `table:<nome>` (o caso Drizzle/TS),
qualquer classificação por PREFIXO de id colide com o namespace dos nós mintados
pelo overlay e declara o modelo inteiro como ponto cego — falso. Corrigido no
servidor (classificação SÓ por `metadata.synthetic && runtimeOnly`); se você vir
um `mintedRatio` de 100% num sistema com entidades no grafo, atualize o Manifest.

**7. `oracleComparablePairs = 0` num sistema Node/Express com rotas casando.**
Duas causas conhecidas no 2º sistema: (a) as rotas ESTÁTICAS extraídas do Express
guardam o subpath do router (`/branding`) e não o caminho completo montado
(`/api/tenant/branding`) → o observado não casa e a rota é mintada (origem não
compartilhada com o estático ⇒ calibração abstém — honesto, mas subaproveitado);
(b) a convenção `<op>.v<N>` do matching serviço-profundo é do easynup — um alvo
com outra convenção de endpoint interno precisa do `opPathPattern` próprio em
`conventionProfile.runtimeOverlay`. Limitação declarada; o mapa e o BIMR
funcionam mesmo assim (a calibração é quem espera).

## Checklist final

- [ ] Projeto criado, `id` anotado, **uma análise concluída**
- [ ] Workflow de índice copiado; variables + secret configurados
- [ ] `workflow_dispatch` verde com `POST /scip-edges → HTTP 201`
- [ ] (Java) `derive-config-edges.mjs` copiado e `CONFIG_ROOT_PACKAGE` setado
- [ ] App instrumentada com OTel e exportando para o collector
- [ ] `JAEGER_QUERY_URL` no Manifest + `runtimeOverlay.services` no projeto
- [ ] `/evidence-health` → `overall: "healthy"`
- [ ] `/graph` → `coverage.byMethod` com os três eixos acima de zero
- [ ] (opcional) `options.gitSha` no `POST /api/analyze` + `appInfo.healthUrl`
      no projeto → `/evidence-health` → `drift.status: "in-sync"`

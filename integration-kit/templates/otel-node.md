# OTel → hub: eixo `RUNTIME_OBSERVED` de um serviço **Node/TypeScript**

O call-graph estático de Node morre no primeiro dispatch dinâmico (o handler
computa a operação). A verdade de "que tabela essa rota tocou" está nos traços.
Este é o caminho: **OTel SDK** com auto-instrumentação de HTTP + driver de banco.

## 1. Dependências

```sh
npm i @opentelemetry/sdk-node \
      @opentelemetry/auto-instrumentations-node \
      @opentelemetry/exporter-trace-otlp-proto
```

## 2. Bootstrap — **antes** de qualquer import do app

A auto-instrumentação faz monkey-patch dos módulos no `require`/`import`. Se o
Express (ou o `pg`) for carregado antes do SDK, ele **não é instrumentado** e
você fica com 0 span — sem nenhum erro. Por isso um arquivo separado carregado
com `--require` / `--import`.

```js
// otel-bootstrap.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');

// GATED: sem endpoint, no-op absoluto (byte-a-byte com hoje).
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // Traces-only — o backend não tem pipeline de métricas/logs (ver §4).
  process.env.OTEL_METRICS_EXPORTER ||= 'none';
  process.env.OTEL_LOGS_EXPORTER ||= 'none';

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(), // lê OTEL_EXPORTER_OTLP_ENDPOINT
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }, // ruído puro
    })],
  });
  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().catch(() => {}));
}
```

```jsonc
// package.json
{ "scripts": { "start": "node --require ./otel-bootstrap.js dist/index.js" } }
```

## 3. Variáveis de ambiente

| Env | Valor | Papel |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ex. `http://otel-jaeger.railway.internal:4318` | **liga** o SDK |
| `OTEL_SERVICE_NAME` | ex. `acme-gateway` | nome nos spans — **chave que o manifest usa** (§5) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | protocolo |
| `OTEL_EXPORTER_OTLP_HEADERS` | `authorization=Bearer <token>` | auth, se exigido |
| `OTEL_TRACES_SAMPLER` / `..._ARG` | `parentbased_traceidratio` / `0.1` | amostragem |

## 4. O que o overlay do manifest realmente lê

Não é SQL parseado a esmo. A extração de tabela é uma cascata sobre atributos
semconv do span de banco:

1. `db.collection.name` (semconv estável, novo)
2. `db.sql.table` (antigo)
3. parse do texto do SQL — `db.query.text` (novo) / `db.statement` (antigo)

O driver `pg` do Node **nem sempre** emite o nome da tabela como atributo; muitas
vezes só o texto do SQL. Por isso o parser existe. Consequência prática: se você
sanitizar o SQL a ponto de remover o nome da tabela, **perde o eixo runtime**.
Sanitizar literais (`WHERE id = ?`) está certo; apagar o `FROM <tabela>` não.

Para ancorar a rota, o span de entrada precisa de `http.route` **ou** `url.path`
(a auto-instrumentação de Express emite). Sem isso o traço não vira aresta.

## 5. Contar ao manifest quais serviços consultar

Config **por projeto** em `conventionProfile.runtimeOverlay` (um env global só
acende o primeiro projeto de uma instância multi-projeto):

```jsonc
{
  "runtimeOverlay": {
    "services": ["acme-gateway", "acme-backend"],
    "gatewayService": "acme-gateway",
    "lookbackMs": 86400000,
    "limit": 400
  }
}
```

`services[0]` / `gatewayService` = quem **recebe** a requisição. Um traço rooteia
no serviço de entrada; se a chamada bate direto no backend (cron, robô, chamada
interna), ele também precisa estar na lista — senão justamente os traços que
carregam os spans de banco são descartados.

## 6. Verificar

```sh
curl -s "$JAEGER_QUERY_URL/api/traces?service=acme-gateway&limit=5&lookback=1h" | jq '.data | length'
curl -s -H "x-api-key: $KEY" "$MANIFEST_URL/api/projects/$ID/evidence-health" | jq .runtime
```

## 7. Limite honesto

OTel observa **fronteiras instrumentadas** (serviço→serviço, serviço→banco), não
o call-graph interno função-a-função. O `observedRatio` mede "fração de arestas
de fronteira observadas" e **por construção não tende a 1.0**. Isso é o teto
correto da técnica, não uma falha de configuração.

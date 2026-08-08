# OTel → hub: eixo `RUNTIME_OBSERVED` de um serviço **Java**

O que os dois workflows de índice **não** conseguem provar (DI concreta, dispatch
dinâmico, reflexão, event-bus) só aparece no mapa se a app **rodando** emitir
traços. Este é o caminho zero-code: o **OTel Java agent** instrumenta HTTP + JDBC
sem tocar o código do produto.

## 1. Bakear o agent na imagem

```dockerfile
# Dockerfile do serviço
ARG OTEL_AGENT_VERSION=2.12.0
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v${OTEL_AGENT_VERSION}/opentelemetry-javaagent.jar /opt/otel/opentelemetry-javaagent.jar

# Traces-only por padrão — ver §4 (evita 404 a cada export).
ENV OTEL_METRICS_EXPORTER=none
ENV OTEL_LOGS_EXPORTER=none
```

## 2. Anexar o agent **de forma gated**

O agent só entra quando o endpoint existe. Sem a env, o comando é byte-a-byte
igual ao de hoje — telemetria nunca vira pré-requisito de boot.

```sh
# ENTRYPOINT — `${VAR:+...}` expande só quando a variável está setada
exec java ${OTEL_EXPORTER_OTLP_ENDPOINT:+-javaagent:/opt/otel/opentelemetry-javaagent.jar} \
     -jar /app/app.jar
```

## 3. Variáveis de ambiente

| Env | Valor | Papel |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | base OTLP do collector/Jaeger, ex. `http://otel-jaeger.railway.internal:4318` | **liga** o agent |
| `OTEL_SERVICE_NAME` | ex. `acme-backend` | nome do serviço nos spans — **é a chave que o manifest usa** (§5) |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (ou `grpc`) | protocolo |
| `OTEL_EXPORTER_OTLP_HEADERS` | `authorization=Bearer <token>` | auth, se o collector exigir |
| `OTEL_TRACES_SAMPLER` / `..._ARG` | `parentbased_traceidratio` / `0.1` | amostragem (ver §6) |

> Se a app usa Spring Boot Actuator/Micrometer tracing, **não ligue os dois**:
> escolha o agent OU o Micrometer. Dois exportadores duplicam spans.

## 4. Traces-only não é preguiça

Um Jaeger (ou um collector com pipeline só de traces) **não tem** `/v1/metrics`
nem `/v1/logs`. O caminho zero-code liga os três sinais por padrão → métricas e
logs batem em endpoint inexistente e voltam **HTTP 404 a cada intervalo de
export**: ruído no log e I/O à toa, para sempre. Daí `OTEL_METRICS_EXPORTER=none`
e `OTEL_LOGS_EXPORTER=none`. Métricas continuam por Prometheus/Actuator (pull),
logs por stdout.

## 5. Contar ao manifest **quais serviços** consultar

Este é o passo esquecido com mais frequência. Uma instância do manifest analisa
vários projetos; um env **global** de allowlist só acende o primeiro. A config
correta é **por projeto**, no `conventionProfile.runtimeOverlay`:

```jsonc
{
  "runtimeOverlay": {
    "services": ["acme-gateway", "acme-backend"],  // OTEL_SERVICE_NAME de cada um
    "gatewayService": "acme-gateway",              // quem RECEBE a requisição
    "opPathPattern": "/internal/[A-Za-z]+\\.v\\d+", // opcional: endpoint interno
    "lookbackMs": 86400000,
    "limit": 400
  }
}
```

Cascata de resolução: `conventionProfile.runtimeOverlay` (por projeto) **>** env
do processo (`RUNTIME_OVERLAY_*` / `JAEGER_QUERY_URL`) **>** default. Sem URL de
Jaeger em nenhuma camada, o overlay fica **desligado** (grafo byte-a-byte).

No lado do manifest, o Jaeger é apontado por `JAEGER_QUERY_URL` (+ opcional
`JAEGER_QUERY_API_KEY`).

## 6. Amostragem — o teto silencioso

Com `traceidratio 0.1` você observa ~10% do tráfego. Uma rota rara pode
simplesmente **nunca** aparecer na janela e ficar `STATIC_UNRESOLVED` para
sempre — sem que nada acuse erro. Se há um robô de tráfego sintético exercitando
o parque, garanta que os traços dele sejam **retidos integralmente** (regra de
tail-sampling do collector por atributo do robô); é ele que fecha a cobertura.

## 7. Persistência do Jaeger

Jaeger all-in-one guarda spans **em memória** por padrão: todo redeploy zera o
eixo RUNTIME. Use storage persistente (ex. Badger em volume):

```
SPAN_STORAGE_TYPE=badger
BADGER_EPHEMERAL=false
BADGER_DIRECTORY_KEY=/badger/key
BADGER_DIRECTORY_VALUE=/badger/data
BADGER_SPAN_STORE_TTL=168h
```

Armadilha conhecida: a imagem roda como uid 10001 e o volume monta como root →
`mkdir /badger/key: permission denied` em crash-loop. Em Railway, resolve com
`RAILWAY_RUN_UID=0`.

## 8. Verificar

```sh
# há traços do serviço na última hora?
curl -s "$JAEGER_QUERY_URL/api/traces?service=acme-backend&limit=5&lookback=1h" \
  | jq '.data | length'
```

Depois, no manifest:

```sh
curl -s -H "x-api-key: $KEY" "$MANIFEST_URL/api/projects/$ID/evidence-health" | jq .runtime
```

`anchorableTraces: false` com `edgeCount`/traços > 0 significa que existem traços
mas **nenhum ancora numa rota** (só job de background / span solto). Ver o §"erros
comuns" do README.

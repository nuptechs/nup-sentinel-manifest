# ADR-0035 — Confiança Calibrada por-Aresta: módulos + desenho de integração

> **Status:** módulos PUROS entregues e testados; **integração no `/graph` NÃO
> aplicada** — deixada aqui como patch mínimo marcado para reconciliação após a
> WS1 (o eixo runtime / `runtime-overlay.ts` está em conserto em paralelo).

## O que este PR entrega

Três módulos puros (zero dependência de express/storage), com testes de números:

| Arquivo | Papel |
|---|---|
| `server/analyzers/calibration.ts` | Confiabilidade por-método via **Clopper–Pearson exato** (= limite split-conformal finito para uma taxa de Bernoulli). Mede a taxa empírica com que as arestas de cada método se **confirmam no runtime** (o oráculo). |
| `server/analyzers/completeness-estimator.ts` | Completude do conjunto de arestas via **capture-recapture (Chao2 incidence / Chao1)** — estima quantas arestas verdadeiras existem mas nenhum método viu. |
| `server/analyzers/calibration-overlay.ts` | Orquestrador puro: arestas modeladas → `{ calibration, completeness, effectiveConfidenceByMethod }`. **Não importa `system-graph.ts`** (recebe os pesos fixos por parâmetro) para não acoplar ao bloco em edição na WS1. |

Testes: `tests/analyzers/calibration.test.ts`, `completeness-estimator.test.ts`,
`calibration-overlay.test.ts`.

## O oráculo e o gate de honestidade

- **RUNTIME_OBSERVED** (traços OTel/Jaeger) = ground-truth: o que executou de fato.
- Cada aresta estática (`STATIC_PROVEN`/`CONFIG_PROVEN`/`STATIC_UNRESOLVED`/`UNKNOWN`)
  vira uma amostra; `confirmed = (o mesmo par from→to está no conjunto observado)`.
- A calibração **só produz número** quando há oráculo (`runtimeOracleSize > 0`) **e**
  `n ≥ minSamples` (default 30). Senão → `calibrated:false` e o consumidor mantém o
  **peso fixo** (byte-a-byte). "0% confirmado com oráculo vazio" ≠ "método ruim":
  é "não temos como medir" — distinguidos por `hasRuntimeGroundTruth`.
- A garantia é de **cobertura do intervalo** (Clopper–Pearson exato / conformal
  finito), **não** de acurácia pontual de p̂. Amostra pequena → intervalo largo.

## Patch MÍNIMO de integração no `/graph` (aplicar após a WS1)

Arquivo: `server/routes.ts`, handler `GET /api/projects/:projectId/graph`
(hoje termina em `res.json({ ...shaped })` ~L1842–L1851). O patch é **top-level e
aditivo** — **não altera `ShapedEdge` nem `coverage`** (a WS1 mexe nisso). O cliente
mapeia `confidenceCalibrated[edge.evidence.method]` por aresta.

```ts
      const { shapeSystemGraph } = await import("./analyzers/system-graph");
      const level = req.query.level === "method" ? "method" : "class";
      const shaped = shapeSystemGraph(systemGraph, level);

      // ── ADR-0035 (calibração por-aresta) — PATCH MÍNIMO, reconciliar após WS1 ──
      // fail-soft: erro de calibração NÃO derruba o /graph (mantém o grafo cru).
      let calibrationBlock: Record<string, unknown> = {};
      try {
        const { buildCalibrationOverlay } = await import("./analyzers/calibration-overlay");
        // Pesos fixos espelham `classifyEdgeEvidence` (system-graph.ts). Mantidos
        // LOCAIS de propósito: aquele bloco está em edição na WS1 — não importar de lá
        // (quando a WS1 estabilizar, exporte-os de system-graph e importe aqui).
        const FIXED_METHOD_WEIGHTS: Record<string, number> = {
          RUNTIME_OBSERVED: 0.95, STATIC_PROVEN: 0.80, CONFIG_PROVEN: 0.78,
          STATIC_UNRESOLVED: 0.40, LLM_CONJECTURED: 0.30, UNKNOWN: 0.20,
        };
        const overlay = buildCalibrationOverlay(shaped.edges, FIXED_METHOD_WEIGHTS);
        calibrationBlock = {
          calibration: overlay.calibration,               // confiabilidade por método + gate
          completeness: overlay.completeness,             // Chao2 + IC
          confidenceCalibrated: overlay.effectiveConfidenceByMethod, // método → confiança efetiva
        };
      } catch (e) {
        console.error("calibration overlay failed (fail-soft):", e);
      }
      // ── fim do patch ──

      res.json({
        projectId,
        analysisRunId: snapshots[0].analysisRunId,
        ...(scipStats ? { scipOverlay: scipStats } : {}),
        ...(configStats ? { configOverlay: configStats } : {}),
        ...calibrationBlock, // ADR-0035
        ...shaped,
      });
```

### Forma do que aparece no `/graph`

```jsonc
{
  "calibration": {
    "alpha": 0.1, "minSamples": 30,
    "hasRuntimeGroundTruth": true, "runtimeOracleSize": 412, "totalSamples": 9631,
    "byMethod": {
      "STATIC_UNRESOLVED": { "reliability": 0.30, "lower": 0.25, "upper": 0.36,
        "width": 0.11, "n": 200, "confirmed": 60, "calibrated": true }
      // ...
    }
  },
  "completeness": { "observed": 9800, "estimatedTotal": 10240, "missShare": 0.043,
    "ci": { "lower": 10010, "upper": 10520 }, "detail": { "methods": 5, "f1": 812, "f2": 640, "estimator": "chao2", "reliable": true } },
  "confidenceCalibrated": {
    "STATIC_UNRESOLVED": { "confidence": 0.30, "source": "calibrated", "fixed": 0.40 },
    "STATIC_PROVEN":     { "confidence": 0.80, "source": "fixed", "fixed": 0.80 }  // sem massa ainda → fixo
  }
}
```

### Alternativa deferida (per-edge attach)

Anexar `edge.confidenceCalibrated` a CADA `ShapedEdge` seria mais direto na UI,
**mas toca `system-graph.ts`** (a interface `ShapedEdge` + o loop de shaping — zona
de conflito da WS1). Fica para depois da reconciliação: adicionar
`confidenceCalibrated?: number` a `ShapedEdge` e preencher via
`effectiveConfidenceByMethod[evidence.method].confidence` no loop de arestas.

## Nota honesta — validação com números REAIS

Os testes provam a **matemática** com dados sintéticos (número colado abaixo). A
validação **em produção** (confiabilidades e completude reais do easynup/identify)
só roda quando o **eixo runtime estiver vivo** — hoje em conserto (a memória de
sessão registra `runtime-overlay.ts` em edição; o oráculo `RUNTIME_OBSERVED`
depende do laço OTel→Jaeger). Sem oráculo, `hasRuntimeGroundTruth=false` e a
calibração corretamente **abstém** (cai no peso fixo). Isso é o comportamento
desejado, não uma lacuna: o mapa admite que ainda não mediu.

## Números provados (sintéticos)

- Método 90% confirmado → `reliability 0.90`, IC `[0.836, 0.945]`, `calibrated:true`.
- Método 30% confirmado → `reliability 0.30` (o **chute** 0.40 seria mentira), IC `[0.247, 0.358]`.
- Amostra `n=5, k=4` → `reliability 0.80` mas `width 0.647`, **`calibrated:false`** (abstém).
- Sem oráculo → **nada calibra**, `hasRuntimeGroundTruth:false`.
- Clopper–Pearson exato: `0/10 @95% = [0, 0.3085]`, `10/10 @95% = [0.6915, 1]` (valores de tabela).
- Chao2 recupera um universo conhecido: `N=300`, observado 282, estimado **294**,
  `missShare 0.041`, IC `[288, 307]` (contém 300).

## Referências primárias

- Clopper & Pearson (1934), *Biometrika* 26(4):404–413 — intervalo exato binomial.
- Vovk, Gammerman & Shafer (2005), *Algorithmic Learning in a Random World* — split/inductive conformal.
- Angelopoulos & Bates (2023), *Conformal Prediction: A Gentle Introduction* — correção finita (n+1), cobertura marginal.
- Chao (1984/1987), *Scand. J. Statist.* 11:265–270 / *Biometrics* 43:783–791 — Chao1, limite inferior, variância.
- Chao & Chiu (2016), *eLS* — formas bias-corrected (Chao2 incidence) robustas a f2=0.

> A aplicação de conformal prediction + capture-recapture a arestas de
> call-graph (método de proveniência como preditor, runtime como rótulo) é
> **território não-reclamado** na literatura — fronteira honesta, não folclore.

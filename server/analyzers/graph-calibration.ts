// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 — FIAÇÃO da camada de calibração no `/graph`.
//
// Os módulos de estatística já existem e são puros (`calibration.ts` =
// Clopper–Pearson exato; `completeness-estimator.ts` = Chao1/Chao2;
// `calibration-overlay.ts` = orquestrador). O que faltava era ligá-los ao
// payload que a tela consome, COM O GATE DE HONESTIDADE CERTO. Este módulo é
// essa costura — e só isso: não reimplementa estatística nenhuma.
//
// ─── §O GATE QUE FALTAVA (a fraqueza achada ao ligar) ───────────────────────
// O `calibration.ts` abstém quando não há oráculo (`runtimeOracleSize === 0`).
// Isso é necessário mas NÃO suficiente. Descoberto ao ligar contra o hub real
// (projeto 27, 2026-08-08): os traços do backend chegam FRAGMENTADOS — só spans
// de DB, sem o span de rota. O overlay então emite as arestas observadas a
// partir de uma fonte SINTÉTICA (`runtime:db:<serviço>`) que NENHUMA aresta
// estática replica. Resultado: o oráculo tem 24 arestas (>0, passa no gate
// atual) mas é ESTRUTURALMENTE incapaz de confirmar qualquer aresta estática —
// toda taxa medida sairia 0%, e "0% confirmado" seria lido como "o método
// estático é péssimo" quando a verdade é "não dá para comparar".
//
// Por isso o gate adicional de COMPARABILIDADE: um par observado só serve de
// oráculo se sua ORIGEM também é origem de alguma aresta estática — isto é, se
// o modelo estático ao menos CONHECE aquele ponto de partida. Zero pares
// comparáveis ⇒ abstém com o motivo nomeado, em vez de publicar um 0% artificial.
// Regra estrutural, sem prefixo hardcoded: vale para qualquer produtor futuro.
//
// ─── §COMPLETUDE: a 2ª fraqueza achada ao ligar ─────────────────────────────
// O `completeness-estimator` (Chao1/Chao2) trata cada MÉTODO de evidência como
// um "capturador independente" do mesmo universo de arestas. Essa premissa NÃO
// vale sobre as arestas já modeladas: o `shapeSystemGraph` atribui a cada aresta
// EXATAMENTE UM método (a classificação é uma PARTIÇÃO, não N detecções
// redundantes). Logo f1 ≈ todas as arestas e f2 ≈ 0, e o termo bias-corrected
// f1·(f1−1)/(2·(f2+1)) EXPLODE: medido na forma do run real do projeto 27 (9.601
// arestas), o estimador cospe ~34,5 MILHÕES de arestas e "falta 99,97% do mapa".
// Publicar isso seria pior que não estimar — é ruído com cara de ciência.
//
// Por isso o gate de APLICABILIDADE: só publicamos completude quando há
// DETECÇÃO REDUNDANTE de verdade (uma fração mínima de arestas vista por ≥2
// métodos). Abaixo disso, `completenessApplicable=false` com o motivo nomeado —
// os números seguem no payload para inspeção, mas a UI não os apresenta como
// fato. Quando o pipeline passar a emitir detecção redundante real (mesmo par
// visto por scip E por runtime E por config, sem colapsar), o gate acende sozinho.
//
// ─── §PESOS FIXOS SEM DUPLICAR VERDADE ──────────────────────────────────────
// O `calibration-overlay` precisa dos pesos de projeto por método para o
// fallback. Em vez de copiar a tabela de `system-graph.ts` (que apodreceria em
// silêncio), os pesos são LIDOS DAS PRÓPRIAS ARESTAS já modeladas — a confiança
// de uma aresta é função pura do método, então a 1ª aresta de cada método já
// declara o peso vigente. Uma fonte só, sempre em dia.
// ─────────────────────────────────────────────────────────────────────────

import { buildCalibrationOverlay, type EffectiveMethodConfidence } from "./calibration-overlay";
import type { CalibrationResult } from "./calibration";
import type { CompletenessResult } from "./completeness-estimator";

/** Aresta modelada — o subconjunto do `ShapedEdge` que a calibração precisa. */
export interface CalibrationInputEdge {
  fromNode: string;
  toNode: string;
  evidence: { method: string; confidence?: number };
}

export interface GraphCalibration {
  /**
   * A calibração produziu número MEDIDO para ao menos um método? `false` ⇒ a UI
   * deve mostrar abstenção e o consumidor deve usar o peso fixo (byte-a-byte).
   */
  calibrated: boolean;
  /** motivo pt-BR quando `calibrated=false` (nunca um número fabricado). */
  reason?: string;
  /** havia arestas RUNTIME_OBSERVED? (condição necessária, não suficiente). */
  hasRuntimeGroundTruth: boolean;
  /** nº de pares observados (o oráculo bruto). */
  runtimeOracleSize: number;
  /** nº de pares observados cuja ORIGEM o modelo estático conhece (utilizáveis). */
  oracleComparablePairs: number;
  /** nº de arestas estáticas CONFIRMÁVEIS pelo oráculo, por método (o denominador honesto). */
  confirmableStaticByMethod: Record<string, number>;
  /** nível do intervalo de confiança da calibração, em % (1−α). */
  confidenceLevelPct: number;
  /** confiabilidade medida + intervalo exato, por método. */
  byMethod: CalibrationResult["byMethod"];
  /** confiança a APLICAR por método (medida quando calibrou; fixa senão). */
  effectiveConfidenceByMethod: Record<string, EffectiveMethodConfidence>;
  /** estimativa Chao de quantas arestas o mapa ainda não viu. */
  completeness: CompletenessResult;
  /** nível do IC da completude, em % (1−α da completude). */
  completenessLevelPct: number;
  /**
   * A premissa de capture-recapture VALE neste grafo? Ver §COMPLETUDE. `false` ⇒
   * a UI NÃO deve publicar `completeness` (os números seguem no payload para
   * inspeção, com o motivo ao lado).
   */
  completenessApplicable: boolean;
  /** motivo pt-BR quando `completenessApplicable=false`. */
  completenessReason?: string;
  /** fração das arestas detectada por ≥2 métodos (0 = partição pura). */
  methodOverlapShare: number;
}

export interface GraphCalibrationOptions {
  alpha?: number;
  minSamples?: number;
  completenessAlpha?: number;
}

const DEFAULT_ALPHA = 0.1;
const DEFAULT_COMPLETENESS_ALPHA = 0.05;
const RUNTIME_METHOD = "RUNTIME_OBSERVED";
/**
 * Fração mínima de arestas detectada por ≥2 métodos para que capture-recapture
 * seja aplicável (ver §COMPLETUDE). 5% é um piso prático e conservador: abaixo
 * disso o termo f1²/(2·f2) domina e a estimativa vira extrapolação de f1.
 */
const MIN_METHOD_OVERLAP_SHARE = 0.05;

/**
 * Pesos fixos por método, lidos das próprias arestas modeladas (a confiança é
 * função pura do método). Métodos ausentes do grafo não precisam de peso.
 */
export function deriveFixedWeights(edges: CalibrationInputEdge[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) {
    const m = e?.evidence?.method;
    if (typeof m !== "string" || m in out) continue;
    const c = e.evidence.confidence;
    if (typeof c === "number" && Number.isFinite(c)) out[m] = c;
  }
  return out;
}

/**
 * Nº de pares observados cuja ORIGEM também é origem de alguma aresta ESTÁTICA.
 * É a medida de "o oráculo é comparável com o mapa estático?" (ver §GATE).
 */
export function countComparableOraclePairs(edges: CalibrationInputEdge[]): number {
  const staticFrom = new Set<string>();
  for (const e of edges) {
    if (e?.evidence?.method !== RUNTIME_METHOD) staticFrom.add(e.fromNode);
  }
  const comparable = new Set<string>();
  for (const e of edges) {
    if (e?.evidence?.method === RUNTIME_METHOD && staticFrom.has(e.fromNode)) {
      comparable.add(`${e.fromNode} ${e.toNode}`);
    }
  }
  return comparable.size;
}

/**
 * ─── §DENOMINADOR CONFIRMÁVEL (3º gate, achado no run 104 do projeto 27) ────
 * Origens comparáveis são NECESSÁRIAS mas ainda não suficientes: um oráculo de
 * FRONTEIRA (spans de DB → arestas serviço→entidade) jamais confirma as arestas
 * INTERNAS do estático (serviço→repositório, serviço→serviço). Medido ao vivo:
 * 444 pares comparáveis e mesmo assim STATIC_PROVEN saiu `reliability=0,
 * n=3085, calibrated=true` — o "0% artificial" UM NÍVEL mais fundo, porque o
 * denominador incluía 3k arestas que o oráculo é estruturalmente incapaz de ver.
 *
 * A regra (estrutural, sem hardcode): uma aresta estática é CONFIRMÁVEL quando
 * (a) sua ORIGEM foi exercitada pelo oráculo nesta janela E (b) seu ALVO é do
 * MESMO TIPO de nó que o oráculo observa — os tipos são DERIVADOS das próprias
 * arestas runtime (kind = prefixo do id antes de ":"), então qualquer oráculo
 * futuro (rota→endpoint, serviço→fila) amplia o universo sozinho. A
 * confiabilidade passa a ser medida SÓ sobre o universo confirmável; método sem
 * NENHUMA aresta confirmável abstém com o motivo nomeado (não é 0%: é fora do
 * alcance do oráculo).
 */
export function confirmableStaticEdges(edges: CalibrationInputEdge[]): {
  subset: CalibrationInputEdge[];
  countsByMethod: Record<string, number>;
} {
  const kindOf = (id: string) => {
    const i = id.indexOf(":");
    return i > 0 ? id.slice(0, i) : id;
  };
  const oracleFrom = new Set<string>();
  const oracleTargetKinds = new Set<string>();
  for (const e of edges) {
    if (e?.evidence?.method === RUNTIME_METHOD) {
      oracleFrom.add(e.fromNode);
      oracleTargetKinds.add(kindOf(e.toNode));
    }
  }
  const subset: CalibrationInputEdge[] = [];
  const countsByMethod: Record<string, number> = {};
  for (const e of edges) {
    if (e?.evidence?.method === RUNTIME_METHOD) {
      subset.push(e); // o oráculo inteiro sempre entra
      continue;
    }
    if (oracleFrom.has(e.fromNode) && oracleTargetKinds.has(kindOf(e.toNode))) {
      subset.push(e);
      countsByMethod[e.evidence.method] = (countsByMethod[e.evidence.method] || 0) + 1;
    }
  }
  return { subset, countsByMethod };
}

/**
 * Monta a seção `coverage.calibration` do `/graph`. Puro, determinístico e
 * NUNCA lança: o consumidor pode chamar sem try/catch defensivo.
 */
export function buildGraphCalibration(
  edges: CalibrationInputEdge[] | null | undefined,
  opts?: GraphCalibrationOptions,
): GraphCalibration {
  const list = Array.isArray(edges) ? edges.filter((e) => e && e.evidence && typeof e.evidence.method === "string") : [];
  const alpha = opts?.alpha ?? DEFAULT_ALPHA;
  const completenessAlpha = opts?.completenessAlpha ?? DEFAULT_COMPLETENESS_ALPHA;
  const confidenceLevelPct = Math.round((1 - alpha) * 100);
  const completenessLevelPct = Math.round((1 - completenessAlpha) * 100);

  const fixed = deriveFixedWeights(list);
  // Passada COMPLETA: completude (Chao) e presença de métodos vêm do grafo
  // inteiro — o recorte confirmável não pode enviesar o censo.
  const overlay = buildCalibrationOverlay(list, fixed, {
    alpha,
    completenessAlpha,
    ...(opts?.minSamples !== undefined ? { minSamples: opts.minSamples } : {}),
  });

  const comparable = countComparableOraclePairs(list);

  // Passada CONFIRMÁVEL (§DENOMINADOR CONFIRMÁVEL): a CONFIABILIDADE por método
  // é medida SÓ sobre as arestas estáticas que o oráculo tem como confirmar.
  const conf = confirmableStaticEdges(list);
  const overlayConf = buildCalibrationOverlay(conf.subset, fixed, {
    alpha,
    completenessAlpha,
    ...(opts?.minSamples !== undefined ? { minSamples: opts.minSamples } : {}),
  });

  // byMethod/effective partem da passada CONFIRMÁVEL; métodos presentes no grafo
  // mas com 0 arestas confirmáveis abstêm com o motivo nomeado (peso fixo).
  const OUT_OF_REACH_REASON =
    "fora do alcance do oráculo desta janela (as arestas deste método são internas — o oráculo de fronteira só observa alvos de outro tipo); não é 0%: é não-confirmável";
  let byMethod: CalibrationResult["byMethod"] = {};
  let effective: Record<string, EffectiveMethodConfidence> = {};
  // eslint-disable-next-line prefer-const -- reatribuídos no gate de incomparabilidade abaixo
  for (const m of Object.keys(overlay.calibration.byMethod)) {
    if (m in overlayConf.calibration.byMethod && (conf.countsByMethod[m] || 0) > 0) {
      byMethod[m] = overlayConf.calibration.byMethod[m];
    } else {
      byMethod[m] = {
        ...overlay.calibration.byMethod[m],
        reliability: 0, confirmed: 0,
        calibrated: false,
        abstainReason: OUT_OF_REACH_REASON,
      };
    }
  }
  for (const m of Object.keys(overlay.effectiveConfidenceByMethod)) {
    const src = overlayConf.effectiveConfidenceByMethod[m];
    if (src && (conf.countsByMethod[m] || 0) > 0) {
      effective[m] = src;
    } else {
      const fx = overlay.effectiveConfidenceByMethod[m].fixed;
      effective[m] = { confidence: fx, source: "fixed", fixed: fx };
    }
  }
  const incomparable = overlay.calibration.hasRuntimeGroundTruth && comparable === 0;
  const INCOMPARABLE_REASON =
    "oráculo de runtime incomparável com o mapa estático (as arestas observadas partem de origens que nenhuma aresta estática compartilha — traço fragmentado); medir confirmação daria 0% artificial";
  if (incomparable) {
    byMethod = demoteAllToAbstain(byMethod, INCOMPARABLE_REASON);
    effective = demoteAllToFixed(effective);
  }

  const anyCalibrated = Object.values(byMethod).some((m) => m.calibrated);

  // ── gates, do mais estrutural ao mais estatístico ──
  let calibrated = anyCalibrated;
  let reason: string | undefined;
  if (list.length === 0) {
    calibrated = false;
    reason = "grafo sem arestas — nada a calibrar";
  } else if (!overlay.calibration.hasRuntimeGroundTruth) {
    calibrated = false;
    reason = "sem oráculo de runtime nesta janela — a confiança segue no peso fixo de projeto (não é 0%: é não-medido)";
  } else if (incomparable) {
    calibrated = false;
    reason = INCOMPARABLE_REASON;
  } else if (!anyCalibrated) {
    calibrated = false;
    reason = `amostra insuficiente por método (mínimo ${overlay.calibration.minSamples} arestas) — intervalo largo demais para publicar número`;
  }

  // ── gate de aplicabilidade da completude (ver §COMPLETUDE) ──
  const { observed, detail } = overlay.completeness;
  const overlapShare = observed > 0 ? round4((observed - detail.f1) / observed) : 0;
  const completenessApplicable =
    detail.reliable && detail.f2 > 0 && overlapShare >= MIN_METHOD_OVERLAP_SHARE;
  let completenessReason: string | undefined;
  if (!completenessApplicable) {
    completenessReason =
      observed === 0
        ? "sem arestas para estimar completude"
        : `os métodos de evidência se comportam como rótulos MUTUAMENTE EXCLUSIVOS neste grafo (só ${Math.round(overlapShare * 100)}% das arestas foi detectada por ≥2 métodos, mínimo ${Math.round(MIN_METHOD_OVERLAP_SHARE * 100)}%) — sem detecção redundante, capture-recapture não se aplica e a estimativa vira extrapolação de f1`;
  }

  return {
    calibrated,
    ...(reason ? { reason } : {}),
    hasRuntimeGroundTruth: overlay.calibration.hasRuntimeGroundTruth,
    runtimeOracleSize: overlay.calibration.runtimeOracleSize,
    oracleComparablePairs: comparable,
    confirmableStaticByMethod: conf.countsByMethod,
    confidenceLevelPct,
    byMethod,
    effectiveConfidenceByMethod: effective,
    completeness: overlay.completeness,
    completenessLevelPct,
    completenessApplicable,
    ...(completenessReason ? { completenessReason } : {}),
    methodOverlapShare: overlapShare,
  };
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/** Marca todo método como não-calibrado, preservando os números MEDIDOS (n, k,
 *  intervalo) para inspeção — o que muda é o veredito, não a evidência. */
function demoteAllToAbstain(
  byMethod: CalibrationResult["byMethod"],
  reason: string,
): CalibrationResult["byMethod"] {
  const out: CalibrationResult["byMethod"] = {};
  for (const [m, v] of Object.entries(byMethod)) {
    out[m] = { ...v, calibrated: false, abstainReason: reason };
  }
  return out;
}

/** Devolve a confiança de projeto (fixa) para todos os métodos. */
function demoteAllToFixed(
  effective: Record<string, EffectiveMethodConfidence>,
): Record<string, EffectiveMethodConfidence> {
  const out: Record<string, EffectiveMethodConfidence> = {};
  for (const [m, v] of Object.entries(effective)) {
    out[m] = { confidence: v.fixed, source: "fixed", fixed: v.fixed };
  }
  return out;
}

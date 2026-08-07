// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 — Confiança CALIBRADA por-método (a camada epistêmica que nenhum
// produto empacotou).
//
// PROBLEMA: hoje cada `EvidenceMethod` do systemGraph carrega um peso FIXO
// (`RUNTIME_OBSERVED 0.95 > STATIC_PROVEN 0.80 > CONFIG_PROVEN 0.78 >
// STATIC_UNRESOLVED 0.40 > UNKNOWN 0.20`, ver `system-graph.ts`
// `classifyEdgeEvidence`). Isso é um CHUTE de projeto — não uma confiabilidade
// MEDIDA. Se, no seu repo, arestas `STATIC_UNRESOLVED` só se confirmam no
// runtime 30% das vezes, a confiança HONESTA delas é ~0.30, não 0.40.
//
// ORÁCULO: os traços OTel/Jaeger (`RUNTIME_OBSERVED`) são o ground-truth — é o
// que DE FATO executou. Este módulo mede, por método estático, a TAXA EMPÍRICA
// com que suas arestas se confirmam no runtime e produz uma confiança calibrada
// com GARANTIA DE COBERTURA distribution-free (intervalo exato de Clopper–
// Pearson, que coincide com o limite split-conformal finito para uma taxa de
// Bernoulli — ver §MATEMÁTICA abaixo).
//
// HONESTIDADE CRAVADA (o requisito nº1 da ADR): a calibração só produz número
// REAL quando há oráculo de runtime suficiente. Sem runtime (ou com amostra
// abaixo de `minSamples`), o método é marcado `calibrated:false` e o CONSUMIDOR
// deve cair no peso fixo (byte-a-byte). NUNCA se inventa calibração de ar:
// "0% confirmado" com oráculo VAZIO não é "método ruim", é "não temos como
// medir" — e os dois casos são distinguidos por `hasRuntimeGroundTruth`.
//
// ─── §MATEMÁTICA (rigor, sem meia-bomba) ────────────────────────────────────
// Para um método m com n arestas de calibração das quais k se confirmaram no
// runtime, a confiabilidade pontual é a taxa empírica p̂ = k/n. A GARANTIA de
// cobertura ≥ 1−α vem do intervalo EXATO de Clopper–Pearson (1934), construído
// via os quantis da distribuição Beta:
//   lower = Q_Beta(α/2 ; k,   n−k+1)      (0 se k=0)
//   upper = Q_Beta(1−α/2 ; k+1, n−k)      (1 se k=n)
// É distribution-free e FINITO (vale para todo n; conservador p/ n pequeno).
//
// Conexão split-conformal: sob permutabilidade das arestas de um método, o
// limite inferior split-conformal de nível α para a probabilidade de confirmação
// de uma NOVA aresta do mesmo método — com a correção finita (n+1) do conformal
// — COINCIDE com o limite inferior unilateral de Clopper–Pearson (parâmetros
// Beta `k, n−k+1`). Implementar Clopper–Pearson via quantil-Beta É, portanto,
// implementar o limite conformal exato, sem aproximação normal (nada de Wald).
// A garantia é de COBERTURA do intervalo — não de acurácia PONTUAL de p̂.
//
// Referências primárias:
//  • Clopper & Pearson (1934), "The use of confidence or fiducial limits...",
//    Biometrika 26(4):404–413 — intervalo exato para proporção binomial.
//  • Vovk, Gammerman & Shafer (2005), "Algorithmic Learning in a Random World"
//    — split/inductive conformal prediction; validade finita sob permutabilidade.
//  • Angelopoulos & Bates (2023), "Conformal Prediction: A Gentle Introduction"
//    — a correção finita (n+1) e a leitura de cobertura marginal.
// A APLICAÇÃO destes a arestas de call-graph (método de proveniência como
// preditor, runtime como rótulo) é território NÃO-reclamado na literatura — é
// fronteira, não folclore. Este módulo é a materialização honesta disso.
// ─────────────────────────────────────────────────────────────────────────

// ─── Uma amostra de calibração: uma aresta ESTÁTICA e se o runtime a confirmou.
export interface CalibrationSample {
  /** o EvidenceMethod estático da aresta (mantido como string p/ desacoplar). */
  method: string;
  /** a MESMA aresta (par from→to) apareceu no conjunto RUNTIME_OBSERVED? */
  confirmed: boolean;
}

export interface MethodReliability {
  method: string;
  /** p̂ = k/n — a confiabilidade MEDIDA (substitui o peso fixo quando calibrada). */
  reliability: number;
  /** limite inferior do intervalo de cobertura (Clopper–Pearson). */
  lower: number;
  /** limite superior do intervalo de cobertura. */
  upper: number;
  /** largura (upper−lower) — proxy de incerteza; larga = método abstém. */
  width: number;
  /** tamanho da amostra de calibração para este método. */
  n: number;
  /** nº de confirmações no runtime (k). */
  confirmed: number;
  /**
   * TRUE só quando há oráculo de runtime E n ≥ minSamples. FALSE = o consumidor
   * DEVE ignorar `reliability` e manter o peso fixo do método (byte-a-byte).
   */
  calibrated: boolean;
  /** motivo pt-BR quando `calibrated=false` (amostra rala / sem oráculo). */
  abstainReason?: string;
}

export interface CalibrationOptions {
  /** miscoverage do intervalo; default 0.1 → intervalo de 90%. */
  alpha?: number;
  /** n mínimo para `calibrated=true`; default 30 (regra prática, documentada). */
  minSamples?: number;
  /**
   * nº de arestas RUNTIME_OBSERVED disponíveis como oráculo. Se 0, NENHUM método
   * calibra (todo `confirmed=false` seria artefato de "sem oráculo", não medida).
   * O consumidor computa isto do próprio grafo (contagem de arestas observadas).
   */
  runtimeOracleSize: number;
}

export interface CalibrationResult {
  alpha: number;
  minSamples: number;
  /** havia oráculo de runtime? (runtimeOracleSize > 0). Gate de honestidade. */
  hasRuntimeGroundTruth: boolean;
  /** nº de arestas RUNTIME_OBSERVED usadas como ground-truth. */
  runtimeOracleSize: number;
  /** total de amostras de calibração processadas (arestas estáticas). */
  totalSamples: number;
  byMethod: Record<string, MethodReliability>;
}

const DEFAULT_ALPHA = 0.1;
const DEFAULT_MIN_SAMPLES = 30;

/**
 * Calibra a confiabilidade de CADA método de proveniência contra o oráculo de
 * runtime. Puro e determinístico. Ver §MATEMÁTICA no topo do arquivo.
 */
export function calibrateMethodReliability(
  samples: CalibrationSample[],
  opts: CalibrationOptions,
): CalibrationResult {
  const alpha = clamp01Open(opts.alpha ?? DEFAULT_ALPHA);
  const minSamples = Math.max(1, Math.floor(opts.minSamples ?? DEFAULT_MIN_SAMPLES));
  const runtimeOracleSize = Math.max(0, Math.floor(opts.runtimeOracleSize ?? 0));
  const hasRuntimeGroundTruth = runtimeOracleSize > 0;

  // agrupa por método: n e k (confirmações)
  const agg = new Map<string, { n: number; k: number }>();
  for (const s of samples) {
    const a = agg.get(s.method) ?? { n: 0, k: 0 };
    a.n += 1;
    if (s.confirmed) a.k += 1;
    agg.set(s.method, a);
  }

  const byMethod: Record<string, MethodReliability> = {};
  for (const [method, { n, k }] of agg) {
    const reliability = n > 0 ? k / n : 0;
    const [lower, upper] = clopperPearson(k, n, alpha);
    // Gate de honestidade: sem oráculo NUNCA calibra; com oráculo, exige massa.
    let calibrated = true;
    let abstainReason: string | undefined;
    if (!hasRuntimeGroundTruth) {
      calibrated = false;
      abstainReason = 'sem oráculo de runtime — nada a medir; use o peso fixo';
    } else if (n < minSamples) {
      calibrated = false;
      abstainReason = `amostra rala (${n} < ${minSamples}) — intervalo largo; use o peso fixo`;
    }
    byMethod[method] = {
      method,
      reliability: round4(reliability),
      lower: round4(lower),
      upper: round4(upper),
      width: round4(upper - lower),
      n,
      confirmed: k,
      calibrated,
      ...(abstainReason ? { abstainReason } : {}),
    };
  }

  return {
    alpha,
    minSamples,
    hasRuntimeGroundTruth,
    runtimeOracleSize,
    totalSamples: samples.length,
    byMethod,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helper de derivação (puro): transforma as arestas JÁ MODELADAS do systemGraph
// em amostras de calibração + o tamanho do oráculo. O CONSUMIDOR (integração no
// `/graph`) chama isto; fica aqui para ser testável isoladamente.
//
// Regra: as arestas RUNTIME_OBSERVED são o ORÁCULO (par from→to = "isto rodou").
// Toda aresta NÃO-observada vira uma amostra do seu método, com
// `confirmed = (par from→to está no conjunto observado)`. A chave ignora o
// `relationType` de propósito: se o runtime viu A→B, isso confirma a aresta
// estática A→B independentemente do tipo de relação modelado.
//
// CAVEAT honesto: no nível de CLASSE o `shapeSystemGraph` já deduplica arestas
// (a,b,relationType); um par observado E provado do MESMO tipo colapsa em UMA
// aresta classificada como RUNTIME_OBSERVED — logo ela entra no oráculo e NÃO
// como amostra estática. Isso subconta levemente as confirmações de métodos
// estáticos (viés conservador — puxa a confiabilidade medida p/ baixo, nunca p/
// cima). Documentado; a correção fina exige amostrar do grafo CRU pré-shape.
// ─────────────────────────────────────────────────────────────────────────
export interface CalibratableEdge {
  fromNode: string;
  toNode: string;
  evidence: { method: string };
}

const RUNTIME_METHOD = 'RUNTIME_OBSERVED';

export function deriveSamplesFromEdges(edges: CalibratableEdge[]): {
  samples: CalibrationSample[];
  runtimeOracleSize: number;
} {
  const observedPairs = new Set<string>();
  for (const e of edges) {
    if (e.evidence.method === RUNTIME_METHOD) observedPairs.add(pairKey(e.fromNode, e.toNode));
  }
  const samples: CalibrationSample[] = [];
  for (const e of edges) {
    if (e.evidence.method === RUNTIME_METHOD) continue; // oráculo, não amostra
    samples.push({ method: e.evidence.method, confirmed: observedPairs.has(pairKey(e.fromNode, e.toNode)) });
  }
  return { samples, runtimeOracleSize: observedPairs.size };
}

function pairKey(from: string, to: string): string {
  return `${from} ${to}`;
}

// ─── Clopper–Pearson (intervalo exato binomial) via quantil-Beta ──────────────
/** Intervalo [lower, upper] de cobertura ≥1−α para p, dados k sucessos em n. */
export function clopperPearson(k: number, n: number, alpha: number): [number, number] {
  if (n <= 0) return [0, 1];
  const a = alpha;
  const lower = k <= 0 ? 0 : betaQuantile(a / 2, k, n - k + 1);
  const upper = k >= n ? 1 : betaQuantile(1 - a / 2, k + 1, n - k);
  return [clamp01(lower), clamp01(upper)];
}

/**
 * Quantil da Beta(a,b): x tal que I_x(a,b) = p. Bisseção sobre a Beta incompleta
 * regularizada (monótona crescente em x). Determinístico; ~50 iterações → ~1e-15.
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

/**
 * Beta incompleta regularizada I_x(a,b). Fração contínua de Lentz (o `betacf`/
 * `betai` clássico de Numerical Recipes). Puro; sem dependências.
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lnBeta + a * Math.log(x) + b * Math.log(1 - x));
  // usa a fração contínua na região de convergência rápida; simetria senão.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-30;
  const MAX_ITER = 300;
  const EPS = 3e-16;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    // passo par
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // passo ímpar
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** ln Γ(x) — aproximação de Lanczos (g=7), precisa a ~1e-13 para x>0. */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // reflexão: Γ(x)Γ(1−x) = π/sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let aSum = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) aSum += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(aSum);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
/** α deve ficar em (0,1); protege contra 0/1 exatos. */
function clamp01Open(v: number): number {
  if (!(v > 0)) return 1e-6;
  if (!(v < 1)) return 1 - 1e-6;
  return v;
}
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

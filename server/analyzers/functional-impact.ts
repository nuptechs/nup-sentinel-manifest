// ─────────────────────────────────────────────
// functional-impact — ADR-0018 Onda 4 (D5: a FACE FUNCIONAL do impacto)
//
// "Este diff acende a caixa Glosa/SLA" — determinístico, com âncora no grafo.
//
// É o Reflexion Model (Murphy FSE'95) aplicado à entrega: projeta o que o diff
// tocou (entidades, endpoints, telas, símbolos, arquivos — a saída das Ondas
// 1–2) sobre o MAPA DE NEGÓCIO declarado do domínio — a ontologia de contratação
// pública que JÁ existe no Manifest (`domain-ontology.ts`: conceito + patterns +
// base legal citável). O mapa é CONVENÇÃO EM CÓDIGO, não planilha manual — a
// barreira nº1 do Reflexion é o mapeamento apodrecer (Ali/Herold EMSE'18), e
// convenção versionada com o código não apodrece calada (D7).
//
// GROUNDING FORÇADO (D8): uma caixa só ACENDE com ≥1 âncora concreta (a
// entidade/endpoint/tela/símbolo que casou o pattern). Sem âncora não emite —
// anti-alucinação estrutural. LLM NÃO participa (Lo ICSE'26: IR bate LLM em
// traceability; aqui nem IR é preciso — as entidades do domínio são NOMEADAS:
// Deflator, SlaIndicator, Acceptance… o casamento é determinístico por padrão
// declarado, o caso que o §8.2 do ADR previu).
//
// Honestidade (D7):
//   - arquivo do diff que não ancora caixa nenhuma é CONTADO em `unmapped`
//     ("não mapeado" ≠ "sem impacto de negócio" — dito explicitamente);
//   - a dimensão de AUSÊNCIA do Reflexion ("deveria existir e não existe") é o
//     `domain-coverage.ts` (auditoria do sistema inteiro) — fora do escopo de
//     UM diff, declarado em `method`;
//   - refinamento por IR/embedding (ADR-080) fica declarado como futuro — o
//     casamento por entidade nomeada é o sinal primário e mais preciso.
//
// Puro; sem I/O; sem LLM. Fonte única do mapa: PUBLIC_PROCUREMENT_ONTOLOGY.
// ─────────────────────────────────────────────

import { PUBLIC_PROCUREMENT_ONTOLOGY, type DomainConcept } from "./domain-ontology";
import type { DiffFile } from "./changed-symbols";
import { extractChangedSymbols } from "./changed-symbols";
import type { BreakingReport } from "./breaking-changes";

export interface BusinessAnchor {
  /** de onde veio a âncora (fonte tipada do grafo/diff) */
  kind: "entity" | "endpoint" | "screen" | "symbol" | "file";
  /** o artefato concreto que casou (ex.: "Deflator", "POST /easynup/findSlas.v1") */
  value: string;
  /** o pattern da ontologia que casou (evidência da regra, legível) */
  matchedPattern: string;
}

export interface BusinessBoxHit {
  /** conceito de negócio aceso (ex.: "Sanção/Glosa (penalidade)") */
  concept: string;
  /** base legal citável — o ancoramento regulatório do conceito */
  legalBasis: string;
  importance: "core" | "recommended";
  why: string;
  /** GROUNDING: as âncoras concretas que acenderam a caixa (nunca vazio) */
  anchors: BusinessAnchor[];
}

export interface FunctionalImpactReport {
  /** caixas de negócio acesas pelo diff (core primeiro, depois nº de âncoras) */
  boxes: BusinessBoxHit[];
  /** arquivos do diff que não ancoraram caixa nenhuma — contados, com a nota honesta */
  unmapped: { files: string[]; note: string };
  /** transparência do método (o que este relatório é — e o que NÃO é) */
  method: string;
  /**
   * ADR-0018 (fidelidade multi-projeto): origem do mapa de negócio —
   * 'project' (ontologia configurada no projeto) ou 'default-procurement'
   * (mapa default de contratação pública BR — PODE NÃO servir ao domínio do
   * projeto; o aviso vai junto no method).
   */
  mapSource: "project" | "default-procurement";
}

/**
 * Valida e compila a ontologia configurada num PROJETO (JSON armazenado) para
 * DomainConcept[]. Regex inválida ou item malformado ⇒ erro nomeando o campo
 * (fail-closed: ontologia meio-válida não entra). Retorna null p/ entrada nula.
 */
export function parseProjectOntology(raw: unknown): DomainConcept[] | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw new Error("ontologia deve ser um array de conceitos");
  if (raw.length === 0) throw new Error("ontologia vazia — remova a configuração ou adicione conceitos");
  const out: DomainConcept[] = [];
  raw.forEach((it: any, i: number) => {
    const at = `conceito[${i}]`;
    if (!it || typeof it !== "object") throw new Error(`${at}: deve ser objeto`);
    if (typeof it.concept !== "string" || !it.concept.trim()) throw new Error(`${at}.concept: obrigatório`);
    if (it.importance !== "core" && it.importance !== "recommended") throw new Error(`${at}.importance: 'core' | 'recommended'`);
    if (!Array.isArray(it.patterns) || it.patterns.length === 0) throw new Error(`${at}.patterns: array não-vazio de strings`);
    const patterns = it.patterns.map((ps: any, j: number) => {
      if (typeof ps !== "string" || !ps.trim()) throw new Error(`${at}.patterns[${j}]: string obrigatória`);
      try {
        return new RegExp(ps, "i");
      } catch (e) {
        throw new Error(`${at}.patterns[${j}]: regex inválida (${(e as Error).message})`);
      }
    });
    out.push({
      concept: it.concept.trim(),
      patterns,
      legalBasis: typeof it.legalBasis === "string" ? it.legalBasis : "",
      importance: it.importance,
      why: typeof it.why === "string" ? it.why : "",
    });
  });
  return out;
}

const METHOD_NOTE =
  "Reflexion determinístico: artefatos tocados (entidades/endpoints/telas/símbolos/arquivos) projetados sobre o mapa de negócio declarado (domain-ontology, convenção em código). Caixa só acende com âncora concreta. NÃO cobre ausência ('deveria existir') — isso é a auditoria de cobertura de domínio do sistema inteiro; refinamento por IR/embedding (ADR-080) é evolução declarada.";

const DEFAULT_MAP_WARNING =
  " ATENÇÃO: mapa de negócio DEFAULT (contratação pública BR) — este projeto NÃO tem ontologia própria configurada; para fidelidade de domínio em outros contextos, configure via PUT /api/projects/:id/ontology.";

const UNMAPPED_NOTE =
  "arquivo sem caixa mapeada ≠ sem impacto de negócio — significa apenas que nenhum padrão do mapa declarado casou; revise manualmente se a entrega for sensível.";

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

/**
 * Visão TOKENIZADA de um artefato pra casar os patterns da ontologia em
 * identificadores reais: split de camelCase + separadores, e forma SINGULAR
 * extra pra token plural (`findSlas.v1` → "find slas v1 sla" — o `\bsla\b` da
 * ontologia casa). Sem isso a caixa SLA não acenderia pra NENHUM endpoint real
 * do easynup (todos camelCase) — fragilidade pega por teste, corrigida na
 * raiz. O pattern é testado no valor CRU e na visão tokenizada; qualquer um
 * casando acende (o cru preserva patterns compostos tipo /priceadjust/).
 */
export function tokenizedView(value: string): string {
  const parts = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  const singulars: string[] = [];
  for (const t of parts) if (t.length > 3 && t.endsWith("s")) singulars.push(t.slice(0, -1));
  return [...parts, ...singulars].join(" ");
}

/** candidato a âncora: um artefato tocado, com o tipo e o arquivo de origem (quando houver). */
interface AnchorCandidate {
  kind: BusinessAnchor["kind"];
  value: string;
  /** arquivo do diff que originou o candidato (p/ contabilizar unmapped) */
  fromFile?: string;
}

/**
 * Reúne os candidatos a âncora do diff + das saídas das Ondas 1–2.
 * Cada candidato carrega o arquivo de origem quando derivado do diff.
 */
export function collectAnchorCandidates(
  files: DiffFile[],
  impact: {
    entitiesTouched?: string[];
    impactedEndpoints?: { path: string; method: string; controller: string }[];
    impactedScreens?: { name: string; route: string | null }[];
  },
  breaking?: BreakingReport,
): AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  const seen = new Set<string>();
  const push = (c: AnchorCandidate) => {
    const k = `${c.kind}:${lc(c.value)}`;
    if (c.value && !seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  };

  // 1) entidades tocadas (o carregador de conceito mais forte do domínio)
  for (const e of impact.entitiesTouched || []) push({ kind: "entity", value: e });
  // entidades citadas nos achados de quebra (alerta E morta — a caixa acende igual)
  for (const list of [breaking?.alerts || [], breaking?.suppressedDead || []]) {
    for (const f of list) {
      for (const ep of [...f.surfaceEndpoints, ...f.consumers.endpoints]) {
        for (const e of ep.entitiesTouched || []) push({ kind: "entity", value: e });
      }
    }
  }

  // 2) endpoints impactados (path + controller)
  for (const ep of impact.impactedEndpoints || []) {
    push({ kind: "endpoint", value: `${ep.method} ${ep.path}` });
    if (ep.controller) push({ kind: "endpoint", value: ep.controller });
  }
  for (const list of [breaking?.alerts || [], breaking?.suppressedDead || []]) {
    for (const f of list) {
      for (const ep of [...f.surfaceEndpoints, ...f.consumers.endpoints]) {
        push({ kind: "endpoint", value: `${ep.method} ${ep.path}` });
        if (ep.controller) push({ kind: "endpoint", value: ep.controller });
      }
    }
  }

  // 3) telas impactadas
  for (const sc of impact.impactedScreens || []) {
    push({ kind: "screen", value: sc.name });
    if (sc.route) push({ kind: "screen", value: sc.route });
  }

  // 4) símbolos + arquivos do próprio diff (com origem p/ unmapped)
  for (const f of files) {
    push({ kind: "file", value: f.path, fromFile: f.path });
    for (const s of extractChangedSymbols(f)) push({ kind: "symbol", value: s, fromFile: f.path });
  }

  return out;
}

/**
 * Projeta os candidatos sobre a ontologia — a caixa acende quando algum pattern
 * do conceito casa algum candidato. Determinístico; core primeiro.
 */
export function computeFunctionalImpact(
  files: DiffFile[],
  impact: {
    entitiesTouched?: string[];
    impactedEndpoints?: { path: string; method: string; controller: string }[];
    impactedScreens?: { name: string; route: string | null }[];
  },
  breaking?: BreakingReport,
  ontology?: DomainConcept[] | null,
): FunctionalImpactReport {
  const mapSource: FunctionalImpactReport["mapSource"] = ontology ? "project" : "default-procurement";
  const activeOntology = ontology ?? PUBLIC_PROCUREMENT_ONTOLOGY;
  const candidates = collectAnchorCandidates(files, impact, breaking);

  const boxes: BusinessBoxHit[] = [];
  const anchoredFiles = new Set<string>();

  for (const concept of activeOntology) {
    const anchors: BusinessAnchor[] = [];
    for (const cand of candidates) {
      const tokenized = tokenizedView(cand.value);
      for (const pat of concept.patterns) {
        if (pat.test(cand.value) || pat.test(tokenized)) {
          anchors.push({ kind: cand.kind, value: cand.value, matchedPattern: String(pat) });
          if (cand.fromFile) anchoredFiles.add(cand.fromFile);
          break; // 1 âncora por candidato por conceito (o pattern que casou primeiro)
        }
      }
    }
    // GROUNDING FORÇADO: sem âncora, a caixa NÃO acende (D8)
    if (anchors.length > 0) {
      boxes.push({
        concept: concept.concept,
        legalBasis: concept.legalBasis,
        importance: concept.importance,
        why: concept.why,
        anchors,
      });
    }
  }

  // core primeiro; dentro do mesmo tier, mais âncoras primeiro (mais evidência)
  boxes.sort((a, b) => {
    if (a.importance !== b.importance) return a.importance === "core" ? -1 : 1;
    return b.anchors.length - a.anchors.length;
  });

  const unmappedFiles = files.map((f) => f.path).filter((p) => !anchoredFiles.has(p));

  return {
    boxes,
    unmapped: { files: unmappedFiles, note: UNMAPPED_NOTE },
    method: mapSource === "project" ? METHOD_NOTE : METHOD_NOTE + DEFAULT_MAP_WARNING,
    mapSource,
  };
}

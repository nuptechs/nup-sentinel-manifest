// ─────────────────────────────────────────────
// breaking-changes — ADR-0018 Onda 2 (nup-sentinel)
//
// "breaking-AND-reachable": detecta do DIFF as quebras de contrato ESTRUTURAIS
// (símbolo removido / assinatura mudada / rename) e cruza cada uma com o grafo
// cross-stack do manifesto pra separar:
//
//   • ALERTA  — a quebra tem CONSUMIDOR conhecido no grafo (endpoint cuja cadeia
//               depende do símbolo, tela que chama o endpoint quebrado);
//   • MORTA   — a quebra não tem consumidor conhecido → SUPRIMIDA do alerta e
//               CONTADA (Ochoa/Degueule/Falleri/Vinju, EMSE 2022: ~92% das
//               breaking changes atingem código que ninguém usa — alarmar tudo
//               é o erro nº1 do mercado contract-only);
//   • REFACTOR — rename puro (mesma assinatura, nome novo) é REBAIXADO: não é
//               "mudou a regra" (RefactoringMiner/RefDiff, D7 do ADR).
//
// Régua de honestidade (D7):
//   - "morta" = sem consumidor NO GRAFO CONHECIDO (telas + cadeias analisadas).
//     Consumidor externo (integração/API pública) é ponto-cego DECLARADO.
//   - BC comportamental (assinatura igual, semântica muda) é INVISÍVEL ao diff
//     estrutural — ponto-cego declarado, coberto por runtime/navegador (Onda 3).
//   - Declaração fora do hunk / overload pode mascarar remoção → classificação
//     CONSERVADORA: na dúvida (nome ainda referenciado nos `+`), não alarma —
//     vira `inconclusive`, contado.
//   - Arquivo de frontend NÃO entra na classificação de quebra (o grafo interno
//     componente→página não está modelado no manifesto) — ponto-cego declarado.
//     O blast radius da Onda 1 segue cobrindo frontend normalmente.
//
// Precisão > recall EM ALERTA: o casamento com a cadeia usa igualdade da ENTRADA
// INTEIRA (`classe.metodo`), nunca por segmento — remover `OutroService.update`
// NÃO acende endpoints que passam por `ContractService.update`.
//
// Puro; sem I/O; sem dependência externa. Fonte única de conhecimento de
// linguagem: `changed-symbols.ts` (D8 — nenhuma regex de declaração re-criada).
// ─────────────────────────────────────────────

import {
  type DiffFile,
  type Decl,
  declarationsFromDiffFile,
} from "./changed-symbols";

// ── shapes de consumidor (estruturalmente compatíveis com o impact-analyzer;
//    declarados aqui pra evitar import circular) ──

export interface ConsumerEndpoint {
  path: string;
  method: string;
  controller: string;
  controllerMethod: string;
  entitiesTouched: string[];
}

export interface ConsumerScreen {
  name: string;
  route: string | null;
  viaEndpoints: string[];
}

// ── classificação (só do diff, sem grafo) ──

export type BreakingChangeKind = "removed" | "signature-changed";

export interface BreakingCandidate {
  file: string;
  /** símbolo QUALIFICADO quando possível: `Classe.metodo` / `Classe.campo` / `Classe` */
  symbol: string;
  /** só o nome declarado (sem a classe) */
  bare: string;
  kind: Decl["kind"];
  change: BreakingChangeKind;
  /** runtime do arquivo (ADR-0018 pronto-pra-cliente): java|js — o cruzamento
   *  de JS exige cadeias Node no manifesto; sem elas vira inconclusive. */
  runtime: "java" | "js";
  /** evidência: a linha de declaração normalizada (antes/depois quando houver) */
  before?: string;
  after?: string;
}

export interface RefactorInfo {
  file: string;
  kind: Decl["kind"];
  from: string;
  to: string;
}

export interface InconclusiveInfo {
  file: string;
  symbol: string;
  reason: string;
}

export interface BreakingClassification {
  candidates: BreakingCandidate[];
  refactors: RefactorInfo[];
  inconclusive: InconclusiveInfo[];
  /** arquivos de frontend com declaração removida — fora da classificação (ponto-cego declarado) */
  frontendFilesSkipped: number;
}

const BACKEND_FILE = /\.(java|kt)$/i;
const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const VUE_FILE = /\.vue$/i;

function classBaseName(path: string): string {
  const base = (path || "").split("/").pop() || path;
  return base.replace(/\.(java|kt|ts|tsx|js|jsx|vue|mjs|cjs)$/i, "");
}

/** normaliza uma linha de declaração p/ comparação de assinatura. */
function normalizeDecl(line: string): string {
  return (line || "").trim().replace(/\s+/g, " ").replace(/\s*[{;]\s*$/, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** a declaração com o PRÓPRIO nome mascarado — iguais ⇒ rename puro. */
function declMaskedName(line: string, name: string): string {
  return normalizeDecl(line).replace(new RegExp(`\\b${escapeRe(name)}\\b`), "§");
}

function qualify(cls: string, d: Decl): string {
  return d.kind === "class" ? d.name : `${cls}.${d.name}`;
}

/**
 * Classifica as quebras estruturais de um diff parseado. Determinístico.
 * Só arquivos de BACKEND (.java/.kt) entram — ver ponto-cego declarado no topo.
 */
export function classifyBreakingChanges(files: DiffFile[]): BreakingClassification {
  const out: BreakingClassification = {
    candidates: [],
    refactors: [],
    inconclusive: [],
    frontendFilesSkipped: 0,
  };

  for (const file of files) {
    const isJava = BACKEND_FILE.test(file.path);
    const isJs = !isJava && JS_FILE.test(file.path);
    if (!isJava && !isJs) {
      // componente .vue com declaração removida = fora da classificação
      // (grafo componente→página não modelado) — contado, ponto-cego declarado
      if (VUE_FILE.test(file.path) && file.status !== "added") {
        const { removed } = declarationsFromDiffFile(file);
        if (removed.length > 0) out.frontendFilesSkipped++;
      }
      continue;
    }
    const runtime: "java" | "js" = isJava ? "java" : "js";
    if (file.status === "added") continue; // arquivo novo nunca quebra

    const cls = classBaseName(file.path);

    if (file.status === "removed") {
      // arquivo inteiro deletado → UM candidato class-level (os métodos caem
      // todos sob o mesmo alcance `Classe.*` — N candidatos redundantes seriam
      // ruído no relatório).
      out.candidates.push({
        file: file.path,
        symbol: cls,
        bare: cls,
        kind: "class",
        change: "removed",
        runtime,
        before: `(arquivo removido: ${file.path})`,
      });
      continue;
    }

    const { added, removed } = declarationsFromDiffFile(file);
    if (!removed.length) continue;

    // `export function x` casa 2 regexes de declaração (method + const) —
    // dedupe por símbolo: o primeiro kind (method, mais específico) vence.
    const emitted = new Set<string>();

    const addedByKey = new Map<string, Decl>();
    for (const a of added) addedByKey.set(`${a.kind}:${a.name}`, a);
    const removedNames = new Set(removed.map((r) => r.name));
    const addedText = file.hunks.map((h) => h.addedLines.join("\n")).join("\n");

    for (const R of removed) {
      const again = addedByKey.get(`${R.kind}:${R.name}`);
      if (again) {
        // redeclarado com o mesmo nome: assinatura mudou ou é cosmético/movido
        const b = normalizeDecl(R.line);
        const a = normalizeDecl(again.line);
        if (b === a) continue; // whitespace/movido dentro do arquivo — não é quebra
        if (!emitted.has(`sig:${qualify(cls, R)}`)) {
          emitted.add(`sig:${qualify(cls, R)}`);
          out.candidates.push({
            file: file.path,
            symbol: qualify(cls, R),
            bare: R.name,
            kind: R.kind,
            change: "signature-changed",
            runtime,
            before: b,
            after: a,
          });
        }
        continue;
      }

      // rename puro? declaração ADICIONADA de mesmo kind, nome NOVO, e a linha
      // igual módulo-nome (RefDiff-style, minimal e determinístico)
      const rename = added.find(
        (A) =>
          A.kind === R.kind &&
          !removedNames.has(A.name) &&
          declMaskedName(A.line, A.name) === declMaskedName(R.line, R.name),
      );
      if (rename) {
        out.refactors.push({ file: file.path, kind: R.kind, from: R.name, to: rename.name });
        continue;
      }

      // nome ainda aparece nas linhas `+` (referência/uso) → a declaração pode
      // existir fora do hunk (overload, etc.) — CONSERVADOR: não alarma.
      if (new RegExp(`\\b${escapeRe(R.name)}\\b`).test(addedText)) {
        out.inconclusive.push({
          file: file.path,
          symbol: qualify(cls, R),
          reason: "nome ainda referenciado nas linhas adicionadas — declaração pode existir fora do hunk",
        });
        continue;
      }

      if (!emitted.has(`rm:${qualify(cls, R)}`)) {
        emitted.add(`rm:${qualify(cls, R)}`);
        out.candidates.push({
          file: file.path,
          symbol: qualify(cls, R),
          bare: R.name,
          kind: R.kind,
          change: "removed",
          runtime,
          before: normalizeDecl(R.line),
        });
      }
    }
  }

  return out;
}

// ── cruzamento com o grafo (breaking × reachable) ──

export interface BreakingFinding extends BreakingCandidate {
  /** true ⇔ existe consumidor conhecido no grafo (dependente ou tela) */
  reachable: boolean;
  /** como o símbolo casou no grafo (evidência) */
  via: string;
  /** a superfície QUEBRADA em si (ex.: o endpoint do controller removido) */
  surfaceEndpoints: ConsumerEndpoint[];
  /** quem DEPENDE da quebra (endpoints cuja cadeia passa pelo símbolo + telas) */
  consumers: { endpoints: ConsumerEndpoint[]; screens: ConsumerScreen[] };
}

export interface BreakingReport {
  /** breaking AND reachable — o que merece atenção (o "7,9%" de Ochoa) */
  alerts: BreakingFinding[];
  /** breaking sem consumidor no grafo conhecido — suprimida do alerta, CONTADA */
  suppressedDead: BreakingFinding[];
  refactors: RefactorInfo[];
  inconclusive: InconclusiveInfo[];
  /** limites honestos desta análise (D7) — sempre presentes no relatório */
  blindSpots: string[];
  summary: {
    candidates: number;
    alerts: number;
    suppressedDead: number;
    refactors: number;
    inconclusive: number;
  };
}

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

function toConsumerEndpoint(ep: any): ConsumerEndpoint {
  return {
    path: String(ep?.path ?? ""),
    method: String(ep?.method ?? "ANY").toUpperCase(),
    controller: String(ep?.controller ?? ""),
    controllerMethod: String(ep?.controllerMethod ?? ""),
    entitiesTouched: Array.isArray(ep?.entitiesTouched) ? ep.entitiesTouched : [],
  };
}

/** telas que consomem algum dos endpoints dados (mesma semântica do computeImpact). */
function screensConsuming(manifest: any, endpoints: ConsumerEndpoint[]): ConsumerScreen[] {
  const screens: any[] = Array.isArray(manifest?.screens) ? manifest.screens : [];
  const keys = endpoints.map((e) => ({ method: e.method, path: e.path }));
  const out: ConsumerScreen[] = [];
  for (const sc of screens) {
    const via: string[] = [];
    for (const it of sc?.interactions || []) {
      const itPath = String(it?.endpoint ?? "");
      if (!itPath) continue;
      const itMethod = String(it?.httpMethod ?? "ANY").toUpperCase();
      for (const k of keys) {
        const same =
          (k.method === itMethod && k.path === itPath) ||
          k.path.endsWith(itPath) ||
          itPath.endsWith(k.path);
        if (same) {
          via.push(`${itMethod} ${itPath}`);
          break;
        }
      }
    }
    if (via.length) {
      out.push({ name: String(sc?.name ?? ""), route: sc?.route ?? null, viaEndpoints: Array.from(new Set(via)) });
    }
  }
  return out;
}

const BLIND_SPOT_EXTERNAL =
  "consumidores FORA do grafo (integrações, API pública, jobs externos) não são visíveis — 'morta' = sem consumidor no grafo conhecido";
const BLIND_SPOT_BEHAVIORAL =
  "mudança COMPORTAMENTAL com assinatura preservada é invisível ao diff estrutural — cobertura é por runtime/navegador (Onda 3), não por este detector";
const BLIND_SPOT_OVERLOAD =
  "declaração fora do hunk/overload pode mascarar remoção — classificação conservadora (na dúvida vira 'inconclusive', nunca alerta)";
const BLIND_SPOT_FRONTEND =
  "componentes .vue não entram na classificação de quebra (grafo componente→página não modelado) — o blast radius da Onda 1 os cobre";

const BLIND_SPOT_NODE_UNMODELED =
  "arquivos JS/TS com remoção detectada, mas o runtime Node NÃO está modelado no manifesto — cruzamento impossível (viraram 'inconclusive'); habilite MANIFEST_MULTISTACK_NODE e reanalise";

/**
 * Cruza os candidatos de quebra com o grafo do manifesto. A travessia reversa é
 * a MATERIALIZADA pelo próprio manifesto: `fullCallChain` por endpoint é o fecho
 * transitivo endpoint→…→símbolo já computado na análise (analyzeEndpoints), e
 * `screens[].interactions` é a aresta tela→endpoint — membership = alcance.
 */
export function crossBreakingWithGraph(
  manifest: any,
  cls: BreakingClassification,
): BreakingReport {
  const endpoints: any[] =
    Array.isArray(manifest?.impactEndpoints) && manifest.impactEndpoints.length
      ? manifest.impactEndpoints
      : Array.isArray(manifest?.endpoints)
        ? manifest.endpoints
        : [];

  // entidades conhecidas (nome → campos) — pro cruzamento em nível de campo
  const entityFields = new Map<string, Set<string>>();
  for (const e of manifest?.entities || []) {
    const name = lc(e?.name);
    if (!name) continue;
    const fields = new Set<string>();
    for (const f of e?.fieldMetadata || []) if (f?.name) fields.add(lc(f.name));
    entityFields.set(name, fields);
  }
  for (const e of manifest?.allEntitiesFromGraph || []) {
    const name = lc(e?.name);
    if (!name) continue;
    const prev = entityFields.get(name) || new Set<string>();
    for (const f of e?.fields || []) if (f?.name) prev.add(lc(f.name));
    entityFields.set(name, prev);
  }

  const alerts: BreakingFinding[] = [];
  const suppressedDead: BreakingFinding[] = [];
  const extraInconclusive: InconclusiveInfo[] = [];
  // o manifesto modela o runtime Node? (entradas do espelho com runtime:'node')
  const hasNodeModel = endpoints.some((ep) => ep?.runtime === "node");

  for (const cand of cls.candidates) {
    if (cand.runtime === "js" && !hasNodeModel) {
      // Sem cadeias Node no manifesto NÃO dá pra saber se há consumidor —
      // não é "morta", é "não-modelado": inconclusive com a razão (D7).
      extraInconclusive.push({
        file: cand.file,
        symbol: cand.symbol,
        reason: "runtime Node/JS não modelado no manifesto deste projeto — habilite MANIFEST_MULTISTACK_NODE e reanalise",
      });
      continue;
    }
    const clsName = cand.kind === "class" ? cand.bare : cand.symbol.split(".")[0];
    const lcCls = lc(clsName);
    const lcSym = lc(cand.symbol);

    let matched: any[] = [];
    let via = "";

    if (cand.kind === "method") {
      // igualdade da ENTRADA INTEIRA `classe.metodo` — nunca por segmento
      matched = endpoints.filter(
        (ep) =>
          (ep?.fullCallChain || []).some((c: unknown) => lc(c) === lcSym) ||
          (lc(ep?.controller) === lcCls && lc(ep?.controllerMethod) === lc(cand.bare)) ||
          (ep?.serviceMethods || []).some((m: unknown) => lc(m) === lcSym) ||
          (ep?.repositoryMethods || []).some((m: unknown) => lc(m) === lcSym),
      );
      via = "callChain";
    } else if (cand.kind === "field") {
      if (entityFields.has(lcCls)) {
        matched = endpoints.filter((ep) =>
          (ep?.entitiesTouched || []).some((e: unknown) => lc(e) === lcCls),
        );
        via = entityFields.get(lcCls)!.has(lc(cand.bare))
          ? `entity-field:${clsName}.${cand.bare}`
          : `entity:${clsName} (campo não catalogado no manifesto — cruzamento em nível de entidade)`;
      } else {
        // campo de classe não-entidade: não há consumidor mapeável em nível de
        // campo — vira "morta" com a razão explícita (contada, nunca alarmada)
        matched = [];
        via = "campo interno (classe não é entidade no manifesto)";
      }
    } else {
      // class / const / component — alcance por classe
      matched = endpoints.filter(
        (ep) =>
          lc(ep?.controller) === lcCls ||
          (ep?.fullCallChain || []).some((c: unknown) => lc(c).startsWith(lcCls + ".")) ||
          (ep?.entitiesTouched || []).some((e: unknown) => lc(e) === lcCls),
      );
      via = "class";
    }

    // superfície × dependente: o endpoint cujo CONTROLLER é a própria classe
    // quebrada é a SUPERFÍCIE (o endpoint quebrado), não um consumidor. Os
    // consumidores dele são as TELAS que o chamam. Endpoint de OUTRO controller
    // cuja cadeia passa pelo símbolo é DEPENDENTE (consumidor de verdade).
    const surface: ConsumerEndpoint[] = [];
    const dependents: ConsumerEndpoint[] = [];
    for (const ep of matched) {
      const c = toConsumerEndpoint(ep);
      if (lc(c.controller) === lcCls) surface.push(c);
      else dependents.push(c);
    }
    const screens = screensConsuming(manifest, [...dependents, ...surface]);

    const finding: BreakingFinding = {
      ...cand,
      reachable: dependents.length > 0 || screens.length > 0,
      via,
      surfaceEndpoints: surface,
      consumers: { endpoints: dependents, screens },
    };
    (finding.reachable ? alerts : suppressedDead).push(finding);
  }

  const blindSpots = [BLIND_SPOT_EXTERNAL, BLIND_SPOT_BEHAVIORAL, BLIND_SPOT_OVERLOAD];
  if (cls.frontendFilesSkipped > 0) blindSpots.push(BLIND_SPOT_FRONTEND);
  if (!hasNodeModel && cls.candidates.some((c) => c.runtime === "js")) {
    blindSpots.push(BLIND_SPOT_NODE_UNMODELED);
  }

  const inconclusive = [...cls.inconclusive, ...extraInconclusive];
  return {
    alerts,
    suppressedDead,
    refactors: cls.refactors,
    inconclusive,
    blindSpots,
    summary: {
      candidates: cls.candidates.length,
      alerts: alerts.length,
      suppressedDead: suppressedDead.length,
      refactors: cls.refactors.length,
      inconclusive: inconclusive.length,
    },
  };
}

/** conveniência: diff parseado → relatório completo de quebra × alcance. */
export function breakingReportForDiff(manifest: any, files: DiffFile[]): BreakingReport {
  return crossBreakingWithGraph(manifest, classifyBreakingChanges(files));
}

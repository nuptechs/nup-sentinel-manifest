// ─────────────────────────────────────────────────────────────────────────
// OBS-E05 (ADR-0036 WS-E) — DEAD-CODE para JAVA: órfão por CALL-GRAPH do engine.
//
// Equivalente Java do dead-code JS/TS (knip/ts-prune, OBS-E04): um MÉTODO Java é
// candidato a morto quando o call-graph REAL do `java-analyzer-engine` (JavaParser
// + symbol-solver, compiler-accurate) não mostra NENHUM chamador (sem aresta
// `CALLS` de entrada) E o método não é alcançado de fora do grafo de código.
//
// HONESTIDADE (§2.2/§2.4 — ausência ≠ morto):
//   • CEGO sem call-graph: se o grafo não tem NENHUMA aresta `CALLS`, o engine não
//     rodou / não produziu call-chain → `callGraphPresent:false`, ZERO candidatos
//     (acusar tudo seria o falso-positivo). Igual à guarda do orphan-surface.
//   • EXCLUI o que é alcançado de fora: `CONTROLLER` (entrada HTTP roteada pelo
//     framework), `entryPoint` (@Scheduled/@EventListener/runner/main), `external`
//     /`synthetic` (não é código do alvo), observado em runtime, e método atingido
//     por `EXTENDS`/`IMPLEMENTS`/`RUNTIME_OBSERVED` (polimorfismo/DI/tráfego).
//   • Confiança < 1 SEMPRE — o estático Java erra por reflexão/DI/serialização.
//     Vira "morto confirmado" só na convergência tri-eixo (OBS-E06), via o
//     adaptador `suspectsFromJavaOrphans`.
//
// DEPENDÊNCIA HONESTA (JDK/CI): este módulo é TypeScript PURO e opera sobre a
// `ApplicationGraph` JÁ montada pelo engine (`backend-java-client.reconstructGraph`).
// NÃO recompila Java — o call-graph é insumo. A validação viva ponta-a-ponta
// (engine Java → este órfão) depende do JAR compilado no CI (não há JDK local);
// o teste de fixture prova a LÓGICA sobre um grafo representativo do engine.
// PURO; nunca lança. §2.3: IA não entra.
// ─────────────────────────────────────────────────────────────────────────

import type { ApplicationGraph, GraphNode } from "./application-graph";

export type JavaOrphanTier = "java-orphan";

export interface JavaOrphanCandidate {
  nodeId: string;
  className: string;
  methodName: string;
  qualifiedSignature?: string;
  sourceFile?: string;
  tier: JavaOrphanTier;
  /** 0..1, nunca 1 — ponto-cego de reflexão/DI/serialização. */
  confidence: number;
  reasons: string[];
}

export interface JavaOrphanExclusions {
  /** alcançado de fora: CONTROLLER (entrada HTTP). */
  entrySurface: number;
  /** gatilho de fundo (@Scheduled/@EventListener/runner/main). */
  entryPoint: number;
  /** nó externo/sintético (não é código do alvo). */
  externalOrSynthetic: number;
  /** tem chamador CALLS provado. */
  hasCaller: number;
  /** atingido por EXTENDS/IMPLEMENTS/RUNTIME_OBSERVED (polimorfismo/DI/tráfego). */
  polymorphicOrObserved: number;
}

export interface JavaOrphanReport {
  /** false = grafo sem NENHUMA aresta CALLS → detector CEGO (honesto). */
  callGraphPresent: boolean;
  candidates: JavaOrphanCandidate[];
  excluded: JavaOrphanExclusions;
  methodsTotal: number;
  summary: string;
}

/** Confiança média: o estático Java é bom (symbol-solver), mas DI/reflexão existe. */
const JAVA_ORPHAN_CONFIDENCE = 0.55;

function meta(n: GraphNode): Record<string, unknown> {
  return (n.metadata || {}) as Record<string, unknown>;
}
function isExternalOrSynthetic(n: GraphNode): boolean {
  const m = meta(n);
  return m.external === true || m.synthetic === true;
}
function isEntryPoint(n: GraphNode): boolean {
  const m = meta(n);
  if (typeof m.entryPoint === "string" && m.entryPoint.trim().length > 0) return true;
  // main(String[]) é ponto de entrada por definição.
  if (n.methodName === "main") return true;
  return false;
}
function isObserved(n: GraphNode): boolean {
  const m = meta(n);
  return m.observed === true || m.runtimeHot === true;
}

/**
 * Encontra métodos Java órfãos no call-graph do engine. PURO, determinístico.
 * `opts.observedNodeIds` (opcional) injeta nós tocados por runtime (overlay) —
 * reforça a exclusão por tráfego além do metadata do nó.
 */
export function findJavaOrphans(
  graph: ApplicationGraph | null | undefined,
  opts: { observedNodeIds?: Set<string> } = {},
): JavaOrphanReport {
  const excluded: JavaOrphanExclusions = { entrySurface: 0, entryPoint: 0, externalOrSynthetic: 0, hasCaller: 0, polymorphicOrObserved: 0 };
  const candidates: JavaOrphanCandidate[] = [];

  const nodes = graph ? graph.getAllNodes() : [];
  const edges = graph ? graph.getAllEdges() : [];
  const observed = opts.observedNodeIds ?? new Set<string>();

  // CEGO sem call-graph: nenhuma aresta CALLS ⇒ o engine não produziu call-chain.
  const callGraphPresent = edges.some((e) => e.relationType === "CALLS");

  // métodos = nós com methodName (CONTROLLER/SERVICE/REPOSITORY com método).
  const methodNodes = nodes.filter((n) => typeof n.methodName === "string" && n.methodName.length > 0);
  const methodsTotal = methodNodes.length;

  if (!callGraphPresent) {
    return {
      callGraphPresent: false,
      candidates: [],
      excluded,
      methodsTotal,
      summary: `Detector cego: o grafo Java não tem arestas CALLS (o java-analyzer-engine não produziu call-chain para este projeto — JAR ausente/engine não rodou). ${methodsTotal} método(s) não avaliados — honesto, nenhum acusado.`,
    };
  }

  for (const n of methodNodes) {
    // entrada HTTP: CONTROLLER é alcançado de fora do grafo de código.
    if (n.type === "CONTROLLER") { excluded.entrySurface++; continue; }
    if (isExternalOrSynthetic(n)) { excluded.externalOrSynthetic++; continue; }
    if (isEntryPoint(n)) { excluded.entryPoint++; continue; }
    if (isObserved(n) || observed.has(n.id)) { excluded.polymorphicOrObserved++; continue; }

    const incoming = graph!.getIncomingEdges(n.id);
    const hasCaller = incoming.some((e) => e.relationType === "CALLS");
    if (hasCaller) { excluded.hasCaller++; continue; }

    // polimorfismo/DI/tráfego: atingido por herança/impl/observação → pode ser
    // chamado por tipo-base ou injeção. Honesto: não acusa.
    const polymorphic = incoming.some((e) => e.relationType === "EXTENDS" || e.relationType === "IMPLEMENTS" || e.relationType === "RUNTIME_OBSERVED");
    if (polymorphic) { excluded.polymorphicOrObserved++; continue; }

    candidates.push({
      nodeId: n.id,
      className: n.className,
      methodName: n.methodName!,
      ...(n.qualifiedSignature ? { qualifiedSignature: n.qualifiedSignature } : {}),
      ...(typeof meta(n).sourceFile === "string" ? { sourceFile: meta(n).sourceFile as string } : {}),
      tier: "java-orphan",
      confidence: JAVA_ORPHAN_CONFIDENCE,
      reasons: [
        "método sem nenhum chamador CALLS no call-graph do engine (symbol-solver)",
        "não é entrada HTTP (CONTROLLER), gatilho (@Scheduled/@EventListener/runner/main) nem main",
        "não é alcançado por herança/implementação, injeção observada ou tráfego de runtime",
      ],
    });
  }

  candidates.sort((a, b) =>
    b.confidence - a.confidence ||
    a.className.localeCompare(b.className) ||
    a.methodName.localeCompare(b.methodName) ||
    a.nodeId.localeCompare(b.nodeId),
  );

  const summary = candidates.length === 0
    ? `Nenhum método Java órfão: os ${methodsTotal} método(s) têm chamador, são entrada/gatilho, ou entram por herança/DI/runtime.`
    : `${candidates.length} método(s) Java candidato(s) a morto de ${methodsTotal} — sem chamador no call-graph, sem entrada/gatilho, sem herança/DI/runtime (excluídos: ${excluded.hasCaller} com chamador, ${excluded.entrySurface} entrada HTTP, ${excluded.entryPoint} gatilho, ${excluded.externalOrSynthetic} externos, ${excluded.polymorphicOrObserved} polimórficos/observados). Confiança < 1 — reflexão/DI permanecem como ponto-cego.`;

  return { callGraphPresent: true, candidates, excluded, methodsTotal, summary };
}

// ── Adaptador: órfãos Java → StaticSuspect do tri-eixo (OBS-E06) ──
// Mantém a forma mínima (sem import de tipo p/ não acoplar) — compatível com
// `StaticSuspect` de triple-orphan.ts.
export interface JavaOrphanStaticSuspect {
  nodeId: string;
  type: string;
  label: string;
  sourceFile?: string;
  staticConfidence: number;
  staticReasons: string[];
  staticSource: string;
}

/** Converte os candidatos órfãos Java em suspeitos do eixo estático do tri-eixo. */
export function suspectsFromJavaOrphans(report: JavaOrphanReport | null | undefined): JavaOrphanStaticSuspect[] {
  if (!report || !report.callGraphPresent || !Array.isArray(report.candidates)) return [];
  return report.candidates.map((c) => ({
    nodeId: c.nodeId,
    type: "METHOD",
    label: `${c.className}.${c.methodName}`,
    ...(c.sourceFile ? { sourceFile: c.sourceFile } : {}),
    staticConfidence: c.confidence,
    staticReasons: c.reasons,
    staticSource: "java-orphan",
  }));
}

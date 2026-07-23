/**
 * Seam ADITIVA do ConventionProfile no grafo — ADR-0020 r2 Onda 1.
 *
 * Espelha o precedente `augmentGraphWithWsV1` (analysis-pipeline.ts:345): nós
 * CONTROLLER sintéticos, id determinístico, NUNCA remove nem sobrescreve nada
 * — perfil vazio/OFF ⇒ grafo byte-a-byte. Somente regras ADMITIDAS PELO GATE
 * (verifyConventionProfile) chegam aqui; a regra rejeitada nunca toca o grafo.
 *
 * Split PURO: `computeProfileEndpoints` (dados → endpoints, testável e usada
 * pelo modo SHADOW pra logar o que SERIA adicionado) + `augmentGraphWithProfile`
 * (mutação, usada só no modo ON).
 */
import { ApplicationGraph, GraphNode } from "./application-graph";
import {
  PatternMatcher,
  ProfileFile,
  RegexAnchoredMatcher,
  VerifiedRule,
} from "./convention-profile";

export interface ProfileEndpoint {
  fullPath: string;
  httpMethod: string;
  ruleId: string;
  sourceFile: string;
  lineNumber: number;
  className: string;
}

const MAX_ENDPOINTS_PER_RULE = 2_000;

/** `$1`..`$9` do template substituídos pelos grupos do match. */
export function renderPathTemplate(template: string, groups: string[]): string | null {
  let missing = false;
  const rendered = template.replace(/\$([1-9])/g, (_s, d: string) => {
    const v = groups[Number(d) - 1];
    if (v == null || v === "") {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : rendered;
}

export function computeProfileEndpoints(
  files: ProfileFile[],
  admitted: VerifiedRule[],
  matcher: PatternMatcher = new RegexAnchoredMatcher(),
): ProfileEndpoint[] {
  const out: ProfileEndpoint[] = [];
  const seen = new Set<string>();

  for (const { rule } of admitted) {
    if (rule.kind !== "endpoint" || !rule.endpoint) continue;
    const method = rule.endpoint.httpMethod ?? "POST";
    let perRule = 0;

    for (const m of matcher.match(rule, files)) {
      const path = renderPathTemplate(rule.endpoint.pathTemplate, m.groups);
      if (!path) continue; // grupo ausente ⇒ endpoint indeterminado — pula, nunca inventa
      if (!path.startsWith("/")) continue; // template grupo-puro com captura não-rota — nunca inventa
      const key = `${method}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        fullPath: path,
        httpMethod: method,
        ruleId: rule.id,
        sourceFile: m.file,
        lineNumber: m.line,
        className: classNameFrom(m.file),
      });
      if (++perRule >= MAX_ENDPOINTS_PER_RULE) break;
    }
  }
  return out;
}

function classNameFrom(filePath: string): string {
  const base = filePath.split("/").pop() || filePath;
  return base.replace(/\.[a-z0-9]+$/i, "");
}

/**
 * Injeta os endpoints do perfil como nós CONTROLLER sintéticos. Aditivo e
 * idempotente: nó já existente (por id OU por rota equivalente de outra
 * fonte, ex. WsV1 hardcoded) nunca é duplicado nem sobrescrito.
 */
export function augmentGraphWithProfile(
  graph: ApplicationGraph,
  endpoints: ProfileEndpoint[],
): number {
  // Rotas já cobertas por outra fonte (ex. wsv1:) não ganham nó paralelo —
  // o perfil AUMENTA a cobertura, não compete com o que já existe.
  const existingRoutes = new Set<string>();
  for (const node of graph.getNodesByType("CONTROLLER")) {
    const meta = (node.metadata ?? {}) as { fullPath?: string; httpMethod?: string };
    if (meta.fullPath) existingRoutes.add(`${meta.httpMethod ?? ""}:${meta.fullPath}`);
  }

  let added = 0;
  for (const ep of endpoints) {
    const id = `profile:${ep.httpMethod}:${ep.fullPath}`;
    if (graph.getNode(id)) continue;
    if (existingRoutes.has(`${ep.httpMethod}:${ep.fullPath}`)) continue;
    graph.addNode(
      new GraphNode(id, "CONTROLLER", ep.className, "execute", null, {
        httpMethod: ep.httpMethod,
        fullPath: ep.fullPath,
        sourceFile: ep.sourceFile,
        lineNumber: ep.lineNumber,
        synthetic: true,
        convention: "profile",
        profileRuleId: ep.ruleId,
      }),
    );
    added++;
  }
  return added;
}

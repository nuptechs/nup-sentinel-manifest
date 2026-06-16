/**
 * Detecção de SOBREPOSIÇÃO FUNCIONAL (ADR-070 Onda 4 — crítica "outra parte já
 * faz X de forma diferente").
 *
 * Determinístico sobre o grafo de endpoints (impactEndpoints do snapshot): acha
 * grupos de endpoints que fazem **a mesma coisa** com a **mesma entidade** por
 * caminhos diferentes — p.ex. `createContract` + `importContract` +
 * `bulkCreateContract` (3 formas de criar Contract). É o sinal que nenhum LLM
 * sozinho enxerga (precisa do mapa de todos os endpoints × entidades).
 *
 * Precisão > recall: agrupa por (classe-de-operação, entidade, cardinalidade)
 * com a classe NARROW (CREATE/UPDATE/DELETE), então NÃO flagga o CRUD normal
 * (create+update+delete são classes distintas) nem transições de estado
 * (approve/reject/cancel ficam em OTHER, não viram falso "duplicado"). Advisory:
 * candidato para revisão humana, não veredito. Puro; sem I/O.
 */

// READ cobre leitura de registro E de coleção — a cardinalidade (single|
// collection) faz o split, então não há classe LIST separada (seria redundante
// e divergiria `find` de `search` para a mesma coleção).
export type OpClass = "CREATE" | "UPDATE" | "DELETE" | "READ" | "OTHER";

export interface OverlapEndpoint {
  path: string;
  operation: string; // ex.: "createContract"
  controller: string;
}

export interface OverlapGroup {
  entity: string;
  opClass: OpClass;
  cardinality: "single" | "collection";
  severity: "review" | "info";
  endpoints: OverlapEndpoint[];
  reason: string;
}

export interface OverlapReport {
  groups: number;
  reviewGroups: number; // grupos de escrita (mais suspeitos)
  overlaps: OverlapGroup[];
}

// Verbos por classe. NARROW de propósito: aprovações/transições de estado
// (approve/reject/cancel/finalize/...) caem em OTHER e não viram "duplicado".
const VERB_CLASS: Array<[OpClass, RegExp]> = [
  ["CREATE", /^(create|add|new|register|insert|import|bulkcreate|bulk|generate|provision|duplicate|clone|copy)/],
  ["UPDATE", /^(update|edit|patch|modify|change|rename)/],
  ["DELETE", /^(delete|remove|destroy|archive|purge)/],
  ["READ", /^(find|get|fetch|load|read|view|show|resolve|count|export|download|list|search|browse|query)/],
];

function classifyVerb(op: string): OpClass {
  const lc = op.toLowerCase();
  for (const [cls, re] of VERB_CLASS) {
    if (re.test(lc)) return cls;
  }
  return "OTHER";
}

const LEADING_VERB = /^(bulkcreate|bulk|create|add|new|register|insert|import|generate|provision|duplicate|clone|copy|update|edit|patch|modify|change|rename|delete|remove|destroy|archive|purge|list|search|browse|query|find|get|fetch|load|read|view|show|resolve|count|export|download)/i;

/** Deriva a entidade-alvo e a cardinalidade do nome da operação (verbo + nome). */
function parseEntityFromOp(op: string): { entity: string; cardinality: "single" | "collection" } | null {
  const m = op.match(LEADING_VERB);
  if (!m) return null;
  let rest = op.slice(m[0].length);
  if (!rest) return null;
  // remove sufixos de versão / ruído
  rest = rest.replace(/V\d+$/i, "").replace(/^[A-Z]/, (c) => c); // mantém PascalCase
  if (rest.length < 3) return null;
  const lc = rest.toLowerCase();
  // cardinalidade por plural simples
  let cardinality: "single" | "collection" = "single";
  let singular = lc;
  if (/(ies)$/.test(lc)) { singular = lc.replace(/ies$/, "y"); cardinality = "collection"; }
  else if (/(ses|xes|zes|ches|shes)$/.test(lc)) { singular = lc.replace(/es$/, ""); cardinality = "collection"; }
  else if (/s$/.test(lc) && !/ss$/.test(lc)) { singular = lc.replace(/s$/, ""); cardinality = "collection"; }
  return { entity: singular, cardinality };
}

/** Extrai a operação de um path `/easynup/<op>.v<N>` (ou null se não casar). */
function operationOf(path: string): string | null {
  if (typeof path !== "string") return null;
  const m = path.match(/\/easynup\/([A-Za-z0-9]+)\.v\d+$/);
  return m ? m[1] : null;
}

/**
 * Computa sobreposições funcionais a partir do manifest persistido. Lê
 * `manifest.impactEndpoints` (espelho rico). Puro.
 */
export function detectFunctionalOverlap(manifest: any): OverlapReport {
  const endpoints: any[] = Array.isArray(manifest?.impactEndpoints) ? manifest.impactEndpoints : [];

  // chave: `${opClass}:${entity}:${cardinality}` → endpoints
  const groups = new Map<string, { entity: string; opClass: OpClass; cardinality: "single" | "collection"; eps: Map<string, OverlapEndpoint> }>();

  for (const ep of endpoints) {
    const op = operationOf(String(ep?.path ?? ""));
    if (!op) continue;
    const opClass = classifyVerb(op);
    if (opClass === "OTHER") continue; // transições de estado etc. não são "duplicado"
    const parsed = parseEntityFromOp(op);
    if (!parsed) continue;
    const key = `${opClass}:${parsed.entity}:${parsed.cardinality}`;
    let g = groups.get(key);
    if (!g) {
      g = { entity: parsed.entity, opClass, cardinality: parsed.cardinality, eps: new Map() };
      groups.set(key, g);
    }
    g.eps.set(op, { path: String(ep.path), operation: op, controller: String(ep.controller ?? "") });
  }

  const writeClasses = new Set<OpClass>(["CREATE", "UPDATE", "DELETE"]);
  const overlaps: OverlapGroup[] = [];
  Array.from(groups.values()).forEach((g) => {
    if (g.eps.size < 2) return; // sobreposição = 2+ operações distintas
    const isWrite = writeClasses.has(g.opClass);
    const eps = Array.from(g.eps.values()).sort((a, b) => a.operation.localeCompare(b.operation));
    const card = g.cardinality === "collection" ? "coleção" : "registro";
    overlaps.push({
      entity: g.entity,
      opClass: g.opClass,
      cardinality: g.cardinality,
      severity: isWrite ? "review" : "info",
      endpoints: eps,
      reason: `${eps.length} endpoints fazem ${g.opClass} sobre ${card} de '${g.entity}' por caminhos diferentes: ${eps.map((e) => e.operation).join(", ")}`,
    });
  });

  // escrita primeiro, depois por nº de endpoints
  overlaps.sort((a, b) =>
    Number(b.severity === "review") - Number(a.severity === "review")
    || b.endpoints.length - a.endpoints.length
    || a.entity.localeCompare(b.entity),
  );

  return {
    groups: overlaps.length,
    reviewGroups: overlaps.filter((o) => o.severity === "review").length,
    overlaps,
  };
}

/** Render Markdown do relatório de sobreposição (advisory). */
export function renderOverlapMarkdown(report: OverlapReport, opts: { projectName?: string } = {}): string {
  const L: string[] = [];
  L.push("# Sobreposição funcional (candidatos a duplicação)");
  L.push("");
  if (opts.projectName) L.push(`**Sistema:** ${opts.projectName}  `);
  L.push(`**Grupos encontrados:** ${report.groups} (${report.reviewGroups} de escrita — maior suspeita)`);
  L.push("");
  if (!report.groups) {
    L.push("> Nenhuma sobreposição funcional candidata — cada operação de escrita tem um caminho único por entidade.");
    L.push("");
    return L.join("\n");
  }
  L.push("> Advisory: são **candidatos** a duplicação para revisão humana, não veredito. Múltiplos caminhos podem ser intencionais (ex.: import em massa vs criação unitária).");
  L.push("");
  for (const o of report.overlaps) {
    const sev = o.severity === "review" ? "🟠 escrita" : "⚪ leitura";
    L.push(`## ${sev} — ${o.opClass} de \`${o.entity}\` (${o.cardinality === "collection" ? "coleção" : "registro"})`);
    L.push("");
    for (const e of o.endpoints) {
      const ctrl = e.controller ? ` — \`${e.controller}\`` : "";
      L.push(`- \`${e.path}\`${ctrl}`);
    }
    L.push("");
  }
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Reasoner — BUILDERS da suíte UML (puros, sobre o grafo shaped provado).
// Cada builder é bounded (cap de nós/relações) p/ o diagrama ser legível, e
// declara nas notas o que cortou. Confiança POR ELEMENTO. Nunca lança.
// ─────────────────────────────────────────────────────────────────────────

import {
  type Graph,
  type GNode,
  type GEdge,
  type UmlModel,
  type UmlNode,
  type UmlRel,
  type UmlGroup,
  type UmlConfidence,
  clamp,
  shortLabel,
  sourceFileOf,
  edgeConfidence,
  nodeById,
  emptyModel,
} from "./uml-model";

const CAP_NODES = 60;
const CAP_RELS = 90;

function outIndex(edges: GEdge[]): Map<string, GEdge[]> {
  const m = new Map<string, GEdge[]>();
  for (const e of edges || []) {
    if (!e?.fromNode) continue;
    (m.get(e.fromNode) ?? m.set(e.fromNode, []).get(e.fromNode)!).push(e);
  }
  return m;
}
function degree(edges: GEdge[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of edges || []) {
    if (e?.fromNode) d.set(e.fromNode, (d.get(e.fromNode) ?? 0) + 1);
    if (e?.toNode) d.set(e.toNode, (d.get(e.toNode) ?? 0) + 1);
  }
  return d;
}

// ══ 1. CLASSES — entidades + herança + associações ═════════════════════════
export function buildClass(graph: Graph, opts: { focus?: string; cap?: number } = {}): UmlModel {
  // Orçamento BALANCEADO: entidades E colaboradores têm cotas próprias — senão as
  // entidades sozinhas estouram o teto e o diagrama fica sem "quem usa" (bug do cap
  // único: num sistema com >N entidades, o loop de colaboradores nunca rodava).
  const ENT_CAP = Math.min(opts.cap ?? 28, CAP_NODES);
  const COLLAB_CAP = 30;
  const byId = nodeById(graph);
  const edges = graph.edges || [];
  const entities = (graph.nodes || []).filter((n) => n.type === "ENTITY" || n.type === "SUPERTYPE" || n.type === "INTERFACE");
  if (!entities.length) return emptyModel("class", "Diagrama de Classes", "Nenhuma entidade/classe de domínio no grafo.");

  // foco opcional: só a vizinhança de uma classe (senão as mais conectadas)
  const deg = degree(edges);
  let chosen: GNode[];
  const focus = opts.focus ? entities.find((n) => shortLabel(n, n.id).toLowerCase() === opts.focus!.toLowerCase() || n.id.toLowerCase().includes(opts.focus!.toLowerCase())) : null;
  if (focus) {
    const near = new Set<string>([focus.id]);
    for (const e of edges) {
      if (e.fromNode === focus.id) near.add(e.toNode);
      if (e.toNode === focus.id) near.add(e.fromNode);
    }
    chosen = [...near].map((id) => byId.get(id)).filter((n): n is GNode => !!n && (n.type === "ENTITY" || n.type === "SUPERTYPE" || n.type === "INTERFACE"));
  } else {
    chosen = entities.slice().sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).slice(0, ENT_CAP);
  }
  chosen = chosen.slice(0, ENT_CAP);
  const keep = new Set(chosen.map((n) => n.id));
  const nodes: UmlNode[] = chosen.map((n) => ({
    id: n.id,
    label: clamp(shortLabel(n, n.id)),
    kind: "class",
    stereotype: n.type === "INTERFACE" ? "interface" : n.type === "SUPERTYPE" ? "abstract" : "entity",
    confidence: "proven",
  }));
  const nodeSet = new Set(nodes.map((n) => n.id));
  const rels: UmlRel[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (!nodeSet.has(e.fromNode) || !nodeSet.has(e.toNode)) continue;
    if (!keep.has(e.fromNode) || !keep.has(e.toNode)) continue;
    const kind = e.relationType === "EXTENDS" ? "inheritance" : e.relationType === "IMPLEMENTS" ? "realization" : e.relationType === "ASSOCIATES" ? "association" : null;
    if (!kind) continue;
    const k = `${e.fromNode}|${kind}|${e.toNode}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (rels.length >= CAP_RELS) break;
    rels.push({ from: e.fromNode, to: e.toNode, kind, confidence: edgeConfidence(e) });
  }
  // ENRIQUECIMENTO: quem USA cada entidade (serviço/repo que lê/grava). Essencial
  // p/ stacks sem associação estrutural entre entidades (ex.: TS/Drizzle não emite
  // EXTENDS/ASSOCIATES como o Java JPA) — o diagrama de classes fica útil nos dois.
  // Só entra quando cabe no orçamento e sem estourar a legibilidade.
  // arestas de uso (serviço/repo/rota → entidade mostrada), agregadas por fonte.
  const usageEdges = edges.filter(
    (e) => (e.relationType === "READS_ENTITY" || e.relationType === "WRITES_ENTITY") && nodeSet.has(e.toNode) && !nodeSet.has(e.fromNode) && byId.has(e.fromNode),
  );
  const srcFreq = new Map<string, number>();
  for (const e of usageEdges) srcFreq.set(e.fromNode, (srcFreq.get(e.fromNode) ?? 0) + 1);
  // os colaboradores mais relevantes primeiro (mais entidades tocadas)
  const topSrc = new Set([...srcFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, COLLAB_CAP).map(([id]) => id));
  const collaborators = new Map<string, GNode>();
  const collabRels: UmlRel[] = [];
  const seenCollab = new Set<string>();
  for (const e of usageEdges) {
    if (!topSrc.has(e.fromNode)) continue;
    if (rels.length + collabRels.length >= CAP_RELS) break;
    const src = byId.get(e.fromNode)!;
    const k = `${e.fromNode}|${e.toNode}`;
    if (seenCollab.has(k)) continue; // 1 aresta por par (lê OU grava, o 1º visto)
    seenCollab.add(k);
    if (!collaborators.has(e.fromNode)) {
      const st = src.type === "REPOSITORY" ? "repository" : src.type === "CONTROLLER" ? "controller" : src.type === "ROUTE" ? "route" : "service";
      collaborators.set(e.fromNode, { id: e.fromNode, label: clamp(shortLabel(src, e.fromNode)), kind: "class", stereotype: st, confidence: "proven" });
    }
    collabRels.push({ from: e.fromNode, to: e.toNode, kind: "dependency", label: e.relationType === "WRITES_ENTITY" ? "grava" : "lê", confidence: edgeConfidence(e) });
  }
  for (const c of collaborators.values()) nodes.push(c);
  rels.push(...collabRels);

  const notes = [`${entities.length} classes de domínio no total; mostrando ${chosen.length}${focus ? ` (vizinhança de ${shortLabel(focus, focus.id)})` : " (as mais conectadas)"}${collaborators.size ? ` + ${collaborators.size} que as usam (serviço/repo)` : ""}.`];
  return { type: "class", title: focus ? `Classes — ${shortLabel(focus, focus.id)}` : "Diagrama de Classes", nodes, rels, groups: [], notes, stats: { classes: nodes.length, relacoes: rels.length, totalEntidades: entities.length, colaboradores: collaborators.size } };
}

// ══ agrupamento por diretório (pacotes/componentes) ════════════════════════
function pkgKey(sf: string, depth: number): string {
  const parts = String(sf || "").split("/").filter(Boolean);
  parts.pop(); // tira o arquivo
  if (!parts.length) return "(raiz)";
  // EXCLUI diretórios de teste/mock — não são partes do sistema (ruído no diagrama).
  if (parts.some((p) => /^(tests?|__tests__|spec|specs|mocks?|__mocks__|fixtures?)$/i.test(p))) return "";
  // pula prefixos genéricos p/ o grupo ficar significativo (arquitetura, não boilerplate)
  let i = 0;
  const skip = new Set(["src", "main", "java", "com", "org", "app"]);
  while (i < parts.length - 1 && skip.has(parts[i])) i++;
  return parts.slice(i, i + depth).join("/") || parts.slice(0, depth).join("/");
}

// ══ 2. COMPONENTES — grandes blocos + dependências ═════════════════════════
export function buildComponent(graph: Graph): UmlModel {
  return buildGrouped(graph, "component", 2, "Diagrama de Componentes", "os grandes blocos e como dependem uns dos outros");
}
// ══ 3. PACOTES — grupos por diretório + dependências ═══════════════════════
export function buildPackage(graph: Graph): UmlModel {
  return buildGrouped(graph, "package", 3, "Diagrama de Pacotes", "como o código está organizado em grupos");
}

function buildGrouped(graph: Graph, type: "component" | "package", depth: number, title: string, _desc: string): UmlModel {
  const byId = nodeById(graph);
  const groupOf = new Map<string, string>();
  const groupSize = new Map<string, number>();
  for (const n of graph.nodes || []) {
    const sf = sourceFileOf(n);
    if (!sf) continue;
    const g = pkgKey(sf, depth);
    if (!g) continue; // teste/mock excluído
    groupOf.set(n.id, g);
    groupSize.set(g, (groupSize.get(g) ?? 0) + 1);
  }
  if (!groupSize.size) return emptyModel(type, title, "Sem arquivos-fonte no grafo para agrupar.");
  // top grupos por tamanho (legibilidade)
  const top = [...groupSize.entries()].sort((a, b) => b[1] - a[1]).slice(0, type === "component" ? 12 : 20);
  const keepG = new Set(top.map(([g]) => g));
  const nodes: UmlNode[] = top.map(([g, size]) => ({ id: g, label: clamp(g, 34), kind: type, confidence: "proven", stereotype: `${size} arquivos` }));
  // dependências entre grupos: agrega CALLS/IMPORTS/ASSOCIATES cross-group
  const pairConf = new Map<string, UmlConfidence>();
  const pairCount = new Map<string, number>();
  for (const e of graph.edges || []) {
    const gf = groupOf.get(e.fromNode);
    const gt = groupOf.get(e.toNode);
    if (!gf || !gt || gf === gt) continue;
    if (!keepG.has(gf) || !keepG.has(gt)) continue;
    if (!["CALLS", "IMPORTS", "ASSOCIATES", "READS_ENTITY", "WRITES_ENTITY", "RUNTIME_OBSERVED"].includes(String(e.relationType))) continue;
    const k = `${gf}|${gt}`;
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    const c = edgeConfidence(e);
    const prev = pairConf.get(k);
    // mantém a MAIOR confiança observada no par
    if (!prev || (c === "observed") || (c === "proven" && prev === "inferred")) pairConf.set(k, c);
  }
  const rels: UmlRel[] = [...pairCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CAP_RELS)
    .map(([k, count]) => {
      const [from, to] = k.split("|");
      return { from, to, kind: "dependency", confidence: pairConf.get(k) || "proven", label: count > 1 ? `×${count}` : undefined };
    });
  const notes = [`${groupSize.size} grupos no total; mostrando os ${top.length} maiores. Dependência = chamada/import/associação cruzando o grupo.`];
  return { type, title, nodes, rels, groups: [], notes, stats: { grupos: nodes.length, dependencias: rels.length, totalGrupos: groupSize.size } };
}

// ══ 4. IMPLANTAÇÃO — onde cada parte roda ══════════════════════════════════
export function buildDeployment(graph: Graph): UmlModel {
  // unidade de deploy inferida do stack/layer/tipo do nó
  const unitOf = (n: GNode): { id: string; label: string; kind: string } | null => {
    const stack = String(n.stack || "").toLowerCase();
    const t = String(n.type || "").toUpperCase();
    if (t === "ENTITY" || t === "SUPERTYPE") return { id: "db", label: "Banco de Dados (Postgres)", kind: "db" };
    if (t === "VIEW" || t === "COMPONENT" || t === "COMPOSABLE" || /vue|react|vite/.test(stack)) return { id: "frontend", label: "Frontend (navegador)", kind: "node" };
    if (/spring|java/.test(stack)) return { id: "backend", label: "Backend (Java/Spring)", kind: "node" };
    if (/express|node|gateway/.test(stack) || String(n.sourceFile || "").includes("services/gateway")) return { id: "gateway", label: "Gateway (Node)", kind: "node" };
    return null;
  };
  const unit = new Map<string, string>();
  const units = new Map<string, UmlNode>();
  for (const n of graph.nodes || []) {
    const u = unitOf(n);
    if (!u) continue;
    unit.set(n.id, u.id);
    if (!units.has(u.id)) units.set(u.id, { id: u.id, label: u.label, kind: u.kind, confidence: "proven" });
  }
  if (!units.size) return emptyModel("deployment", "Diagrama de Implantação", "Sem sinais de stack/camada nos nós para inferir a topologia.");
  // arestas entre unidades: PREFERE runtime observado; agrega
  const pairConf = new Map<string, UmlConfidence>();
  for (const e of graph.edges || []) {
    const uf = unit.get(e.fromNode);
    const ut = unit.get(e.toNode);
    if (!uf || !ut || uf === ut) continue;
    const k = `${uf}|${ut}`;
    const c = edgeConfidence(e);
    const prev = pairConf.get(k);
    if (!prev || c === "observed" || (c === "proven" && prev === "inferred")) pairConf.set(k, c);
  }
  const rels: UmlRel[] = [...pairConf.entries()].map(([k, c]) => {
    const [from, to] = k.split("|");
    return { from, to, kind: c === "observed" ? "flow" : "dependency", confidence: c, label: to === "db" ? "acessa" : "chama" };
  });
  const anyObserved = rels.some((r) => r.confidence === "observed");
  const notes = [
    "Unidades de deploy inferidas do stack/camada de cada parte (frontend/gateway/backend/banco).",
    anyObserved ? "Setas OBSERVADAS vêm de tráfego real (runtime)." : "Sem tráfego observado: as ligações são a topologia provada estaticamente.",
  ];
  return { type: "deployment", title: "Diagrama de Implantação", nodes: [...units.values()], rels, groups: [], notes, stats: { unidades: units.size, ligacoes: rels.length } };
}

// ══ 5. CASO DE USO — ator + o que dá pra fazer, por domínio ════════════════
function domainOfRoute(n: GNode): string {
  const path = String(n.endpoint || "").replace(/^\/+/, "");
  const seg = path.split("/").filter((s) => s && !s.startsWith(":") && !/^v\d+$/.test(s));
  if (seg.length) return seg[0] === "api" ? seg[1] || "api" : seg[0];
  const sf = sourceFileOf(n).split("/").filter(Boolean);
  return sf.length > 2 ? sf[sf.length - 2] : "geral";
}
export function buildUseCase(graph: Graph, opts: { cap?: number } = {}): UmlModel {
  const cap = opts.cap ?? 40;
  const routes = (graph.nodes || []).filter((n) => n.type === "ROUTE" || n.type === "CONTROLLER");
  if (!routes.length) return emptyModel("usecase", "Diagrama de Caso de Uso", "Nenhuma rota/controller (ponto de entrada) no grafo.");
  // agrupa por domínio; cada domínio vira um grupo com seus casos de uso (rotas)
  const byDomain = new Map<string, GNode[]>();
  for (const r of routes) {
    const d = domainOfRoute(r);
    (byDomain.get(d) ?? byDomain.set(d, []).get(d)!).push(r);
  }
  const topDomains = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  const groups: UmlGroup[] = topDomains.map(([d]) => ({ id: `dom_${d}`, label: clamp(d, 24) }));
  const actor: UmlNode = { id: "__actor__", label: "Usuário", kind: "actor", confidence: "proven" };
  const nodes: UmlNode[] = [actor];
  const rels: UmlRel[] = [];
  let shown = 0;
  for (const [d, rs] of topDomains) {
    const perDomain = rs.slice(0, Math.max(3, Math.floor(cap / topDomains.length)));
    for (const r of perDomain) {
      if (shown >= cap) break;
      const label = r.httpMethod && r.endpoint ? `${r.httpMethod} ${r.endpoint}` : shortLabel(r, r.id);
      const uc: UmlNode = { id: r.id, label: clamp(label, 34), kind: "usecase", group: `dom_${d}`, confidence: (r.observed || r.runtimeHot) ? "observed" : "proven" };
      nodes.push(uc);
      rels.push({ from: actor.id, to: r.id, kind: "uses", confidence: uc.confidence! });
      shown++;
    }
  }
  const notes = [`${routes.length} pontos de entrada no total, agrupados por domínio; mostrando ${shown} em ${topDomains.length} domínios. Verde = já exercitado por tráfego real.`];
  return { type: "usecase", title: "Diagrama de Caso de Uso", nodes, rels, groups, notes, stats: { casos: shown, dominios: topDomains.length, totalRotas: routes.length } };
}

// ══ 6. ATIVIDADE — passo a passo de um processo (reusa o mechanism) ═════════
export interface MechStep {
  order: number;
  fromLabel: string;
  toLabel: string;
  relationType?: string;
  method?: string;
  runtimeConfirmed?: boolean;
  resolution?: string;
}
export function buildActivity(
  report: { steps: MechStep[]; branches?: Array<{ atLabel: string; fanOut: number }>; resolvedEntryId?: string | null; entry?: string },
  opts: { entryLabel?: string } = {},
): UmlModel {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const title = `Atividade — ${opts.entryLabel || report.resolvedEntryId || report.entry || "processo"}`;
  if (!steps.length) return emptyModel("activity", title, "Sem passos provados a partir desta entrada (exercite a funcionalidade ou rode o robô).");
  const nodes: UmlNode[] = [{ id: "__start__", label: "início", kind: "start", confidence: "proven" }];
  const rels: UmlRel[] = [];
  const seen = new Set<string>();
  const branchAt = new Set((report.branches || []).map((b) => b.atLabel));
  let prev = "__start__";
  let order = 0;
  const confOf = (s: MechStep): UmlConfidence => (s.runtimeConfirmed || s.method === "RUNTIME_OBSERVED" ? "observed" : s.method === "STATIC_PROVEN" || s.resolution === "compiler" ? "proven" : "inferred");
  // um passo do processo é uma OPERAÇÃO, não um acessor: getters/setters triviais
  // (get*/set*/is*/has*) são ruído numa atividade — filtrados p/ o passo a passo ser legível.
  const isAccessor = (lbl: string) => /(^|[#.])(get|set|is|has)[A-Z0-9]/.test(String(lbl || ""));
  let filtered = 0;
  for (const s of [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    if (!s.toLabel) continue;
    if (isAccessor(s.toLabel)) { filtered++; continue; }
    const id = "act_" + s.toLabel;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, label: clamp(s.toLabel), kind: branchAt.has(s.toLabel) ? "decision" : "activity", confidence: confOf(s) });
    }
    rels.push({ from: prev, to: id, kind: "flow", confidence: confOf(s), order: order++ } as UmlRel & { order: number });
    prev = id;
  }
  rels.push({ from: prev, to: "__end__", kind: "flow", confidence: "proven" });
  nodes.push({ id: "__end__", label: "fim", kind: "end", confidence: "proven" });
  const notes = [`Passo a passo por alcance provado; losangos = pontos de decisão (fan-out). Ordem real quando houve tráfego.${filtered ? ` ${filtered} acessor(es) get/set filtrados.` : ""}`];
  return { type: "activity", title, nodes, rels, groups: [], notes, stats: { atividades: nodes.length - 2, decisoes: branchAt.size, acessoresFiltrados: filtered } };
}

// ══ 7. ESTADOS — em que estado algo está e como muda ═══════════════════════
// Fonte honesta: nós de status/estado (enum/máquina). Transições só quando o grafo
// as prova (aresta entre estados); senão, mostra os estados e DECLARA que as
// transições vivem na config de workflow, não no grafo estático.
/**
 * PURO: extrai os VALORES de um enum/união de estados do código-fonte — os estados
 * REAIS da máquina (Java `enum X{A,B}` · TS `enum`/`type X='a'|'b'`/`const X=[...]`).
 * Transições NÃO são extraídas aqui (vivem na lógica de validação/workflow) — o
 * diagrama declara isso, honesto. Nunca lança.
 */
export function extractEnumStates(sourceText: string, className: string): string[] {
  const src = String(sourceText || "");
  const name = String(className || "").replace(/[^A-Za-z0-9_]/g, "");
  if (!name) return [];
  const out: string[] = [];
  const push = (v: string) => {
    const t = v.trim().replace(/^['"]|['"]$/g, "");
    if (t && /^[A-Za-z0-9_]+$/.test(t) && !out.includes(t) && out.length < 40) out.push(t);
  };
  // Java/TS: enum X { A, B(...), C }
  let m = new RegExp(`enum\\s+${name}\\s*(?:implements[^\\{]+)?\\{([\\s\\S]*?)\\}`).exec(src);
  if (m) for (const tok of m[1].split(/[,;\n]/)) { const id = tok.trim().match(/^([A-Z][A-Z0-9_]*)/); if (id) push(id[1]); }
  // TS: type X = 'a' | 'b' | 'c'
  if (!out.length) { m = new RegExp(`type\\s+${name}\\s*=\\s*([^;\\n]+)`).exec(src); if (m) for (const lit of m[1].match(/['"]([^'"]+)['"]/g) || []) push(lit); }
  // TS: const X = ['a','b'] as const
  if (!out.length) { m = new RegExp(`(?:const|enum)\\s+${name}\\s*=?\\s*\\[([^\\]]+)\\]`).exec(src); if (m) for (const lit of m[1].match(/['"]([^'"]+)['"]/g) || []) push(lit); }
  return out;
}

export function buildState(graph: Graph, opts: { focus?: string; enumValues?: Map<string, string[]> } = {}): UmlModel {
  // Se temos os VALORES reais de um enum (extraídos da fonte), o diagrama são os
  // ESTADOS de verdade — não só o nome do tipo. Transições declaradas como "na config".
  const ev = opts.enumValues;
  if (ev && ev.size) {
    const [entId, values] = [...ev.entries()].find(([, v]) => v.length) || [];
    if (entId && values && values.length) {
      const enNode = (graph.nodes || []).find((n) => n.id === entId);
      const enName = enNode ? shortLabel(enNode, entId) : opts.focus || "Estado";
      const nodes: UmlNode[] = values.slice(0, 40).map((v) => ({ id: `st_${v}`, label: clamp(v, 28), kind: "state", confidence: "proven" }));
      const notes = [`${nodes.length} estado(s) REAIS do enum ${enName} (extraídos da fonte). As transições permitidas vivem na lógica de validação/workflow — não no grafo estático; por isso não são desenhadas (honesto).`];
      return { type: "state", title: `Estados — ${enName}`, nodes, rels: [], groups: [], notes, stats: { estados: nodes.length, transicoes: 0 } };
    }
  }
  // PRECISÃO (anti falso-positivo): só ENUM DE ESTADO real — nó de DADO (ENTITY/
  // SUPERTYPE/ENUM) cujo NOME TERMINA em Status/State/Phase/Situacao. Isso exclui
  // serviços/controllers que só têm "Status" no meio do nome (ex.: FindConnector
  // StatusServiceV1) — que NÃO são estados. A máquina de estado em si (valores +
  // transições) vive na config de workflow; aqui mostramos os TIPOS de estado.
  const DATA_TYPES = new Set(["ENTITY", "SUPERTYPE", "ENUM", "INTERFACE"]);
  const isStateEnum = (n: GNode) => {
    const cn = String(n.className || "").trim();
    // exclui MÉTODOS (getStatus, #getFromStatus) e membros — só o TIPO enum/estado.
    if (/[#.(]/.test(cn) || String(n.id || "").includes("#")) return false;
    return DATA_TYPES.has(String(n.type || "").toUpperCase()) && /(status|state|phase|situacao|situa|stage)$/i.test(cn);
  };
  let states = (graph.nodes || []).filter(isStateEnum);
  if (opts.focus) {
    const f = opts.focus.toLowerCase();
    states = states.filter((n) => String(n.className || n.id).toLowerCase().includes(f));
  }
  if (!states.length) return emptyModel("state", "Diagrama de Estados", "Nenhum nó de status/estado identificável no grafo (as máquinas de estado do domínio vivem na config de workflow).");
  const cap = 40;
  const chosen = states.slice(0, cap);
  const keep = new Set(chosen.map((n) => n.id));
  const nodes: UmlNode[] = chosen.map((n) => ({ id: n.id, label: clamp(shortLabel(n, n.id)), kind: "state", confidence: "proven" }));
  const rels: UmlRel[] = [];
  for (const e of graph.edges || []) {
    if (!keep.has(e.fromNode) || !keep.has(e.toNode) || e.fromNode === e.toNode) continue;
    if (!["ASSOCIATES", "CALLS", "EXTENDS"].includes(String(e.relationType))) continue;
    rels.push({ from: e.fromNode, to: e.toNode, kind: "transition", confidence: edgeConfidence(e) });
    if (rels.length >= CAP_RELS) break;
  }
  const notes = rels.length
    ? [`${chosen.length} estado(s); transições derivadas de relações provadas no grafo.`]
    : [`${chosen.length} estado(s) identificados. As TRANSIÇÕES não estão no grafo estático — vivem na config de workflow (stepsConfig). Diagrama mostra os estados; transições exigem ler a config de processo.`];
  return { type: "state", title: opts.focus ? `Estados — ${opts.focus}` : "Diagrama de Estados", nodes, rels, groups: [], notes, stats: { estados: nodes.length, transicoes: rels.length } };
}

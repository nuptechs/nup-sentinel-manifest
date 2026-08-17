// ─────────────────────────────────────────────────────────────────────────
// Reasoner — MODELO C4 ÚNICO a partir do grafo PROVADO (puro, nunca lança).
//
// SOTA 2025-26 (pesquisa): o vocabulário dominante de arquitetura é o C4/
// Structurizr — UM modelo → N views (Contexto/Contêiner/Componente/Implantação),
// DSL versionável em git; a novidade real é "IA gera Structurizr DSL a partir do
// código". Nosso diferencial: o modelo sai do GRAFO PROVADO (não de um LLM
// chutando), com CONFIANÇA por elemento (observado × provado × inferido).
//
// Hierarquia derivada do grafo:
//   Sistema  = o projeto
//   Pessoa   = Usuário (+ papéis, se houver)
//   Contêiner= por STACK (Frontend/Gateway/Backend/Banco)
//   Componente = grupos por diretório dentro de cada contêiner (exclui teste)
//   Relações = arestas agregadas entre contêineres e entre componentes, c/ confiança
// ─────────────────────────────────────────────────────────────────────────

import { type Graph, type GNode, type UmlConfidence, clamp, sourceFileOf, edgeConfidence } from "../uml/uml-model";

export type { UmlConfidence as C4Confidence } from "../uml/uml-model";

export type C4Kind = "person" | "system" | "container" | "component";
export interface C4Element {
  id: string; // id estável e safe (usado no DSL/Mermaid)
  name: string;
  kind: C4Kind;
  technology?: string;
  description?: string;
  parent?: string; // container do componente / system do container
  confidence: UmlConfidence;
}
export interface C4Rel {
  from: string;
  to: string;
  description: string;
  technology?: string;
  confidence: UmlConfidence;
}
export interface C4Model {
  system: C4Element;
  people: C4Element[];
  containers: C4Element[];
  components: C4Element[];
  rels: C4Rel[];
  notes: string[];
  stats: Record<string, number>;
}

// contêiner de um nó, inferido do stack/tipo (mesma régua do deployment UML).
function containerOf(n: GNode): { id: string; name: string; tech: string } | null {
  const stack = String(n.stack || "").toLowerCase();
  const t = String(n.type || "").toUpperCase();
  if (t === "ENTITY" || t === "SUPERTYPE") return { id: "db", name: "Banco de Dados", tech: "Postgres" };
  if (t === "VIEW" || t === "COMPONENT" || t === "COMPOSABLE" || /vue|react|vite/.test(stack)) return { id: "frontend", name: "Frontend", tech: "Vue/TS" };
  if (/spring|java/.test(stack)) return { id: "backend", name: "Backend", tech: "Java/Spring" };
  if (/express|node/.test(stack) || String(n.sourceFile || "").includes("services/gateway")) return { id: "gateway", name: "Gateway", tech: "Node/Express" };
  return null;
}
// Componente = módulo. As duas ÚLTIMAS pastas antes do arquivo são as mais
// específicas/de-domínio (…/services/web/contracts/v1/Foo.java → "contracts/v1";
// frontend/src/pages/contracts/X.vue → "pages/contracts"). Bem mais útil que os
// dois primeiros diretórios de boilerplate (que colapsam tudo em "src/main").
function componentKey(sf: string): string {
  const parts = String(sf || "").split("/").filter(Boolean);
  parts.pop();
  if (parts.some((p) => /^(tests?|__tests__|spec|specs|mocks?|__mocks__|fixtures?|node_modules|dist|build|target)$/i.test(p))) return "";
  const skip = new Set(["src", "main", "java", "com", "org"]);
  const meaningful = parts.filter((p) => !skip.has(p));
  return meaningful.slice(-2).join("/") || parts.slice(-2).join("/");
}
const strongest = (a: UmlConfidence | undefined, b: UmlConfidence): UmlConfidence =>
  b === "observed" || a === "observed" ? "observed" : b === "proven" || a === "proven" ? "proven" : "inferred";

export function buildC4Model(graph: Graph, opts: { systemName?: string } = {}): C4Model {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const system: C4Element = { id: "sys", name: opts.systemName || "Sistema", kind: "system", confidence: "proven" };
  const user: C4Element = { id: "user", name: "Usuário", kind: "person", confidence: "proven" };

  // nó → contêiner e nó → componente
  const nodeContainer = new Map<string, string>();
  const containers = new Map<string, C4Element>();
  const nodeComponent = new Map<string, string>();
  const compMeta = new Map<string, { container: string; size: number }>();
  for (const n of nodes) {
    const c = containerOf(n);
    if (!c) continue;
    nodeContainer.set(n.id, c.id);
    if (!containers.has(c.id)) containers.set(c.id, { id: c.id, name: c.name, technology: c.tech, kind: "container", parent: "sys", confidence: "proven" });
    // componente (só p/ contêineres de código; o banco não tem componentes de arquivo)
    if (c.id === "db") continue;
    const ck = componentKey(sourceFileOf(n));
    if (!ck) continue;
    const cid = `${c.id}__${ck}`;
    nodeComponent.set(n.id, cid);
    const m = compMeta.get(cid);
    if (m) m.size++;
    else compMeta.set(cid, { container: c.id, size: 1 });
  }

  // marca contêiner OBSERVADO se algum nó dele é runtime-hot
  for (const n of nodes) {
    if (n.observed || n.runtimeHot) {
      const cid = nodeContainer.get(n.id);
      if (cid && containers.has(cid)) containers.get(cid)!.confidence = "observed";
    }
  }

  // componentes: top por tamanho por contêiner (legibilidade)
  const byContainer = new Map<string, Array<{ cid: string; size: number }>>();
  for (const [cid, m] of compMeta) (byContainer.get(m.container) ?? byContainer.set(m.container, []).get(m.container)!).push({ cid, size: m.size });
  const components: C4Element[] = [];
  const keptComp = new Set<string>();
  for (const [container, list] of byContainer) {
    for (const { cid, size } of list.sort((a, b) => b.size - a.size).slice(0, 12)) {
      const label = cid.slice(cid.indexOf("__") + 2);
      components.push({ id: cid, name: clamp(label, 30), kind: "component", parent: container, description: `${size} arquivos`, confidence: "proven" });
      keptComp.add(cid);
    }
  }

  // relações entre CONTÊINERES + entre COMPONENTES (agregadas, com confiança)
  const contRel = new Map<string, UmlConfidence>();
  const compRel = new Map<string, UmlConfidence>();
  const FLOW = new Set(["CALLS", "READS_ENTITY", "WRITES_ENTITY", "ASSOCIATES", "RUNTIME_OBSERVED", "IMPORTS"]);
  for (const e of edges) {
    if (!FLOW.has(String(e.relationType))) continue;
    const cf = nodeContainer.get(e.fromNode);
    const ct = nodeContainer.get(e.toNode);
    if (cf && ct && cf !== ct) {
      const k = `${cf}|${ct}`;
      contRel.set(k, strongest(contRel.get(k), edgeConfidence(e)));
    }
    const kf = nodeComponent.get(e.fromNode);
    const kt = nodeComponent.get(e.toNode);
    if (kf && kt && kf !== kt && keptComp.has(kf) && keptComp.has(kt)) {
      const k = `${kf}|${kt}`;
      compRel.set(k, strongest(compRel.get(k), edgeConfidence(e)));
    }
  }

  const rels: C4Rel[] = [];
  if (containers.has("frontend")) rels.push({ from: "user", to: "frontend", description: "usa", confidence: containers.get("frontend")!.confidence });
  else if (containers.has("gateway")) rels.push({ from: "user", to: "gateway", description: "usa", confidence: "proven" });
  for (const [k, c] of contRel) {
    const [from, to] = k.split("|");
    rels.push({ from, to, description: to === "db" ? "lê/grava" : "chama", confidence: c });
  }
  for (const [k, c] of compRel) {
    const [from, to] = k.split("|");
    rels.push({ from, to, description: "usa", confidence: c });
  }

  const notes = [
    "Modelo C4 derivado do grafo PROVADO: contêineres por stack, componentes por diretório (teste excluído).",
    "Confiança por elemento — contêiner/relação OBSERVADO = houve tráfego real; provado = compilador; inferido = heurística.",
  ];
  return {
    system,
    people: [user],
    containers: [...containers.values()],
    components,
    rels,
    notes,
    stats: { conteineres: containers.size, componentes: components.length, relacoes: rels.length },
  };
}

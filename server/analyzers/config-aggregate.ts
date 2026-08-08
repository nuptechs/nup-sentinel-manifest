// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 §4 — Motor de Agregação CONFIG→System-Graph (o CONSUMIDOR da camada
// CONFIG_PROVEN que faltava; irmão do `scip-aggregate.ts`).
//
// O resolvedor `config-proven` do repo-alvo (easynup PR #1403,
// `scripts/config-proven/derive-config-edges.mjs`) lê o WIRING do Spring em
// `src/main/java` — SEM runtime, SEM LLM — e emite as arestas interface→impl cuja
// resolução o container torna DETERMINÍSTICA (1 bean concreto, ou @Primary
// desempatando). POSTa em `/config-edges` (store lateral `projects.configEdges`,
// separado das `scipEdges`). Este módulo faz a PONTE que faltava: agrega
// FQN-de-tipo → nó-de-sistema e mescla as arestas provadas no `systemGraph` cru
// com `resolution:'config'` — que o `classifyEdgeEvidence` (system-graph.ts) agora
// classifica como CONFIG_PROVEN, sem tocar o rollup/censo.
//
// IDENTIDADE (agnóstica à forma). O `derive-config-edges.mjs` POSTa em DUAS formas,
// conforme rode com/sem `--scip-json`:
//   1) FQN pontuado (o que o CI POSTa hoje — sem `--scip-json`):
//        { from:'easynup.services.x.MyPort', to:'easynup...impl.MyAdapter',
//          kind:'DI_RESOLVES', resolution:'config', reason:'spring-single-bean' }
//   2) símbolo scip-java de TIPO (com `--scip-json`), preservando o FQN:
//        { from:'scip-java maven … easynup/services/x/MyPort#', fromFqn:'easynup…MyPort', … }
// O `typeFqnOfConfigEndpoint` resolve o FQN em ambas (usa `fromFqn`/`toFqn` quando
// presentes; senão extrai o descritor de tipo do símbolo; senão trata o próprio
// endpoint como FQN pontuado). O nó Java do Engine A tem id `<STEREOTYPE>:<FQN>`
// (`SERVICE:easynup.services.x.MyPort`) — o `buildFqnNodeIndex` casa por FQN.
//
// Granularidade de CLASSE: DI é class→class por natureza (interface→impl), então —
// ao contrário do scip (que abre sub-nós de FUNÇÃO) — NÃO materializamos nós novos;
// só ligamos nós de classe que JÁ existem no grafo.
//
// ⚠️ IDENTIDADE DE NÓ NO GRAFO REAL (o bug do #140, corrigido aqui). O comentário
// original supunha que o nó Java tem id `<STEREOTYPE>:<FQN>`
// (`SERVICE:easynup.services.x.MyPort`), mas o `java-analyzer.ts` do Engine A usa o
// NOME SIMPLES da classe no id (`SERVICE:MyPort.metodo`, `ENTITY:Contract`,
// `REPOSITORY:Foo.findById`, `CONTROLLER:Bar.get`) — o PACOTE só aparece em
// `metadata.sourceFile` (o caminho do arquivo). Como as config-edges vêm em FQN
// PONTUADO com pacote (`easynup.services.x.MyPort`), casar o FQN pelo id (nome
// simples) resulta em ZERO match (o `configEdgesProven:0` medido no projeto 27).
// Por isso o índice reconstrói o FQN de cada nó a partir de `sourceFile` + nome de
// classe (os SUFIXOS pontuados do caminho, terminando na classe) — exatamente como
// o scip resolve por ARQUIVO (`buildFileNodeIndex`), mas mantendo a identidade FQN
// que a config-edge carrega. O caminho legado (FQN-embutido-no-id) segue suportado
// (retrocompat com o símbolo scip-java e fixtures FQN-in-id).
//
// PURO e testável (nenhum I/O). Espelha o `mergeScipEdges`: mescla evidência EXTERNA
// no grafo persistido, GATED + fail-soft (sem `configEdges`, o `/graph` é byte-a-byte).
//
// A régua de honestidade (ADR-0031 §5, herdada): NUNCA inventar nó — FQN cujo tipo
// não sustenta um nó de sistema (interface de lib, impl fora do escopo parseado) →
// aresta DESCARTADA (só se refina o que JÁ é arquitetura); auto-referência (mesmo
// nó nas duas pontas) descartada.
//
// PRECEDÊNCIA scip > config: o scip é compiler-accurate; a config é prova de
// wiring. Se o par de nós JÁ tem uma aresta STATIC_PROVEN (scip), NÃO emitimos uma
// aresta CONFIG_PROVEN concorrente e mais fraca para ele (não rebaixa, não duplica).
// ─────────────────────────────────────────────────────────────────────────

import type { RawSystemNode, RawSystemGraph, RawSystemEdge } from "./system-graph";
import { classKeyOf, PRECISE_RESOLUTIONS } from "./system-graph";

/** Aresta crua emitida pelo `derive-config-edges.mjs` (FQN→FQN ou símbolo→símbolo). */
export interface ConfigDerivedEdge {
  from: string;
  to: string;
  kind?: string;
  resolution: "config";
  reason?: string;
  /**
   * FQN pontuado de cada ponta, preservado pelo resolvedor quando ele faz o
   * upgrade dos FQN para símbolos scip-java (`--scip-json`). Quando presentes, são
   * a identidade canônica (mais barata que reparsear o símbolo).
   */
  fromFqn?: string;
  toFqn?: string;
  /**
   * ADR-0035 F1 — arquivo-fonte, se um dia o resolvedor os fornecer. HOJE o
   * config-edge é FQN-based (não file-based), então IGNORADOS no mapeamento (o FQN
   * é canônico). Aceitos e tolerados para não quebrar um payload que os carregue.
   */
  fromFile?: string;
  toFile?: string;
}

/** Payload que o CI POSTa em `/api/projects/:id/config-edges`. */
export interface ConfigEdgesPayload {
  tool?: string;
  schema?: string;
  counts?: unknown;
  edges: ConfigDerivedEdge[];
  ingestedAt?: string;
}

/** Aresta de SISTEMA agregada (nó→nó), pronta para mesclar no `systemGraph`. */
export interface AggregatedConfigEdge {
  fromNode: string;
  toNode: string;
  relationType: "DI_RESOLVES";
  resolution: "config";
  reason?: string;
}

export interface ConfigMergeStats {
  /** arestas derivadas recebidas. */
  derived: number;
  /** arestas de sistema únicas após agregação (nó→nó, dedup). */
  aggregated: number;
  /** arestas de sistema NOVAS adicionadas. */
  added: number;
  /** arestas DI cruas já presentes que foram PROMOVIDAS a `resolution:'config'`. */
  upgraded: number;
  /** pares já provados por scip (STATIC_PROVEN) → aresta config NÃO emitida. */
  supersededByScip: number;
  /** FQN cujo tipo não casou nenhum nó E está FORA do escopo do projeto → aresta descartada (§5). */
  orphanDropped: number;
  /** auto-referência (mesmo nó nas duas pontas) → descartada. */
  intraDropped: number;
  /** nós de PORT (interface) sintéticos materializados p/ ancorar a aresta DI. */
  interfacesMinted: number;
}

/**
 * Nó de PORT (interface) sintético a materializar. O analisador estático NÃO emite
 * nó para a interface referenciada só via DI (o PORT do hexagonal) — ela existe no
 * código mas não vira nó (verificado ao vivo: `AuthorizationDecisionPort`/
 * `PermissionPort`/`TenantScopePort` = 0 nós, os ADAPTERS = 1 nó cada). Sem o nó do
 * port, a aresta port→adapter orfaniza e o CONFIG_PROVEN fica 0. Materializamos um
 * `INTERFACE:<fqn>` — análogo ao scip que materializa sub-nós de função — SÓ quando o
 * FQN é IN-SCOPE (sob um pacote-raiz do projeto), nunca para interface de lib externa
 * (`org.springframework.*` segue órfão, §5 "nunca inventa nó de fora").
 */
export interface InterfaceNodeSpec {
  id: string;
  fqn: string;
  className: string;
}

const RELATION = "DI_RESOLVES" as const;
// Um símbolo SCIP com pacote é `scip-<lang> <manager> <pkg> <ver> <descritores>`.
const SCIP_SCHEME_RE = /^scip-[a-z0-9]+ /;
// Descritor de TIPO Java no SCIP: `<seg>/<seg>/…/<Class>#` (segmentos por `/`,
// tipo termina em `#`). Espelha o `buildFqnToScipSymbol` do resolvedor (easynup).
const TYPE_DESC_RE = /((?:[\w$]+\/)+[\w$.]+)#/;

/** Resoluções que representam prova STATIC_PROVEN do scip (precedência sobre config). */
const SCIP_PROVEN_RESOLUTIONS = PRECISE_RESOLUTIONS;

/**
 * Resolve o FQN de TIPO pontuado de um endpoint de config-edge, agnóstico à forma
 * (ADR-0035 §4). Ordem de confiança:
 *   1. `fqnHint` (`fromFqn`/`toFqn`) — o resolvedor já o preservou;
 *   2. símbolo scip-java (`scip-… <pkg>/<Class>#`) → extrai o tipo e `/`→`.`;
 *   3. FQN pontuado cru (o caso do CI hoje) → usado direto.
 * Retorna null para entrada vazia/sem descritor de tipo. Nunca lança.
 */
export function typeFqnOfConfigEndpoint(sym: string, fqnHint?: string | null): string | null {
  if (typeof fqnHint === "string" && fqnHint.trim()) return fqnHint.trim();
  if (typeof sym !== "string" || !sym.trim()) return null;
  const s = sym.trim();
  if (SCIP_SCHEME_RE.test(s)) {
    const parts = s.split(" ");
    if (parts.length < 5) return null;
    const descriptors = parts.slice(4).join(" ");
    const m = TYPE_DESC_RE.exec(descriptors);
    if (!m) return null;
    return m[1].replace(/\//g, ".");
  }
  // FQN pontuado cru (ou qualquer identificador de tipo) — identidade direta.
  return s;
}

/** FQN a partir da chave de classe (`STEREOTYPE:pkg.Class` → `pkg.Class`). */
function fqnOfClassKey(classKey: string): string {
  const i = classKey.indexOf(":");
  return i >= 0 ? classKey.slice(i + 1) : classKey;
}

/** `metadata.sourceFile` de um nó, se for string não-vazia. */
function sourceFileOf(n: RawSystemNode): string | undefined {
  const sf = n?.metadata?.sourceFile;
  return typeof sf === "string" && sf ? sf : undefined;
}

// Extensões de arquivo de código que um `sourceFile` pode carregar (removidas antes
// de pontilhar o caminho). Java é o caso das config-edges; as demais são inócuas.
const CODE_EXT_RE = /\.(?:java|kt|kts|scala|groovy|tsx?|jsx?|mts|cts)$/i;

/**
 * Reconstrói os FQN-de-tipo candidatos de um nó a partir do CAMINHO do arquivo:
 * tira a extensão, troca `/`|`\` por `.`, e devolve TODOS os sufixos pontuados
 * (do mais longo ao nome de classe sozinho). Um arquivo Java `.../easynup/services/
 * x/Foo.java` gera `[easynup.services.x.Foo, services.x.Foo, x.Foo, Foo, …]` — a
 * config-edge (`easynup.services.x.Foo`) é UM desses sufixos, então casa por
 * lookup exato SEM precisar conhecer a raiz de fonte (`src/main/java`, etc.).
 * Puro; nunca lança; `[]` para caminho vazio. O último segmento do caminho é o
 * nome de arquivo (== nome da classe pública em Java), garantindo que todo sufixo
 * TERMINA na classe.
 */
export function fqnSuffixesFromSourceFile(sourceFile: string | undefined): string[] {
  if (!sourceFile || typeof sourceFile !== "string") return [];
  const noExt = sourceFile.replace(CODE_EXT_RE, "");
  const segs = noExt.split(/[/\\]/).filter(Boolean);
  if (!segs.length) return [];
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    out.push(segs.slice(i).join("."));
  }
  return out; // do mais longo (caminho inteiro pontuado) ao mais curto (só a classe)
}

/**
 * Índice `FQN-de-tipo → id de nó REAL`. Duas fontes de identidade, nesta ordem:
 *
 *   1. FQN EMBUTIDO NO ID (`fqnOfClassKey(classKeyOf(id))`) — retrocompat com o
 *      esquema em que o id JÁ carrega o FQN (símbolo scip-java, fixtures FQN-in-id).
 *   2. FQN RECONSTRUÍDO DO `sourceFile` — o esquema REAL do `java-analyzer`, cujo id
 *      só tem o NOME SIMPLES da classe (`SERVICE:Foo.metodo`) e o pacote vive no
 *      caminho do arquivo. Registra os sufixos pontuados do caminho → nó
 *      representativo da classe. É o que faz a config-edge (FQN pontuado) casar no
 *      parque real (o `configEdgesProven:0` do #140).
 *
 * Preferência de nó por FQN: nó de CLASSE (id === chave de classe, ex. `ENTITY:Foo`)
 * vence; senão um membro real (colapsa para a classe no rollup class-level). Para
 * não gerar ambiguidade intra-classe entre os N nós de método de uma classe, a
 * fonte (2) agrupa por ARQUIVO (1 classe pública por arquivo em Java) e registra
 * uma vez por arquivo. Um sufixo reivindicado por DUAS classes distintas (mesmo
 * nome simples em pacotes diferentes → só colide nos sufixos curtos) é marcado
 * AMBÍGUO e removido — honesto: prefere não casar a mis-atribuir (a config-edge usa
 * o FQN pontuado longo, que é único, então nunca cai nessa colisão).
 */
export function buildFqnNodeIndex(nodes: RawSystemNode[]): Map<string, string> {
  const index = new Map<string, string>();
  const hasBareClass = new Set<string>();       // FQN → tem nó de CLASSE (bare) reivindicando
  const ambiguous = new Set<string>();          // FQN reivindicado por >1 classe distinta
  const ownerClass = new Map<string, string>(); // FQN → assinatura da classe que o reivindicou (p/ detectar colisão real)

  const put = (fqn: string, nodeId: string, isBare: boolean, classSig: string) => {
    if (!fqn) return;
    if (isBare) {
      // nó de CLASSE (a melhor representação por-FQN) — sempre vence, resolve dúvida.
      index.set(fqn, nodeId);
      hasBareClass.add(fqn);
      ambiguous.delete(fqn);
      ownerClass.set(fqn, classSig);
      return;
    }
    if (hasBareClass.has(fqn)) return;            // classe bare já reivindicou
    if (!index.has(fqn)) {
      index.set(fqn, nodeId);
      ownerClass.set(fqn, classSig);
      return;
    }
    // já reivindicado: se por OUTRA classe → ambíguo (não mis-atribui)
    if (ownerClass.get(fqn) !== classSig) ambiguous.add(fqn);
  };

  // Fonte 1 — FQN embutido no id (retrocompat exata). Assinatura de classe = a
  // chave de classe do id (agrupa métodos da mesma classe já pelo `classKeyOf`).
  for (const n of nodes || []) {
    if (!n || typeof n.id !== "string") continue;
    const ck = classKeyOf(n.id);
    put(fqnOfClassKey(ck), n.id, n.id === ck, `id:${ck}`);
  }

  // Fonte 2 — FQN reconstruído do `sourceFile`, agrupado por arquivo (1 classe
  // pública por arquivo em Java) para escolher UM nó representativo por classe.
  const repByFile = new Map<string, RawSystemNode>();
  for (const n of nodes || []) {
    if (!n || typeof n.id !== "string") continue;
    const sf = sourceFileOf(n);
    if (!sf) continue;
    const cur = repByFile.get(sf);
    // representante preferido: o nó de CLASSE (sem método) — ex. `ENTITY:Foo`.
    if (!cur || (!n.methodName && cur.methodName)) repByFile.set(sf, n);
  }
  for (const [sf, rep] of repByFile) {
    const isBare = rep.id === classKeyOf(rep.id) && !rep.methodName;
    for (const fqn of fqnSuffixesFromSourceFile(sf)) put(fqn, rep.id, isBare, `file:${sf}`);
  }

  for (const a of ambiguous) index.delete(a);
  return index;
}

// Ids de nó não contêm o separador (são `STEREOTYPE:pkg.Class` / `node:<path>`…).
const EDGE_SEP = "\t";
function pairKey(from: string, to: string, rel: string): string {
  return `${from}${EDGE_SEP}${to}${EDGE_SEP}${rel}`;
}
/** Chave direcional de PAR de nós (ignora relationType) — para a precedência scip. */
function dirKey(from: string, to: string): string {
  return `${from}${EDGE_SEP}${to}`;
}

/** É um FQN Java pontuado (pacote.Classe), não um id de nó/rota/tabela. */
const JAVA_FQN_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
/** Nome simples de um FQN (`a.b.Foo` → `Foo`). */
function simpleNameOf(fqn: string): string {
  return fqn.split(".").pop() || fqn;
}
/**
 * Infere os segmentos-raiz de pacote do PROJETO a partir dos FQN dos nós existentes
 * (ex. `{easynup}`). Um FQN de port sem nó só é materializado se seu 1º segmento ∈
 * raízes — assim `easynup.…Port` (in-scope) materializa e `org.springframework.…`
 * (lib externa) NÃO. Usa só FQN Java válidos (ignora ids `route:`/`node:`/`table:`).
 */
export function inferRootSegments(nodes: RawSystemNode[]): Set<string> {
  const roots = new Set<string>();
  for (const n of nodes || []) {
    if (!n || typeof n.id !== "string") continue;
    const fqn = fqnOfClassKey(classKeyOf(n.id));
    if (fqn && JAVA_FQN_RE.test(fqn)) {
      const top = fqn.split(".")[0];
      if (top) roots.add(top);
    }
  }
  return roots;
}
/** FQN in-scope = FQN Java válido cujo 1º segmento é um pacote-raiz do projeto. */
function isInScopeFqn(fqn: string, roots: Set<string>): boolean {
  if (!JAVA_FQN_RE.test(fqn)) return false;
  return roots.has(fqn.split(".")[0]);
}

/**
 * Agregação FQN→nó→aresta-de-sistema (nível de CLASSE). Pura. Para cada aresta
 * config `A→B`: resolve o nó de A/B via FQN. Quando o FQN NÃO tem nó mas é IN-SCOPE
 * (um PORT do hexagonal, que o estático não emite), MATERIALIZA um `INTERFACE:<fqn>`
 * (retornado em `interfaceNodes` para o merge criar) — senão a aresta port→adapter
 * orfanizaria e o CONFIG_PROVEN seria 0. FQN fora de escopo (lib externa) → órfão
 * (§5). Auto-referência → descarta. Dedup por par (mantém a 1ª razão).
 */
export function aggregateConfigEdges(
  nodes: RawSystemNode[],
  derived: ConfigDerivedEdge[],
): { edges: AggregatedConfigEdge[]; interfaceNodes: InterfaceNodeSpec[]; stats: Omit<ConfigMergeStats, "added" | "upgraded" | "supersededByScip"> } {
  const fqnIndex = buildFqnNodeIndex(nodes);
  const roots = inferRootSegments(nodes);
  const planned = new Map<string, InterfaceNodeSpec>(); // fqn → spec do port sintético
  const best = new Map<string, AggregatedConfigEdge>();
  let orphanDropped = 0;
  let intraDropped = 0;

  // Resolve um FQN a um id de nó: existente > materializa PORT in-scope > null (órfão).
  const resolveOrMaterialize = (fqn: string): string | null => {
    const existing = fqnIndex.get(fqn);
    if (existing) return existing;
    if (!isInScopeFqn(fqn, roots)) return null; // lib externa / não-FQN → órfão (§5)
    const id = `INTERFACE:${fqn}`;
    if (!planned.has(fqn)) planned.set(fqn, { id, fqn, className: simpleNameOf(fqn) });
    fqnIndex.set(fqn, id); // registra p/ outras arestas do mesmo port reusarem
    return id;
  };

  for (const e of derived || []) {
    if (!e || e.resolution !== "config") continue;
    const fromFqn = typeFqnOfConfigEndpoint(e.from, e.fromFqn);
    const toFqn = typeFqnOfConfigEndpoint(e.to, e.toFqn);
    if (!fromFqn || !toFqn) { orphanDropped++; continue; }
    const na = resolveOrMaterialize(fromFqn);
    const nb = resolveOrMaterialize(toFqn);
    if (!na || !nb) { orphanDropped++; continue; }
    if (na === nb) { intraDropped++; continue; }
    const key = pairKey(na, nb, RELATION);
    if (best.has(key)) continue; // dedup — 1ª aresta vence (razão idêntica por par)
    best.set(key, {
      fromNode: na,
      toNode: nb,
      relationType: RELATION,
      resolution: "config",
      ...(typeof e.reason === "string" && e.reason ? { reason: e.reason } : {}),
    });
  }
  const edges = Array.from(best.values());
  // só materializa o port que participa de ao menos 1 aresta final (dedup pode ter
  // descartado a única aresta que o tocava via auto-referência).
  const usedNodes = new Set<string>();
  for (const a of edges) { usedNodes.add(a.fromNode); usedNodes.add(a.toNode); }
  const interfaceNodes = Array.from(planned.values()).filter((s) => usedNodes.has(s.id));
  return {
    edges,
    interfaceNodes,
    stats: { derived: (derived || []).length, aggregated: edges.length, orphanDropped, intraDropped, interfacesMinted: interfaceNodes.length },
  };
}

/**
 * Mescla as arestas config no `systemGraph` cru (opção "na leitura", como o scip).
 * NÃO muta a entrada — opera sobre um CLONE. Para cada par de nós provado por
 * config:
 *   - se o par JÁ tem uma aresta STATIC_PROVEN (scip: `scipProven` ou resolução
 *     precisa) → SUPRIME (precedência scip > config; nunca rebaixa nem duplica);
 *   - senão, se já existe uma aresta DI_RESOLVES crua para o par → PROMOVE
 *     (seta `resolution:'config'` + `configProven`, remove `synthetic`);
 *   - senão → ADICIONA aresta DI_RESOLVES nova com `resolution:'config'`.
 * O `shapeSystemGraph` posterior classifica como CONFIG_PROVEN (0.78) e conta no
 * censo `coverage.byMethod.CONFIG_PROVEN` sem mudança.
 */
export function mergeConfigEdges(
  rawGraph: RawSystemGraph,
  payload: ConfigEdgesPayload | null | undefined,
): { graph: RawSystemGraph; stats: ConfigMergeStats } {
  const zero: ConfigMergeStats = { derived: 0, aggregated: 0, added: 0, upgraded: 0, supersededByScip: 0, orphanDropped: 0, intraDropped: 0, interfacesMinted: 0 };
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) {
    return { graph: rawGraph, stats: zero };
  }
  const derived = payload?.edges;
  if (!Array.isArray(derived) || derived.length === 0) {
    return { graph: rawGraph, stats: zero };
  }
  const { edges: aggregated, interfaceNodes, stats: aggStats } = aggregateConfigEdges(rawGraph.nodes, derived);
  if (aggregated.length === 0) {
    return { graph: rawGraph, stats: { ...aggStats, added: 0, upgraded: 0, supersededByScip: 0 } };
  }
  // clone defensivo (não mutar o snapshot persistido/cacheado)
  const graph: RawSystemGraph = {
    ...rawGraph,
    nodes: rawGraph.nodes.slice(),
    edges: rawGraph.edges.map((e) => ({ ...e, metadata: e.metadata ? { ...e.metadata } : e.metadata })),
  };

  // MATERIALIZA os nós de PORT (interface) ausentes que ancoram as arestas DI.
  // Sem o nó, o `shapeSystemGraph` descartaria a aresta (as duas pontas têm de
  // existir entre os nós). Marca proveniência de config; nunca duplica id.
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  for (const spec of interfaceNodes) {
    if (existingIds.has(spec.id)) continue;
    existingIds.add(spec.id);
    graph.nodes.push({
      id: spec.id,
      type: "INTERFACE",
      className: spec.className,
      metadata: { synthetic: true, configProven: true, materializedByConfig: true, fqn: spec.fqn },
    });
  }

  // Índices sobre o grafo (pós-scip): pares já provados pelo scip + arestas DI cruas.
  const scipProvenPairs = new Set<string>();
  const diEdgeByKey = new Map<string, RawSystemEdge>();
  for (const e of graph.edges) {
    const md = (e.metadata || {}) as Record<string, unknown>;
    const res = typeof md.resolution === "string" ? md.resolution : undefined;
    if (md.scipProven === true || (res !== undefined && SCIP_PROVEN_RESOLUTIONS.has(res))) {
      scipProvenPairs.add(dirKey(e.fromNode, e.toNode));
    }
    if (e.relationType === RELATION) diEdgeByKey.set(pairKey(e.fromNode, e.toNode, RELATION), e);
  }

  let added = 0;
  let upgraded = 0;
  let supersededByScip = 0;
  for (const a of aggregated) {
    if (scipProvenPairs.has(dirKey(a.fromNode, a.toNode))) { supersededByScip++; continue; }
    const existing = diEdgeByKey.get(pairKey(a.fromNode, a.toNode, RELATION));
    if (existing) {
      const md = (existing.metadata || {}) as Record<string, unknown>;
      md.resolution = "config";
      md.configProven = true;
      if (a.reason) md.reason = a.reason;
      delete md.synthetic; // deixa de ser DECLARADA — agora é PROVADA por config
      existing.metadata = md;
      upgraded++;
    } else {
      graph.edges.push({
        fromNode: a.fromNode,
        toNode: a.toNode,
        relationType: RELATION,
        metadata: { resolution: "config", configProven: true, ...(a.reason ? { reason: a.reason } : {}) },
      });
      added++;
    }
  }
  return { graph, stats: { ...aggStats, added, upgraded, supersededByScip } };
}

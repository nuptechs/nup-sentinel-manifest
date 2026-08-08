// ─────────────────────────────────────────────────────────────────────────
// BIMR — Blind-Impact-Miss-Rate (ADR-0035, prova de valor do eixo RUNTIME).
//
// A PERGUNTA: um leitor SÓ-estático (um agente de IA lendo o código, um dev
// novo, qualquer ferramenta de análise estática) enxerga o sistema inteiro? O
// BIMR responde com NÚMERO, usando o eixo RUNTIME como oráculo: das tabelas que
// o banco de produção DE FATO viu serem tocadas na janela observada, quantas o
// modelo estático não conseguiu ligar a nenhuma entidade do código?
//
// ─── §COMO SE MEDE ──────────────────────────────────────────────────────────
// O overlay de runtime (`runtime-overlay.ts`) faz duas coisas com cada tabela
// vista em span de DB:
//   • ACHA a `ENTITY` correspondente no grafo estático (`toSnakeCase(className)`
//     casa `sla_indicator` ↔ `SlaIndicator`) → marca `runtimeHot` nela; OU
//   • NÃO acha → MINTA um nó `table:<nome>` (`synthetic + runtimeOnly`).
// O 2º caso é a evidência dura: a tabela existe, é escrita/lida em produção, e
// NÃO HÁ entidade no modelo estático que a represente. Nenhuma leitura de código
// a encontraria — é um ponto cego estrutural, não um bug de parsing.
//
//   BIMR (v1) = tabelas mintadas / tabelas observadas em runtime
//
// ─── §HONESTIDADE CRAVADA ───────────────────────────────────────────────────
// 1) O DENOMINADOR é o que o overlay OBSERVOU NA JANELA — não o universo de
//    tabelas do banco. Tabela sem tráfego na janela não entra nem como acerto
//    nem como erro. O BIMR é, portanto, uma taxa sobre a AMOSTRA observada.
// 2) Nem toda tabela mintada é "buraco de arquitetura": migração
//    (`databasechangelog`), sessão, lock distribuído e fila são INFRA — existem
//    de propósito sem entidade JPA. Elas são MARCADAS (`likelyInfrastructure`) e
//    a taxa é reportada TAMBÉM sem elas. Nunca são apagadas em silêncio: quem
//    lê decide.
// 3) `mintedRatio` NÃO é "% do sistema invisível" — é "% das tabelas tocadas em
//    produção que o modelo estático não representa". A frase larga seria mentira.
//
// Puro e determinístico: recebe o grafo cru (nós + arestas com metadata) e
// devolve números + as listas nomeadas. Sem express, sem storage, sem rede.
// ─────────────────────────────────────────────────────────────────────────

export interface BimrNode {
  id: string;
  type: string;
  className?: string;
  metadata?: Record<string, unknown> | null;
}
export interface BimrEdge {
  fromNode: string;
  toNode: string;
  relationType: string;
  metadata?: Record<string, unknown> | null;
}
export interface BimrGraph {
  nodes: BimrNode[];
  edges: BimrEdge[];
}

/** Tabela tocada em produção que o modelo estático NÃO representa. */
export interface MintedTable {
  /** id do nó sintético (`table:<nome>`). */
  id: string;
  /** nome da tabela, normalizado pelo overlay (snake_case, sem schema). */
  table: string;
  /** nº de spans de DB que a tocaram (quando o overlay registrou). */
  runtimeCount?: number;
  /**
   * a tabela CASA um padrão conhecido de infraestrutura (migração/sessão/lock/
   * fila)? Nesse caso a ausência de entidade é ESPERADA — não é ponto cego de
   * domínio. Marcada, nunca removida.
   */
  likelyInfrastructure: boolean;
}

/** Tabela tocada em produção que o modelo estático representa (o acerto). */
export interface ResolvedEntity {
  id: string;
  className?: string;
  runtimeCount?: number;
}

/** Entidade que EXISTE no código, roda em produção, e nada estático a alcança. */
export interface OrphanHotEntity {
  id: string;
  label: string;
  runtimeCount?: number;
}

export interface BimrResult {
  /** houve eixo de runtime nesta análise? false ⇒ o BIMR não é mensurável. */
  measurable: boolean;
  /** motivo pt-BR quando `measurable=false`. */
  reason?: string;
  /** denominador: tabelas/entidades distintas tocadas em runtime na janela. */
  tablesObservedRuntime: number;
  /** das observadas, quantas casaram uma ENTITY do modelo estático. */
  tablesResolvedStatic: number;
  /** das observadas, quantas NÃO existem no modelo estático (mintadas). */
  tablesMintedRuntimeOnly: number;
  /** BIMR v1 = mintadas / observadas ∈ [0,1]. 0 quando não há observação. */
  mintedRatio: number;
  /** mesma taxa desconsiderando as mintadas marcadas como infraestrutura. */
  mintedRatioExcludingInfrastructure: number;
  /** denominador da taxa acima (observadas − mintadas-de-infra). */
  observedExcludingInfrastructure: number;
  minted: MintedTable[];
  resolved: ResolvedEntity[];
  /**
   * Entidades REAIS (não-mintadas) exercitadas por tráfego cujo modelo estático
   * não tem NENHUMA aresta entrante — o código existe, roda, e a leitura estática
   * não sabe quem o usa. 2º sinal de cegueira, ortogonal ao minting.
   */
  entitiesHotWithoutStaticInbound: { count: number; nodes: OrphanHotEntity[] };
  caveats: string[];
}

/**
 * Padrões de tabela que são INFRAESTRUTURA por natureza — existir sem entidade
 * JPA/ORM é o comportamento correto delas, não um ponto cego. Conservador de
 * propósito: na dúvida, NÃO marca (prefere superestimar o ponto cego a escondê-lo).
 */
const INFRA_TABLE_PATTERNS: readonly RegExp[] = [
  /^databasechangelog/i,          // Liquibase
  /^flyway_schema_history$/i,     // Flyway
  /^schema_migrations$/i,         // Rails/ActiveRecord, Drizzle
  /^__drizzle_migrations$/i,
  /^qrtz_/i,                      // Quartz scheduler
  /^shedlock$/i,                  // ShedLock
  /^scheduled_job_lock$/i,
  /_lock$/i,
  /^spring_session/i,
  /^session$/i,
  /^sessions$/i,
  /^oauth2?_/i,
  /^pg_/i,                        // catálogo do Postgres
];

export function isLikelyInfrastructureTable(table: string): boolean {
  const t = (table || "").trim().toLowerCase();
  if (!t) return false;
  return INFRA_TABLE_PATTERNS.some((re) => re.test(t));
}

const RUNTIME_RELATION = "RUNTIME_OBSERVED";

function meta(n: { metadata?: Record<string, unknown> | null }): Record<string, unknown> {
  return (n.metadata || {}) as Record<string, unknown>;
}

/**
 * Nó mintado pelo overlay: entidade que só existe porque o runtime a viu.
 *
 * SÓ metadata (`synthetic && runtimeOnly` — o overlay SEMPRE seta os dois no
 * mint). O antigo fallback por prefixo de id (`table:`) foi REMOVIDO após o
 * dogfood do 2º sistema (NuPIdentify, 2026-08-08): o analyzer TS modela as
 * entidades Drizzle com id `table:<nome>` — MESMO namespace do mint — e o
 * fallback classificava as 53 entidades REAIS do modelo como "invisíveis ao
 * estático", cravando um BIMR de 100% FALSO. Colisão de namespace ≠ ponto
 * cego; a verdade está nos flags, nunca no prefixo.
 */
function isMintedEntity(n: BimrNode): boolean {
  if (n.type !== "ENTITY") return false;
  const m = meta(n);
  return m.synthetic === true && m.runtimeOnly === true;
}

/** Aresta de runtime (o overlay marca as duas formas). */
function isRuntimeEdge(e: BimrEdge): boolean {
  return e.relationType === RUNTIME_RELATION || meta(e).observed === true;
}

function tableNameOf(n: BimrNode): string {
  if (n.id.startsWith("table:")) return n.id.slice("table:".length);
  return n.className || n.id;
}

function runtimeCountOf(n: BimrNode): number | undefined {
  const c = meta(n).runtimeCount;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : undefined;
}

/**
 * Computa o BIMR a partir do grafo cru (o MESMO que o `/graph` modela). Puro.
 * Nunca lança: entrada malformada devolve `measurable:false` com motivo.
 */
export function computeBimr(graph: BimrGraph | null | undefined): BimrResult {
  const nodes = Array.isArray(graph?.nodes) ? graph!.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph!.edges : [];

  // Entidades tocadas em runtime: por marcação do overlay (`runtimeHot`) OU por
  // aresta de runtime entrante (redundância proposital — as duas provas valem).
  const hotByEdge = new Set<string>();
  for (const e of edges) {
    if (e && isRuntimeEdge(e) && typeof e.toNode === "string") hotByEdge.add(e.toNode);
  }

  const minted: MintedTable[] = [];
  const resolved: ResolvedEntity[] = [];
  const hotEntities: BimrNode[] = [];

  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || n.type !== "ENTITY") continue;
    const observed = meta(n).runtimeHot === true || hotByEdge.has(n.id);
    if (!observed) continue;
    hotEntities.push(n);
    if (isMintedEntity(n)) {
      const table = tableNameOf(n);
      minted.push({
        id: n.id,
        table,
        ...(runtimeCountOf(n) !== undefined ? { runtimeCount: runtimeCountOf(n) } : {}),
        likelyInfrastructure: isLikelyInfrastructureTable(table),
      });
    } else {
      resolved.push({
        id: n.id,
        ...(n.className ? { className: n.className } : {}),
        ...(runtimeCountOf(n) !== undefined ? { runtimeCount: runtimeCountOf(n) } : {}),
      });
    }
  }

  // 2º sinal: entidade REAL, quente, sem nenhuma aresta ESTÁTICA entrante.
  // (as mintadas ficam fora por construção — elas não existem no estático, e
  // contá-las aqui seria contar o mesmo furo duas vezes.)
  const staticInbound = new Set<string>();
  for (const e of edges) {
    if (!e || isRuntimeEdge(e) || typeof e.toNode !== "string") continue;
    staticInbound.add(e.toNode);
  }
  const orphans: OrphanHotEntity[] = [];
  for (const n of hotEntities) {
    if (isMintedEntity(n)) continue;
    if (staticInbound.has(n.id)) continue;
    orphans.push({
      id: n.id,
      label: n.className || n.id,
      ...(runtimeCountOf(n) !== undefined ? { runtimeCount: runtimeCountOf(n) } : {}),
    });
  }

  const observedTotal = minted.length + resolved.length;
  const infraMinted = minted.filter((m) => m.likelyInfrastructure).length;
  const observedExInfra = Math.max(0, observedTotal - infraMinted);
  const mintedExInfra = minted.length - infraMinted;

  const caveats: string[] = [];
  if (observedTotal > 0) {
    caveats.push(
      "O denominador é o conjunto de tabelas tocadas na JANELA observada de traços — não o universo de tabelas do banco. Tabela sem tráfego na janela não entra na conta.",
    );
    if (infraMinted > 0) {
      caveats.push(
        `${infraMinted} tabela(s) mintada(s) casam padrão de INFRAESTRUTURA (migração/sessão/lock) — não ter entidade é o esperado nelas; a taxa "sem infraestrutura" as desconta.`,
      );
    }
    caveats.push(
      "O casamento tabela↔entidade usa a convenção de nome (snake_case do nome da classe). Entidade mapeada com @Table(name=…) divergente da convenção aparece como mintada — falso ponto cego.",
    );
  }

  const measurable = observedTotal > 0;
  return {
    measurable,
    ...(measurable
      ? {}
      : {
          reason:
            "nenhuma entidade/tabela foi observada em runtime nesta análise — sem oráculo, o BIMR não é mensurável (não é 0%: é não-medido)",
        }),
    tablesObservedRuntime: observedTotal,
    tablesResolvedStatic: resolved.length,
    tablesMintedRuntimeOnly: minted.length,
    mintedRatio: observedTotal > 0 ? round4(minted.length / observedTotal) : 0,
    mintedRatioExcludingInfrastructure: observedExInfra > 0 ? round4(mintedExInfra / observedExInfra) : 0,
    observedExcludingInfrastructure: observedExInfra,
    minted: minted.sort(byTable),
    resolved: resolved.sort((a, b) => (a.className || a.id).localeCompare(b.className || b.id)),
    entitiesHotWithoutStaticInbound: { count: orphans.length, nodes: orphans.sort((a, b) => a.label.localeCompare(b.label)) },
    caveats,
  };
}

function byTable(a: MintedTable, b: MintedTable): number {
  return a.table.localeCompare(b.table);
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

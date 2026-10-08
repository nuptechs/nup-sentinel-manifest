// ─────────────────────────────────────────────────────────────────────────
// OBS-D05 (ADR-0036 WS-D) — GRANULARIDADE DE CAMPO no grafo de sistema.
//
// Hoje o grafo tem granularidade de CLASSE/MÉTODO (system-graph.ts) e de TABELA
// (data-access-aggregate.ts: função→`table:<físico>`). Falta o nó mais fino que a
// visão V3/V8 exige: o CAMPO — um campo de tela (VIEW), um campo de DTO/contrato,
// ou uma COLUNA física de tabela. Sem ele, "o que muda se eu incluir/alterar o
// campo X nesta tela?" (OBS-F03/F05) não tem alvo rastreável no grafo.
//
// ESTE MÓDULO é só o MODELO (tipos + id estável + construtores puros). NÃO está
// ligado ao pipeline — nenhum produtor emite nós FIELD ainda, então o grafo
// servido continua byte-a-byte (gates G2/G3 intactos). Os produtores (extrair
// campos de SFC/JSX, de DTO, de `pgTable`) e o consumo em impacto entram em PRs
// seguintes (F03/F05), consumindo este contrato — a mesma estratégia inerte do
// `EdgeRefutation` (produtor no nup-sentinel, contrato aqui).
//
// INVARIANTES (herdadas da §2 da ADR-0036):
//  • id DETERMINÍSTICO e reversível: `field:<scope>:<owner>#<name>` — parseável de
//    volta sem ambiguidade (owner e name são percent-encoded p/ `#`/`:`).
//  • PURO: nenhuma função aqui lança nem faz I/O.
//  • HONESTO: `kind` declara a NATUREZA do campo (view/dto/column); a evidência de
//    COMO sabemos (compiler/convention) fica na aresta, como no resto do grafo.
// ─────────────────────────────────────────────────────────────────────────

import type { RawSystemNode, RawSystemEdge } from "./system-graph";

/** Tipo de nó novo — campo rastreável. Fica FORA do vocabulário de papel (CM1),
 *  como `table:` já fica: é uma faceta de dado fino, não um papel de componente. */
export const FIELD_NODE_TYPE = "FIELD" as const;

/** Natureza do campo. `column` = coluna física (liga em `table:<físico>`); `view`
 *  = campo renderizado numa tela; `dto` = propriedade de contrato/DTO trafegado. */
export type FieldKind = "view" | "dto" | "column";

/** Relações do eixo de campo (nascem aqui; produtores as emitem em F03/F05). */
export const FIELD_REL = {
  /** owner (VIEW/DTO/ENTITY) → campo que ele declara. */
  HAS_FIELD: "HAS_FIELD",
  /** campo de tela/DTO → coluna física que ele materializa (travessia front→coluna). */
  MAPS_TO_COLUMN: "MAPS_TO_COLUMN",
} as const;
export type FieldRelation = (typeof FIELD_REL)[keyof typeof FIELD_REL];

export interface FieldNodeSpec {
  /** id do nó DONO do campo (ex.: `VIEW:...`, `entity:Contract`, `table:contract`). */
  owner: string;
  /** nome do campo como aparece na fonte (ex.: `cnpj`, `razaoSocial`, `created_at`). */
  name: string;
  kind: FieldKind;
  /** arquivo-fonte onde o campo é declarado (evidência de localização). */
  sourceFile?: string;
  /** metadados extra (ex.: tipo declarado, sensível, nullable) — opacos ao modelo. */
  metadata?: Record<string, unknown>;
}

const SEP = "#"; // owner#name
const PREFIX = "field:";

// `#` e `:` são separadores do id — precisam escapar p/ o parse ser reversível.
function enc(s: string): string {
  return s.replace(/%/g, "%25").replace(/#/g, "%23").replace(/:/g, "%3A");
}
function dec(s: string): string {
  return s.replace(/%3A/gi, ":").replace(/%23/gi, "#").replace(/%25/gi, "%");
}

/**
 * id estável de um nó de campo: `field:<kind>:<owner>#<name>` (owner/name
 * escapados). Determinístico — mesma entrada, mesmo id; reversível por
 * `parseFieldNodeId`. Puro.
 */
export function fieldNodeId(owner: string, name: string, kind: FieldKind): string {
  return `${PREFIX}${kind}:${enc(owner)}${SEP}${enc(name)}`;
}

/** Inverso de `fieldNodeId`. Retorna null se o id não for um id de campo válido. */
export function parseFieldNodeId(
  id: string,
): { kind: FieldKind; owner: string; name: string } | null {
  if (typeof id !== "string" || !id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return null;
  const kind = rest.slice(0, firstColon) as FieldKind;
  if (kind !== "view" && kind !== "dto" && kind !== "column") return null;
  const ownerName = rest.slice(firstColon + 1);
  const sep = ownerName.indexOf(SEP);
  if (sep < 0) return null;
  const owner = dec(ownerName.slice(0, sep));
  const name = dec(ownerName.slice(sep + 1));
  if (!owner || !name) return null;
  return { kind, owner, name };
}

export function isFieldNodeId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(PREFIX) && parseFieldNodeId(id) !== null;
}

/**
 * Constrói o nó `RawSystemNode` de um campo. `className` carrega o nome do campo
 * (p/ o `labelOf` do shape e da triagem cair no nome, não no id cru). Puro.
 */
export function makeFieldNode(spec: FieldNodeSpec): RawSystemNode {
  const id = fieldNodeId(spec.owner, spec.name, spec.kind);
  return {
    id,
    type: FIELD_NODE_TYPE,
    className: spec.name,
    metadata: {
      fieldKind: spec.kind,
      fieldOwner: spec.owner,
      ...(spec.sourceFile ? { sourceFile: spec.sourceFile } : {}),
      ...(spec.metadata ?? {}),
    },
  };
}

/** Aresta owner→campo (`HAS_FIELD`). `resolution` default convenção (declarado). */
export function hasFieldEdge(
  owner: string,
  field: FieldNodeSpec,
  resolution = "convention-name",
): RawSystemEdge {
  return {
    fromNode: owner,
    toNode: fieldNodeId(field.owner, field.name, field.kind),
    relationType: FIELD_REL.HAS_FIELD,
    metadata: { resolution },
  };
}

/** Aresta campo→coluna física (`MAPS_TO_COLUMN`) — travessia front/DTO → dado. */
export function mapsToColumnEdge(
  fieldId: string,
  columnId: string,
  resolution = "convention-name",
): RawSystemEdge {
  return { fromNode: fieldId, toNode: columnId, relationType: FIELD_REL.MAPS_TO_COLUMN, metadata: { resolution } };
}

// ─────────────────────────────────────────────────────────────────────────
// PRODUTOR de campo (OBS-D05) — compõe o modelo acima num subgrafo mesclável.
//
// Dado um conjunto de DECLARAÇÕES de campo (owner + nome + kind, opcionalmente a
// coluna física que o campo materializa), emite os nós FIELD e as arestas
// HAS_FIELD/MAPS_TO_COLUMN, deduplicados, com estatística HONESTA:
//   • owner que NÃO existe no grafo → NÃO cria campo flutuante (fieldOwnerUnresolved);
//     o campo só entra ligado a um dono real (mesma regra do data-access: sem nó, não
//     atribui). A exceção são colunas físicas cujo owner é `table:<x>`, que pode ser
//     mintado pelo próprio eixo de dado — por isso `allowMintTableOwner` (default off).
//   • dedup por id de nó e por tripla de aresta.
//
// INERTE por construção: nenhum pipeline chama isto ainda (F03/F05 vão), então o
// grafo servido continua byte-a-byte. PURO: clona, nunca muta o snapshot, nunca lança.
// ─────────────────────────────────────────────────────────────────────────

export interface FieldDecl extends FieldNodeSpec {
  /** se o campo materializa uma coluna física, o id do nó-coluna/tabela destino. */
  mapsToColumn?: string;
  /** método de resolução p/ as arestas (default `convention-name`). */
  resolution?: string;
}

export interface FieldGraphStats {
  received: number;
  fieldNodesAdded: number;
  hasFieldEdges: number;
  mapsToColumnEdges: number;
  /** owner declarado sem nó no grafo → campo não atribuído (honesto). */
  fieldOwnerUnresolved: number;
}

interface MinimalGraph {
  nodes: RawSystemNode[];
  edges: RawSystemEdge[];
}

export interface MergeFieldGraphOptions {
  /** permite mintar o owner `table:<x>` quando ausente (eixo de coluna física). */
  allowMintTableOwner?: boolean;
}

/**
 * Mescla declarações de campo como nós FIELD + arestas. PURO: clona o grafo (não
 * muta o snapshot). Fail-soft por declaração. Owner inexistente → não atribui.
 */
export function mergeFieldGraph<G extends MinimalGraph>(
  rawGraph: G | null | undefined,
  decls: FieldDecl[] | null | undefined,
  opts: MergeFieldGraphOptions = {},
): { graph: G; stats: FieldGraphStats } {
  const zero: FieldGraphStats = { received: 0, fieldNodesAdded: 0, hasFieldEdges: 0, mapsToColumnEdges: 0, fieldOwnerUnresolved: 0 };
  if (!rawGraph || !Array.isArray(rawGraph.nodes) || !Array.isArray(rawGraph.edges)) return { graph: rawGraph as G, stats: zero };
  if (!Array.isArray(decls) || decls.length === 0) return { graph: rawGraph, stats: { ...zero } };

  const graph = { ...rawGraph, nodes: rawGraph.nodes.slice(), edges: rawGraph.edges.slice() } as G;
  const existingIds = new Set(graph.nodes.map((n) => n.id));
  const seenEdge = new Set<string>();
  for (const e of graph.edges) seenEdge.add(`${e.fromNode}|${e.toNode}|${e.relationType}`);

  const stats: FieldGraphStats = { received: decls.length, fieldNodesAdded: 0, hasFieldEdges: 0, mapsToColumnEdges: 0, fieldOwnerUnresolved: 0 };

  const addEdge = (e: RawSystemEdge): boolean => {
    const key = `${e.fromNode}|${e.toNode}|${e.relationType}`;
    if (seenEdge.has(key)) return false;
    seenEdge.add(key);
    graph.edges.push(e);
    return true;
  };

  for (const d of decls) {
    if (!d || typeof d.owner !== "string" || !d.owner || typeof d.name !== "string" || !d.name) continue;
    if (d.kind !== "view" && d.kind !== "dto" && d.kind !== "column") continue;

    // HONESTO: só liga o campo a um dono que EXISTE no grafo (sem nó → não atribui).
    // Exceção opt-in: coluna física cujo owner `table:<x>` pode ser mintado aqui.
    if (!existingIds.has(d.owner)) {
      if (opts.allowMintTableOwner && d.owner.startsWith("table:")) {
        const ownerNode: RawSystemNode = { id: d.owner, type: "ENTITY", className: d.owner.slice("table:".length), metadata: { materializedFrom: "field-graph" } };
        graph.nodes.push(ownerNode);
        existingIds.add(d.owner);
      } else {
        stats.fieldOwnerUnresolved++;
        continue;
      }
    }

    const fieldId = fieldNodeId(d.owner, d.name, d.kind);
    if (!existingIds.has(fieldId)) {
      graph.nodes.push(makeFieldNode(d));
      existingIds.add(fieldId);
      stats.fieldNodesAdded++;
    }
    if (addEdge(hasFieldEdge(d.owner, d, d.resolution))) stats.hasFieldEdges++;

    if (typeof d.mapsToColumn === "string" && d.mapsToColumn) {
      if (addEdge(mapsToColumnEdge(fieldId, d.mapsToColumn, d.resolution))) stats.mapsToColumnEdges++;
    }
  }

  return { graph, stats };
}

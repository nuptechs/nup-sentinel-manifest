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

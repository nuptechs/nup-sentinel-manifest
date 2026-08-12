// ─────────────────────────────────────────────────────────────────────────
// Reasoner — PORTA do CATÁLOGO de funcionalidades (arquitetura hexagonal).
//
// A geração da sequência REUSA o motor `traceMechanism` (que já depende da
// `RuntimeOrderPort`). O que faltava como porta é ENUMERAR as funcionalidades
// (rotas do front + batch/agendados) — o adapter `graphEntryCatalog` a implementa
// a partir do grafo do snapshot. Fail-soft: grafo vazio → []. Nunca lança.
// ─────────────────────────────────────────────────────────────────────────

/** uma funcionalidade candidata a diagrama (rota do front OU batch/agendado). */
export interface EntryPoint {
  /** id estável para pedir o diagrama (nodeId do grafo). */
  id: string;
  /** rótulo humano (ex.: "GET /api/users" ou "@Scheduled ReconcileJob"). */
  label: string;
  /** origem — ajuda o robô da Fase 2 a saber COMO exercitar. */
  kind: "route" | "batch" | "job" | "view" | "other";
  httpMethod?: string;
  httpPath?: string;
  /** já há tráfego observado desta funcionalidade? (verde no catálogo). */
  observed?: boolean;
}

/** CATÁLOGO — enumera as funcionalidades (front + batch) do sistema. */
export interface EntryPointCatalog {
  list(): EntryPoint[];
  resolve(idOrQuery: string): EntryPoint | null;
}

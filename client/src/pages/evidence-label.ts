// ─────────────────────────────────────────────
// Diagramas de Evidência — rótulo humano de nó (lógica PURA compartilhada).
//
// O shape /graph NÃO traz `label`, e o analisador Node marca código de nível de
// arquivo como `methodName:"<module>"` (server/analyzers/data-access-aggregate.ts).
// Renderizar "<module>" cru é lixo visual — este helper cai pro basename do
// arquivo ou pro fim do id, e NUNCA devolve um placeholder.
// ─────────────────────────────────────────────

const PLACEHOLDERS = new Set(["<module>", "<anonymous>", "<init>", "<clinit>", ""]);

function usable(s: string | undefined | null): s is string {
  return !!s && !PLACEHOLDERS.has(s);
}

/** Basename do caminho, sem diretórios. */
function basename(path: string): string {
  const p = path.split(/[\\/]/).filter(Boolean).pop();
  return p || path;
}

export interface LabelableNode {
  id: string;
  className?: string;
  methodName?: string;
  qualifiedSignature?: string;
  sourceFile?: string;
  name?: string;
}

/**
 * Rótulo legível: className → methodName real → basename do sourceFile →
 * fim do id (nunca um placeholder). Puro e determinístico.
 */
export function humanLabel(n: LabelableNode): string {
  if (usable(n.name)) return n.name!;
  if (usable(n.className)) return n.className!;
  if (usable(n.methodName)) return n.methodName!;
  if (n.sourceFile) {
    const base = basename(n.sourceFile);
    if (usable(base)) return base;
  }
  // fim do id (aceita separadores : e /); descarta placeholder
  const tail = n.id.split(/[:/]/).filter(Boolean).pop();
  if (usable(tail)) return tail!;
  return n.id;
}

// ─────────────────────────────────────────────
// pr-unified-diff — ADR-0019 Onda 4 (webhook vira bot de PR REAL)
//
// Os providers (GitHub/GitLab) devolvem o PR como CONJUNTOS de arquivos
// (base/head). O motor de impacto (ADR-0018) consome um `git diff` UNIFICADO.
// Este módulo constrói o unified diff a partir dos dois conjuntos — no formato
// EXATO que o nosso parseUnifiedDiff lê (`diff --git a/x b/x` + ---/+++ com
// /dev/null para added/removed). O teste de ouro é o ROUND-TRIP: o diff
// construído aqui, parseado pelo changed-symbols, extrai os símbolos certos.
//
// Puro; usa o pacote `diff` (já no node_modules) para os hunks.
// ─────────────────────────────────────────────

import { createTwoFilesPatch } from "diff"; // tipos: server/types/diff.d.ts
import type { GitPRDiff } from "./git-provider";

/** remove o cabeçalho "Index:/===" que o createTwoFilesPatch emite. */
function stripPatchHeader(patch: string): string {
  const lines = patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("--- "));
  return start >= 0 ? lines.slice(start).join("\n") : patch;
}

/**
 * Constrói o unified diff do PR. Para cada arquivo mudado:
 *   modified → diff base×head; added → /dev/null×head; removed → base×/dev/null.
 * Arquivo sem mudança de conteúdo (patch só de header) é omitido.
 */
export function buildUnifiedDiffFromPR(pr: GitPRDiff): string {
  const baseByPath = new Map(pr.baseFiles.map((f) => [f.filePath, f.content]));
  const headByPath = new Map(pr.headFiles.map((f) => [f.filePath, f.content]));
  const chunks: string[] = [];

  for (const cf of pr.changedFiles) {
    const path = cf.filePath;
    const oldPath = cf.oldPath || path;
    const before = cf.status === "added" ? "" : baseByPath.get(oldPath) ?? "";
    const after = cf.status === "removed" ? "" : headByPath.get(path) ?? "";
    if (before === after) continue;

    const oldName = cf.status === "added" ? "/dev/null" : `a/${oldPath}`;
    const newName = cf.status === "removed" ? "/dev/null" : `b/${path}`;
    const patch = createTwoFilesPatch(oldName, newName, before, after, "", "", { context: 3 });
    const body = stripPatchHeader(patch);
    // corpo vazio (sem hunks) = sem mudança real
    if (!/@@/.test(body)) continue;
    chunks.push(`diff --git a/${oldPath} b/${path}\n${body.trimEnd()}\n`);
  }

  return chunks.join("");
}

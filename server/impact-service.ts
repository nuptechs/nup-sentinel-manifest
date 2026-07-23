// ─────────────────────────────────────────────
// impact-service — ADR-0019 Ondas 4–5 (fonte ÚNICA do laudo de impacto)
//
// Núcleo "diff → laudo completo" para os canais NOVOS: webhook de PR (Onda 4)
// e GitHub App (Onda 5). ESPELHA o caminho `diff` da rota impact-diff (que
// mantém também o caminho `files` e permanece a referência provada em prod) —
// consolidar a rota sobre este serviço é refactor futuro declarado; até lá,
// mudanças de laudo precisam tocar os DOIS lugares (nota anti-drift).
// ─────────────────────────────────────────────

import { storage } from "./storage";

export interface ImpactBuildResult {
  ok: true;
  payload: any;
  markdown: string;
  signature: any | null;
}
export interface ImpactBuildError {
  ok: false;
  status: number;
  message: string;
}

export async function buildImpactForDiff(
  projectId: number,
  diff: string,
): Promise<ImpactBuildResult | ImpactBuildError> {
  const snapshots = await storage.getAnalysisSnapshots(projectId);
  if (!snapshots.length) {
    return { ok: false, status: 404, message: "No analysis snapshot for this project yet — run an analysis first." };
  }
  const manifest = (snapshots[0].manifestJson as any) || {};
  const { computeImpactForDiff, renderImpactDiffMarkdown } = await import("./analyzers/impact-analyzer");
  const { retrieveAdrsForFiles, renderApplicableAdrsMarkdown } = await import("./analyzers/adr-retrieval");

  const projectRec = await storage.getProject(projectId);
  let projectOntology: any = null;
  try {
    const { parseProjectOntology } = await import("./analyzers/functional-impact");
    projectOntology = parseProjectOntology((projectRec as any)?.businessOntology ?? null);
  } catch (err) {
    console.error(`[impact-service] ontologia do projeto ${projectId} inválida — usando default: ${err}`);
  }

  const report = computeImpactForDiff(manifest, diff, { ontology: projectOntology });
  // ADR-0021 r2 Onda 4 — consumidores cross-repo do índice de símbolos
  // (env-gated + fail-soft: sem envs/índice fora ⇒ laudo byte-a-byte).
  try {
    const { consumersConfigFromEnv, fetchCrossRepoConsumers, repoSlugOf } = await import(
      "./analyzers/cross-repo-consumers"
    );
    const cfg = consumersConfigFromEnv();
    const repoSlug = repoSlugOf((projectRec as any)?.gitRepoUrl);
    const alerts = (report as any)?.breaking?.alerts ?? [];
    if (cfg && repoSlug && alerts.length > 0) {
      const section = await fetchCrossRepoConsumers(
        alerts.map((a: any) => a.symbol),
        repoSlug,
        cfg,
      );
      if (section) (report as any).crossRepoConsumers = section;
    }
  } catch {
    /* fail-soft: laudo segue sem a seção */
  }
  const filesForAdr: string[] = report.perFile.map((f) => f.file);
  const applicableAdrs = retrieveAdrsForFiles(Array.isArray(manifest.adrIndex) ? manifest.adrIndex : [], filesForAdr);

  // frescor do mapa (a mesma régua da rota — snapshot velho nunca em silêncio)
  const generatedAt = typeof manifest.generatedAt === "string" ? manifest.generatedAt : null;
  const ageDays = generatedAt ? Math.floor((Date.now() - new Date(generatedAt).getTime()) / 86400000) : null;
  let unknownToMap: string[] = [];
  try {
    const known = await storage.getSourceFiles(projectId);
    const knownPaths = known.map((k) => (k.filePath || "").replace(/^\.?\/+/, ""));
    unknownToMap = filesForAdr.filter((p0) => {
      const norm = p0.replace(/^\.?\/+/, "");
      return !knownPaths.some((kp) => kp === norm || kp.endsWith("/" + norm) || norm.endsWith("/" + kp));
    });
  } catch (err) {
    console.error(`[impact-service] frescor fail-soft: ${err}`);
  }
  const mapInfo = {
    generatedAt,
    ageDays,
    stale: ageDays !== null && ageDays > 14,
    diffFilesUnknownToMap: unknownToMap,
    note:
      unknownToMap.length > 0
        ? "arquivos do diff DESCONHECIDOS do mapa — snapshot desatualizado, arquivo novo/renomeado, ou fora do escopo analisado; reanalise para fidelidade"
        : ageDays !== null && ageDays > 14
          ? "mapa com mais de 14 dias — considere reanalisar"
          : null,
  };

  const payload = { projectId, analysisRunId: snapshots[0].analysisRunId, mapInfo, ...report, applicableAdrs };

  const hmacKey = process.env.MANIFEST_REPORT_HMAC_KEY;
  let signature: any | null = null;
  if (hmacKey) {
    const { signReport } = await import("./analyzers/report-signature");
    signature = signReport(payload, hmacKey);
  }

  let markdown = renderImpactDiffMarkdown(report, { projectName: (projectRec as any)?.name });
  if (mapInfo.generatedAt || mapInfo.diffFilesUnknownToMap.length) {
    const staleFlag = mapInfo.stale ? " ⚠️ DESATUALIZADO" : "";
    let header = `> **Mapa do sistema:** gerado em ${mapInfo.generatedAt ?? "?"} (${mapInfo.ageDays ?? "?"} dia(s))${staleFlag}`;
    if (mapInfo.diffFilesUnknownToMap.length) {
      const fileList = mapInfo.diffFilesUnknownToMap.slice(0, 5).map((f) => "`" + f + "`").join(", ");
      header += `\n> ⚠️ ${mapInfo.diffFilesUnknownToMap.length} arquivo(s) do diff DESCONHECIDO(S) do mapa: ${fileList}${mapInfo.diffFilesUnknownToMap.length > 5 ? "…" : ""} — ${mapInfo.note}`;
    }
    markdown = markdown.replace("\n", `\n\n${header}\n`);
  }
  if (applicableAdrs.length) markdown += "\n" + renderApplicableAdrsMarkdown(applicableAdrs);
  if (signature) {
    const { renderSignatureFooter } = await import("./analyzers/report-signature");
    markdown += "\n" + renderSignatureFooter(signature);
  }

  return { ok: true, payload, markdown, signature };
}

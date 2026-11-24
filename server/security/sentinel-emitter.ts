/**
 * Sentinel emitter — translates SecurityOmissionEngine output into Finding v2
 * payloads and POSTs them to the orchestrator (`nup-sentinel`) so the
 * correlator can merge them with runtime + adversarial signals.
 *
 * Closes the wiring for:
 *   - Vácuo 1 (Permission drift, eixo H⁺ from MATRIZ-COMPETITIVA.md)
 *   - Vácuo 4 (Adversarial confirmer, eixo P): the `unprotected_handler`
 *     subtype emitted here is exactly what `HttpProbe` confirms in Onda 4.
 *
 * This is best-effort — Sentinel offline must NEVER fail a Manifest analysis
 * run. All failures are logged and swallowed.
 *
 * Configured via env:
 *   SENTINEL_URL          — base URL of the orchestrator (e.g. https://sentinel.nuptechs.com)
 *   SENTINEL_API_KEY      — apikey from `provision-sentinel-key.js`. Tenant-scoped
 *                           when formatted `key:orgId`; the orchestrator enforces.
 *   SENTINEL_PROJECT_ID   — Sentinel project that owns this Manifest project's findings
 *   SENTINEL_TIMEOUT_MS   — per-request timeout (default 5000)
 *
 * Alvo real do achado (ADR — carimbo de repo/ref/sourceFiles p/ a correção):
 *   MANIFEST_EMIT_RESOLVED_TARGET — default OFF. ON ⇒ findings de rota saem com
 *                           `symbolRef.repo`/`.ref` + `codeContext.endpoints[].sourceFiles`
 *                           (o que a correção do Sentinel lê). OFF ⇒ byte-a-byte de hoje.
 *   MANIFEST_DEFAULT_REPO_OWNER — owner usado ao derivar o repo de `<name>-cron`
 *                           quando o payload não traz `repo` nem gitRepoUrl (default `nuptechs`).
 *
 * Absent SENTINEL_URL or SENTINEL_API_KEY → emitter is a no-op (returns
 * `{ skipped: true, reason }`). This lets local Manifest dev work without
 * any Sentinel running.
 */
import type { SecurityFinding } from "./omission-engine";
import type { ConsistencyFinding } from "../analyzers/frontend-backend-consistency";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * SENTINEL_API_KEY pode vir como `chave:orgId` (tenant-scoped) e/ou múltiplas
 * entradas separadas por vírgula. O Sentinel autentica comparando SÓ a parte
 * `chave` (antes do `:`) — então o header X-Sentinel-Key deve levar a chave NUA,
 * não `chave:orgId`, senão dá 401. Retorna a 1ª chave + o orgId embutido (se
 * houver), pra derivar a organização sem env extra.
 */
export function parseSentinelKey(raw: string | undefined): { apiKey: string; organizationId: string | undefined } {
  const firstEntry = (raw || "").split(",")[0]?.trim() || "";
  const colonIdx = firstEntry.indexOf(":");
  if (colonIdx < 0) return { apiKey: firstEntry, organizationId: undefined };
  return {
    apiKey: firstEntry.slice(0, colonIdx).trim(),
    organizationId: firstEntry.slice(colonIdx + 1).trim() || undefined,
  };
}

type EmitContext = {
  manifestProjectId: number;
  analysisRunId: number;
  /**
   * Alvo REAL do run analisado — preenchido pelo pipeline, consumido SÓ quando a
   * flag MANIFEST_EMIT_RESOLVED_TARGET está ligada. Sem a flag (default), estes
   * campos são ignorados e a emissão sai byte-a-byte igual à de hoje.
   *
   *  - `repo`: owner/name do repositório analisado (ex. `nuptechs/easynup`).
   *  - `ref`:  gitSha analisado (o `symbolRef.ref` que a correção do Sentinel usa
   *            para ler o arquivo no commit exato via GitHub Contents API).
   *  - `sourceFileByRoute`: mapa `"<MÉTODO> <endpoint>"` → caminho-fonte REAL do
   *            handler de backend daquela rota (vem de `endpointImpacts[].sourceFile`,
   *            que é o arquivo do nó CONTROLLER — NÃO o componente de frontend que
   *            o catálogo via interações carrega). A chave casa com o
   *            `symbolRef.identifier` de rota (`symbolRefFor`).
   */
  repo?: string | null;
  ref?: string | null;
  sourceFileByRoute?: Record<string, string>;
};

/** Flag (default OFF): carimba alvo real (repo/ref/sourceFiles) nos findings. */
export function emitResolvedTargetEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.MANIFEST_EMIT_RESOLVED_TARGET || "").trim());
}

/**
 * Deriva o slug `owner/name` do repositório analisado, FAIL-CLOSED: devolve
 * `undefined` quando não há como saber com segurança (um repo errado é pior que
 * um repo vazio). Precedência:
 *   1. `optRepo` — campo explícito do payload de /api/analyze (futuro: o job do
 *      Sentinel pode passar `options.repo`; hoje ele manda só `<name>-cron`).
 *   2. `gitRepoUrl` do projeto — quando o projeto foi conectado via git/connect.
 *   3. Derivação do `projectName` (`<name>-cron` → `<name>`) + owner default
 *      (`MANIFEST_DEFAULT_REPO_OWNER`, default `nuptechs`).
 * Valida o shape `owner/name` (via o MESMO parser do Sentinel seria ideal, mas
 * aqui basta owner+name não-vazios, sem `/` sobrando).
 */
export function resolveRepoSlug(args: {
  optRepo?: string | null;
  gitRepoUrl?: string | null;
  projectName?: string | null;
  defaultOwner?: string | null;
}): string | undefined {
  // owner e name só com os caracteres que o GitHub aceita; nada de slug chutado.
  const SEG = /^[A-Za-z0-9._-]+$/;
  const asSlug = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    let s = String(raw).trim();
    if (!s) return undefined;
    // git@host:owner/name.git
    const scp = s.match(/^[^@]+@[^:]+:(.+)$/);
    if (scp) s = scp[1];
    // scheme://host/owner/name(...)
    s = s.replace(/^[a-z]+:\/\/[^/]+\//i, "");
    s = s.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    const parts = s.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    const [owner, name] = parts;
    if (!SEG.test(owner) || !SEG.test(name)) return undefined;
    return `${owner}/${name}`;
  };

  // 1. campo explícito
  const fromOpt = asSlug(args.optRepo);
  if (fromOpt) return fromOpt;
  // 2. gitRepoUrl do projeto
  const fromUrl = asSlug(args.gitRepoUrl);
  if (fromUrl) return fromUrl;
  // 3. derivação FAIL-CLOSED: SÓ para o projeto do cron (`<name>-cron`), que é o
  //    único cujo nome carrega o repositório. Qualquer outro nome (headless-<ts>,
  //    "Customer Portal (Sample)", upload ad-hoc) NÃO vira repo — um slug errado
  //    é pior que nenhum.
  const pname = (args.projectName || "").trim();
  if (!/-cron$/i.test(pname)) return undefined;
  const owner = (args.defaultOwner || process.env.MANIFEST_DEFAULT_REPO_OWNER || "nuptechs").trim();
  const nameRaw = pname.replace(/-cron$/i, "");
  if (owner && nameRaw) return asSlug(`${owner}/${nameRaw}`);
  return undefined;
}

/**
 * Mapa `"<MÉTODO> <endpoint>"` → caminho-fonte REAL do handler de BACKEND, união
 * das duas fontes autoritativas de backend do pipeline:
 *   - `endpointImpacts` (nós CONTROLLER: Java/Spring/WsV1; `sourceFile` = arquivo
 *     do controller), independente do dedup do catálogo;
 *   - rotas Express (`extractExpressRoutes`, balde node-backend): `sourceFile` =
 *     arquivo da rota. Necessário porque os endpoints Express NÃO viram
 *     `endpointImpacts` (não são nós CONTROLLER) — sem isto, inquilino Node sai
 *     com repo+ref e SEM sourceFiles.
 * A chave casa o `symbolRef.identifier` de rota (`symbolRefFor` /
 * `${httpMethod.toUpperCase()} ${endpoint}`). COLISÃO (mesma chave → arquivos
 * diferentes) é DESCARTADA: melhor não carimbar do que apontar o arquivo errado.
 */
export function buildRouteSourceFileMap(args: {
  endpointImpacts?: Array<{ httpMethod?: string | null; endpoint?: string | null; sourceFile?: string | null }>;
  expressRoutes?: Array<{ method?: string | null; path?: string | null; sourceFile?: string | null }>;
}): Record<string, string> {
  const map: Record<string, string> = {};
  const conflicted = new Set<string>();
  const put = (method: string | null | undefined, endpoint: string | null | undefined, file: string | null | undefined) => {
    const m = String(method || "").trim().toUpperCase();
    const e = String(endpoint || "").trim();
    const f = typeof file === "string" ? file.trim() : "";
    if (!m || !e || !f) return;
    const key = `${m} ${e}`;
    if (conflicted.has(key)) return;
    if (map[key] && map[key] !== f) { delete map[key]; conflicted.add(key); return; }
    map[key] = f;
  };
  for (const i of args.endpointImpacts || []) put(i?.httpMethod, i?.endpoint, i?.sourceFile);
  for (const r of args.expressRoutes || []) put(r?.method, r?.path, r?.sourceFile);
  return map;
}

type EmitResult =
  | { skipped: true; reason: string }
  | { skipped: false; sessionId: string; emitted: number; rejected: number };

type FindingV2Payload = {
  sessionId: string;
  projectId: string;
  source: "auto_manifest";
  type: "permission_drift" | "inconsistency" | "functional_overlap" | "lifecycle_gap";
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  description: string;
  subtype: string;
  schemaVersion: "2.0.0";
  evidences: Array<{
    source: "auto_manifest";
    sourceRunId: string;
    observation: string;
    observedAt: string;
  }>;
  symbolRef: { kind: "route" | "entity"; identifier: string; repo?: string; ref?: string } | null;
  // Alvo de arquivo-fonte que a CORREÇÃO do Sentinel lê
  // (`correction.service.js:_extractFilePaths` → `codeContext.endpoints[].sourceFiles`).
  // Presente SÓ sob a flag MANIFEST_EMIT_RESOLVED_TARGET e só quando há arquivo
  // real resolvido. Shape mínimo: só `sourceFiles` (caminhos repo-relative). NÃO
  // preenche `controllerClass`/`serviceClass` — a correção os trata como CAMINHO,
  // então um nome de classe nu ali viraria um path inexistente.
  codeContext?: { endpoints: Array<{ sourceFiles: string[] }> };
  manifestProjectId: string;
  manifestRunId: string;
  organizationId?: string;
};

/**
 * Carimba o alvo REAL num payload já montado (flag ON). FAIL-CLOSED e aditivo:
 *   - `symbolRef.repo`/`symbolRef.ref`: só quando `ctx.repo` resolveu; `ref` só
 *     quando há gitSha. Vale para qualquer `symbolRef` (rota ou entidade).
 *   - `codeContext.endpoints[].sourceFiles`: só para findings de ROTA cujo
 *     identifier casa um arquivo-fonte real no mapa `ctx.sourceFileByRoute`.
 * Quando nada resolve, devolve o payload inalterado — então a flag ON sem alvo
 * conhecido emite exatamente como a flag OFF.
 */
function withResolvedTarget(p: FindingV2Payload, ctx: EmitContext): FindingV2Payload {
  let out = p;
  if (out.symbolRef && ctx.repo) {
    out = {
      ...out,
      symbolRef: {
        ...out.symbolRef,
        repo: ctx.repo,
        ...(ctx.ref ? { ref: ctx.ref } : {}),
      },
    };
  }
  if (out.symbolRef?.kind === "route" && ctx.sourceFileByRoute) {
    const file = ctx.sourceFileByRoute[out.symbolRef.identifier];
    if (file) {
      out = { ...out, codeContext: { endpoints: [{ sourceFiles: [file] }] } };
    }
  }
  return out;
}

const SUBTYPE_BY_TYPE: Record<SecurityFinding["type"], string> = {
  UNPROTECTED_OUTLIER: "unprotected_handler",
  PRIVILEGE_ESCALATION: "privilege_escalation",
  MISSING_PROTECTION: "missing_protection",
  SENSITIVE_DATA_EXPOSURE: "sensitive_exposure",
  INCONSISTENT_PROTECTION: "inconsistent_protection",
  COVERAGE_GAP: "coverage_gap",
};

function mapSeverity(s: SecurityFinding["severity"]): FindingV2Payload["severity"] {
  return s === "info" ? "low" : s;
}

function symbolRefFor(f: SecurityFinding): FindingV2Payload["symbolRef"] {
  const target = f.evidence?.targetEntry;
  if (!target?.endpoint || !target?.httpMethod) return null;
  return {
    kind: "route",
    identifier: `${target.httpMethod.toUpperCase()} ${target.endpoint}`,
  };
}

function translate(
  f: SecurityFinding,
  ctx: EmitContext,
  sessionId: string,
  organizationId: string | undefined
): FindingV2Payload {
  const observedAt = new Date().toISOString();
  const description = f.recommendation
    ? `${f.description}\n\nRecommendation: ${f.recommendation}`
    : f.description;
  return {
    sessionId,
    projectId: String(ctx.manifestProjectId),
    source: "auto_manifest",
    type: "permission_drift",
    severity: mapSeverity(f.severity),
    title: f.title,
    description,
    subtype: SUBTYPE_BY_TYPE[f.type] ?? "permission_drift",
    schemaVersion: "2.0.0",
    evidences: [
      {
        source: "auto_manifest",
        sourceRunId: String(ctx.analysisRunId),
        observation: f.description,
        observedAt,
      },
    ],
    symbolRef: symbolRefFor(f),
    manifestProjectId: String(ctx.manifestProjectId),
    manifestRunId: String(ctx.analysisRunId),
    ...(organizationId ? { organizationId } : {}),
  };
}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs: number }
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep as text
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Emit a batch of SecurityFindings to Sentinel as Finding v2 payloads.
 *
 * Best-effort: any failure is logged with `[sentinel-emitter]` prefix and the
 * function resolves to `{ skipped: true }` instead of throwing. The Manifest
 * analysis pipeline keeps running.
 */
export async function emitSecurityFindings(
  findings: SecurityFinding[],
  ctx: EmitContext
): Promise<EmitResult> {
  if (findings.length === 0) {
    return { skipped: true, reason: "no findings to emit" };
  }
  return emitToSentinel(
    ctx,
    (sessionId, organizationId) => findings.map((f) => translate(f, ctx, sessionId, organizationId)),
    "permission_drift"
  );
}

/**
 * Emit a batch of ConsistencyFindings (frontend calls with no matching backend
 * endpoint) to Sentinel as `inconsistency` findings. Same best-effort contract
 * and transport as emitSecurityFindings — reuses emitToSentinel.
 */
export async function emitConsistencyFindings(
  findings: ConsistencyFinding[],
  ctx: EmitContext
): Promise<EmitResult> {
  if (findings.length === 0) {
    return { skipped: true, reason: "no findings to emit" };
  }
  return emitToSentinel(
    ctx,
    (sessionId, organizationId) =>
      findings.map((f) => translateConsistency(f, ctx, sessionId, organizationId)),
    "inconsistency"
  );
}

function translateConsistency(
  f: ConsistencyFinding,
  ctx: EmitContext,
  sessionId: string,
  organizationId: string | undefined
): FindingV2Payload {
  const observedAt = new Date().toISOString();
  const route = `${(f.httpMethod || "ANY").toUpperCase()} ${f.url}`;
  return {
    sessionId,
    projectId: String(ctx.manifestProjectId),
    source: "auto_manifest",
    type: "inconsistency",
    severity: f.severity,
    title: f.title,
    description: f.description,
    subtype: f.subtype,
    schemaVersion: "2.0.0",
    evidences: [
      {
        source: "auto_manifest",
        sourceRunId: String(ctx.analysisRunId),
        observation: `${route} chamado em ${f.sourceFile}:${f.lineNumber} (${f.component}) sem endpoint de backend correspondente`,
        observedAt,
      },
    ],
    symbolRef: { kind: "route", identifier: route },
    manifestProjectId: String(ctx.manifestProjectId),
    manifestRunId: String(ctx.analysisRunId),
    ...(organizationId ? { organizationId } : {}),
  };
}

// ── ADR-070 Onda 4 — críticos de grafo no loop + Tribunal ──────────────────

type OverlapItem = { entity: string; opClass: string; severity: string; reason: string; endpoints: Array<{ operation: string }> };
type LifecycleItem = { entity: string; kind: string; severity: string; reason: string; has: string[] };

/**
 * Emit sobreposições funcionais (grupos de escrita = 2+ caminhos para a mesma
 * entidade) como findings `functional_overlap`. Só os de escrita (precisão).
 */
export async function emitOverlapFindings(
  overlaps: OverlapItem[],
  ctx: EmitContext
): Promise<EmitResult> {
  const writes = overlaps.filter((o) => o.severity === "review");
  if (writes.length === 0) return { skipped: true, reason: "no overlap findings to emit" };
  return emitToSentinel(
    ctx,
    (sessionId, organizationId) =>
      writes.map((o) => {
        const observedAt = new Date().toISOString();
        return {
          sessionId,
          projectId: String(ctx.manifestProjectId),
          source: "auto_manifest" as const,
          type: "functional_overlap" as const,
          severity: "medium" as const,
          title: `${o.endpoints.length} caminhos fazem ${o.opClass} de '${o.entity}'`,
          description: o.reason,
          subtype: `${o.opClass.toLowerCase()}_overlap`,
          schemaVersion: "2.0.0" as const,
          evidences: [{
            source: "auto_manifest" as const,
            sourceRunId: String(ctx.analysisRunId),
            observation: o.reason,
            observedAt,
          }],
          symbolRef: { kind: "entity" as const, identifier: o.entity },
          manifestProjectId: String(ctx.manifestProjectId),
          manifestRunId: String(ctx.analysisRunId),
          ...(organizationId ? { organizationId } : {}),
        };
      }),
    "functional_overlap"
  );
}

/**
 * Emit buracos de ciclo de vida (entidade escrita sem leitura própria) como
 * findings `lifecycle_gap`. Só os de severidade alta (writable-not-readable).
 */
export async function emitCompletenessFindings(
  findings: LifecycleItem[],
  ctx: EmitContext
): Promise<EmitResult> {
  const high = findings.filter((f) => f.severity === "high");
  if (high.length === 0) return { skipped: true, reason: "no lifecycle findings to emit" };
  return emitToSentinel(
    ctx,
    (sessionId, organizationId) =>
      high.map((f) => {
        const observedAt = new Date().toISOString();
        return {
          sessionId,
          projectId: String(ctx.manifestProjectId),
          source: "auto_manifest" as const,
          type: "lifecycle_gap" as const,
          severity: "high" as const,
          title: `'${f.entity}' é escrita (${f.has.join("/")}) mas não tem leitura própria`,
          description: f.reason,
          subtype: f.kind.toLowerCase(),
          schemaVersion: "2.0.0" as const,
          evidences: [{
            source: "auto_manifest" as const,
            sourceRunId: String(ctx.analysisRunId),
            observation: f.reason,
            observedAt,
          }],
          symbolRef: { kind: "entity" as const, identifier: f.entity },
          manifestProjectId: String(ctx.manifestProjectId),
          manifestRunId: String(ctx.analysisRunId),
          ...(organizationId ? { organizationId } : {}),
        };
      }),
    "lifecycle_gap"
  );
}

/**
 * Shared transport: create a session, build the payloads (with the resolved
 * sessionId), ingest them as one batch. Best-effort — any failure resolves to
 * `{ skipped: true }` and never throws, so a Manifest analysis run survives a
 * Sentinel outage. `buildPayloads` is a callback because each payload needs the
 * sessionId that only exists after the session is created.
 */
async function emitToSentinel(
  ctx: EmitContext,
  buildPayloads: (sessionId: string, organizationId: string | undefined) => FindingV2Payload[],
  label: string
): Promise<EmitResult> {
  const baseUrl = process.env.SENTINEL_URL?.replace(/\/+$/, "");
  const { apiKey, organizationId: keyOrgId } = parseSentinelKey(process.env.SENTINEL_API_KEY);
  const projectId = process.env.SENTINEL_PROJECT_ID;
  const organizationId = process.env.SENTINEL_ORG_ID || keyOrgId;
  const timeoutMs = Number(process.env.SENTINEL_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) return { skipped: true, reason: "SENTINEL_URL not set" };
  if (!apiKey) return { skipped: true, reason: "SENTINEL_API_KEY not set" };
  if (!projectId) return { skipped: true, reason: "SENTINEL_PROJECT_ID not set" };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-sentinel-key": apiKey,
  };

  // 1. Create a session for this analysis run so all findings group together.
  let sessionId: string;
  try {
    const { status, body } = await fetchJson(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      timeoutMs,
      body: JSON.stringify({
        projectId,
        userId: "nup-sentinel-manifest",
        metadata: {
          source: "auto_manifest",
          manifestProjectId: ctx.manifestProjectId,
          analysisRunId: ctx.analysisRunId,
        },
      }),
    });
    if (status !== 201 && status !== 200) {
      console.warn(
        `[sentinel-emitter] session create failed: HTTP ${status} ${JSON.stringify(body).slice(0, 200)}`
      );
      return { skipped: true, reason: `session create returned HTTP ${status}` };
    }
    const data = (body as { data?: { id?: string } })?.data;
    if (!data?.id) {
      console.warn(`[sentinel-emitter] session create returned no id`);
      return { skipped: true, reason: "session create returned no id" };
    }
    sessionId = data.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sentinel-emitter] session create error: ${msg}`);
    return { skipped: true, reason: `session create error: ${msg}` };
  }

  // 2. Build + ingest findings as a single batch.
  // O `projectId` do finding DEVE ser o projeto Sentinel (uuid), não o id
  // numérico do projeto interno do Manifest. Os translate setam
  // `projectId: manifestProjectId` por engano — isso faz os findings landarem
  // sob "16"/"19" (órfãos) em vez do projeto do sistema, e nunca convergirem no
  // Tribunal com os de outras naturezas. O `manifestProjectId` segue como campo
  // separado. Override central cobre todos os builders de uma vez.
  // Carimbo de alvo real atrás da flag (default OFF). OFF ⇒ `{ ...p, projectId }`
  // byte-a-byte como antes; ON ⇒ aditivo (repo/ref no symbolRef + codeContext com
  // o arquivo-fonte do handler), fail-closed quando o alvo não resolve.
  const resolveTarget = emitResolvedTargetEnabled();
  const payloads = buildPayloads(sessionId, organizationId).map((p) => {
    const base = { ...p, projectId };
    return resolveTarget ? withResolvedTarget(base, ctx) : base;
  });
  try {
    const { status, body } = await fetchJson(`${baseUrl}/api/findings/ingest`, {
      method: "POST",
      headers,
      timeoutMs,
      body: JSON.stringify(payloads),
    });
    if (status !== 201 && status !== 200) {
      console.warn(
        `[sentinel-emitter] ingest failed: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`
      );
      return { skipped: true, reason: `ingest returned HTTP ${status}` };
    }
    const parsed = body as {
      acceptedCount?: number;
      rejectedCount?: number;
      rejected?: unknown[];
    };
    const accepted = parsed?.acceptedCount ?? payloads.length;
    const rejected = parsed?.rejectedCount ?? 0;
    if (rejected > 0) {
      console.warn(
        `[sentinel-emitter] ${rejected}/${payloads.length} findings rejected: ${JSON.stringify(
          parsed.rejected
        ).slice(0, 400)}`
      );
    }
    console.log(
      `[sentinel-emitter] emitted ${accepted} ${label} findings (session=${sessionId}, run=${ctx.analysisRunId})`
    );
    return { skipped: false, sessionId, emitted: accepted, rejected };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sentinel-emitter] ingest error: ${msg}`);
    return { skipped: true, reason: `ingest error: ${msg}` };
  }
}

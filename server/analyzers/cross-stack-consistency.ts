// ─────────────────────────────────────────────────────────────────────────
// OBS-D12 (ADR-0036 WS-D) — DETECÇÃO TELA→ENDPOINT INEXISTENTE **CROSS-STACK**.
//
// O detector de hoje (`frontend-backend-consistency.ts`) acha a tela que chama um
// endpoint inexistente, mas SÓ dentro de UMA análise onde o backend foi parseado
// no MESMO run (same-stack): ele confia no `mappedBackendNode` que o matcher
// resolveu contra o backend daquele projeto. Quando o frontend vive num serviço
// (ex.: gateway/easynup) e o backend em OUTRO (ex.: identify/Java), toda chamada
// fica trivialmente "não-mapeada" — o detector same-stack teria de ser desligado
// (o próprio guard dele exige cobertura de backend no run).
//
// ESTE MÓDULO faz a checagem ATRAVESSANDO a fronteira de serviço: dada a lista de
// interações do frontend de um serviço + um INVENTÁRIO de endpoints que abrange
// VÁRIOS serviços (derivável do grafo unificado da OBS-D11) + (opcional) o
// conjunto de chamadas JÁ provadas por SÍMBOLO na junção cross-service (OBS-D04),
// acusa a chamada que não casa NENHUM endpoint de NENHUM serviço conhecido — o
// 404 cross-stack que o string-matching de um lado só não pega.
//
// HONESTIDADE / FALSO-POSITIVO (espelha o guard do same-stack e a cegueira do
// `orphan-surface.ts`): sem inventário de endpoints (`inventoryPresent:false`) o
// detector se declara CEGO e acusa ZERO — senão TODA chamada seria "inexistente"
// (o exato falso-positivo a evitar). Uma chamada JÁ resolvida por símbolo
// (OBS-D04) é consistente por prova e é pulada. PURA: nunca lança, nenhum I/O.
//
// INERTE por construção (régua D2): nenhum pipeline monta o inventário
// cross-service ainda (depende da OBS-D11 servida); sem ele, retorna cego. O
// contrato e o motor moram aqui; o produtor liga depois. "Nasce ◐."
// ─────────────────────────────────────────────────────────────────────────

import type { FrontendInteraction } from "./frontend-analyzer";

/** Endpoint conhecido, de QUALQUER serviço do inventário (abrange cross-stack). */
export interface EndpointRef {
  /** verbo HTTP em maiúsculas; `ANY`/ausente casa qualquer verbo. */
  method?: string | null;
  /** path do endpoint (`/api/x/:id` — `:param` casa qualquer segmento). */
  path: string;
  /** serviço dono do endpoint (p/ o relatório dizer onde procurou/achou). */
  service: string;
}

export interface CrossStackFinding {
  id: string;
  subtype: "missing_backend_endpoint_cross_stack";
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  url: string;
  httpMethod: string | null;
  component: string;
  sourceFile: string;
  lineNumber: number;
  /** serviço de origem da tela (quando conhecido). */
  fromService?: string;
  /** serviços onde se procurou o endpoint e não se achou. */
  servicesSearched: string[];
  declaredRoles: string[];
}

export interface DetectCrossStackOptions {
  /** abaixo desta confiança a interação é ignorada (evita chute). Default 0.5. */
  minConfidence?: number;
  /** serviço dono do frontend analisado (rotula o finding). */
  fromService?: string;
  /**
   * chaves `METHOD url` (upper METHOD) de chamadas JÁ provadas consistentes pela
   * junção cross-service por símbolo (OBS-D04) — puladas (consistência por prova).
   */
  resolvedBySymbol?: Set<string>;
}

export interface CrossStackReport {
  /** false = sem inventário de endpoints → detector CEGO (honesto), zero findings. */
  inventoryPresent: boolean;
  findings: CrossStackFinding[];
  /** nº de chamadas HTTP (method,url) únicas efetivamente avaliadas. */
  checked: number;
  /** serviços presentes no inventário (onde a busca aconteceu). */
  servicesInInventory: string[];
  summary: string;
}

const DEFAULT_MIN_CONFIDENCE = 0.5;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function segs(p: string): string[] {
  return (p || "").split("?")[0].split("/").filter(Boolean);
}

/** URL concreta casa o path do endpoint? (`:param` casa qualquer segmento.) */
export function urlMatchesEndpointPath(url: string, path: string): boolean {
  const us = segs(url);
  const rs = segs(path);
  if (us.length !== rs.length || us.length === 0) return false;
  for (let i = 0; i < rs.length; i++) {
    if (rs[i].startsWith(":") || rs[i] === "*") continue;
    if (rs[i] !== us[i]) return false;
  }
  return true;
}

function methodMatches(callMethod: string, ep: EndpointRef): boolean {
  const em = (ep.method || "ANY").toUpperCase();
  if (em === "ANY" || em === "ALL") return true;
  return em === callMethod;
}

/**
 * Detecta telas que chamam endpoints inexistentes ATRAVÉS de serviços. PURA.
 * Varre o inventário INTEIRO (todos os serviços) por chamada; só acusa quando
 * NENHUM endpoint de NENHUM serviço casa e a chamada não foi provada por símbolo.
 */
export function detectCrossStackInconsistencies(
  interactions: FrontendInteraction[] | null | undefined,
  endpointInventory: EndpointRef[] | null | undefined,
  opts: DetectCrossStackOptions = {},
): CrossStackReport {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const inventory = Array.isArray(endpointInventory) ? endpointInventory.filter((e) => e && typeof e.path === "string" && e.path) : [];
  const servicesInInventory = Array.from(new Set(inventory.map((e) => e.service).filter((s): s is string => typeof s === "string" && !!s))).sort();
  const resolvedBySymbol = opts.resolvedBySymbol instanceof Set ? opts.resolvedBySymbol : new Set<string>();

  // CEGO sem inventário: declara e acusa zero (anti-falso-positivo).
  if (inventory.length === 0) {
    return {
      inventoryPresent: false,
      findings: [],
      checked: 0,
      servicesInInventory,
      summary: "Detector cross-stack cego: nenhum inventário de endpoints fornecido (OBS-D11 ainda não serve o grafo unificado). Zero acusações — honesto.",
    };
  }

  const findings: CrossStackFinding[] = [];
  const seen = new Set<string>();
  let checked = 0;

  for (const it of interactions || []) {
    if (!it || it.interactionCategory !== "HTTP") continue;
    if (!it.url) continue;
    if (typeof it.confidence === "number" && it.confidence < minConfidence) continue;

    const method = (it.httpMethod || "ANY").toUpperCase();
    const key = `${method} ${it.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checked++;

    // provada consistente pela junção por símbolo (OBS-D04) → não é 404.
    if (resolvedBySymbol.has(key)) continue;

    // casa algum endpoint de QUALQUER serviço? (cross-stack) → consistente.
    let matched = false;
    for (const ep of inventory) {
      if (!methodMatches(method, ep)) continue;
      if (urlMatchesEndpointPath(it.url, ep.path)) { matched = true; break; }
    }
    if (matched) continue;

    const isWrite = WRITE_METHODS.has(method);
    findings.push({
      id: `fe-be-xstack:${key}`,
      subtype: "missing_backend_endpoint_cross_stack",
      severity: isWrite ? "high" : "medium",
      title: `Tela chama endpoint inexistente (cross-stack): ${key}`,
      description:
        `O componente "${it.component}" (${it.sourceFile}:${it.lineNumber}) faz ${method} ${it.url}, ` +
        `mas nenhum endpoint corresponde a essa chamada em nenhum dos serviços conhecidos ` +
        `(${servicesInInventory.join(", ") || "—"}). Provável 404 cross-stack — endpoint nunca ` +
        `implementado, renomeado ou removido no serviço de backend. A tela oferece a ação; nenhum backend a atende.`,
      url: it.url,
      httpMethod: it.httpMethod,
      component: it.component,
      sourceFile: it.sourceFile,
      lineNumber: it.lineNumber,
      ...(opts.fromService ? { fromService: opts.fromService } : {}),
      servicesSearched: servicesInInventory,
      declaredRoles: it.detectedRoles || [],
    });
  }

  const summary = findings.length === 0
    ? `Nenhuma inconsistência cross-stack: as ${checked} chamada(s) avaliada(s) casam um endpoint em ${servicesInInventory.length} serviço(s).`
    : `${findings.length} chamada(s) tela→endpoint inexistente cross-stack de ${checked} avaliada(s), buscadas em ${servicesInInventory.length} serviço(s): ${servicesInInventory.join(", ")}.`;

  return { inventoryPresent: true, findings, checked, servicesInInventory, summary };
}

/**
 * Deriva um inventário de endpoints a partir dos nós de um grafo (unificado ou
 * shaped): nós CONTROLLER/ROUTE com verbo+path no metadata, e nós `wsv1:`/
 * `route:` reconhecíveis. PURO, best-effort — só o que o nó PROVA carregar.
 * Útil p/ montar o inventário cross-stack sem acoplar ao formato de um serviço.
 */
export function endpointInventoryFromNodes(
  nodes: { id: string; type?: string; service?: string; metadata?: Record<string, unknown> | null }[] | null | undefined,
  defaultService = "",
): EndpointRef[] {
  const out: EndpointRef[] = [];
  const seen = new Set<string>();
  for (const n of nodes || []) {
    if (!n || typeof n.id !== "string") continue;
    const type = String(n.type || "");
    if (type !== "CONTROLLER" && type !== "ROUTE") continue;
    const meta = n.metadata || {};
    const method = typeof meta.httpMethod === "string" ? meta.httpMethod.toUpperCase() : undefined;
    const path = typeof meta.fullPath === "string" ? meta.fullPath : undefined;
    if (!path) continue;
    const service = n.service || defaultService;
    const key = `${service}|${method || "ANY"}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...(method ? { method } : {}), path, service });
  }
  return out;
}

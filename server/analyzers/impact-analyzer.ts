/**
 * Análise de impacto cross-stack (ADR-070 Onda 2 — semente do Living System Graph).
 *
 * Responde "se eu mudar o símbolo X, o que é impactado?" — o **blast radius**
 * front→endpoint→service→repo→entidade — SEM re-analisar: lê o manifest já
 * persistido (`analysisSnapshots.manifestJson`), que por endpoint já carrega
 * `fullCallChain`, `serviceMethods`, `repositoryMethods` e `entitiesTouched`, e as
 * telas que chamam cada endpoint. Reuso-primeiro (§2.5): zero pipeline novo.
 *
 * É o gap que nenhuma ferramenta de mercado mapeia (UI→API→DB cross-stack), aqui
 * realizado por consulta sobre o grafo que o Manifest já computa. Determinístico.
 */

export interface ImpactedEndpoint {
  path: string;
  method: string;
  controller: string;
  controllerMethod: string;
  matchedVia: string; // por que casou (controller | service:Foo.bar | repo | callChain | entity | sourceFile)
  entitiesTouched: string[];
}

export interface ImpactedScreen {
  name: string;
  route: string | null;
  viaEndpoints: string[]; // "METHOD path"
}

export interface ImpactReport {
  symbol: string;
  found: boolean;
  summary: {
    endpoints: number;
    screens: number;
    entities: number;
  };
  impactedEndpoints: ImpactedEndpoint[];
  impactedScreens: ImpactedScreen[];
  entitiesTouched: string[];
}

const MIN_SYMBOL_LEN = 3;

function lc(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase() : "";
}

/** True + a label quando `sym` (lowercased) aparece em algum campo do endpoint. */
function endpointMatch(ep: any, sym: string): string | null {
  const ctrl = lc(ep?.controller);
  const ctrlMethod = `${lc(ep?.controller)}.${lc(ep?.controllerMethod)}`;
  if (ctrl && ctrl.includes(sym)) return "controller";
  if (ep?.controllerMethod && ctrlMethod.includes(sym)) return `controller:${ep.controller}.${ep.controllerMethod}`;
  for (const m of ep?.serviceMethods || []) {
    if (lc(m).includes(sym)) return `service:${m}`;
  }
  for (const m of ep?.repositoryMethods || []) {
    if (lc(m).includes(sym)) return `repository:${m}`;
  }
  for (const c of ep?.fullCallChain || []) {
    if (lc(c).includes(sym)) return `callChain:${c}`;
  }
  for (const e of ep?.entitiesTouched || []) {
    if (lc(e) === sym || lc(e).includes(sym)) return `entity:${e}`;
  }
  if (ep?.sourceFile && lc(ep.sourceFile).includes(sym)) return "sourceFile";
  // Match por path/rota: cobre o caso em que o manifest só tem o lado frontend
  // resolvido (controller/service vazios) — ainda assim responde "quem chama esta
  // rota". Também permite consultar diretamente por endpoint (ex: "findContract.v1").
  if (ep?.path && lc(ep.path).includes(sym)) return `path:${ep.path}`;
  return null;
}

/**
 * Computa o blast radius de `symbol` sobre um manifest gerado. Puro; sem I/O.
 * `symbol` pode ser: classe/método (`FooService`, `FooService.bar`), caminho de
 * arquivo (`Foo.java`/`foo.vue`), ou nome de entidade (`Contract`).
 */
export function computeImpact(manifest: any, symbol: string): ImpactReport {
  const sym = (symbol || "").trim().toLowerCase();
  const empty: ImpactReport = {
    symbol,
    found: false,
    summary: { endpoints: 0, screens: 0, entities: 0 },
    impactedEndpoints: [],
    impactedScreens: [],
    entitiesTouched: [],
  };
  if (sym.length < MIN_SYMBOL_LEN || !manifest) return empty;

  const endpoints: any[] = Array.isArray(manifest.endpoints) ? manifest.endpoints : [];
  const screens: any[] = Array.isArray(manifest.screens) ? manifest.screens : [];

  // 1) Endpoints diretamente impactados.
  const impactedEndpoints: ImpactedEndpoint[] = [];
  const matchedKeys = new Set<string>(); // "METHOD path" pra casar com telas
  const entities = new Set<string>();

  for (const ep of endpoints) {
    const via = endpointMatch(ep, sym);
    if (!via) continue;
    const path = String(ep.path ?? "");
    const method = String(ep.method ?? "ANY").toUpperCase();
    impactedEndpoints.push({
      path,
      method,
      controller: String(ep.controller ?? ""),
      controllerMethod: String(ep.controllerMethod ?? ""),
      matchedVia: via,
      entitiesTouched: Array.isArray(ep.entitiesTouched) ? ep.entitiesTouched : [],
    });
    matchedKeys.add(`${method} ${path}`);
    for (const e of ep.entitiesTouched || []) entities.add(String(e));
  }

  // 2) Se o símbolo É uma entidade declarada, agrega os endpoints que a tocam via
  //    accessedBy (pega quem lê/escreve a tabela mesmo sem aparecer no call chain).
  const declaredEntities: any[] = Array.isArray(manifest.entities) ? manifest.entities : [];
  for (const ent of declaredEntities) {
    if (lc(ent?.name) !== sym) continue;
    entities.add(String(ent.name));
    for (const acc of ent.accessedBy || []) {
      const path = String(acc.endpoint ?? "");
      if (!path) continue;
      const key = `${"ANY"} ${path}`;
      if (Array.from(matchedKeys).some((k) => k.endsWith(` ${path}`))) continue;
      matchedKeys.add(key);
      impactedEndpoints.push({
        path,
        method: "ANY",
        controller: String(acc.controller ?? ""),
        controllerMethod: String(acc.method ?? ""),
        matchedVia: `entityAccess:${ent.name}`,
        entitiesTouched: [String(ent.name)],
      });
    }
  }

  // 3) Telas impactadas: chamam algum endpoint impactado.
  const impactedScreens: ImpactedScreen[] = [];
  for (const sc of screens) {
    const via: string[] = [];
    for (const it of sc.interactions || []) {
      const path = String(it.endpoint ?? "");
      if (!path) continue;
      const method = String(it.httpMethod ?? "ANY").toUpperCase();
      if (matchedKeys.has(`${method} ${path}`) || Array.from(matchedKeys).some((k) => k.endsWith(` ${path}`))) {
        via.push(`${method} ${path}`);
      }
    }
    if (via.length) {
      impactedScreens.push({ name: String(sc.name ?? ""), route: sc.route ?? null, viaEndpoints: Array.from(new Set(via)) });
    }
  }

  // 3b) Tela casada DIRETAMENTE pelo símbolo (ex.: arquivo de frontend `ChatIa.vue`
  //     → tela "ChatIa"). A tela é impactada e seus endpoints viram "scope afetado"
  //     — SEM cascatear pra outras telas que chamam os mesmos endpoints (evita ruído).
  const screenNamed = new Set(impactedScreens.map((s) => s.name));
  for (const sc of screens) {
    const name = lc(sc?.name);
    const route = lc(sc?.route);
    const matchedName = (name && (name === sym || name.includes(sym))) || (route && route.includes(sym));
    if (!matchedName || screenNamed.has(String(sc.name ?? ""))) continue;
    const own: string[] = [];
    for (const it of sc.interactions || []) {
      const path = String(it.endpoint ?? "");
      if (!path) continue;
      const method = String(it.httpMethod ?? "ANY").toUpperCase();
      own.push(`${method} ${path}`);
    }
    impactedScreens.push({ name: String(sc.name ?? ""), route: sc.route ?? null, viaEndpoints: Array.from(new Set(own)) });
    screenNamed.add(String(sc.name ?? ""));
  }

  const found = impactedEndpoints.length > 0 || impactedScreens.length > 0 || entities.size > 0;
  return {
    symbol,
    found,
    summary: { endpoints: impactedEndpoints.length, screens: impactedScreens.length, entities: entities.size },
    impactedEndpoints,
    impactedScreens,
    entitiesTouched: Array.from(entities).sort(),
  };
}

// ─────────────────────────────────────────────
// Impacto de um DIFF (ADR-070 Onda 2 / Propósito 2) — "o fornecedor entregou
// estes N arquivos: o que foi impactado no sistema cliente?". Agrega o blast
// radius de cada arquivo mudado num único mapa. Reusa computeImpact; puro.
// ─────────────────────────────────────────────

export interface FileImpact {
  file: string;
  symbols: string[]; // símbolos candidatos derivados do arquivo
  summary: { endpoints: number; screens: number; entities: number };
}

export interface DiffImpactReport {
  files: number;
  matchedFiles: number;
  aggregate: {
    summary: { endpoints: number; screens: number; entities: number };
    impactedEndpoints: ImpactedEndpoint[];
    impactedScreens: ImpactedScreen[];
    entitiesTouched: string[];
  };
  perFile: FileImpact[];
}

const STRIP_SUFFIX = /(WsV\d+|Ws|ServiceV\d+|Service|RepositoryImpl|Repository|Controller|Resource|Endpoint|\.routes|\.route|\.spec|\.test|\.vue|\.component)$/i;

/** Deriva símbolos candidatos de um caminho de arquivo (basename, sem sufixos
 *  comuns, e o próprio caminho p/ match por sourceFile/path). */
export function symbolsForFile(filePath: string): string[] {
  if (!filePath || typeof filePath !== "string") return [];
  const base = filePath.split("/").pop() || filePath;
  const noExt = base.replace(/\.(java|ts|tsx|js|jsx|vue|kt)$/i, "");
  const stripped = noExt.replace(STRIP_SUFFIX, "");
  const out = new Set<string>();
  if (noExt.length >= 3) out.add(noExt);
  if (stripped.length >= 3 && stripped !== noExt) out.add(stripped);
  // caminho normalizado (sem extensão) p/ match por sourceFile/path
  const relNoExt = filePath.replace(/\.(java|ts|tsx|js|jsx|vue|kt)$/i, "");
  if (relNoExt.length >= 3) out.add(relNoExt);
  return Array.from(out);
}

function epKey(e: ImpactedEndpoint): string {
  return `${e.method} ${e.path}`;
}

/**
 * Computa o impacto agregado de um conjunto de arquivos mudados (um diff/entrega).
 * Para cada arquivo, deriva símbolos candidatos, roda computeImpact e une tudo.
 * Puro; sem I/O. Quanto mais completo o manifest (backend analisado), mais profundo.
 */
export function computeImpactForFiles(manifest: any, files: string[]): DiffImpactReport {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === "string" && f.trim()) : [];
  const aggEndpoints = new Map<string, ImpactedEndpoint>();
  const aggScreens = new Map<string, ImpactedScreen>();
  const aggEntities = new Set<string>();
  const perFile: FileImpact[] = [];
  let matchedFiles = 0;

  for (const file of list) {
    const symbols = symbolsForFile(file);
    const eps = new Map<string, ImpactedEndpoint>();
    const screens = new Map<string, ImpactedScreen>();
    const ents = new Set<string>();

    for (const sym of symbols) {
      const r = computeImpact(manifest, sym);
      if (!r.found) continue;
      for (const e of r.impactedEndpoints) eps.set(epKey(e), e);
      for (const s of r.impactedScreens) {
        const prev = screens.get(s.name);
        screens.set(s.name, prev ? { ...s, viaEndpoints: Array.from(new Set([...prev.viaEndpoints, ...s.viaEndpoints])) } : s);
      }
      for (const e of r.entitiesTouched) ents.add(e);
    }

    if (eps.size || screens.size || ents.size) matchedFiles++;
    perFile.push({
      file,
      symbols,
      summary: { endpoints: eps.size, screens: screens.size, entities: ents.size },
    });

    // une no agregado
    Array.from(eps.entries()).forEach(([k, v]) => aggEndpoints.set(k, v));
    Array.from(screens.entries()).forEach(([k, v]) => {
      const prev = aggScreens.get(k);
      aggScreens.set(k, prev ? { ...v, viaEndpoints: Array.from(new Set([...prev.viaEndpoints, ...v.viaEndpoints])) } : v);
    });
    Array.from(ents).forEach((e) => aggEntities.add(e));
  }

  return {
    files: list.length,
    matchedFiles,
    aggregate: {
      summary: { endpoints: aggEndpoints.size, screens: aggScreens.size, entities: aggEntities.size },
      impactedEndpoints: Array.from(aggEndpoints.values()),
      impactedScreens: Array.from(aggScreens.values()),
      entitiesTouched: Array.from(aggEntities).sort(),
    },
    perFile,
  };
}

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

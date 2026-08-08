#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// ADR-0035 (nup-sentinel) §4 — Camada CONFIG_PROVEN: o 6º tier de proveniência.
//
// ⚠️ TEMPLATE DO INTEGRATION-KIT — copie para `scripts/config-proven/` do SEU
// repo Java/Spring. É a versão GENÉRICA (sem pacote-raiz cravado) do resolvedor
// provado em campo no easynup. Não edite o algoritmo: parametrize por `--root`.
//
// O muro de Rice diz que o dispatch dinâmico é indecidível EM GERAL. Mas grande
// parte do "dinâmico" de uma app Spring é decidível LENDO O WIRING, sem runtime
// e sem LLM: o grafo de beans resolve `@Autowired MinhaPort` para a ÚNICA
// implementação registrada. Essa resolução é uma ARESTA PROVADA — não uma
// hipótese, não um K-candidato.
//
// Este resolvedor ataca o caso de MAIOR valor e mais determinístico:
//   Spring interface → impl, quando a resolução é ÚNICA
//   (exatamente 1 bean concreto implementa a interface, OU um @Primary desempata).
//
// Contraste com o `derive-edges.mjs` (ADR-0030) do manifest, que emite
// `interface-impl` como K-CANDIDATOS (toda impl de toda interface chamada —
// ~142k num monolito grande, ruidoso). CONFIG_PROVEN é o SUBCONJUNTO cuja
// resolução o container do Spring torna determinística → `resolution:'config'`.
//
// HONESTIDADE (ADR-0035 §5, §8):
//   - Interface com >1 bean e sem @Primary → AMBÍGUO, NÃO emitido (precisa de
//     @Qualifier no ponto de injeção ou runtime). Contado, nunca chutado.
//   - Interface Spring-Data (repositório com proxy em runtime) → 0 impl em fonte
//     → naturalmente NÃO emitida. É honesto: a impl não existe no código.
//   - `@Bean` de fábrica cujo corpo não revela o concreto (delega/builda) →
//     OPACO, não emitido.
//   - Só arestas onde a INTERFACE está sob o pacote-raiz do produto (`--root`).
//
// Uso:
//   node derive-config-edges.mjs --root <pkg> [--src <dir>] [--scip-json <idx>]
//   node derive-config-edges.mjs --root com.acme            # src/main/java
//   node derive-config-edges.mjs --root com.acme --scip-json /tmp/index.json
//
// `--root` é OBRIGATÓRIO (sem default). No original do easynup ele defaultava ao
// pacote daquele produto — num repo diferente isso emite ZERO aresta EM SILÊNCIO
// (nenhuma interface casa o prefixo) e o integrador conclui que "não há o que
// provar". Aqui a ausência é um erro de uso explícito.
//
// Saída (stdout): { tool, schema, counts, edges:[{from,to,kind,resolution,reason}] }
// Diagnóstico (stderr): contadores por classe de resolução.
// ─────────────────────────────────────────────────────────────────────────
import fs from 'fs';
import path from 'path';

// ── Estereótipos do Spring que registram um bean concreto ──────────────────
// (@Controller/@RestController incluídos; são <<@Component>>.)
const STEREOTYPES = new Set([
  'Component',
  'Service',
  'Repository',
  'Controller',
  'RestController',
  'Configuration',
]);

// ── 1. Limpeza léxica: remove comentários e literais para não casar `@Service`
//    dentro de string/comentário. Preserva offsets de linha não é necessário
//    (trabalhamos por tipo, não por posição fina). ─────────────────────────
export function stripCommentsAndLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    // comentário de linha
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // comentário de bloco
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // texto em bloco (Java 15+ """...""")
    if (c === '"' && c2 === '"' && src[i + 2] === '"') {
      i += 3;
      while (i < n && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) i++;
      i += 3;
      out += '""';
      continue;
    }
    // string
    if (c === '"') {
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }
    // char
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += "' '";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Divide uma lista de tipos (extends/implements) por vírgulas de TOPO,
// respeitando a profundidade de generics `<...>`.
function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '<') depth++;
    else if (ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Nome simples de um tipo referenciado: remove generics e pacote.
export function simpleTypeName(ref) {
  const noGen = ref.replace(/<.*$/s, '').trim();
  const seg = noGen.split('.').pop();
  return (seg || '').trim();
}

// Cabeçalho de tipo: captura anotações imediatamente anteriores + palavra-chave.
// Uma anotação: @Nome opcionalmente com (args de 1 nível, sem parênteses aninhados).
const TYPE_HEADER_RE = new RegExp(
  String.raw`(?:^|[;{}])\s*` +
    String.raw`((?:@\w+(?:\s*\([^()]*\))?\s*)*)` + // grupo 1: anotações + modificadores intercalados
    String.raw`(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*` +
    String.raw`(class|interface|enum|record|@interface)\s+` + // grupo 2: kind
    String.raw`(\w+)` + // grupo 3: nome
    String.raw`(?:\s*<[^{;]*?>)?` + // generics do próprio tipo (best-effort)
    String.raw`\s*(?:extends\s+([^{]*?))?` + // grupo 4: extends
    String.raw`\s*(?:implements\s+([^{]*?))?` + // grupo 5: implements
    String.raw`\s*(?:permits\s+[^{]*?)?\s*\{`,
  'gs',
);

// Extrai anotações puras (sem args) de um blob de modificadores+anotações.
function annotationsIn(blob) {
  const set = new Set();
  const re = /@(\w+)/g;
  let m;
  while ((m = re.exec(blob))) set.add(m[1]);
  return set;
}

// Métodos de fábrica `@Bean`: registram um bean cujo TIPO é o tipo de retorno.
// O container também os injeta — ignorá-los faz o resolvedor emitir aresta
// FALSA quando um `@Bean @Primary` compete com um `@Service` (ex.: o
// IdentityProviderPort do easynup). Captura: tipo de retorno, @Primary, e o
// tipo concreto do 1º `new X(...)`/`return new X` do corpo (best-effort).
const BEAN_METHOD_RE = new RegExp(
  String.raw`(?:^|[;{}])\s*` +
    String.raw`((?:@\w+(?:\s*\([^()]*\))?\s*)+)` + // grupo 1: bloco de anotações (deve conter @Bean)
    String.raw`(?:(?:public|protected|private|static|final|default|abstract)\s+)*` +
    String.raw`([\w.]+)(?:\s*<[^;{]*?>)?\s+` + // grupo 2: tipo de retorno (base)
    String.raw`(\w+)\s*\(([^;{]*?)\)\s*` + // grupo 3: nome; grupo 4: params
    String.raw`(?:throws\s+[\w.,\s]+)?\{`,
  'gs',
);

// nome→tipo dos parâmetros de um método (best-effort; ignora generics/annos).
function paramTypeMap(paramList) {
  const map = new Map();
  for (const raw of splitTopLevel(paramList)) {
    const p = raw.replace(/@\w+(\([^()]*\))?/g, '').trim();
    const tok = p.split(/\s+/).filter(Boolean);
    if (tok.length >= 2) map.set(tok[tok.length - 1], simpleTypeName(tok.slice(0, -1).join(' ')));
  }
  return map;
}

export function parseBeanMethods(clean, pkg, file) {
  const beans = [];
  let m;
  BEAN_METHOD_RE.lastIndex = 0;
  while ((m = BEAN_METHOD_RE.exec(clean))) {
    const annoBlob = m[1] || '';
    const annos = annotationsIn(annoBlob);
    if (!annos.has('Bean')) continue;
    const returnType = simpleTypeName(m[2]);
    if (!returnType || returnType === 'void') continue;
    const params = paramTypeMap(m[4] || '');
    // Corpo do método: janela após o `{` do cabeçalho.
    const bodyStart = BEAN_METHOD_RE.lastIndex - 1;
    const body = clean.slice(bodyStart, bodyStart + 2000);
    // Resolução do concreto (best-effort, nesta ordem):
    //  1. `new X(...)` → X.
    //  2. `return <ident>` onde <ident> é um PARÂMETRO injetado → tipo do param
    //     (idiom @Primary-alias: `FeelEvaluator fe(CamundaFeelEvaluator c){return c;}`).
    let concrete = null;
    const nm = body.match(/\breturn\s+new\s+([\w.]+)/) || body.match(/\bnew\s+([\w.]+)\s*[<(]/);
    if (nm) concrete = simpleTypeName(nm[1]);
    if (!concrete) {
      const rid = body.match(/\breturn\s+([A-Za-z_]\w*)\s*;/);
      if (rid && params.has(rid[1])) concrete = params.get(rid[1]);
    }
    beans.push({
      returnType,
      concrete: concrete && concrete !== returnType ? concrete : null,
      isPrimary: annos.has('Primary'),
      file,
      pkg,
    });
  }
  return beans;
}

// ── 2. Parse de um arquivo Java → declarações de tipo ─────────────────────
export function parseJavaFile(src, file = '<mem>') {
  const clean = stripCommentsAndLiterals(src);
  const pkgMatch = clean.match(/\bpackage\s+([\w.]+)\s*;/);
  const pkg = pkgMatch ? pkgMatch[1] : '';
  const types = [];
  const beanMethods = parseBeanMethods(clean, pkg, file);
  let m;
  TYPE_HEADER_RE.lastIndex = 0;
  while ((m = TYPE_HEADER_RE.exec(clean))) {
    const annoBlob = m[1] || '';
    const kind = m[2];
    const name = m[3];
    const extendsRaw = (m[4] || '').trim();
    const implementsRaw = (m[5] || '').trim();
    const annos = annotationsIn(annoBlob);
    // record/@interface: kind normalizado
    const isInterface = kind === 'interface';
    const isAbstract = /\babstract\b/.test(annoBlob) || false;
    const stereotypes = new Set([...annos].filter((a) => STEREOTYPES.has(a)));
    const supers = [];
    if (extendsRaw) for (const t of splitTopLevel(extendsRaw)) supers.push(simpleTypeName(t));
    if (implementsRaw) for (const t of splitTopLevel(implementsRaw)) supers.push(simpleTypeName(t));
    types.push({
      name,
      // FQN provisório: pacote + nome (nested types resolvem por nome simples também).
      fqn: pkg ? `${pkg}.${name}` : name,
      kind: isInterface ? 'interface' : kind === '@interface' ? 'annotation' : kind === 'enum' ? 'enum' : kind === 'record' ? 'record' : 'class',
      isInterface,
      isAbstract,
      stereotypes,
      isPrimary: annos.has('Primary'),
      annotations: annos,
      supers: [...new Set(supers)].filter(Boolean),
      file,
    });
  }
  return { pkg, types, beanMethods };
}

// Varre a árvore de fontes recursivamente coletando .java.
export function collectJavaFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.java')) out.push(p);
    }
  };
  walk(root);
  return out;
}

// ── 3. Universo de tipos + resolução de arestas config-proven ─────────────
export function buildUniverse(parsedFiles) {
  const byFqn = new Map();
  const bySimple = new Map();
  const beanMethods = [];
  // Resolve estereótipos herdados via meta-anotação em fonte (ex.: uma anotação
  // custom @MyService que é <<@Service>>). 1º junta os tipos, depois propaga.
  for (const pf of parsedFiles) {
    for (const t of pf.types) {
      byFqn.set(t.fqn, t);
      if (!bySimple.has(t.name)) bySimple.set(t.name, new Set());
      bySimple.get(t.name).add(t.fqn);
    }
    if (pf.beanMethods) beanMethods.push(...pf.beanMethods);
  }
  // Meta-estereótipos: annotation type anotado com um estereótipo vira "stereo-anno".
  const stereoAnnos = new Set(STEREOTYPES);
  for (const t of byFqn.values()) {
    if (t.kind === 'annotation') {
      for (const a of t.annotations) if (stereoAnnos.has(a)) stereoAnnos.add(t.name);
    }
  }
  // Re-derivar estereótipos de cada tipo considerando meta-anotações.
  for (const t of byFqn.values()) {
    for (const a of t.annotations) if (stereoAnnos.has(a)) t.stereotypes.add(a);
  }
  return { byFqn, bySimple, stereoAnnos, beanMethods };
}

// Resolve o nome simples de um super-tipo para o FQN em-fonte (ou null se
// externo/ambíguo). Ambíguo (2+ FQNs mesmo nome simples) → null (honesto).
function resolveInSource(simple, bySimple) {
  const set = bySimple.get(simple);
  if (!set || set.size === 0) return null; // externo (JpaRepository, List, ...)
  if (set.size > 1) return { ambiguous: true }; // colisão de nome simples
  return { fqn: [...set][0] };
}

// Fecho de super-tipos EM FONTE de um tipo (interfaces e classes ancestrais).
function superClosure(type, byFqn, bySimple, cache = new Map()) {
  if (cache.has(type.fqn)) return cache.get(type.fqn);
  const acc = new Set();
  cache.set(type.fqn, acc); // guarda contra ciclos
  for (const s of type.supers) {
    const r = resolveInSource(s, bySimple);
    if (!r || r.ambiguous) continue;
    acc.add(r.fqn);
    const parent = byFqn.get(r.fqn);
    if (parent) for (const up of superClosure(parent, byFqn, bySimple, cache)) acc.add(up);
  }
  return acc;
}

export function resolveConfigEdges(universe, { root = '' } = {}) {
  const { byFqn, bySimple, beanMethods = [] } = universe;
  const cache = new Map();
  const fqnOf = (simple) => {
    const r = resolveInSource(simple, bySimple);
    return r && !r.ambiguous ? r.fqn : null;
  };
  // interfaceFqn → Map(chaveDoCandidato → { concrete|null, isPrimary, via })
  const candsByInterface = new Map();
  const addCand = (ifaceFqn, cand) => {
    if (!candsByInterface.has(ifaceFqn)) candsByInterface.set(ifaceFqn, []);
    candsByInterface.get(ifaceFqn).push(cand);
  };

  // (A) Beans por ESTEREÓTIPO: classe concreta anotada → candidato de cada
  //     interface em seu fecho de super-tipos.
  for (const t of byFqn.values()) {
    const isConcrete = (t.kind === 'class' || t.kind === 'record') && !t.isAbstract;
    if (!isConcrete || t.stereotypes.size === 0) continue;
    for (const superFqn of superClosure(t, byFqn, bySimple, cache)) {
      const st = byFqn.get(superFqn);
      if (st && st.isInterface) addCand(superFqn, { concrete: t.fqn, isPrimary: t.isPrimary, via: 'stereotype' });
    }
  }

  // (B/C) Beans por MÉTODO @Bean: o tipo de retorno registra um bean.
  for (const bm of beanMethods) {
    const retFqn = fqnOf(bm.returnType);
    if (!retFqn) continue; // tipo de retorno externo (não é uma interface/port nosso)
    const retType = byFqn.get(retFqn);
    if (!retType) continue;
    const concreteFqn = bm.concrete ? fqnOf(bm.concrete) : null;
    if (retType.isInterface) {
      // (B) @Bean retornando a INTERFACE: candidato p/ ela e suas super-interfaces.
      // Concreto = o `new X()` do corpo (se em-fonte); senão opaco (null).
      const ifaces = new Set([retFqn, ...[...superClosure(retType, byFqn, bySimple, cache)].filter((f) => byFqn.get(f)?.isInterface)]);
      for (const ifaceFqn of ifaces) addCand(ifaceFqn, { concrete: concreteFqn, isPrimary: bm.isPrimary, via: 'bean' });
    } else {
      // (C) @Bean retornando uma CLASSE concreta: candidato de suas interfaces.
      for (const superFqn of superClosure(retType, byFqn, bySimple, cache)) {
        const st = byFqn.get(superFqn);
        if (st && st.isInterface) addCand(superFqn, { concrete: retFqn, isPrimary: bm.isPrimary, via: 'bean' });
      }
    }
  }

  const edges = [];
  const counts = {
    interfacesWithBean: 0,
    proven: 0,
    singleBean: 0,
    primary: 0,
    ambiguousSkipped: 0,
    primaryOpaqueSkipped: 0,
  };
  const ambiguous = [];

  for (const [ifaceFqn, cands] of candsByInterface) {
    if (root && !ifaceFqn.startsWith(root + '.') && ifaceFqn !== root) continue;
    counts.interfacesWithBean++;
    const primaries = cands.filter((c) => c.isPrimary);
    let chosen = null;
    let reason = null;

    if (primaries.length >= 1) {
      // @Primary desempata. Exige que os @Primary apontem a UM concreto nomeável.
      const primConc = [...new Set(primaries.map((c) => c.concrete).filter(Boolean))];
      if (primConc.length === 1 && primaries.every((c) => !c.concrete || c.concrete === primConc[0])) {
        chosen = primConc[0];
        reason = 'spring-primary';
        counts.primary++;
      } else {
        // @Primary opaco (não sei nomear o concreto) ou @Primary conflitantes → honesto: não emito.
        counts.primaryOpaqueSkipped++;
        ambiguous.push({ interface: ifaceFqn, candidates: cands.map((c) => c.concrete || '<opaco@Bean>'), why: 'primary-opaco-ou-conflitante' });
        continue;
      }
    } else {
      const concretes = [...new Set(cands.map((c) => c.concrete).filter(Boolean))];
      const hasOpaque = cands.some((c) => !c.concrete);
      if (concretes.length === 1 && !hasOpaque) {
        chosen = concretes[0];
        reason = 'spring-single-bean';
        counts.singleBean++;
      } else {
        counts.ambiguousSkipped++;
        ambiguous.push({ interface: ifaceFqn, candidates: cands.map((c) => c.concrete || '<opaco@Bean>'), why: hasOpaque ? 'opaco' : 'multiplos' });
        continue;
      }
    }
    counts.proven++;
    edges.push({ from: ifaceFqn, to: chosen, kind: 'DI_RESOLVES', resolution: 'config', reason });
  }
  return { edges, counts, ambiguous };
}

// ── 4. (opcional) Upgrade dos FQNs para símbolos SCIP compiler-exact ───────
// Lê a saída de `scip print --json` e mapeia FQN de TIPO → símbolo SCIP, para
// que as arestas config sejam homogêneas/joináveis com as scip-edges (ADR-0030).
// Símbolo de tipo Java no SCIP: `... <seg>/<seg>/.../<Class>#` (descritores após
// os 4 tokens de cabeçalho; pacote = segmentos por `/`, tipo termina em `#`).
export function buildFqnToScipSymbol(scipIndexJson) {
  const map = new Map();
  const TYPE_DESC_RE = /(?:^|\s)((?:[\w$]+\/)+[\w$.]+#)(?:\s|$)/;
  for (const d of scipIndexJson.documents || []) {
    for (const s of d.symbols || []) {
      const sym = s.symbol;
      if (typeof sym !== 'string') continue;
      const parts = sym.split(' ');
      if (parts.length < 5) continue;
      const descriptors = parts.slice(4).join(' ');
      const m = TYPE_DESC_RE.exec(' ' + descriptors + ' ');
      if (!m) continue;
      const desc = m[1]; // ex.: com/acme/services/x/MyPort#
      const fqn = desc.slice(0, -1).replace(/\//g, '.'); // com.acme.services.x.MyPort
      if (!map.has(fqn)) map.set(fqn, sym);
    }
  }
  return map;
}

export function upgradeEdgesToScip(edges, fqnToSym) {
  let upgraded = 0;
  const out = edges.map((e) => {
    const fromSym = fqnToSym.get(e.from);
    const toSym = fqnToSym.get(e.to);
    if (fromSym && toSym) {
      upgraded++;
      return { ...e, from: fromSym, to: toSym, fromFqn: e.from, toFqn: e.to };
    }
    return e;
  });
  return { edges: out, upgraded };
}

// ── 5. Pipeline de alto nível ─────────────────────────────────────────────
export function deriveFromSource(srcRoot, { root = '' } = {}) {
  const files = collectJavaFiles(srcRoot);
  const parsed = files.map((f) => parseJavaFile(fs.readFileSync(f, 'utf8'), f));
  const universe = buildUniverse(parsed);
  const res = resolveConfigEdges(universe, { root });
  return { ...res, filesScanned: files.length };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const opt = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : def;
  };
  const srcRoot = opt('--src', 'src/main/java');
  const root = opt('--root', null);
  const scipJson = opt('--scip-json', null);

  // `--root` OBRIGATÓRIO: sem ele o filtro de pacote não existe e o resolvedor
  // ou emite tudo (ruído) ou — se herdasse o default de outro produto — ZERO em
  // silêncio. Falhar aqui é a única saída honesta.
  if (!root) {
    console.error(
      'erro: --root <pacote-raiz> é obrigatório (ex.: --root com.acme).\n' +
        'uso: node derive-config-edges.mjs --root <pkg> [--src src/main/java] [--scip-json <index.json>]',
    );
    process.exit(2);
  }

  const { edges: srcEdges, counts, ambiguous, filesScanned } = deriveFromSource(srcRoot, { root });

  let edges = srcEdges;
  let upgraded = 0;
  if (scipJson) {
    try {
      const idx = JSON.parse(fs.readFileSync(scipJson, 'utf8'));
      const fqnToSym = buildFqnToScipSymbol(idx);
      const up = upgradeEdgesToScip(srcEdges, fqnToSym);
      edges = up.edges;
      upgraded = up.upgraded;
    } catch (e) {
      console.error(`[config-proven] --scip-json falhou (${e.message}); mantendo chaves FQN.`);
    }
  }

  process.stdout.write(
    JSON.stringify({
      tool: 'config-proven',
      schema: 'adr-0035.config-proven.v1',
      counts: { ...counts, filesScanned, scipUpgraded: upgraded },
      edges,
    }) + '\n',
  );
  console.error(
    `[config-proven] CONFIG_PROVEN=${counts.proven} ` +
      `(single-bean=${counts.singleBean} primary=${counts.primary}) ` +
      `ambíguo-pulado=${counts.ambiguousSkipped} ` +
      `interfaces-com-bean=${counts.interfacesWithBean} ` +
      `arquivos=${filesScanned}` +
      (scipJson ? ` scip-upgraded=${upgraded}/${edges.length}` : ''),
  );
  if (ambiguous.length) {
    console.error(
      `[config-proven] ${ambiguous.length} interface(s) ambígua(s) (>1 bean, sem @Primary) NÃO emitidas — ex.: ` +
        ambiguous
          .slice(0, 3)
          .map((a) => `${a.interface}→{${a.candidates.length}}`)
          .join(', '),
    );
  }
}

// Executa como CLI só quando invocado diretamente (permite import nos testes).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const selfPath = fileURLToPathSafe(import.meta.url);
if (invokedPath && selfPath && invokedPath === selfPath) main();

function fileURLToPathSafe(u) {
  try {
    return path.resolve(new URL(u).pathname);
  } catch {
    return '';
  }
}

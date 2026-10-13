import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SVELTE_REL,
  analyzeSvelteComponent,
  svelteComponentId,
  svelteSymbolId,
  svelteModuleId,
  makeSvelteComponentNode,
  mergeSvelteGraph,
} from "../../server/analyzers/frontend-svelte";
import { shapeSystemGraph, type RawSystemGraph } from "../../server/analyzers/system-graph";

// OBS-D06 — analyzer de SFC Svelte. Fixture real de componente: prova que o
// parser extrai componente, imports, símbolos e bindings→símbolo (não stub).

const COUNTER_SVELTE = `<script context="module">
  export const TITLE = "Counter";
</script>

<script>
  import { onMount } from "svelte";
  import Button from "./Button.svelte";
  import { count as store } from "../stores";

  let count = 0;
  const step = 2;
  function increment() { count += step; }
  $: doubled = count * 2;

  onMount(() => increment());
</script>

<h1>{TITLE}</h1>
<Button on:click={increment}>+{step}</Button>
<input bind:value={count} />
<p>Doubled: {doubled}</p>
<p>Store: {$store}</p>
{#each items as it}
  <span>{it}</span>
{/each}
`;

describe("frontend-svelte — parse de SFC real", () => {
  const model = analyzeSvelteComponent("src/Counter.svelte", COUNTER_SVELTE);

  it("identifica o componente pelo nome do arquivo", () => {
    assert.equal(model.componentName, "Counter");
    assert.equal(model.componentId, svelteComponentId("src/Counter.svelte"));
  });

  it("extrai imports de ambos os blocos de script (incl. .svelte e named/alias)", () => {
    const specs = model.imports.map((i) => i.specifier).sort();
    assert.deepEqual(specs, ["../stores", "./Button.svelte", "svelte"]);
    const stores = model.imports.find((i) => i.specifier === "../stores")!;
    assert.ok(stores.names.includes("store"), "alias `count as store` captura o binding local `store`");
  });

  it("extrai símbolos de topo: var/const/function/reactive + imports", () => {
    const byName = new Map(model.symbols.map((s) => [s.name, s.kind]));
    assert.equal(byName.get("count"), "var");
    assert.equal(byName.get("step"), "var");
    assert.equal(byName.get("increment"), "function");
    assert.equal(byName.get("doubled"), "reactive");
    assert.equal(byName.get("TITLE"), "var"); // export const no bloco module
    assert.equal(byName.get("onMount"), "import");
    assert.equal(byName.get("Button"), "import");
  });

  it("casa bindings→símbolo da marcação (on:/bind:/mustache/each/store)", () => {
    const kinds = new Map<string, Set<string>>();
    for (const b of model.bindings) {
      if (!kinds.has(b.symbol)) kinds.set(b.symbol, new Set());
      kinds.get(b.symbol)!.add(b.kind);
    }
    assert.ok(kinds.get("increment")?.has("on"), "on:click={increment} liga em increment");
    assert.ok(kinds.get("count")?.has("bind"), "bind:value={count} liga em count");
    assert.ok(kinds.get("doubled")?.has("mustache"), "{doubled} liga no reativo");
    assert.ok(kinds.get("store")?.has("store"), "$store auto-subscription liga no símbolo store");
  });

  it("captura referência não-declarada (`items`) — resolução fica no produtor", () => {
    // parser é honesto: cita `items` ({#each items}); quem decide se vira aresta
    // (símbolo declarado) é o mergeSvelteGraph.
    assert.ok(model.bindings.some((b) => b.symbol === "items" && b.kind === "each"));
  });
});

describe("mergeSvelteGraph — produtor puro, inerte, dedup", () => {
  const base = (): RawSystemGraph => ({ nodes: [], edges: [] });

  it("emite COMPONENT + MODULE/IMPORTS + SYMBOL/DECLARES + BINDS", () => {
    const { graph, stats } = mergeSvelteGraph(base(), [
      { filePath: "src/Counter.svelte", content: COUNTER_SVELTE },
    ]);
    assert.equal(stats.componentsAdded, 1);
    assert.ok(stats.importEdges >= 3, `esperava ≥3 imports, veio ${stats.importEdges}`);
    assert.ok(stats.symbolNodesAdded >= 5);
    assert.ok(stats.declaresEdges >= 5);
    assert.ok(stats.bindsEdges >= 4, `esperava ≥4 binds, veio ${stats.bindsEdges}`);
    assert.ok(stats.bindingSymbolUnresolved >= 1, "`items` não-declarado é contado");

    const cid = svelteComponentId("src/Counter.svelte");
    assert.ok(graph.nodes.some((n) => n.id === cid && n.type === "COMPONENT"));
    assert.ok(graph.edges.some((e) => e.relationType === SVELTE_REL.IMPORTS && e.toNode === svelteModuleId("./Button.svelte")));
    assert.ok(graph.edges.some((e) => e.relationType === SVELTE_REL.DECLARES && e.toNode === svelteSymbolId("src/Counter.svelte", "increment")));
    assert.ok(graph.edges.some((e) => e.relationType === SVELTE_REL.BINDS && e.toNode === svelteSymbolId("src/Counter.svelte", "count")));
  });

  it("convive com o shape do censo (nó COMPONENT tem evidence.method)", () => {
    const { graph } = mergeSvelteGraph(base(), [{ filePath: "src/Counter.svelte", content: COUNTER_SVELTE }]);
    const shaped = shapeSystemGraph(graph as RawSystemGraph);
    const comp = shaped.nodes.find((n) => n.id === svelteComponentId("src/Counter.svelte"));
    assert.ok(comp, "componente presente no shape");
    assert.ok(comp!.evidence?.method, "nó COMPONENT declara evidência");
    assert.ok(shaped.counts.byType["COMPONENT"] >= 1);
  });

  it("dedup: mesmo componente duas vezes não duplica nós/arestas", () => {
    const files = [
      { filePath: "src/Counter.svelte", content: COUNTER_SVELTE },
      { filePath: "src/Counter.svelte", content: COUNTER_SVELTE },
    ];
    const { stats } = mergeSvelteGraph(base(), files);
    assert.equal(stats.componentsAdded, 1);
  });

  it("ignora não-.svelte e payload vazio → no-op byte-a-byte; não muta entrada", () => {
    const g = base();
    g.nodes.push({ id: "x", type: "SERVICE", metadata: {} });
    const before = g.nodes.length;
    const r1 = mergeSvelteGraph(g, [{ filePath: "src/App.tsx", content: "export const x = 1;" }]);
    assert.equal(r1.stats.componentsAdded, 0);
    const r2 = mergeSvelteGraph(g, []);
    assert.equal(r2.graph.nodes.length, before);
    assert.equal(g.nodes.length, before, "grafo de entrada intacto (puro)");
  });

  it("fail-soft: conteúdo quebrado não lança; componente ainda entra", () => {
    const { stats } = mergeSvelteGraph(base(), [
      { filePath: "src/Broken.svelte", content: "<script>let a = ;;;</script><div bind:x={" },
    ]);
    assert.equal(stats.componentsAdded, 1);
  });
});

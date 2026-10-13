import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApplicationGraph, GraphNode, GraphEdge } from "../../server/analyzers/application-graph";
import { findJavaOrphans, suspectsFromJavaOrphans } from "../../server/analyzers/java-orphan";

// OBS-E05 — órfão Java por call-graph do engine. O grafo de entrada imita o que o
// `backend-java-client.reconstructGraph` monta a partir do java-analyzer-engine
// (nós METHOD com type/metadata + arestas CALLS/EXTENDS/IMPLEMENTS). O teste prova
// a LÓGICA sobre um grafo representativo — a execução viva do engine Java depende
// do JAR compilado no CI (não há JDK local).

function method(id: string, type: any, className: string, methodName: string, metadata: Record<string, unknown> = {}): GraphNode {
  return new GraphNode(id, type, className, methodName, `${className}.${methodName}()`, metadata);
}

describe("findJavaOrphans — detector cego sem call-graph (honesto)", () => {
  it("grafo sem NENHUMA aresta CALLS → callGraphPresent=false, zero candidatos", () => {
    const g = new ApplicationGraph();
    g.addNode(method("m:A.foo", "SERVICE", "A", "foo"));
    g.addNode(method("m:A.bar", "SERVICE", "A", "bar"));
    const r = findJavaOrphans(g);
    assert.equal(r.callGraphPresent, false);
    assert.equal(r.candidates.length, 0, "nada acusado sem call-graph (JAR ausente/engine não rodou)");
    assert.equal(r.methodsTotal, 2);
  });

  it("grafo nulo → vazio, não lança", () => {
    const r = findJavaOrphans(null);
    assert.equal(r.callGraphPresent, false);
    assert.equal(r.candidates.length, 0);
  });
});

describe("findJavaOrphans — com call-graph, acusa só o método sem chamador e sem entrada", () => {
  const g = new ApplicationGraph();
  // Controller (entrada HTTP) chama um service; outro service é órfão; há gatilho e entidade.
  g.addNode(method("m:OrderController.list", "CONTROLLER", "OrderController", "list", { httpMethod: "GET", fullPath: "/orders" }));
  g.addNode(method("m:OrderService.findAll", "SERVICE", "OrderService", "findAll"));
  g.addNode(method("m:OrderService.deadHelper", "SERVICE", "OrderService", "deadHelper")); // ÓRFÃO
  g.addNode(method("m:Scheduler.tick", "SERVICE", "Scheduler", "tick", { entryPoint: "Scheduled" })); // gatilho
  g.addNode(method("m:LegacyService.legacyMain", "SERVICE", "LegacyService", "main")); // main = entrada
  g.addNode(method("m:ExternalLib.helper", "SERVICE", "ExternalLib", "helper", { external: true })); // externo
  // chamadas
  g.addEdge(new GraphEdge("m:OrderController.list", "m:OrderService.findAll", "CALLS"));

  const r = findJavaOrphans(g);

  it("callGraphPresent=true e acusa SÓ deadHelper", () => {
    assert.equal(r.callGraphPresent, true);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].nodeId, "m:OrderService.deadHelper");
    assert.equal(r.candidates[0].tier, "java-orphan");
    assert.ok(r.candidates[0].confidence < 1);
  });

  it("exclui entrada HTTP, chamador, gatilho, main e externo pelos motivos certos", () => {
    assert.equal(r.excluded.entrySurface, 1, "OrderController.list é entrada HTTP");
    assert.equal(r.excluded.hasCaller, 1, "OrderService.findAll tem chamador");
    assert.equal(r.excluded.entryPoint, 2, "Scheduler.tick (@Scheduled) e LegacyService.main");
    assert.equal(r.excluded.externalOrSynthetic, 1, "ExternalLib.helper é externo");
  });
});

describe("findJavaOrphans — guardas de polimorfismo/DI/runtime", () => {
  it("método atingido por IMPLEMENTS/EXTENDS/RUNTIME_OBSERVED não é acusado", () => {
    const g = new ApplicationGraph();
    g.addNode(method("m:I.op", "SERVICE", "I", "op"));
    g.addNode(method("m:Impl.op", "SERVICE", "Impl", "op"));
    g.addNode(method("m:Obs.run", "SERVICE", "Obs", "run", { runtimeHot: true }));
    g.addNode(method("m:Caller.go", "CONTROLLER", "Caller", "go", { httpMethod: "GET", fullPath: "/go" }));
    // há CALLS no grafo (não-cego), mas Impl.op só é atingido por IMPLEMENTS
    g.addEdge(new GraphEdge("m:Caller.go", "m:I.op", "CALLS"));
    g.addEdge(new GraphEdge("m:I.op", "m:Impl.op", "IMPLEMENTS"));
    const r = findJavaOrphans(g);
    assert.equal(r.callGraphPresent, true);
    // nem Impl.op (IMPLEMENTS) nem Obs.run (runtime) acusados; I.op tem chamador
    assert.equal(r.candidates.length, 0);
    assert.ok(r.excluded.polymorphicOrObserved >= 2);
  });

  it("observedNodeIds injetado exclui por tráfego", () => {
    const g = new ApplicationGraph();
    g.addNode(method("m:A.foo", "SERVICE", "A", "foo"));
    g.addNode(method("m:A.bar", "CONTROLLER", "A", "bar", { httpMethod: "GET", fullPath: "/x" }));
    g.addEdge(new GraphEdge("m:A.bar", "m:X.y", "CALLS")); // garante call-graph presente
    const base = findJavaOrphans(g);
    assert.equal(base.candidates.length, 1); // A.foo órfão
    const withRt = findJavaOrphans(g, { observedNodeIds: new Set(["m:A.foo"]) });
    assert.equal(withRt.candidates.length, 0, "A.foo excluído por runtime injetado");
  });
});

describe("suspectsFromJavaOrphans — compõe com o tri-eixo (OBS-E06)", () => {
  it("converte candidatos em StaticSuspect; cego → vazio", () => {
    const g = new ApplicationGraph();
    g.addNode(method("m:OrderService.deadHelper", "SERVICE", "OrderService", "deadHelper", { sourceFile: "Order.java" }));
    g.addNode(method("m:C.go", "CONTROLLER", "C", "go", { httpMethod: "GET", fullPath: "/go" }));
    g.addEdge(new GraphEdge("m:C.go", "m:OrderService.other", "CALLS"));
    const r = findJavaOrphans(g);
    const suspects = suspectsFromJavaOrphans(r);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].staticSource, "java-orphan");
    assert.equal(suspects[0].type, "METHOD");
    assert.equal(suspects[0].label, "OrderService.deadHelper");
    assert.equal(suspects[0].sourceFile, "Order.java");
    // cego (sem call-graph) → nenhum suspeito
    const blind = new ApplicationGraph();
    blind.addNode(method("m:A.x", "SERVICE", "A", "x"));
    assert.equal(suspectsFromJavaOrphans(findJavaOrphans(blind)).length, 0);
  });
});

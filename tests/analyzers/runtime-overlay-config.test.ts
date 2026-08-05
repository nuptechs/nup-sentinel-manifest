import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRuntimeOverlayConfig,
  projectOverlayConfig,
} from "../../server/analyzers/runtime-overlay";

// ── ADR-0028 P1.1 — resolução de config do overlay POR PROJETO ──
// PROVA que uma instância multi-projeto consegue mirar o serviço OTel de um 2º
// projeto (ex. NuPIdentify) — a causa-raiz do `observedRatio:0`.

describe("ADR-0028 P1.1 — resolveRuntimeOverlayConfig (cascata pura)", () => {
  it("sem Jaeger em nenhuma camada → null (gated, byte-a-byte ao de hoje)", () => {
    assert.equal(resolveRuntimeOverlayConfig(null, {}), null);
    assert.equal(resolveRuntimeOverlayConfig({}, {}), null);
    // Serviço configurado mas sem URL de Jaeger ⇒ ainda desligado.
    assert.equal(resolveRuntimeOverlayConfig({ services: "nupidentify" }, {}), null);
  });

  it("só env (comportamento legado) → default easynup, gateway = services[0]", () => {
    const cfg = resolveRuntimeOverlayConfig(null, { JAEGER_QUERY_URL: "http://jaeger:16686" });
    assert.ok(cfg);
    assert.equal(cfg!.jaegerUrl, "http://jaeger:16686");
    assert.deepEqual(cfg!.services, ["easynup-gateway", "easynup-backend"]);
    assert.equal(cfg!.gatewayService, "easynup-gateway");
    assert.equal(cfg!.lookbackMs, 86400000);
    assert.equal(cfg!.limit, 400);
    assert.equal(cfg!.apiKey, null);
    assert.equal(cfg!.opPathPattern, undefined);
  });

  it("env RUNTIME_OVERLAY_* sobrepõe o default (URL/serviços/apiKey/lookback/limit)", () => {
    const cfg = resolveRuntimeOverlayConfig(null, {
      RUNTIME_OVERLAY_JAEGER_URL: "http://ov:1", // precede JAEGER_QUERY_URL
      JAEGER_QUERY_URL: "http://ignored",
      RUNTIME_OVERLAY_SERVICES: "nupidentify , nupidentify-worker",
      JAEGER_QUERY_API_KEY: "k1",
      RUNTIME_OVERLAY_LOOKBACK_MS: "3600000",
      RUNTIME_OVERLAY_LIMIT: "50",
    });
    assert.ok(cfg);
    assert.equal(cfg!.jaegerUrl, "http://ov:1");
    assert.deepEqual(cfg!.services, ["nupidentify", "nupidentify-worker"]); // trim + split
    assert.equal(cfg!.gatewayService, "nupidentify");
    assert.equal(cfg!.apiKey, "k1");
    assert.equal(cfg!.lookbackMs, 3600000);
    assert.equal(cfg!.limit, 50);
  });

  it("O CASO NuPIdentify: override por projeto vence o env global easynup", () => {
    // env do processo aponta pro easynup (a instância multi-projeto)…
    const env = {
      JAEGER_QUERY_URL: "http://jaeger:16686",
      RUNTIME_OVERLAY_SERVICES: "easynup-gateway,easynup-backend",
    };
    // …mas ESTE projeto declara seu próprio serviço OTel no conventionProfile.
    const cfg = resolveRuntimeOverlayConfig({ services: ["nupidentify"] }, env);
    assert.ok(cfg);
    assert.equal(cfg!.jaegerUrl, "http://jaeger:16686"); // herda a URL do env
    assert.deepEqual(cfg!.services, ["nupidentify"]);     // mas mira o SEU serviço
    assert.equal(cfg!.gatewayService, "nupidentify");     // serviço único = raiz
  });

  it("gatewayService explícito por projeto (serviço de fronteira ≠ services[0])", () => {
    const cfg = resolveRuntimeOverlayConfig(
      { jaegerUrl: "http://j", services: ["edge", "auth", "db-proxy"], gatewayService: "edge" },
      {},
    );
    assert.equal(cfg!.gatewayService, "edge");
    assert.deepEqual(cfg!.services, ["edge", "auth", "db-proxy"]);
  });

  it("opPathPattern do projeto compila; string inválida cai no default (nunca lança)", () => {
    const ok = resolveRuntimeOverlayConfig({ jaegerUrl: "http://j", opPathPattern: "/rest/[a-z]+" }, {});
    assert.ok(ok!.opPathPattern instanceof RegExp);
    assert.ok(ok!.opPathPattern!.test("/rest/foo"));

    // regex inválida NÃO derruba a análise: retorna o default (não undefined).
    const bad = resolveRuntimeOverlayConfig({ jaegerUrl: "http://j", opPathPattern: "([" }, {});
    assert.ok(bad!.opPathPattern instanceof RegExp);
  });

  it("números malformados no env são ignorados → cai no default seguro", () => {
    const cfg = resolveRuntimeOverlayConfig(null, {
      JAEGER_QUERY_URL: "http://j",
      RUNTIME_OVERLAY_LOOKBACK_MS: "abc",
      RUNTIME_OVERLAY_LIMIT: "",
    });
    assert.equal(cfg!.lookbackMs, 86400000);
    assert.equal(cfg!.limit, 400);
  });
});

describe("ADR-0028 P1.1 — projectOverlayConfig (leitura defensiva do bag)", () => {
  it("lê conventionProfile.runtimeOverlay", () => {
    const project = { conventionProfile: { runtimeOverlay: { services: ["nupidentify"] } } };
    assert.deepEqual(projectOverlayConfig(project), { services: ["nupidentify"] });
  });

  it("ausência de bag → null (sem override; usa env/default)", () => {
    assert.equal(projectOverlayConfig(null), null);
    assert.equal(projectOverlayConfig({}), null);
    assert.equal(projectOverlayConfig({ conventionProfile: null }), null);
    assert.equal(projectOverlayConfig({ conventionProfile: { businessOntology: [] } }), null);
    // tipo errado não derruba
    assert.equal(projectOverlayConfig({ conventionProfile: "x" }), null);
  });
});

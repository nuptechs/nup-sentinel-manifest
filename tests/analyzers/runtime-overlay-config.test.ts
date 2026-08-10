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

  // ── ISOLAMENTO MULTI-TENANT (Furo 1, 2026-08-10): o 1º teste é o isolamento ──
  // Antes, Jaeger sem allowlist de serviço caía no default `easynup-*`. Isso
  // vazava: qualquer projeto novo (cliente) sem perfil herdava os traços do
  // easynup e mintava tabelas de OUTRO sistema no mapa dele (provado no snapshot
  // do NuPIdentify: `service_order`/`financial_entry` do easynup, que o identify
  // não tem nem toca). Agora: sem allowlist de serviço explícita → overlay OFF.
  it("ISOLAMENTO: Jaeger presente mas SEM allowlist de serviço → null (nunca herda easynup)", () => {
    // um projeto-cliente sem `services` no perfil e sem env de serviço
    assert.equal(resolveRuntimeOverlayConfig({ jaegerUrl: "http://jaeger:16686" }, {}), null);
    // idem via env só de Jaeger (o caso exato do projeto que contaminou)
    assert.equal(resolveRuntimeOverlayConfig(null, { JAEGER_QUERY_URL: "http://jaeger:16686" }), null);
    // `services: []` explícito também desliga (não é "use o default")
    assert.equal(resolveRuntimeOverlayConfig({ jaegerUrl: "http://j", services: [] }, {}), null);
  });

  it("com allowlist EXPLÍCITA no perfil → mira SÓ o serviço declarado (isolado)", () => {
    const cfg = resolveRuntimeOverlayConfig(
      { jaegerUrl: "http://jaeger:16686", services: ["easynup-gateway", "easynup-backend"] },
      {},
    );
    assert.ok(cfg);
    assert.deepEqual(cfg!.services, ["easynup-gateway", "easynup-backend"]);
    assert.equal(cfg!.gatewayService, "easynup-gateway");
    assert.deepEqual(cfg!.gatewayServices, ["easynup-gateway", "easynup-backend"]);
    assert.equal(cfg!.lookbackMs, 86400000);
    assert.equal(cfg!.limit, 400);
  });

  it("gatewayServices = fronteira explícita + allowlist, dedup e ordem preservada", () => {
    const cfg = resolveRuntimeOverlayConfig(
      { jaegerUrl: "http://j", services: ["auth", "auth-worker"], gatewayService: "auth" },
      {},
    );
    // o de fronteira primeiro, sem duplicar (auth aparece em ambos)
    assert.deepEqual(cfg!.gatewayServices, ["auth", "auth-worker"]);
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
    // (services explícito: sem allowlist o overlay é OFF por isolamento — Furo 1)
    const ok = resolveRuntimeOverlayConfig({ jaegerUrl: "http://j", services: ["svc"], opPathPattern: "/rest/[a-z]+" }, {});
    assert.ok(ok!.opPathPattern instanceof RegExp);
    assert.ok(ok!.opPathPattern!.test("/rest/foo"));

    // regex inválida NÃO derruba a análise: retorna o default (não undefined).
    const bad = resolveRuntimeOverlayConfig({ jaegerUrl: "http://j", services: ["svc"], opPathPattern: "([" }, {});
    assert.ok(bad!.opPathPattern instanceof RegExp);
  });

  it("números malformados no env são ignorados → cai no default seguro", () => {
    const cfg = resolveRuntimeOverlayConfig(null, {
      JAEGER_QUERY_URL: "http://j",
      RUNTIME_OVERLAY_SERVICES: "svc",   // allowlist explícita (senão overlay OFF)
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

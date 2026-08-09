// ─────────────────────────────────────────────────────────────────────────
// evidence-health — testes.
//
// O que estes testes protegem é a razão de o módulo existir: o pipeline de
// evidência morrer de fome EM SILÊNCIO. Cada eixo é levado à inanição
// isoladamente e o veredito é conferido; e o caminho de erro (Jaeger fora do
// ar, storage quebrado) tem de virar `unknown` — NUNCA uma acusação de falha
// sem evidência, e nunca uma exceção.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildEvidenceHealth,
  edgeAxisHealth,
  analysisAxisHealth,
  runtimeAxisHealthFrom,
  computeOverall,
  computeCulprits,
  resolveThresholds,
  lastSpanMs,
  probeJaeger,
  DEFAULT_THRESHOLDS,
  type AnalysisRunLike,
  type ProjectLike,
} from "../../server/analyzers/evidence-health";
import type { JaegerTrace } from "../../server/analyzers/runtime-overlay";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/** Traço ANCORÁVEL: span de entrada do gateway com rota + span de banco. */
function anchorableTrace(ageHours = 1, traceID = "t1"): JaegerTrace {
  const startMicros = (NOW - ageHours * 3_600_000) * 1000;
  return {
    traceID,
    processes: { p1: { serviceName: "acme-gateway" }, p2: { serviceName: "acme-backend" } },
    spans: [
      {
        spanID: "s1",
        processID: "p1",
        startTime: startMicros,
        tags: [
          { key: "url.path", value: "/api/contracts/42" },
          { key: "http.request.method", value: "GET" },
        ],
      },
      {
        spanID: "s2",
        processID: "p2",
        startTime: startMicros,
        references: [{ refType: "CHILD_OF", spanID: "s1" }],
        tags: [
          { key: "db.sql.table", value: "contract" },
          { key: "db.operation", value: "SELECT" },
        ],
      },
    ],
  };
}

/** Traço NÃO-ancorável: job de background — sem span de entrada com rota. */
function backgroundOnlyTrace(ageHours = 1): JaegerTrace {
  const startMicros = (NOW - ageHours * 3_600_000) * 1000;
  return {
    traceID: "bg1",
    processes: { p1: { serviceName: "acme-backend" } },
    spans: [
      { spanID: "b1", processID: "p1", startTime: startMicros, tags: [{ key: "job.name", value: "nightly-sync" }] },
    ],
  };
}

const OVERLAY_CFG = { gatewayServices: ["acme-gateway", "acme-backend"] };

// ─────────────────────────────────────────────────────────────────────────
describe("evidence-health — limiares", () => {
  it("env vazio → defaults", () => {
    assert.deepEqual(resolveThresholds({}), { ...DEFAULT_THRESHOLDS });
  });
  it("env válido sobrepõe; inválido/negativo cai no default (nunca lança)", () => {
    const th = resolveThresholds({
      EVIDENCE_HEALTH_RUNTIME_STALE_HOURS: "6",
      EVIDENCE_HEALTH_STATIC_STALE_HOURS: "nope",
      EVIDENCE_HEALTH_CONFIG_STALE_HOURS: "-3",
    });
    assert.equal(th.runtimeHours, 6);
    assert.equal(th.staticHours, DEFAULT_THRESHOLDS.staticHours);
    assert.equal(th.configHours, DEFAULT_THRESHOLDS.configHours);
  });
});

describe("evidence-health — eixos de aresta (static/config)", () => {
  it("push recente → fresh, com contagem e idade", () => {
    const a = edgeAxisHealth({ edges: [1, 2, 3], ingestedAt: hoursAgo(2) }, 168, NOW);
    assert.equal(a.status, "fresh");
    assert.equal(a.stale, false);
    assert.equal(a.edgeCount, 3);
    assert.ok(a.ageHours !== null && Math.abs(a.ageHours - 2) < 0.01);
  });

  it("push além do limiar → stale (O ALARME)", () => {
    const a = edgeAxisHealth({ edges: [1], ingestedAt: hoursAgo(200) }, 168, NOW);
    assert.equal(a.status, "stale");
    assert.equal(a.stale, true);
  });

  it("exatamente no limiar ainda é fresh (fronteira não dispara alarme)", () => {
    assert.equal(edgeAxisHealth({ edges: [1], ingestedAt: hoursAgo(168) }, 168, NOW).status, "fresh");
  });

  it("nunca enviado → absent, e absent NÃO é stale", () => {
    const a = edgeAxisHealth(null, 168, NOW);
    assert.equal(a.status, "absent");
    assert.equal(a.stale, false);
    assert.equal(a.reason, "never-pushed");
    assert.equal(a.edgeCount, 0);
  });

  it("payload corrompido / sem carimbo → unknown, nunca acusa stale", () => {
    assert.equal(edgeAxisHealth("lixo", 168, NOW).status, "unknown");
    const semData = edgeAxisHealth({ edges: [1, 2] }, 168, NOW);
    assert.equal(semData.status, "unknown");
    assert.equal(semData.reason, "no-timestamp");
    assert.equal(semData.edgeCount, 2);
    assert.equal(semData.stale, false);
    assert.equal(edgeAxisHealth({ edges: [], ingestedAt: "não é data" }, 168, NOW).reason, "invalid-timestamp");
  });
});

describe("evidence-health — eixo de análise", () => {
  const run = (o: Partial<AnalysisRunLike>): AnalysisRunLike => ({ id: 1, status: "completed", ...o });

  it("análise recente concluída → fresh", () => {
    const a = analysisAxisHealth([run({ completedAt: hoursAgo(3) })], 48, NOW);
    assert.equal(a.status, "fresh");
    assert.equal(a.lastRunId, 1);
  });

  it("análise antiga → stale", () => {
    assert.equal(analysisAxisHealth([run({ completedAt: hoursAgo(72) })], 48, NOW).status, "stale");
  });

  it("última análise FALHOU → stale mesmo recém-rodada (o grafo congelou)", () => {
    const a = analysisAxisHealth([run({ status: "failed", completedAt: hoursAgo(1) })], 48, NOW);
    assert.equal(a.status, "stale");
    assert.equal(a.stale, true);
    assert.equal(a.reason, "last-run-failed");
  });

  it("run em andamento sem completedAt usa o startedAt", () => {
    const a = analysisAxisHealth([run({ status: "running", startedAt: hoursAgo(1), completedAt: null })], 48, NOW);
    assert.equal(a.status, "fresh");
    assert.equal(a.lastRunStatus, "running");
  });

  it("nunca analisado → absent", () => {
    assert.equal(analysisAxisHealth([], 48, NOW).status, "absent");
    assert.equal(analysisAxisHealth(null, 48, NOW).reason, "never-analyzed");
  });
});

describe("evidence-health — eixo runtime", () => {
  it("traço ancorável recente → fresh + anchorableTraces", () => {
    const a = runtimeAxisHealthFrom({ traces: [anchorableTrace(1)], unreachable: false }, OVERLAY_CFG, 24, NOW);
    assert.equal(a.status, "fresh");
    assert.equal(a.anchorableTraces, true);
    assert.equal(a.tracesConsidered, 1);
    assert.equal(a.routesObserved, 1);
    assert.ok(a.lastTraceSeenAt);
  });

  it("último traço ancorável além do limiar → stale", () => {
    const a = runtimeAxisHealthFrom({ traces: [anchorableTrace(30)], unreachable: false }, OVERLAY_CFG, 24, NOW);
    assert.equal(a.status, "stale");
    assert.equal(a.stale, true);
  });

  it("Jaeger fora do ar → unknown, NÃO stale (não se acusa sem saber)", () => {
    const a = runtimeAxisHealthFrom({ traces: [], unreachable: true }, OVERLAY_CFG, 24, NOW);
    assert.equal(a.status, "unknown");
    assert.equal(a.stale, false);
    assert.equal(a.reason, "jaeger-unreachable");
  });

  it("overlay desligado (sem JAEGER_QUERY_URL) → unknown, não é culpa do projeto", () => {
    const a = runtimeAxisHealthFrom({ traces: [], unreachable: false }, null, 24, NOW);
    assert.equal(a.status, "unknown");
    assert.equal(a.reason, "overlay-disabled");
  });

  it("Jaeger no ar e vazio → absent (≠ inalcançável)", () => {
    const a = runtimeAxisHealthFrom({ traces: [], unreachable: false }, OVERLAY_CFG, 24, NOW);
    assert.equal(a.status, "absent");
    assert.equal(a.reason, "no-traces");
  });

  it("só tráfego de background → absent com tracesConsidered>0 (o diagnóstico real)", () => {
    const a = runtimeAxisHealthFrom({ traces: [backgroundOnlyTrace(1)], unreachable: false }, OVERLAY_CFG, 24, NOW);
    assert.equal(a.anchorableTraces, false);
    assert.equal(a.reason, "no-anchorable-traces");
    assert.equal(a.tracesConsidered, 1, "esconder que HÁ telemetria mandaria o diagnóstico pro lado errado");
    assert.equal(a.routesObserved, 0);
  });

  it("serviço fora da allowlist não ancora (o erro nº3 do kit)", () => {
    const a = runtimeAxisHealthFrom(
      { traces: [anchorableTrace(1)], unreachable: false },
      { gatewayServices: ["outro-sistema"] },
      24, NOW,
    );
    assert.equal(a.anchorableTraces, false);
    assert.equal(a.reason, "no-anchorable-traces");
  });

  it("lastSpanMs usa o span mais recente e ignora startTime inválido", () => {
    assert.equal(lastSpanMs([]), 0);
    assert.equal(lastSpanMs([{ spans: [{ startTime: NaN }, { startTime: 2_000_000 }] }] as JaegerTrace[]), 2000);
    const t = [anchorableTrace(5, "a"), anchorableTrace(1, "b")];
    assert.ok(Math.abs(lastSpanMs(t) - (NOW - 3_600_000)) < 1000);
  });
});

describe("evidence-health — probeJaeger separa 'sem traço' de 'não perguntei'", () => {
  const cfg = { jaegerUrl: "http://jaeger:16686", apiKey: null, services: ["acme-gateway"], lookbackMs: 3_600_000, limit: 10 };

  it("HTTP 200 vazio → não é unreachable", async () => {
    const fetchFn = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
    assert.deepEqual(await probeJaeger(cfg, { fetchFn, nowMs: NOW }), { traces: [], unreachable: false });
  });

  it("HTTP 503 → unreachable", async () => {
    const fetchFn = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    assert.equal((await probeJaeger(cfg, { fetchFn, nowMs: NOW })).unreachable, true);
  });

  it("fetch explode → unreachable, sem propagar a exceção", async () => {
    const fetchFn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await probeJaeger(cfg, { fetchFn, nowMs: NOW });
    assert.equal(r.unreachable, true);
    assert.deepEqual(r.traces, []);
  });

  it("um serviço falha mas outro devolve traços → NÃO é unreachable (há dado)", async () => {
    let call = 0;
    const fetchFn = (async () => {
      call++;
      return call === 1
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ data: [anchorableTrace(1)] }) };
    }) as unknown as typeof fetch;
    const r = await probeJaeger({ ...cfg, services: ["a", "b"] }, { fetchFn, nowMs: NOW });
    assert.equal(r.unreachable, false);
    assert.equal(r.traces.length, 1);
  });
});

describe("evidence-health — veredito", () => {
  const fresh = { status: "fresh", stale: false } as never;
  const stale = { status: "stale", stale: true } as never;
  const absent = { status: "absent", stale: false } as never;
  const unknown = { status: "unknown", stale: false } as never;

  it("tudo fresco → healthy", () => {
    assert.equal(computeOverall({ static: fresh, config: fresh, runtime: fresh, analysis: fresh }), "healthy");
  });

  it("um eixo parou de fluir → degraded", () => {
    assert.equal(computeOverall({ static: fresh, config: fresh, runtime: stale, analysis: fresh }), "degraded");
  });

  it("nada fresco → starving (o estado que passava despercebido)", () => {
    assert.equal(computeOverall({ static: absent, config: absent, runtime: absent, analysis: absent }), "starving");
  });

  it("projeto Node (sem wiring Spring) NÃO é degradado por CONFIG absent", () => {
    assert.equal(
      computeOverall({ static: fresh, config: absent, runtime: fresh, analysis: fresh }),
      "healthy",
      "absent degradante treinaria todo mundo a ignorar o alarme",
    );
  });

  it("Jaeger fora do ar não vira acusação de falha do projeto", () => {
    assert.equal(computeOverall({ static: fresh, config: fresh, runtime: unknown, analysis: fresh }), "healthy");
  });

  it("telemetria chegando mas nenhuma ancora → degraded (pipeline vivo e inútil)", () => {
    const semAncora = { status: "absent", stale: false, reason: "no-anchorable-traces" } as never;
    assert.equal(computeOverall({ static: fresh, config: fresh, runtime: semAncora, analysis: fresh }), "degraded");
  });

  // A assimetria deliberada do `absent`: ele só é alarme onde alguém DECLAROU
  // que o eixo deveria fluir. Estes dois casos travam essa regra.
  it("overlay DECLARADO e sem traço nenhum → degraded", () => {
    const semTraco = { status: "absent", stale: false, reason: "no-traces" } as never;
    assert.equal(computeOverall({ static: fresh, config: fresh, runtime: semTraco, analysis: fresh }), "degraded");
  });

  it("overlay NÃO declarado → healthy (não se cobra eixo que ninguém pediu)", () => {
    const desligado = { status: "unknown", stale: false, reason: "overlay-disabled" } as never;
    assert.equal(computeOverall({ static: fresh, config: fresh, runtime: desligado, analysis: fresh }), "healthy");
  });

  // ── eixo de drift no veredito ──
  const todosFrescos = { static: fresh, config: fresh, runtime: fresh, analysis: fresh };

  it("drift MEDIDO (as duas pontas discordam) → degraded", () => {
    const drift = { status: "drift", reason: "sha-mismatch", analyzedSha: null, analyzedAt: null, deployedSha: null } as never;
    assert.equal(computeOverall({ ...todosFrescos, drift }), "degraded");
  });

  it("drift em dia → healthy", () => {
    const drift = { status: "in-sync", analyzedSha: "a", analyzedAt: null, deployedSha: "a" } as never;
    assert.equal(computeOverall({ ...todosFrescos, drift }), "healthy");
  });

  it("drift UNKNOWN nunca piora o veredito (não saber ≠ saber que não cobre)", () => {
    for (const reason of ["health-url-not-configured", "health-unreachable", "no-analyzed-sha", "health-no-commit"]) {
      const drift = { status: "unknown", reason, analyzedSha: null, analyzedAt: null, deployedSha: null } as never;
      assert.equal(computeOverall({ ...todosFrescos, drift }), "healthy", reason);
    }
  });

  it("relatório SEM o eixo (contrato anterior) computa igual — retrocompatível", () => {
    assert.equal(computeOverall(todosFrescos), "healthy");
  });
});

describe("evidence-health — culpados resolvidos no servidor", () => {
  const fresh = { status: "fresh", stale: false } as never;
  const stale = { status: "stale", stale: true, reason: "last-run-failed" } as never;
  const absent = { status: "absent", stale: false, reason: "never-pushed" } as never;
  const base = { static: fresh, config: fresh, runtime: fresh, analysis: fresh };

  it("saudável → lista VAZIA (nunca ausente: leitor não adivinha)", () => {
    assert.deepEqual(computeCulprits(base), []);
  });

  it("eixo que parou entra com status e motivo", () => {
    assert.deepEqual(computeCulprits({ ...base, analysis: stale }), [
      { axis: "analysis", status: "stale", reason: "last-run-failed" },
    ]);
  });

  it("ausência informativa (config sem Spring) NÃO entra", () => {
    assert.deepEqual(computeCulprits({ ...base, config: absent }), []);
  });

  it("runtime DECLARADO e vazio entra (a assimetria deliberada do absent)", () => {
    const semAncora = { status: "absent", stale: false, reason: "no-anchorable-traces" } as never;
    assert.deepEqual(computeCulprits({ ...base, runtime: semAncora }), [
      { axis: "runtime", status: "absent", reason: "no-anchorable-traces" },
    ]);
  });

  it("drift medido entra; drift unknown NÃO", () => {
    const drift = { status: "drift", reason: "sha-mismatch" } as never;
    assert.deepEqual(computeCulprits({ ...base, drift }), [{ axis: "drift", status: "drift", reason: "sha-mismatch" }]);
    const naoSei = { status: "unknown", reason: "health-unreachable" } as never;
    assert.deepEqual(computeCulprits({ ...base, drift: naoSei }), []);
  });

  it("lista e veredito NUNCA divergem — degraded ⟺ há culpado", () => {
    const casos = [
      { ...base, analysis: stale },
      { ...base, runtime: { status: "absent", stale: false, reason: "no-traces" } as never },
      { ...base, drift: { status: "drift", reason: "sha-mismatch" } as never },
      base,
      { ...base, config: absent },
    ];
    for (const c of casos) {
      const degraded = computeOverall(c) === "degraded";
      assert.equal(degraded, computeCulprits(c).length > 0, JSON.stringify(c.drift ?? c.analysis ?? c.runtime));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("evidence-health — buildEvidenceHealth (fim a fim)", () => {
  const projectBase: ProjectLike = {
    id: 42,
    scipEdges: { edges: [1, 2, 3], ingestedAt: hoursAgo(4) },
    configEdges: { edges: [1], ingestedAt: hoursAgo(4) },
    conventionProfile: { runtimeOverlay: { jaegerUrl: "http://jaeger:16686", services: ["acme-gateway", "acme-backend"] } },
  };
  const runsOk: AnalysisRunLike[] = [{ id: 9, status: "completed", completedAt: hoursAgo(5) }];
  const fetchOk = (async () => ({ ok: true, status: 200, json: async () => ({ data: [anchorableTrace(1)] }) })) as unknown as typeof fetch;

  const build = (p: ProjectLike | null, opts: Partial<{ runs: AnalysisRunLike[]; fetchFn: typeof fetch; env: Record<string, string | undefined>; runsThrow: boolean }> = {}) =>
    buildEvidenceHealth(42, {
      getProject: async () => p ?? undefined,
      getAnalysisRuns: async () => { if (opts.runsThrow) throw new Error("db down"); return opts.runs ?? runsOk; },
      env: opts.env ?? {},
      nowMs: NOW,
      fetchFn: opts.fetchFn ?? fetchOk,
    });

  it("pipeline saudável → healthy nos quatro eixos", async () => {
    const h = (await build(projectBase))!;
    assert.equal(h.overall, "healthy");
    assert.equal(h.projectId, 42);
    assert.equal(h.static.status, "fresh");
    assert.equal(h.config.status, "fresh");
    assert.equal(h.runtime.status, "fresh");
    assert.equal(h.analysis.status, "fresh");
    assert.equal(h.runtime.anchorableTraces, true);
    assert.equal(h.generatedAt, new Date(NOW).toISOString());
  });

  it("projeto inexistente → null (a rota traduz em 404)", async () => {
    assert.equal(await build(null), null);
  });

  it("SÓ o runtime seca (o caso real do Gateway derrubado) → degraded", async () => {
    const fetchVazio = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
    const h = (await build(projectBase, { fetchFn: fetchVazio }))!;
    assert.equal(h.runtime.status, "absent");
    assert.equal(h.static.status, "fresh", "os outros eixos seguem saudáveis");
    assert.equal(h.overall, "degraded", "era exatamente isto que passava em silêncio");
  });

  it("SÓ o índice estático seca → degraded, apontando o eixo certo", async () => {
    const h = (await build({ ...projectBase, scipEdges: { edges: [1], ingestedAt: hoursAgo(400) } }))!;
    assert.equal(h.static.status, "stale");
    assert.equal(h.config.status, "fresh");
    assert.equal(h.overall, "degraded");
  });

  it("SÓ a análise seca → degraded", async () => {
    const h = (await build(projectBase, { runs: [{ id: 9, status: "completed", completedAt: hoursAgo(200) }] }))!;
    assert.equal(h.analysis.status, "stale");
    assert.equal(h.overall, "degraded");
  });

  it("nada nunca chegou → starving", async () => {
    const h = (await build({ id: 42, scipEdges: null, configEdges: null, conventionProfile: null }, { runs: [] }))!;
    assert.equal(h.overall, "starving");
    assert.equal(h.runtime.reason, "overlay-disabled");
    assert.equal(h.static.reason, "never-pushed");
  });

  it("Jaeger fora do ar → runtime unknown e o relatório sai inteiro (fail-soft)", async () => {
    const fetchBoom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const h = (await build(projectBase, { fetchFn: fetchBoom }))!;
    assert.equal(h.runtime.status, "unknown");
    assert.equal(h.runtime.reason, "jaeger-unreachable");
    assert.equal(h.static.status, "fresh");
    assert.equal(h.overall, "healthy", "indisponibilidade da SONDA não é falha do projeto");
  });

  it("storage de runs quebrado → analysis unknown, relatório inteiro (fail-soft)", async () => {
    const h = (await build(projectBase, { runsThrow: true }))!;
    assert.equal(h.analysis.status, "unknown");
    assert.equal(h.analysis.reason, "storage-error");
    assert.equal(h.static.status, "fresh");
  });

  it("limiar por env muda o veredito sem tocar em código", async () => {
    const p = { ...projectBase, scipEdges: { edges: [1], ingestedAt: hoursAgo(10) } };
    assert.equal((await build(p))!.static.status, "fresh");
    const apertado = (await build(p, { env: { EVIDENCE_HEALTH_STATIC_STALE_HOURS: "5" } }))!;
    assert.equal(apertado.static.status, "stale");
    assert.equal(apertado.overall, "degraded");
  });

  it("config do overlay vem do PROJETO (uma instância serve vários projetos)", async () => {
    const urls: string[] = [];
    const spy = (async (u: string) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ data: [] }) }; }) as unknown as typeof fetch;
    await build(projectBase, { fetchFn: spy });
    assert.ok(urls.length > 0, "não consultou o Jaeger");
    assert.ok(urls.every((u) => u.startsWith("http://jaeger:16686/api/traces")), urls.join(","));
    assert.ok(urls.some((u) => u.includes("service=acme-gateway")));
    assert.ok(urls.some((u) => u.includes("service=acme-backend")));
  });

  it("sem override no projeto, cai no env do processo", async () => {
    const urls: string[] = [];
    const spy = (async (u: string) => { urls.push(String(u)); return { ok: true, status: 200, json: async () => ({ data: [] }) }; }) as unknown as typeof fetch;
    await build(
      { ...projectBase, conventionProfile: null },
      { fetchFn: spy, env: { JAEGER_QUERY_URL: "http://env-jaeger:16686", RUNTIME_OVERLAY_SERVICES: "svc-a" } },
    );
    assert.ok(urls.every((u) => u.startsWith("http://env-jaeger:16686/")), urls.join(","));
    assert.ok(urls.some((u) => u.includes("service=svc-a")));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// O eixo de drift dentro do relatório: aqui o que se protege é o relatório não
// mentir nem calar. Sem healthUrl ele diz "não configurado" (e NÃO acusa); com
// healthUrl ele mede de verdade e nomeia; e nenhuma falha da sonda pode
// derrubar os outros quatro eixos.
describe("evidence-health — drift (o mapa cobre o binário que roda?)", () => {
  const SHA_A = "9f2c1ab34d5e6f708192a3b4c5d6e7f809a1b2c3";
  const SHA_B = "0123456789abcdef0123456789abcdef01234567";
  const HEALTH = "https://app.exemplo/healthz";

  const projectWith = (appInfo: unknown) => ({
    id: 42,
    scipEdges: { edges: [1, 2, 3], ingestedAt: hoursAgo(4) },
    configEdges: { edges: [1], ingestedAt: hoursAgo(4) },
    conventionProfile: {
      runtimeOverlay: { jaegerUrl: "http://jaeger:16686", services: ["acme-gateway"] },
      ...(appInfo ? { appInfo } : {}),
    },
  });

  const runsWithSha = (sha: string | null): AnalysisRunLike[] => [
    { id: 9, status: "completed", completedAt: hoursAgo(5), diagnostics: sha ? { gitSha: sha } : { files: 3 } },
  ];

  /** Roteia por URL: Jaeger devolve traço ancorável; health devolve o commit. */
  const routed = (deployed: { commit?: unknown } | null, opts: { healthOk?: boolean } = {}) =>
    (async (u: string) => {
      if (String(u).includes("jaeger")) {
        return { ok: true, status: 200, json: async () => ({ data: [anchorableTrace(1)] }) };
      }
      if (opts.healthOk === false) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => deployed ?? {} };
    }) as unknown as typeof fetch;

  const build = (project: ProjectLike, runs: AnalysisRunLike[], fetchFn: typeof fetch) =>
    buildEvidenceHealth(42, {
      getProject: async () => project,
      getAnalysisRuns: async () => runs,
      env: {},
      nowMs: NOW,
      fetchFn,
    });

  it("mesmo commit dos dois lados → in-sync e overall segue healthy", async () => {
    const h = (await build(projectWith({ healthUrl: HEALTH }), runsWithSha(SHA_A), routed({ commit: SHA_A })))!;
    assert.equal(h.drift.status, "in-sync");
    assert.equal(h.drift.analyzedSha, SHA_A);
    assert.equal(h.drift.deployedSha, SHA_A);
    assert.equal(h.overall, "healthy");
    assert.deepEqual(h.culprits, []);
  });

  it("commits diferentes → drift, degraded, e o culpado nomeado", async () => {
    const h = (await build(projectWith({ healthUrl: HEALTH }), runsWithSha(SHA_A), routed({ commit: SHA_B })))!;
    assert.equal(h.drift.status, "drift");
    assert.equal(h.overall, "degraded", "mapa fresco descrevendo outro commit É degradação");
    assert.deepEqual(h.culprits, [{ axis: "drift", status: "drift", reason: "sha-mismatch" }]);
    assert.equal(h.static.status, "fresh", "os eixos de freshness seguem intactos");
  });

  it("sem healthUrl → unknown nomeado, SEM acusar (e sem tocar a rede de health)", async () => {
    const urls: string[] = [];
    const spy = (async (u: string) => {
      urls.push(String(u));
      return { ok: true, status: 200, json: async () => ({ data: [anchorableTrace(1)] }) };
    }) as unknown as typeof fetch;
    const h = (await build(projectWith(null), runsWithSha(SHA_A), spy))!;
    assert.equal(h.drift.status, "unknown");
    assert.equal(h.drift.reason, "health-url-not-configured");
    assert.equal(h.drift.analyzedSha, SHA_A, "o que sabemos continua exposto");
    assert.equal(h.overall, "healthy");
    assert.ok(urls.every((u) => u.includes("jaeger")), `sondou health sem config: ${urls.join(",")}`);
  });

  it("health fora do ar → unknown, relatório inteiro (fail-soft, nunca drift)", async () => {
    const h = (await build(projectWith({ healthUrl: HEALTH }), runsWithSha(SHA_A), routed(null, { healthOk: false })))!;
    assert.equal(h.drift.status, "unknown");
    assert.equal(h.drift.reason, "health-unreachable");
    assert.equal(h.overall, "healthy", "indisponibilidade da SONDA não é falha do projeto");
    assert.equal(h.runtime.status, "fresh");
  });

  it("nenhum run carimbou o commit → unknown, mesmo com o ambiente respondendo", async () => {
    const h = (await build(projectWith({ healthUrl: HEALTH }), runsWithSha(null), routed({ commit: SHA_B })))!;
    assert.equal(h.drift.status, "unknown");
    assert.equal(h.drift.reason, "no-analyzed-sha");
    assert.equal(h.drift.deployedSha, SHA_B, "o lado medido aparece: a lacuna é a nossa");
  });

  it("ambiente responde sem commit → health-no-commit (≠ 'não perguntei')", async () => {
    const h = (await build(projectWith({ healthUrl: HEALTH }), runsWithSha(SHA_A), routed({ commit: null })))!;
    assert.equal(h.drift.reason, "health-no-commit");
  });

  it("storage de runs quebrado → runs-unavailable, e nada de zero fabricado", async () => {
    const h = (await buildEvidenceHealth(42, {
      getProject: async () => projectWith({ healthUrl: HEALTH }),
      getAnalysisRuns: async () => { throw new Error("db down"); },
      env: {},
      nowMs: NOW,
      fetchFn: routed({ commit: SHA_B }),
    }))!;
    assert.equal(h.drift.status, "unknown");
    assert.equal(h.drift.reason, "runs-unavailable");
    assert.equal(h.drift.analyzedSha, null);
  });

  it("culprits acompanha o veredito também quando há eixo parado + drift", async () => {
    const p = projectWith({ healthUrl: HEALTH }) as ProjectLike;
    const h = (await build(
      { ...p, scipEdges: { edges: [1], ingestedAt: hoursAgo(400) } },
      runsWithSha(SHA_A),
      routed({ commit: SHA_B }),
    ))!;
    assert.equal(h.overall, "degraded");
    assert.deepEqual(h.culprits.map((c) => c.axis), ["static", "drift"]);
  });
});

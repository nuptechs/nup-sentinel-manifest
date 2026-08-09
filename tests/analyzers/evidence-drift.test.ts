// ─────────────────────────────────────────────────────────────────────────
// evidence-drift — testes.
//
// O que estes testes protegem é a única regra que o eixo não pode quebrar:
// **sem SHA ≠ SHA errado**. Um drift falso é pior que drift nenhum — manda o
// dono re-analisar sem motivo e, na terceira vez, ele para de olhar o alarme.
// Por isso cada caminho de ignorância (health fora do ar, URL não configurada,
// `commit: null`, run sem carimbo, storage quebrado) tem teste próprio exigindo
// `unknown` com motivo NOMEADO — nunca `drift`, nunca exceção.
// ─────────────────────────────────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  analyzedRefFrom,
  driftHealthFrom,
  driftNotConfigured,
  gitShaFromDiagnostics,
  healthUrlOf,
  probeDeployedSha,
  projectAppInfo,
} from "../../server/analyzers/evidence-drift";
import { normalizeGitSha, shortSha } from "../../server/git/sha";

const SHA_A = "9f2c1ab34d5e6f708192a3b4c5d6e7f809a1b2c3";
const SHA_B = "0123456789abcdef0123456789abcdef01234567";

// ─────────────────────────────────────────────────────────────────────────
describe("normalizeGitSha — 40-hex ou nada", () => {
  it("aceita 40-hex e normaliza para minúsculo", () => {
    assert.equal(normalizeGitSha(SHA_A.toUpperCase()), SHA_A);
    assert.equal(normalizeGitSha(`  ${SHA_A}  `), SHA_A);
  });

  it("REJEITA SHA curto — comparar prefixo produziria falso drift", () => {
    assert.equal(normalizeGitSha("9f2c1ab"), null);
    assert.equal(normalizeGitSha(SHA_A.slice(0, 12)), null);
  });

  it("rejeita lixo/não-string sem lançar", () => {
    for (const v of ["", "zzzz", `${SHA_A}0`, null, undefined, 42, {}, [SHA_A]]) {
      assert.equal(normalizeGitSha(v), null, String(v));
    }
  });

  it("shortSha só encurta o que é SHA de verdade", () => {
    assert.equal(shortSha(SHA_A), "9f2c1ab3");
    assert.equal(shortSha("9f2c1ab"), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("evidence-drift — config por projeto (appInfo)", () => {
  const withUrl = (healthUrl: unknown) => ({ conventionProfile: { appInfo: { healthUrl } } });

  it("lê healthUrl do conventionProfile do projeto", () => {
    assert.equal(healthUrlOf(withUrl("https://app.exemplo/healthz")), "https://app.exemplo/healthz");
    assert.deepEqual(projectAppInfo(withUrl("https://x/h")), { healthUrl: "https://x/h" });
  });

  it("projeto sem perfil / sem appInfo → null (não é erro, é ausência)", () => {
    assert.equal(healthUrlOf(null), null);
    assert.equal(healthUrlOf({}), null);
    assert.equal(healthUrlOf({ conventionProfile: {} }), null);
    assert.equal(healthUrlOf({ conventionProfile: { appInfo: {} } }), null);
    assert.equal(projectAppInfo({ conventionProfile: { appInfo: [] } }), null, "array não é bag");
  });

  it("esquema não-http é descartado (config errada não vira sonda)", () => {
    assert.equal(healthUrlOf(withUrl("file:///etc/passwd")), null);
    assert.equal(healthUrlOf(withUrl("   ")), null);
    assert.equal(healthUrlOf(withUrl(42)), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("evidence-drift — sonda do /healthz (fail-soft)", () => {
  const res = (body: unknown, ok = true, status = 200) =>
    (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

  it("200 com commit 40-hex → sha resolvido, sem motivo", async () => {
    assert.deepEqual(await probeDeployedSha("http://app/healthz", { fetchFn: res({ commit: SHA_A.toUpperCase() }) }), {
      sha: SHA_A,
    });
  });

  it("200 com commit null → health-no-commit ('ele não sabe' ≠ 'não perguntei')", async () => {
    assert.deepEqual(await probeDeployedSha("http://app/healthz", { fetchFn: res({ commit: null }) }), {
      sha: null,
      reason: "health-no-commit",
    });
  });

  it("200 com commit curto → health-no-commit (nunca aproxima)", async () => {
    const r = await probeDeployedSha("http://app/healthz", { fetchFn: res({ commit: "9f2c1ab" }) });
    assert.equal(r.sha, null);
    assert.equal(r.reason, "health-no-commit");
  });

  it("HTTP 503 → health-unreachable", async () => {
    const r = await probeDeployedSha("http://app/healthz", { fetchFn: res({}, false, 503) });
    assert.deepEqual(r, { sha: null, reason: "health-unreachable" });
  });

  it("fetch explode / JSON quebrado → health-unreachable, sem propagar exceção", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.deepEqual(await probeDeployedSha("http://app/healthz", { fetchFn: boom }), {
      sha: null,
      reason: "health-unreachable",
    });

    const badJson = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    })) as unknown as typeof fetch;
    assert.equal((await probeDeployedSha("http://app/healthz", { fetchFn: badJson })).reason, "health-unreachable");
  });

  it("timeout aborta e vira health-unreachable (não pendura o relatório)", async () => {
    const nunca = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const r = await probeDeployedSha("http://app/healthz", { fetchFn: nunca, timeoutMs: 5 });
    assert.deepEqual(r, { sha: null, reason: "health-unreachable" });
  });

  it("body não-objeto (texto solto) → health-no-commit", async () => {
    assert.equal((await probeDeployedSha("http://app/h", { fetchFn: res("ok") })).reason, "health-no-commit");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("evidence-drift — lado ANALISADO (o carimbo do run)", () => {
  it("último run completado com carimbo vence", () => {
    const ref = analyzedRefFrom([
      { id: 3, status: "completed", completedAt: "2026-08-09T10:00:00.000Z", diagnostics: { gitSha: SHA_A } },
      { id: 2, status: "completed", completedAt: "2026-08-08T10:00:00.000Z", diagnostics: { gitSha: SHA_B } },
    ]);
    assert.equal(ref.sha, SHA_A);
    assert.equal(ref.at, "2026-08-09T10:00:00.000Z");
  });

  it("run FALHO não empresta seu SHA — ele não substituiu o snapshot", () => {
    const ref = analyzedRefFrom([
      { id: 4, status: "failed", completedAt: "2026-08-09T12:00:00.000Z", diagnostics: { gitSha: SHA_B } },
      { id: 3, status: "completed", completedAt: "2026-08-09T10:00:00.000Z", diagnostics: { gitSha: SHA_A } },
    ]);
    assert.equal(ref.sha, SHA_A, "o mapa vigente é o do último run que COMPLETOU");
  });

  it("run recente sem carimbo → cai no anterior que tem (não inventa)", () => {
    const ref = analyzedRefFrom([
      { id: 5, status: "completed", completedAt: "2026-08-09T12:00:00.000Z", diagnostics: { files: 10 } },
      { id: 4, status: "completed", completedAt: "2026-08-09T10:00:00.000Z", diagnostics: { gitSha: SHA_A } },
    ]);
    assert.equal(ref.sha, SHA_A);
  });

  it("nenhum run / nenhum carimbo → no-analyzed-sha", () => {
    assert.deepEqual(analyzedRefFrom([]), { sha: null, at: null, reason: "no-analyzed-sha" });
    assert.deepEqual(analyzedRefFrom(null), { sha: null, at: null, reason: "no-analyzed-sha" });
    assert.equal(analyzedRefFrom([{ id: 1, status: "completed" }]).reason, "no-analyzed-sha");
  });

  it("diagnóstico corrompido não derruba a leitura", () => {
    assert.equal(gitShaFromDiagnostics(null), null);
    assert.equal(gitShaFromDiagnostics("lixo"), null);
    assert.equal(gitShaFromDiagnostics([SHA_A]), null);
    assert.equal(gitShaFromDiagnostics({ gitSha: 42 }), null);
    assert.equal(gitShaFromDiagnostics({ gitSha: SHA_A }), SHA_A);
  });

  it("completedAt ausente cai no startedAt (data aproximada > data nenhuma)", () => {
    const ref = analyzedRefFrom([
      { id: 7, status: "completed", startedAt: "2026-08-09T09:00:00.000Z", diagnostics: { gitSha: SHA_A } },
    ]);
    assert.equal(ref.at, "2026-08-09T09:00:00.000Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("evidence-drift — veredito (sem SHA ≠ SHA errado)", () => {
  it("iguais → in-sync, sem motivo", () => {
    const d = driftHealthFrom({ sha: SHA_A, at: "2026-08-09T10:00:00.000Z" }, { sha: SHA_A });
    assert.equal(d.status, "in-sync");
    assert.equal(d.reason, undefined);
    assert.equal(d.analyzedSha, SHA_A);
    assert.equal(d.deployedSha, SHA_A);
  });

  it("diferentes → drift, com as duas pontas visíveis (o alarme legítimo)", () => {
    const d = driftHealthFrom({ sha: SHA_A, at: null }, { sha: SHA_B });
    assert.equal(d.status, "drift");
    assert.equal(d.reason, "sha-mismatch");
    assert.equal(d.analyzedSha, SHA_A);
    assert.equal(d.deployedSha, SHA_B);
  });

  it("sem lado analisado → unknown, MESMO com o ambiente respondendo", () => {
    const d = driftHealthFrom({ sha: null, at: null, reason: "no-analyzed-sha" }, { sha: SHA_B });
    assert.equal(d.status, "unknown");
    assert.equal(d.reason, "no-analyzed-sha", "o buraco é nosso — apontar o ambiente mandaria consertar o lugar errado");
  });

  it("storage de runs quebrado propaga runs-unavailable (≠ 'não há carimbo')", () => {
    const d = driftHealthFrom({ sha: null, at: null, reason: "runs-unavailable" }, { sha: SHA_B });
    assert.equal(d.reason, "runs-unavailable");
  });

  it("health fora do ar → unknown com o motivo do ambiente, jamais drift", () => {
    const d = driftHealthFrom({ sha: SHA_A, at: null }, { sha: null, reason: "health-unreachable" });
    assert.equal(d.status, "unknown");
    assert.equal(d.reason, "health-unreachable");
    assert.equal(d.analyzedSha, SHA_A, "o que sabemos continua visível");
  });

  it("URL não configurada → unknown nomeado (e o SHA analisado segue exposto)", () => {
    const d = driftNotConfigured({ sha: SHA_A, at: "2026-08-09T10:00:00.000Z" });
    assert.deepEqual(d, {
      analyzedSha: SHA_A,
      analyzedAt: "2026-08-09T10:00:00.000Z",
      deployedSha: null,
      status: "unknown",
      reason: "health-url-not-configured",
    });
  });

  it("SHA analisado inválido nunca vira comparação (entra como não-sei)", () => {
    const d = driftHealthFrom({ sha: "9f2c1ab", at: null }, { sha: SHA_B });
    assert.equal(d.status, "unknown");
    assert.equal(d.analyzedSha, null);
  });
});

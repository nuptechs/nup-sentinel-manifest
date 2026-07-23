/**
 * ADR-0021 r2 Onda 4 — consumidores cross-repo no laudo: env-gated, fail-soft,
 * cap, e a seção markdown honesta (⚠️ outro repo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bareSymbolName,
  consumersConfigFromEnv,
  fetchCrossRepoConsumers,
  renderCrossRepoSection,
  repoSlugOf,
} from "../../server/analyzers/cross-repo-consumers";

describe("config env-gated", () => {
  it("sem envs ⇒ null (laudo byte-a-byte); com envs ⇒ config", () => {
    assert.equal(consumersConfigFromEnv({} as any), null);
    assert.equal(consumersConfigFromEnv({ SENTINEL_SYMBOLS_URL: "https://s" } as any), null);
    const cfg = consumersConfigFromEnv({
      SENTINEL_SYMBOLS_URL: "https://s/", SENTINEL_SYMBOLS_KEY: "k", SENTINEL_SYMBOLS_ORG: "o",
    } as any);
    assert.deepEqual(cfg, { url: "https://s", apiKey: "k", organizationId: "o" });
  });
});

describe("helpers puros", () => {
  it("bareSymbolName tira a qualificação; repoSlugOf espelha a canon do Sentinel", () => {
    assert.equal(bareSymbolName("ContractService.findAll"), "findAll");
    assert.equal(bareSymbolName("logger"), "logger");
    assert.equal(repoSlugOf("https://github.com/nuptechs/easynup.git"), "nuptechs/easynup");
    assert.equal(repoSlugOf("nuptechs/easynup"), "nuptechs/easynup");
    assert.equal(repoSlugOf(null), null);
  });
});

describe("fetchCrossRepoConsumers", () => {
  const cfg = { url: "https://s", apiKey: "k", organizationId: "org-1" };
  const okFetch = (data: unknown) => (async (url: string) => ({
    ok: true, status: 200, json: async () => ({ data }),
  })) as any;

  it("consulta por nome NU, dedupe, e anexa consumidores + sem-consumidor contado", async () => {
    const urls: string[] = [];
    const impl = (async (url: string) => {
      urls.push(url);
      const name = new URL(url).searchParams.get("name");
      if (name === "logger") {
        return { ok: true, status: 200, json: async () => ({ data: { totalConsumers: 2, repos: [
          { repo: "other/app", count: 2, sample: [{ relativePath: "src/x.ts", startLine: 3 }] },
        ] } }) };
      }
      return { ok: true, status: 200, json: async () => ({ data: { totalConsumers: 0, repos: [] } }) };
    }) as any;
    const s = await fetchCrossRepoConsumers(
      ["Core.logger", "logger", "Api.morto"], "nuptechs/easynup", cfg, impl,
    );
    assert.equal(urls.length, 2, "dedupe por nome nu (logger 1×)");
    assert.ok(urls[0].includes("organizationId=org-1"));
    assert.equal(s!.bySymbol[0].symbol, "logger");
    assert.equal(s!.bySymbol[0].totalConsumers, 2);
    assert.deepEqual(s!.noConsumers, ["morto"]);
  });

  it("cap de 8 símbolos; HTTP não-ok e exceção viram errors NOMEADOS (fail-soft)", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `s${i}`);
    let calls = 0;
    const impl = (async () => { calls++; return { ok: false, status: 503, json: async () => ({}) }; }) as any;
    const s = await fetchCrossRepoConsumers(many, "r/r", cfg, impl);
    assert.equal(calls, 8, "cap");
    assert.equal(s!.errors.length, 8);
    assert.match(s!.errors[0], /HTTP 503/);

    const boom = (async () => { throw new Error("índice fora"); }) as any;
    const s2 = await fetchCrossRepoConsumers(["a"], "r/r", cfg, boom);
    assert.match(s2!.errors[0], /índice fora/);
  });

  it("lista vazia de símbolos ⇒ null (nada a perguntar)", async () => {
    assert.equal(await fetchCrossRepoConsumers([], "r/r", cfg, okFetch({})), null);
  });
});

describe("renderCrossRepoSection", () => {
  it("marca ⚠️ outro repo e lista amostras arquivo:linha", () => {
    const md = renderCrossRepoSection({
      repoSlug: "nuptechs/easynup",
      bySymbol: [{
        symbol: "logger", totalConsumers: 3,
        repos: [
          { repo: "nuptechs/identify", count: 2, sample: [{ relativePath: "src/a.ts", startLine: 5 }] },
          { repo: "nuptechs/easynup", count: 1, sample: [{ relativePath: "src/b.ts", startLine: 9 }] },
        ],
      }],
      noConsumers: ["orfao"],
      errors: [],
    }).join("\n");
    assert.match(md, /Consumidores no índice de símbolos/);
    assert.match(md, /nuptechs\/identify: 2× \(`src\/a\.ts:5`\) ⚠️ \*\*outro repo\*\*/);
    assert.match(md, /nuptechs\/easynup: 1× \(`src\/b\.ts:9`\)$/m);
    assert.match(md, /Sem consumidor indexado: `orfao`/);
  });
});

describe("supressão contestada (segunda opinião do índice)", () => {
  it("render anuncia 🔴 quando o grafo suprimiu mas o índice vê consumo", () => {
    const md = renderCrossRepoSection({
      repoSlug: "nuptechs/easynup",
      bySymbol: [{ symbol: "asyncHandler", totalConsumers: 84, repos: [] }],
      noConsumers: [],
      errors: [],
      contested: [{ symbol: "asyncHandler", totalConsumers: 84 }],
    }).join("\n");
    assert.match(md, /Supressão contestada pelo índice/);
    assert.match(md, /84 consumo\(s\)/);
    assert.match(md, /revisar antes de confiar na supressão/);
  });
});

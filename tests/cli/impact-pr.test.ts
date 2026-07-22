// ─────────────────────────────────────────────
// impact-pr — testes (ADR-0019 Onda 1). Helpers PUROS, determinísticos.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// O CLI é CommonJS (cli/tsconfig module:commonjs); sob o harness ESM do tsx a
// interop entrega os named exports via default. Destructure do default.
import _prctx from "../../cli/src/utils/pr-context.ts";
import _impactpr from "../../cli/src/commands/impact-pr.ts";
const {
  resolveGithubPrContext,
  diffRangeForPr,
  buildCommentBody,
  findExistingBotComment,
  COMMENT_MARKER,
} = _prctx as any;
const { computePrDiff } = _impactpr as any;
type GitRunner = (args: string[]) => string;

describe("resolveGithubPrContext", () => {
  const base = {
    GITHUB_REPOSITORY: "acme/loja",
    GITHUB_REF: "refs/pull/42/merge",
    GITHUB_BASE_REF: "main",
    GITHUB_HEAD_REF: "feature/x",
    GITHUB_TOKEN: "ghs_secret",
    GITHUB_API_URL: "https://api.github.com",
  };

  it("resolve owner/repo/prNumber/base/head/token de um evento pull_request", () => {
    const r = resolveGithubPrContext(base);
    assert.ok("ctx" in r);
    const c = (r as any).ctx;
    assert.deepEqual(
      { owner: c.owner, repo: c.repo, prNumber: c.prNumber, baseRef: c.baseRef, headRef: c.headRef },
      { owner: "acme", repo: "loja", prNumber: 42, baseRef: "main", headRef: "feature/x" },
    );
  });

  it("GHES: respeita GITHUB_API_URL próprio", () => {
    const r = resolveGithubPrContext({ ...base, GITHUB_API_URL: "https://ghe.acme.com/api/v3/" });
    assert.equal((r as any).ctx.apiBase, "https://ghe.acme.com/api/v3");
  });

  it("SKIP honesto quando NÃO é PR (sem número), sem token, ou fora do Actions", () => {
    assert.ok("skip" in resolveGithubPrContext({ ...base, GITHUB_REF: "refs/heads/main" }));
    assert.ok("skip" in resolveGithubPrContext({ ...base, GITHUB_TOKEN: "" }));
    assert.ok("skip" in resolveGithubPrContext({}));
    assert.ok("skip" in resolveGithubPrContext({ ...base, GITHUB_BASE_REF: "" }));
  });

  it("PR_NUMBER explícito supre o ref quando o evento não é pull/merge", () => {
    const r = resolveGithubPrContext({ ...base, GITHUB_REF: "refs/heads/x", PR_NUMBER: "7" });
    assert.equal((r as any).ctx.prNumber, 7);
  });
});

describe("diffRangeForPr", () => {
  it("three-dot origin/<base>...<head> (mudanças introduzidas pelo PR)", () => {
    assert.equal(diffRangeForPr("main", "feature/x"), "origin/main...feature/x");
  });
  it("head ausente/igual à base → HEAD (checkout do CI)", () => {
    assert.equal(diffRangeForPr("main", ""), "origin/main...HEAD");
    assert.equal(diffRangeForPr("main", "main"), "origin/main...HEAD");
  });
  it("base já qualificada (com /) não é re-prefixada", () => {
    assert.equal(diffRangeForPr("origin/develop", "HEAD"), "origin/develop...HEAD");
  });
});

describe("buildCommentBody / findExistingBotComment (upsert idempotente)", () => {
  it("embute o marcador oculto + relatório + rodapé de proveniência", () => {
    const body = buildCommentBody("## Laudo\nendpoints: 3", { projectName: "loja", ranAt: "2026-07-22T00:00:00Z" });
    assert.ok(body.startsWith(COMMENT_MARKER));
    assert.match(body, /## Laudo/);
    assert.match(body, /NuPtechs Sentinel/);
    assert.match(body, /projeto `loja`/);
  });

  it("acha o NOSSO comentário pelo marcador; ignora comentários alheios", () => {
    const comments = [
      { id: 1, body: "comentário de outra pessoa" },
      { id: 2, body: buildCommentBody("x") },
      { id: 3, body: null },
    ];
    assert.equal(findExistingBotComment(comments), 2);
    assert.equal(findExistingBotComment([{ id: 9, body: "nada nosso" }]), null);
    assert.equal(findExistingBotComment([]), null);
  });
});

describe("computePrDiff (git runner injetável)", () => {
  it("faz fetch do base e diff three-dot; retorna o unified diff", () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "fetch") return "";
      if (args[0] === "diff") return "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
      return "";
    };
    const out = computePrDiff("origin/main...HEAD", "main", runner);
    assert.match(out, /diff --git/);
    assert.deepEqual(calls[0], ["fetch", "--no-tags", "--depth=1", "origin", "main"]);
    assert.deepEqual(calls[1], ["diff", "--unified=3", "origin/main...HEAD"]);
  });

  it("fetch que falha (base já presente/sem rede) NÃO derruba o diff", () => {
    const runner: GitRunner = (args) => {
      if (args[0] === "fetch") throw new Error("fatal: couldn't find remote ref");
      return "diff --git a/y b/y\n";
    };
    assert.match(computePrDiff("origin/main...HEAD", "main", runner), /diff --git/);
  });
});

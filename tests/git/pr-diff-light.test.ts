// ─────────────────────────────────────────────
// fetchPRDiffLight (follow-up ADR-0023 O5) — o bot de laudo NÃO pode baixar
// a árvore inteira ×2 (estoura 5000 req/h num repo do tamanho do EasyNuP).
// Prova com fetch FAKE: (1) só os arquivos ALTERADOS são buscados, por SHA;
// (2) added não busca no base / removed não busca no head; (3) falha
// individual pula o arquivo (fail-soft); (4) o unified diff sai igual ao
// que o buildUnifiedDiffFromPR faria com o fetch cheio para esses paths.
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../../server/git/github-provider";
import { buildUnifiedDiffFromPR } from "../../server/git/pr-unified-diff";

function makeFetchFake() {
  const calls: string[] = [];
  const fake = async (url: any, _init?: any) => {
    const u = String(url);
    calls.push(u);
    const json = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const raw = (body: string) => ({ ok: true, status: 200, text: async () => body, json: async () => ({}) });
    if (u.includes("/pulls/936/files")) {
      return json([
        { filename: "src/A.java", status: "modified", additions: 1, deletions: 1 },
        { filename: "src/New.java", status: "added", additions: 5, deletions: 0 },
        { filename: "src/Old.java", status: "removed", additions: 0, deletions: 7 },
        { filename: "img/logo.png", status: "modified", additions: 0, deletions: 0 }, // não-fonte: fora
      ]);
    }
    if (u.match(/\/pulls\/936$/)) {
      return json({
        number: 936, title: "t", body: "", merged_at: "x", state: "closed",
        user: { login: "u" }, created_at: "c", updated_at: "u2", html_url: "h",
        base: { ref: "main", sha: "basesha1234567" }, head: { ref: "gone-branch", sha: "headsha1234567" },
      });
    }
    if (u.includes("/contents/")) {
      if (u.includes("ref=basesha")) {
        if (u.includes("A.java")) return raw("class A { int x = 1; }\n");
        if (u.includes("Old.java")) return raw("class Old {}\n");
      }
      if (u.includes("ref=headsha")) {
        if (u.includes("A.java")) return raw("class A { int x = 2; }\n");
        if (u.includes("New.java")) return { ok: false, status: 404, text: async () => "nope", json: async () => ({}) }; // fail-soft
      }
    }
    return { ok: false, status: 500, text: async () => "unexpected " + u, json: async () => ({}) };
  };
  return { fake, calls };
}

describe("fetchPRDiffLight — laudo sem estourar a cota da API", () => {
  it("busca SÓ os alterados por SHA (added fora do base, removed fora do head, não-fonte fora de tudo) + fail-soft", async () => {
    const { fake, calls } = makeFetchFake();
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = fake;
    try {
      const p = new GitHubProvider({ provider: "github", repoUrl: "https://github.com/nuptechs/EasyNuP", token: "t" });
      const diff = await p.fetchPRDiffLight(936);

      // shape e SHAs: branch head deletada NUNCA é usada como ref
      assert.equal(diff.pullRequest.id, 936);
      const contentCalls = calls.filter((c) => c.includes("/contents/"));
      assert.ok(contentCalls.every((c) => c.includes("ref=basesha") || c.includes("ref=headsha")), contentCalls.join("\n"));
      assert.ok(!contentCalls.some((c) => c.includes("ref=gone-branch") || c.includes("ref=main")));

      // NENHUM fetch de árvore (o bug era fetchFiles(branch) ×2)
      assert.ok(!calls.some((c) => c.includes("/git/trees") || c.includes("per_page=100&ref")), calls.join("\n"));

      // added fora do base; removed fora do head; png fora de tudo
      assert.ok(!contentCalls.some((c) => c.includes("New.java") && c.includes("basesha")));
      assert.ok(!contentCalls.some((c) => c.includes("Old.java") && c.includes("headsha")));
      assert.ok(!contentCalls.some((c) => c.includes("logo.png")));

      // fail-soft: 404 do New.java@head não derruba; A.java presente nos 2 lados
      assert.deepEqual(diff.baseFiles.map((f) => f.filePath).sort(), ["src/A.java", "src/Old.java"]);
      assert.deepEqual(diff.headFiles.map((f) => f.filePath), ["src/A.java"]);

      // e o unified diff (o que o laudo consome) sai com a mudança real
      const unified = buildUnifiedDiffFromPR(diff);
      assert.ok(unified.includes("src/A.java"), unified);
      assert.ok(unified.includes("-class A { int x = 1; }"));
      assert.ok(unified.includes("+class A { int x = 2; }"));
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});

// ─────────────────────────────────────────────
// ADR-0019 Ondas 4–5 — testes dos núcleos puros:
// token-vault (cifra fail-closed) · pr-unified-diff (ROUND-TRIP com o nosso
// parser) · github-app (JWT verificável offline + assinatura de webhook) ·
// pr-comment (upsert por marcador, MESMO marcador do CLI).
// ─────────────────────────────────────────────
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { vaultKeyFromEnv, encryptToken, decryptToken } from "../../server/git/token-vault.ts";
import { buildUnifiedDiffFromPR } from "../../server/git/pr-unified-diff.ts";
import { appConfigFromEnv, appJwt, verifyWebhookSignature, isRelevantPrAction } from "../../server/git/github-app.ts";
import { COMMENT_MARKER, buildServerCommentBody, findBotComment } from "../../server/git/pr-comment.ts";
import { parseUnifiedDiff, changedSymbolsFromDiff } from "../../server/analyzers/changed-symbols.ts";
import { classifyBreakingChanges } from "../../server/analyzers/breaking-changes.ts";

const KEY_HEX = crypto.randomBytes(32).toString("hex");

describe("token-vault (Onda 4)", () => {
  it("roundtrip cifra→decifra; blob versionado v1", () => {
    const key = vaultKeyFromEnv({ MANIFEST_TOKEN_ENCRYPTION_KEY: KEY_HEX });
    const blob = encryptToken("ghp_secreto123", key)!;
    assert.match(blob, /^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    assert.equal(decryptToken(blob, key), "ghp_secreto123");
  });

  it("FAIL-CLOSED: sem chave/chave inválida → vault desligado (null), nunca plaintext", () => {
    assert.equal(vaultKeyFromEnv({}), null);
    assert.equal(vaultKeyFromEnv({ MANIFEST_TOKEN_ENCRYPTION_KEY: "curta" }), null);
    assert.equal(encryptToken("x", null), null);
    assert.equal(decryptToken("v1:aa:bb:cc", null), null);
  });

  it("chave errada / blob adulterado → null (GCM detecta), nunca lança", () => {
    const key = vaultKeyFromEnv({ MANIFEST_TOKEN_ENCRYPTION_KEY: KEY_HEX })!;
    const other = vaultKeyFromEnv({ MANIFEST_TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex") })!;
    const blob = encryptToken("tok", key)!;
    assert.equal(decryptToken(blob, other), null);
    const tampered = blob.slice(0, -2) + (blob.endsWith("00") ? "11" : "00");
    assert.equal(decryptToken(tampered, key), null);
    assert.equal(decryptToken("lixo", key), null);
  });
});

describe("pr-unified-diff (Onda 4) — ROUND-TRIP com o parser do motor", () => {
  it("modificado/adicionado/removido → parseUnifiedDiff lê status e o breaking classifica", () => {
    const pr = {
      pullRequest: {} as any,
      changedFiles: [
        { filePath: "src/main/java/ContractService.java", status: "modified" as const, additions: 0, deletions: 3 },
        { filePath: "src/main/java/Novo.java", status: "added" as const, additions: 2, deletions: 0 },
        { filePath: "src/main/java/Velho.java", status: "removed" as const, additions: 0, deletions: 2 },
      ],
      baseFiles: [
        { filePath: "src/main/java/ContractService.java", content: "public class ContractService {\n    public Contract update(Long id, ContractDto dto) {\n        return repo.save(dto);\n    }\n}\n" },
        { filePath: "src/main/java/Velho.java", content: "public class Velho {\n}\n" },
      ],
      headFiles: [
        { filePath: "src/main/java/ContractService.java", content: "public class ContractService {\n}\n" },
        { filePath: "src/main/java/Novo.java", content: "public class Novo {\n}\n" },
      ],
    };
    const unified = buildUnifiedDiffFromPR(pr as any);
    const files = parseUnifiedDiff(unified);
    const byPath = new Map(files.map((f) => [f.path, f.status]));
    assert.equal(byPath.get("src/main/java/ContractService.java"), "modified");
    assert.equal(byPath.get("src/main/java/Novo.java"), "added");
    assert.equal(byPath.get("src/main/java/Velho.java"), "removed");
    // símbolos extraídos do diff construído (o motor inteiro funciona em cima)
    const syms = changedSymbolsFromDiff(unified).find((f) => f.path.endsWith("ContractService.java"))!;
    assert.ok(syms.symbols.includes("update"), JSON.stringify(syms.symbols));
    // e o breaking classifica a remoção do update
    const cls = classifyBreakingChanges(files);
    assert.ok(cls.candidates.some((c) => c.symbol === "ContractService.update" && c.change === "removed"), JSON.stringify(cls.candidates));
  });

  it("arquivo sem mudança real de conteúdo é OMITIDO; PR vazio → string vazia", () => {
    const pr = {
      pullRequest: {} as any,
      changedFiles: [{ filePath: "a.java", status: "modified" as const, additions: 0, deletions: 0 }],
      baseFiles: [{ filePath: "a.java", content: "igual\n" }],
      headFiles: [{ filePath: "a.java", content: "igual\n" }],
    };
    assert.equal(buildUnifiedDiffFromPR(pr as any), "");
  });
});

describe("github-app (Onda 5)", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("appJwt: RS256 VERIFICÁVEL offline com a chave pública; claims iss/iat/exp corretos", () => {
    const now = 1_800_000_000;
    const jwt = appJwt("12345", pem, now);
    const [h, p, sig] = jwt.split(".");
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, "base64url"));
    assert.equal(ok, true, "assinatura RS256 verifica");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    assert.deepEqual(payload, { iat: now - 60, exp: now + 540, iss: "12345" });
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  });

  it("appConfigFromEnv: FAIL-CLOSED sem os 3 envs; aceita PEM em base64", () => {
    assert.equal(appConfigFromEnv({}), null);
    assert.equal(appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem }), null);
    const cfg = appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_WEBHOOK_SECRET: "s" })!;
    assert.equal(cfg.appId, "1");
    const b64 = Buffer.from(pem).toString("base64");
    const cfg2 = appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: b64, GITHUB_APP_WEBHOOK_SECRET: "s" })!;
    assert.ok(cfg2.privateKeyPem.includes("BEGIN"));
    assert.equal(appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "bm90LXBlbQ==", GITHUB_APP_WEBHOOK_SECRET: "s" }), null);
  });

  it("verifyWebhookSignature: HMAC certo passa; errado/ausente falha (timing-safe)", () => {
    const body = JSON.stringify({ action: "opened" });
    const sig = "sha256=" + crypto.createHmac("sha256", "segredo").update(body).digest("hex");
    assert.equal(verifyWebhookSignature(body, sig, "segredo"), true);
    assert.equal(verifyWebhookSignature(body, sig, "outro"), false);
    assert.equal(verifyWebhookSignature(body, undefined, "segredo"), false);
    assert.equal(verifyWebhookSignature(body, "sha256=zz", "segredo"), false);
  });

  it("isRelevantPrAction: opened/synchronize/reopened sim; closed/labeled não", () => {
    for (const a of ["opened", "synchronize", "reopened"]) assert.equal(isRelevantPrAction(a), true);
    for (const a of ["closed", "labeled", undefined]) assert.equal(isRelevantPrAction(a as any), false);
  });
});

describe("pr-comment (Ondas 4–5)", () => {
  it("MESMO marcador do CLI (os dois canais convergem no mesmo comentário)", async () => {
    const _cli = (await import("../../cli/src/utils/pr-context.ts")) as any;
    const cliMarker = (_cli.default ?? _cli).COMMENT_MARKER;
    assert.equal(COMMENT_MARKER, cliMarker);
  });

  it("corpo com marcador + upsert acha o nosso e ignora alheios", () => {
    const body = buildServerCommentBody("## Laudo", { projectName: "x" });
    assert.ok(body.startsWith(COMMENT_MARKER));
    assert.equal(findBotComment([{ id: 1, body: "outro" }, { id: 2, body }]), 2);
    assert.equal(findBotComment([]), null);
  });
});

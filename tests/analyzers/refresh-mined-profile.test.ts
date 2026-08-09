/**
 * ADR-0020 r2 Onda 5 — re-perfil no drift + nascimento no onboarding.
 * refreshMinedProfile: minera dos arquivos ATUAIS, mescla (manual VENCE),
 * grava; SEMPRE fail-soft (nunca derruba análise/onboarding).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refreshMinedProfile } from "../../server/analyzers/convention-miner";

const FLEET = Array.from({ length: 5 }, (_, i) => ({
  filePath: `src/services/web/Op${i}WsV1.java`,
  content: `public class Op${i}WsV1 {}\n`,
}));

function storageWith(existingProfile: unknown) {
  const writes: unknown[] = [];
  return {
    writes,
    getProject: async () => ({ conventionProfile: existingProfile }),
    updateProjectConventionProfile: async (_id: number, p: unknown) => { writes.push(p); },
  };
}

describe("refreshMinedProfile", () => {
  it("minera + grava perfil novo quando não existia (nascimento no onboarding)", async () => {
    const st = storageWith(null);
    const out = await refreshMinedProfile(st as any, 7, FLEET as any, () => {});
    assert.ok(out && out.admitted >= 1);
    assert.equal(st.writes.length, 1);
    const saved = st.writes[0] as { rules: { id: string }[] };
    assert.ok(saved.rules.some((r) => r.id === "mined-suffix-wsv1"));
  });

  it("DRIFT: re-minera e MESCLA — regra manual com o mesmo id VENCE, sempre", async () => {
    const manual = {
      version: 1,
      rules: [{ id: "mined-suffix-wsv1", claim: "CURADA", kind: "layer-suffix", pattern: "custom", minSites: 3 }],
      source: "manual",
    };
    const st = storageWith(manual);
    const out = await refreshMinedProfile(st as any, 7, FLEET as any, () => {});
    assert.ok(out);
    const saved = st.writes[0] as { rules: { id: string; claim: string }[]; source: string };
    const kept = saved.rules.find((r) => r.id === "mined-suffix-wsv1");
    assert.equal(kept?.claim, "CURADA", "manual nunca é sobrescrita pelo drift");
    assert.match(saved.source, /manual\+statistical/);
  });

  it("mineração sem admitidas ⇒ perfil INALTERADO (nenhum write)", async () => {
    const st = storageWith(null);
    const out = await refreshMinedProfile(st as any, 7, [{ filePath: "a.txt", content: "nada" }] as any, () => {});
    assert.deepEqual(out, { admitted: 0, total: 0 });
    assert.equal(st.writes.length, 0);
  });

  it("storage que LANÇA ⇒ null fail-soft (onboarding/reindex nunca caem por causa do perfil)", async () => {
    const st = {
      getProject: async () => { throw new Error("db down"); },
      updateProjectConventionProfile: async () => {},
    };
    const out = await refreshMinedProfile(st as any, 7, FLEET as any, () => {});
    assert.equal(out, null);
  });

  it("perfil armazenado INVÁLIDO não bloqueia o refresh (vira base vazia)", async () => {
    const st = storageWith({ version: 99, lixo: true });
    const out = await refreshMinedProfile(st as any, 7, FLEET as any, () => {});
    assert.ok(out && out.admitted >= 1);
    assert.equal(st.writes.length, 1);
  });

  // Os bags de CONFIG moram no mesmo JSONB das regras. O merge reconstruía o
  // perfil só com {version, rules, source, updatedAt} — e APAGAVA, em silêncio,
  // o endereço do Jaeger e a URL de health a cada mineração. Ninguém tinha
  // mexido em config e o overlay ia a zero.
  it("PRESERVA runtimeOverlay e appInfo — mineração não come a configuração", async () => {
    const st = storageWith({
      version: 1,
      rules: [],
      runtimeOverlay: { services: ["acme-gateway"] },
      appInfo: { healthUrl: "https://app.exemplo/healthz" },
    });
    const out = await refreshMinedProfile(st as any, 7, FLEET as any, () => {});
    assert.ok(out && out.admitted >= 1);
    const saved = st.writes[0] as { runtimeOverlay?: any; appInfo?: any; rules: unknown[] };
    assert.deepEqual(saved.runtimeOverlay?.services, ["acme-gateway"]);
    assert.equal(saved.appInfo?.healthUrl, "https://app.exemplo/healthz");
    assert.ok(saved.rules.length >= 1, "e as regras mineradas entram normalmente");
  });

  it("sem os bags, o perfil salvo NÃO ganha chaves vazias (byte-a-byte)", async () => {
    const st = storageWith(null);
    await refreshMinedProfile(st as any, 7, FLEET as any, () => {});
    const saved = st.writes[0] as Record<string, unknown>;
    assert.ok(!("runtimeOverlay" in saved));
    assert.ok(!("appInfo" in saved));
  });
});

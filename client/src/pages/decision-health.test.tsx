// ─────────────────────────────────────────────
// O que estes testes protegem: o banner de saúde não pode dar sossego falso.
//
// Quatro mentiras possíveis, cada uma com teste dedicado:
//   • tratar `absent` como alarme — um projeto Node nunca terá wiring de
//     Spring; degradar por isso treina todo mundo a ignorar o alarme;
//   • tratar `absent` de runtime DECLARADO como normal — é justamente o caso
//     que motivou o endpoint (serviço cai, eixo vai a zero, /graph segue 200);
//   • dizer "degradado" sem nomear o culpado — alarme sem endereço não age;
//   • ler falha de consulta como saúde — não saber ≠ estar bem.
// ─────────────────────────────────────────────
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  EvidenceHealthBanner,
  ageText,
  axisView,
  driftLine,
  healthHeadline,
  reasonText,
  shortSha,
  type EvidenceHealthPayload,
} from "./decision-health";

afterEach(cleanup);

// Payload saudável do projeto 27 (easynup) como base.
const healthy: EvidenceHealthPayload = {
  projectId: 27,
  generatedAt: "2026-08-08T14:20:00.000Z",
  static: { status: "fresh", stale: false, ageHours: 3, edgeCount: 338000, lastPushAt: "2026-08-08T11:00:00.000Z" },
  config: { status: "fresh", stale: false, ageHours: 5, edgeCount: 22 },
  runtime: { status: "fresh", stale: false, ageHours: 0.5, tracesConsidered: 120, routesObserved: 24 },
  analysis: { status: "fresh", stale: false, ageHours: 2, lastRunId: 102, lastRunStatus: "completed" },
  overall: "healthy",
};

// ── helpers puros ─────────────────────────────────────────────────────
describe("ageText", () => {
  it("escala minuto → hora → dia", () => {
    expect(ageText(0.5)).toBe("há 30 min");
    expect(ageText(3)).toBe("há 3 h");
    expect(ageText(72)).toBe("há 3 d");
  });

  it("entrada inválida vira null — nunca 'há 0 h' fabricado", () => {
    expect(ageText(null)).toBeNull();
    expect(ageText(undefined)).toBeNull();
    expect(ageText(Number.NaN)).toBeNull();
    expect(ageText(-1)).toBeNull();
  });
});

describe("reasonText", () => {
  it("traduz os motivos conhecidos para pt-BR de gente", () => {
    expect(reasonText("no-anchorable-traces")).toMatch(/ancora/);
    expect(reasonText("last-run-failed")).toMatch(/falhou/);
    expect(reasonText("overlay-disabled")).toMatch(/não está configurado/);
  });

  it("motivo desconhecido vira null — não inventa explicação", () => {
    expect(reasonText("motivo-que-o-servidor-inventou-amanha")).toBeNull();
    expect(reasonText(undefined)).toBeNull();
  });
});

describe("axisView — quem é culpado e quem só está ausente", () => {
  it("stale é culpado", () => {
    const a = axisView("static", { status: "stale", stale: true, ageHours: 300 });
    expect(a.culprit).toBe(true);
    expect(a.statusLabel).toBe("parou");
    expect(a.detail).toContain("há 13 d");
  });

  it("config ausente NÃO é culpado (projeto sem Spring nunca terá wiring)", () => {
    const a = axisView("config", { status: "absent", stale: false, reason: "never-pushed" });
    expect(a.culprit).toBe(false);
    expect(a.statusLabel).toBe("nunca houve");
  });

  it("runtime DECLARADO e vazio É culpado — o caso que motivou o endpoint", () => {
    expect(axisView("runtime", { status: "absent", stale: false, reason: "no-traces" }).culprit).toBe(true);
    expect(axisView("runtime", { status: "absent", stale: false, reason: "no-anchorable-traces" }).culprit).toBe(true);
  });

  it("runtime sem overlay configurado NÃO é culpado (não foi declarado)", () => {
    const a = axisView("runtime", { status: "unknown", stale: false, reason: "overlay-disabled" });
    expect(a.culprit).toBe(false);
    expect(a.statusLabel).toBe("não sabemos");
  });

  it("eixo ausente do payload degrada para 'não sabemos', sem crashar", () => {
    const a = axisView("analysis", undefined);
    expect(a.status).toBe("unknown");
    expect(a.culprit).toBe(false);
    expect(a.detail).toBeNull();
  });
});

describe("healthHeadline", () => {
  it("saudável: sem suspeita, e os eixos frescos são nomeados", () => {
    const h = healthHeadline(healthy);
    expect(h.state).toBe("healthy");
    expect(h.suspect).toBe(false);
    expect(h.culprits).toHaveLength(0);
    expect(h.sub).toContain("tráfego real");
  });

  it("degradado NOMEIA o eixo culpado e liga a suspeita", () => {
    const h = healthHeadline({
      ...healthy,
      runtime: { status: "absent", stale: false, reason: "no-anchorable-traces", ageHours: 31 },
      overall: "degraded",
    });
    expect(h.state).toBe("degraded");
    expect(h.suspect).toBe(true);
    expect(h.headline).toContain("tráfego real");
    expect(h.culprits.map((c) => c.key)).toEqual(["runtime"]);
  });

  it("degradado com 2 culpados conta e lista os dois", () => {
    const h = healthHeadline({
      ...healthy,
      runtime: { status: "stale", stale: true, ageHours: 40 },
      analysis: { status: "stale", stale: true, reason: "last-run-failed", lastRunId: 99 },
      overall: "degraded",
    });
    expect(h.headline).toContain("2 eixos");
    expect(h.culprits.map((c) => c.key).sort()).toEqual(["analysis", "runtime"]);
    expect(h.sub).toContain("esses eixos não voltarem"); // concordância, não "esse eixo"
  });

  it("degradado SEM culpado identificável admite não saber apontar (não inventa)", () => {
    const h = healthHeadline({ ...healthy, overall: "degraded" });
    expect(h.culprits).toHaveLength(0);
    expect(h.sub).toMatch(/nenhum eixo se declarou culpado/);
    expect(h.suspect).toBe(true);
  });

  it("starving: nada alimenta o mapa, suspeita ligada", () => {
    const h = healthHeadline({ ...healthy, overall: "starving" });
    expect(h.state).toBe("starving");
    expect(h.suspect).toBe(true);
    expect(h.headline).toMatch(/Nenhuma evidência/);
  });

  it("sem payload / overall desconhecido → 'não sabemos' COM suspeita (não é saúde)", () => {
    expect(healthHeadline(undefined).state).toBe("unavailable");
    expect(healthHeadline(undefined).suspect).toBe(true);
    const lixo = healthHeadline({ overall: "tudo-certo-confia" } as unknown as EvidenceHealthPayload);
    expect(lixo.state).toBe("unavailable");
    expect(lixo.suspect).toBe(true);
  });
});

// ── banner (presentacional) ───────────────────────────────────────────
describe("EvidenceHealthBanner", () => {
  it("saudável: sem o aviso de suspeita, com procedência", () => {
    render(<EvidenceHealthBanner data={healthy} />);
    expect(screen.getByTestId("health-banner-healthy")).toBeInTheDocument();
    expect(screen.queryByTestId("health-suspect-warning")).toBeNull();
    expect(screen.getByTestId("health-source")).toHaveTextContent("/evidence-health");
    expect(screen.getByTestId("health-axis-runtime")).toHaveTextContent("chegando");
  });

  it("degradado: nomeia o culpado no corpo, não só no chip", () => {
    render(
      <EvidenceHealthBanner
        data={{
          ...healthy,
          runtime: { status: "absent", stale: false, reason: "no-traces", ageHours: 31 },
          overall: "degraded",
        }}
      />,
    );
    expect(screen.getByTestId("health-banner-degraded")).toBeInTheDocument();
    expect(screen.getByTestId("health-culprit-runtime")).toHaveTextContent(/nenhum traço na janela/);
    expect(screen.getByTestId("health-suspect-warning")).toBeInTheDocument();
  });

  it("carregando ≠ falhou ≠ saudável — cada um tem render próprio", () => {
    const { unmount } = render(<EvidenceHealthBanner isLoading />);
    expect(screen.getByTestId("health-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("health-banner-healthy")).toBeNull();
    unmount();

    render(<EvidenceHealthBanner isError error={new Error("500: boom")} data={healthy} />);
    // dado antigo em cache NÃO pode virar veredito de saúde quando a consulta falhou
    expect(screen.getByTestId("health-banner-unavailable")).toBeInTheDocument();
    expect(screen.getByTestId("health-sub")).toHaveTextContent("500: boom");
    expect(screen.getByTestId("health-suspect-warning")).toBeInTheDocument();
  });
});

// ── eixo de drift: o mapa cobre o binário que roda? ───────────────────
//
// A mentira nova possível aqui é a mais cara de todas: acusar drift sem ter as
// duas pontas medidas. Alarme falso gasta o crédito do alarme verdadeiro — na
// terceira vez ninguém olha. Daí os testes exigirem SILÊNCIO quando não se
// perguntou, e voz clara só quando os dois SHAs existem e discordam.
const SHA_A = "9f2c1ab34d5e6f708192a3b4c5d6e7f809a1b2c3";
const SHA_B = "0123456789abcdef0123456789abcdef01234567";

describe("driftLine — fala quando sabe, cala quando não foi pedido", () => {
  it("em dia: confirma com o commit curto", () => {
    const l = driftLine({ status: "in-sync", analyzedSha: SHA_A, deployedSha: SHA_A });
    expect(l?.state).toBe("in-sync");
    expect(l?.text).toContain("9f2c1ab3");
    expect(l?.text).toMatch(/cobre o que está no ar/);
  });

  it("drift: mostra os DOIS commits e o que fazer", () => {
    const l = driftLine({ status: "drift", analyzedSha: SHA_A, deployedSha: SHA_B, reason: "sha-mismatch" });
    expect(l?.state).toBe("drift");
    expect(l?.text).toContain("9f2c1ab3");
    expect(l?.text).toContain("01234567");
    expect(l?.text).toMatch(/re-análise recomendada/);
  });

  it("SILÊNCIO quando o health não foi configurado (não se cobra quem não pediu)", () => {
    expect(driftLine({ status: "unknown", reason: "health-url-not-configured" })).toBeNull();
  });

  it("SILÊNCIO com servidor antigo (campo ausente) — nada de linha fantasma", () => {
    expect(driftLine(undefined)).toBeNull();
    expect(driftLine(null)).toBeNull();
    expect(driftLine({} as never)).toBeNull();
  });

  it("unknown pedido (health fora do ar) FALA que não deu para conferir", () => {
    const l = driftLine({ status: "unknown", reason: "health-unreachable", analyzedSha: SHA_A });
    expect(l?.state).toBe("unknown");
    expect(l?.text).toMatch(/Não deu para conferir/);
    expect(l?.text).toMatch(/qual versão está no ar/);
  });

  it("sem SHA legível não escreve meio-SHA nem 'undefined'", () => {
    const l = driftLine({ status: "drift", analyzedSha: "9f2c1ab", deployedSha: null });
    expect(l?.state).toBe("drift");
    expect(l?.text).not.toMatch(/undefined|null|9f2c1ab/);
    expect(shortSha("9f2c1ab")).toBeNull();
  });
});

describe("culprits — a lista do SERVIDOR é a autoridade", () => {
  it("usa os culpados do servidor, e o chip concorda com a lista", () => {
    const h = healthHeadline({
      ...healthy,
      analysis: { status: "stale", stale: true, reason: "last-run-failed", lastRunId: 99 },
      overall: "degraded",
      culprits: [{ axis: "analysis", status: "stale", reason: "last-run-failed" }],
    });
    expect(h.culprits.map((c) => c.key)).toEqual(["analysis"]);
    expect(h.axes.find((a) => a.key === "analysis")?.culprit).toBe(true);
    expect(h.axes.find((a) => a.key === "runtime")?.culprit).toBe(false);
  });

  it("servidor manda drift como culpado → entra na lista com as duas pontas", () => {
    const h = healthHeadline({
      ...healthy,
      overall: "degraded",
      drift: { status: "drift", analyzedSha: SHA_A, deployedSha: SHA_B, reason: "sha-mismatch" },
      culprits: [{ axis: "drift", status: "drift", reason: "sha-mismatch" }],
    });
    expect(h.culprits.map((c) => c.key)).toEqual(["drift"]);
    expect(h.culprits[0].detail).toContain("9f2c1ab3");
    // e a frase muda: drift NÃO é "a evidência parou de chegar"
    expect(h.headline).toMatch(/não descreve o que está no ar/);
    expect(h.sub).toMatch(/chegando normalmente/);
  });

  it("servidor manda lista VAZIA em payload degradado → admite não saber apontar", () => {
    const h = healthHeadline({ ...healthy, overall: "degraded", culprits: [] });
    expect(h.culprits).toHaveLength(0);
    expect(h.sub).toMatch(/nenhum eixo se declarou culpado/);
  });

  it("a lista do servidor VENCE o espelho local (senão o banner acusa o eixo errado)", () => {
    // payload em que o espelho local acusaria `runtime`, mas o servidor diz `config`
    const h = healthHeadline({
      ...healthy,
      runtime: { status: "absent", stale: false, reason: "no-traces" },
      overall: "degraded",
      culprits: [{ axis: "config", status: "stale", reason: "never-pushed" }],
    });
    expect(h.culprits.map((c) => c.key)).toEqual(["config"]);
    expect(h.axes.find((a) => a.key === "runtime")?.culprit).toBe(false);
  });

  it("culpado que não reconhecemos não é descartado em silêncio", () => {
    const h = healthHeadline({
      ...healthy,
      overall: "degraded",
      culprits: [{ axis: "eixo-do-futuro", status: "stale", reason: "motivo-novo" }],
    });
    expect(h.culprits).toHaveLength(1);
    expect(h.headline).toContain("eixo-do-futuro");
  });

  it("o lembrete do rodapé segue QUAL é a suspeita (drift ≠ 'a evidência parou')", () => {
    const soDrift = healthHeadline({
      ...healthy,
      overall: "degraded",
      drift: { status: "drift", analyzedSha: SHA_A, deployedSha: SHA_B, reason: "sha-mismatch" },
      culprits: [{ axis: "drift", status: "drift", reason: "sha-mismatch" }],
    });
    expect(soDrift.suspectNote).toMatch(/está chegando, mas sobre um commit diferente/);

    const eixoParado = healthHeadline({
      ...healthy,
      runtime: { status: "stale", stale: true, ageHours: 40 },
      overall: "degraded",
      culprits: [{ axis: "runtime", status: "stale" }],
    });
    expect(eixoParado.suspectNote).toMatch(/não está chegando normalmente/);

    expect(healthHeadline(undefined).suspectNote).toMatch(/não sabemos/i);
    expect(healthHeadline(healthy).suspectNote).toBe("");
  });

  it("servidor ANTIGO (sem culprits) mantém o espelho local funcionando", () => {
    const h = healthHeadline({
      ...healthy,
      runtime: { status: "stale", stale: true, ageHours: 40 },
      overall: "degraded",
    });
    expect(h.culprits.map((c) => c.key)).toEqual(["runtime"]);
  });
});

describe("EvidenceHealthBanner — linha de drift", () => {
  it("drift real aparece no banner com os dois commits", () => {
    render(
      <EvidenceHealthBanner
        data={{
          ...healthy,
          overall: "degraded",
          drift: { status: "drift", analyzedSha: SHA_A, deployedSha: SHA_B, reason: "sha-mismatch" },
          culprits: [{ axis: "drift", status: "drift", reason: "sha-mismatch" }],
        }}
      />,
    );
    expect(screen.getByTestId("health-drift-drift")).toHaveTextContent("01234567");
    expect(screen.getByTestId("health-culprit-drift")).toBeInTheDocument();
  });

  it("em dia: linha discreta de confirmação, sem suspeita", () => {
    render(
      <EvidenceHealthBanner
        data={{ ...healthy, drift: { status: "in-sync", analyzedSha: SHA_A, deployedSha: SHA_A } }}
      />,
    );
    expect(screen.getByTestId("health-drift-in-sync")).toBeInTheDocument();
    expect(screen.queryByTestId("health-suspect-warning")).toBeNull();
  });

  it("sem health configurado: NENHUMA linha de drift (silêncio, não 'não sabemos')", () => {
    render(
      <EvidenceHealthBanner
        data={{ ...healthy, drift: { status: "unknown", reason: "health-url-not-configured", analyzedSha: SHA_A } }}
      />,
    );
    expect(screen.queryByTestId("health-drift-unknown")).toBeNull();
    expect(screen.getByTestId("health-banner-healthy")).toBeInTheDocument();
  });

  it("payload sem o campo (servidor antigo) não desenha nada nem quebra", () => {
    render(<EvidenceHealthBanner data={healthy} />);
    expect(screen.queryByTestId("health-drift-in-sync")).toBeNull();
    expect(screen.queryByTestId("health-drift-drift")).toBeNull();
    expect(screen.getByTestId("health-banner-healthy")).toBeInTheDocument();
  });
});

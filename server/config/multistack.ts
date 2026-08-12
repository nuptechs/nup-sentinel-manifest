// ─────────────────────────────────────────────
// Multistack flags — ADR-0015 (nup-sentinel/docs/adr/0015-*.md), Onda 0.
//
// Toda capacidade multi-stack nova (balde node-backend, parser de rotas
// Express, Drizzle, captura queryKey/apiRequest, etc.) nasce atrás destas
// flags, DEFAULT OFF. Contrato dos gates anti-regressão:
//   G2 — flags OFF  ⇒ saída do pipeline byte-a-byte idêntica à atual;
//   G3 — flags ON   ⇒ saída é SUPERSET estrito (nada some, só entra).
// O teste tests/regression/goldset-baseline.test.ts trava os dois lados.
//
// Nomes de env:
//   MANIFEST_MULTISTACK_NODE           — balde node-backend + rotas Express +
//                                        middleware→securityAnnotations +
//                                        Drizzle + call-chain (Onda 1, D1-D5)
//   MANIFEST_MULTISTACK_HTTP_TEMPLATE  — captura HTTP do template rest-express
//                                        no frontend: queryKey-como-URL +
//                                        apiRequest(method, url) (Onda 1, D6)
// ─────────────────────────────────────────────

export interface MultistackFlags {
  /** Onda 1 D1-D5: balde node-backend (Express/Drizzle/middleware/call-chain). */
  nodeBackend: boolean;
  /** Onda 1 D6: branches queryKey-como-URL e apiRequest no http-service-map. */
  frontendHttpTemplate: boolean;
}

const TRUTHY = /^(1|true|on|yes)$/i;

function isOn(value: string | undefined): boolean {
  return typeof value === "string" && TRUTHY.test(value.trim());
}

/**
 * Lê as flags multistack do ambiente. Sem env ⇒ tudo OFF (G2: comportamento
 * atual, byte-a-byte). Aceita 1/true/on/yes (case-insensitive).
 */
export function readMultistackFlags(
  env: Record<string, string | undefined> = process.env,
): MultistackFlags {
  return {
    nodeBackend: isOn(env.MANIFEST_MULTISTACK_NODE),
    frontendHttpTemplate: isOn(env.MANIFEST_MULTISTACK_HTTP_TEMPLATE),
  };
}

export type FrontendHttpTemplateMode = "on" | "off" | "auto";

/**
 * Modo da captura HTTP do template rest-express (D6) — ADR-0028: o default OFF
 * cego custou 1 peça de 12 no mapa do NuPIdentify (o único extractor que
 * entende useQuery({queryKey})/apiRequest ficava desligado). Semântica:
 *   env truthy (1/true/on/yes)      → "on"   (força ligado, como antes);
 *   env setado com OUTRO valor      → "off"  (força desligado — opt-out);
 *   env AUSENTE ou vazio            → "auto" (liga por DETECÇÃO do template —
 *       client/src + wouter/@tanstack/react-query; detectRestExpressTemplate).
 * A captura é superset estrito (G3), então auto-detecção não remove nada; o
 * golden G1/G2 segue intacto porque o fixture Vue não dispara a detecção.
 */
export function frontendHttpTemplateMode(
  env: Record<string, string | undefined> = process.env,
): FrontendHttpTemplateMode {
  const v = env.MANIFEST_MULTISTACK_HTTP_TEMPLATE;
  if (v === undefined || v.trim() === "") return "auto";
  return isOn(v) ? "on" : "off";
}

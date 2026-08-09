// ─────────────────────────────────────────────────────────────────────────
// SHA de commit — o normalizador ÚNICO.
//
// O mapa epistêmico responde "o que é provado". A pergunta que ficava sem
// resposta MEDIDA é anterior a essa: **o mapa cobre o binário que está
// rodando?**. Um agente lendo código chegou a concluir (errado) que um
// ambiente rodava binário velho; a conclusão era palpite porque o Manifest
// nunca guardou QUAL commit ele analisou — comparar era impossível.
//
// A partir daqui o SHA é campo de 1ª classe: entra pelo `POST /api/analyze`
// (`options.gitSha`), fica no diagnóstico durável do run, viaja na série
// histórica e é confrontado com o `commit` do `/healthz` do ambiente.
//
// ─── §POR QUE SÓ 40-HEX ─────────────────────────────────────────────────
// Aceitar SHA curto (7/8/12) parece gentileza e é armadilha: dois curtos
// diferentes podem ser o mesmo commit, e a comparação "analisado × no ar"
// passaria a produzir FALSO DRIFT (o pior resultado possível — alarme que
// treina o time a ignorar alarme). Entrada que não é 40-hex vira `null`
// ("não sei"), NUNCA um valor aproximado. Ausência de medida jamais vira
// medida.
// ─────────────────────────────────────────────────────────────────────────

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * `string` de 40 hex → minúsculo. Qualquer outra coisa (curto, sujo, não-string,
 * `null`) → `null`. PURA, nunca lança.
 */
export function normalizeGitSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return FULL_SHA.test(s) ? s.toLowerCase() : null;
}

/** Prefixo legível (8) para texto de tela/log. `null` entra, `null` sai. */
export function shortSha(raw: unknown): string | null {
  const full = normalizeGitSha(raw);
  return full ? full.slice(0, 8) : null;
}

/**
 * Capacidades-padrão do setor (ADR-070 Onda 7 — crítica "grandes players já
 * fazem Y") — versão SEGURA, sem scraping.
 *
 * O ADR exige, pra inteligência competitiva ao vivo, um MarketIntelPort com
 * scraping de fontes primárias + RAG + guarda anti-SSRF + cofre AES-256-GCM +
 * **citação-por-campo + refusal-as-default + verificação humana**. Essa parte é
 * DIFERIDA (lane isolada, requisitos de segurança próprios — ver nota no fim).
 *
 * Esta primeira fatia entrega o critério SEM o risco: uma base CURADA e
 * VERIFICÁVEL de capacidades que são **padrão ou mandadas** no setor público
 * brasileiro — cada uma com fonte citável (lei/norma/sistema gov). Não é "o
 * concorrente X faz" (especulativo, proibido pelo ADR), é "o setor espera isto,
 * pela fonte Y". Advisory; verificação humana obrigatória.
 */

export type CapabilityTier = "mandatory" | "standard";

export interface MarketCapability {
  capability: string;
  patterns: RegExp[];     // como reconhecer no sistema (entidade/endpoint)
  source: string;         // fonte citável (lei/norma/sistema gov)
  tier: CapabilityTier;   // mandada por lei vs padrão de mercado
  why: string;
}

// Setor: plataformas de gestão de contratação pública (Brasil).
export const PUBLIC_SECTOR_CAPABILITIES: MarketCapability[] = [
  {
    capability: "Publicação no PNCP",
    patterns: [/pncp/i, /portal.?nacional/i],
    source: "Lei 14.133/2021, Art. 174 (divulgação obrigatória no PNCP)",
    tier: "mandatory",
    why: "A divulgação de editais/contratos/atas no PNCP é obrigatória; plataformas do setor integram com a API do PNCP.",
  },
  {
    capability: "Assinatura eletrônica (gov.br / ICP-Brasil)",
    patterns: [/signature/i, /assinatura/i, /\bsign\b/i, /icp.?brasil/i, /certificad/i],
    source: "Lei 14.063/2020 + MP 2.200-2/2001 (ICP-Brasil)",
    tier: "standard",
    why: "Atos do processo de contratação são assinados eletronicamente; plataformas integram assinatura gov.br/ICP-Brasil.",
  },
  {
    capability: "Due diligence / habilitação de fornecedor (SICAF, CND, sanções)",
    patterns: [/sicaf/i, /\bcnd\b/i, /habilitac/i, /duediligence|due.?diligence/i, /supplier.?check|fornecedor.*(consulta|verifica)/i, /\bceis\b|\bcnep\b/i],
    source: "Habilitação (Lei 14.133/2021) + SICAF + cadastros de sanções CEIS/CNEP (Lei 12.846/2013)",
    tier: "standard",
    why: "Verificar regularidade fiscal/jurídica e impedimentos do fornecedor é etapa esperada; plataformas consultam SICAF/CND/sanções.",
  },
  {
    capability: "Pesquisa de preços (Painel de Preços / Catmat-Catser)",
    patterns: [/catmat|catser/i, /pesquisa.?preco|pesquisa.?preço/i, /price.?(search|research)/i, /painel.?preco/i],
    source: "IN SEGES/ME 65/2021 (pesquisa de preços) + Catmat/Catser",
    tier: "standard",
    why: "A estimativa de preços segue parâmetros oficiais; plataformas integram Painel de Preços e catálogos Catmat/Catser.",
  },
  {
    capability: "Trilha de auditoria à prova de adulteração",
    patterns: [/audit/i, /auditoria/i, /\bhmac\b/i, /tamper/i, /trilha/i],
    source: "Governança e controle (Lei 14.133/2021; TCU) — integridade do registro",
    tier: "standard",
    why: "Órgãos de controle (TCU) exigem rastreabilidade íntegra; plataformas mantêm trilha de auditoria forense.",
  },
  {
    capability: "Gestão documental / repositório do processo",
    patterns: [/document/i, /\bsection\b/i, /attachment|anexo/i, /arquivo|file.?store/i, /digest/i],
    source: "Instrução do processo (Lei 14.133/2021) — documentos do contrato",
    tier: "standard",
    why: "O processo de contratação é instruído por documentos; plataformas oferecem gestão documental do contrato.",
  },
];

// ──────────────────────────────────────────────────────────────────────────
// NOTA — MarketIntelPort (inteligência competitiva AO VIVO) está DIFERIDO.
// Atualizar esta base a partir de fontes primárias (changelogs/docs/standards)
// exige, conforme ADR-070 §3 (e) e ADR-057: porta hex `MarketIntelPort` com
// guarda anti-SSRF (ADR-055), cofre AES-256-GCM de credenciais (ADR-052/057),
// RAG sobre fontes primárias raspadas, citação-por-campo, refusal-as-default e
// verificação humana. Lane de segurança própria — não entra aqui.
// ──────────────────────────────────────────────────────────────────────────

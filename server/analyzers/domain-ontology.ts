/**
 * Ontologia-semente do domínio "gestão de contratos públicos" (ADR-070 Onda 7 —
 * crítica de NEGÓCIO "falta Y dado o domínio").
 *
 * É a ponte que o ADR recomenda pra começar pelo vácuo mais arriscado: ancorar a
 * crítica no TEXTO REGULATÓRIO citável (onde a técnica é confiável), não em
 * opinião de LLM. Cada conceito esperado traz a base legal e a importância.
 *
 * PRINCÍPIO DE CONFIABILIDADE: artigo citado SÓ onde há certeza. Onde o número
 * exato não é seguro, cita-se a lei e o conceito (citação errada destrói a
 * credibilidade — pior que citação geral). É uma SEMENTE (não exaustiva),
 * extensível, e específica deste domínio.
 */

export type ConceptImportance = "core" | "recommended";

export interface DomainConcept {
  concept: string;        // nome do conceito de domínio
  patterns: RegExp[];     // como reconhecê-lo numa entidade do sistema
  legalBasis: string;     // base legal citável
  importance: ConceptImportance;
  why: string;            // por que o domínio espera isso
}

// Domínio: contratação pública brasileira (Lei 14.133/2021 como carro-chefe).
export const PUBLIC_PROCUREMENT_ONTOLOGY: DomainConcept[] = [
  {
    concept: "Contrato",
    patterns: [/\bcontract\b/i, /contrato/i],
    legalBasis: "Lei 14.133/2021 (instrumento contratual)",
    importance: "core",
    why: "Núcleo do domínio — sem a entidade de contrato não há o que gerir.",
  },
  {
    concept: "Garantia de execução",
    patterns: [/guarantee/i, /garantia/i],
    legalBasis: "Lei 14.133/2021, Art. 96–102",
    importance: "core",
    why: "A Administração pode exigir garantia de execução (caução, seguro-garantia, fiança); precisa de ciclo de vida e alerta de vencimento.",
  },
  {
    concept: "Reajuste/Repactuação",
    patterns: [/adjustment/i, /reajuste/i, /repactua/i, /priceadjust/i],
    legalBasis: "Lei 14.133/2021, Art. 92 (cláusula obrigatória em todos os contratos)",
    importance: "core",
    why: "A cláusula de reajuste é obrigatória; sem a entidade não há histórico nem aplicação do índice.",
  },
  {
    concept: "Sanção/Glosa (penalidade)",
    patterns: [/deflator/i, /penalty/i, /penalidade/i, /sancao|sanção/i, /glosa/i],
    legalBasis: "Lei 14.133/2021, Art. 156 (sanções administrativas)",
    importance: "core",
    why: "Descumprimento gera dedução/penalidade; o domínio espera um mecanismo de glosa/sanção fundamentada.",
  },
  {
    concept: "Recebimento (TRP/TRD)",
    patterns: [/acceptance/i, /recebimento/i, /atesto/i, /\btrp\b|\btrd\b/i],
    legalBasis: "Lei 14.133/2021, Art. 140 (recebimento provisório e definitivo)",
    importance: "core",
    why: "O objeto é recebido provisória e definitivamente; sem aceite não há liquidação fiel.",
  },
  {
    concept: "Nível de serviço (SLA/ANS/IMR)",
    patterns: [/\bsla\b/i, /\bans\b/i, /\bimr\b/i, /servicelevel/i, /indicator/i],
    legalBasis: "Lei 14.133/2021 (mensuração de resultado) + IMR",
    importance: "recommended",
    why: "Contratos de serviço contínuo medem desempenho por níveis; o IMR liga medição a pagamento/glosa.",
  },
  {
    concept: "Fiscalização (fiscal designado)",
    patterns: [/fiscal/i, /gestor.?contrato/i, /fiscalizacao|fiscalização/i],
    legalBasis: "Lei 14.133/2021, Art. 117 (fiscalização do contrato)",
    importance: "recommended",
    why: "O contrato deve ter fiscal designado; o domínio espera rastrear quem fiscaliza.",
  },
  {
    concept: "Pagamento/Lançamento financeiro",
    patterns: [/financ/i, /payment/i, /pagamento/i, /\bfatura\b|invoice/i],
    legalBasis: "Lei 14.133/2021 (liquidação e pagamento)",
    importance: "core",
    why: "Execução financeira (liquidação/pagamento) é parte indissociável da gestão contratual.",
  },
  {
    concept: "Obrigação de execução",
    patterns: [/obligation/i, /obrigacao|obrigação/i, /milestone|marco/i, /entrega/i],
    legalBasis: "Lei 14.133/2021 (obrigações contratuais)",
    importance: "recommended",
    why: "O acompanhamento de obrigações/marcos sustenta a conformidade de execução.",
  },
  {
    concept: "Ordem de Serviço / demanda",
    patterns: [/serviceorder/i, /ordem.?servico|ordem.?serviço/i, /\bos\b/i, /demanda/i],
    legalBasis: "Lei 14.133/2021 (execução por demanda)",
    importance: "recommended",
    why: "Serviços por demanda materializam a execução em ordens de serviço.",
  },
];

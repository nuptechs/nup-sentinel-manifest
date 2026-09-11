# AGENTS.md — regras operacionais para agentes de IA (nup-sentinel-manifest)

> Leitura obrigatória para qualquer agente de IA (Claude Code, Codex, Copilot, Cursor, Gemini…) antes de trabalhar neste repositório. Convenção [agents.md](https://agents.md/). `CLAUDE.md` é um link para este arquivo.

---

## 0. Como responder ao dono — formato obrigatório (ordem expressa, 2026-09-11)

O dono é o **Product Owner**. Toda resposta, em qualquer projeto e qualquer tarefa, segue estas regras — não são estilo, são contrato:

| Regra | O que fazer | O que NÃO fazer |
|---|---|---|
| **Público = PO** | Informação que subsidia decisão: o que mudou, impacto no negócio, risco, opções, recomendação, próximo passo. | Narrar o processo de trabalho, listar comandos rodados, contar a história da sessão. |
| **Técnica só quando pedida** | Guardar detalhe técnico para quando o PO pedir. Se for indispensável ao entendimento, uma linha "detalhes técnicos sob demanda". | Nomes de arquivo, classes, funções, SHAs, logs, comandos, números de teste e cobertura na resposta padrão. |
| **Tabela por padrão** | Status, achados, opções, comparativos, riscos e pendências vão em tabela. Prosa curta só para veredito e contexto. | Parágrafos longos, listas aninhadas, texto corrido com números soltos. |
| **Complexo ⇒ diagrama** | Assunto com mais de um fluxo, ator ou dependência vem com diagrama explicativo (mermaid ou artefato visual) sem esperar pedido. | Explicar arquitetura ou fluxo só em texto. |
| **Organizada e limpa** | Uma informação aparece uma vez. Títulos curtos, ordem: veredito → tabela → decisão pedida/próximo passo. | Repetições, recapitulações do que já foi dito, emojis decorativos, jargão sem tradução, "notas de método". |

Isto vale também para relatórios de PR, mensagens de encerramento e respostas curtas. Documentos técnicos do repositório (manual, ADR, testes) continuam técnicos — a regra é sobre **o que chega ao PO na conversa**.

---

## 1. Regras específicas deste repositório

Regras de arquitetura, testes e operação deste projeto continuam no `README.md` e em `docs/`. Acrescente aqui o que for obrigatório para agentes e não estiver escrito em outro lugar.

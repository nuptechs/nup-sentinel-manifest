# Manifest — nota do Replit (stub)

> **Verificado @ cf394d3 · 2026-08-11.** Se código e este doc divergirem, o código vence — atualize este doc no MESMO PR.
<!-- doc-verify: on -->

A arquitetura autoritativa deste módulo vive em [`README.md`](README.md) e [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) — ambos code-anchored (`arquivo:símbolo`) e verificados pelo linter `scripts/doc-verify.mjs`.

O enquadramento antigo deste arquivo ("Code-to-Permission Catalog Generator") está **obsoleto**: o produto real é um **servidor de análise de evidência tri-eixo** (RUNTIME_OBSERVED / STATIC_PROVEN / CONFIG_PROVEN, mais o método de admissão STATIC_UNRESOLVED) que monta um grafo de aplicação, cataloga endpoints/permissões/entidades e provê evidência por REST, com veredito determinístico local. O catálogo de permissões e os geradores de manifesto são **uma das saídas**, não a tese.

Nada aqui deve ser tratado como fonte de verdade sobre o código — leia o `README.md`.

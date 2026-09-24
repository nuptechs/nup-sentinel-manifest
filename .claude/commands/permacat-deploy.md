---
description: Verifica o deploy do PermaCat (nup-sentinel-manifest) no Railway
---
# /permacat-deploy — deploy do PermaCat

Repo é o variante deployado (railway.toml). O engine Java só compila no CI — editar Java aqui é às cegas até o job `java-engine` (mvn, temurin 21).
1. Confirme o deploy Railway após o merge (startup/healthz).
2. `check` (tsc) está fora do gate por dívida de tipos legada — não confie nele como rede.

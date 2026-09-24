#!/usr/bin/env bash
# nup-sentinel-manifest: 'check' (tsc) esta FORA do gate (divida de tipos legada).
# O gate real e test (server) + test:client. Roda-os se .ts mudou.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -d node_modules ] || { echo "ℹ pulei testes (node_modules ausente)." >&2; exit 0; }
if git diff --quiet -- '*.ts' '*.tsx' 2>/dev/null && git diff --cached --quiet -- '*.ts' '*.tsx' 2>/dev/null; then exit 0; fi
fail=0
if ! out="$(npm test 2>&1)"; then echo "🚫 test (server) falhou:" >&2; printf '%s\n' "$out" | tail -20 >&2; fail=1; fi
if ! out="$(npm run test:client 2>&1)"; then echo "🚫 test:client (telas do Mapa) falhou:" >&2; printf '%s\n' "$out" | tail -20 >&2; fail=1; fi
[ "$fail" = 1 ] && exit 2
exit 0

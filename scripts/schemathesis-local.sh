#!/usr/bin/env bash
# ─────────────────────────────────────────────
# Schemathesis local — adversarial fuzzing do Manifest contra o próprio OpenAPI.
#
# Schemathesis lê o spec OpenAPI 3.0 exposto em /api/docs/openapi.json
# e gera milhares de inputs adversariais (boundary, type confusion, missing
# required, oversized, malformed enum, etc.) automaticamente. Resultado:
# cobertura property-based grátis sem escrever caso a caso.
#
# Pre-requisitos:
#   - Manifest server rodando (npm run dev) na porta 5000
#   - Docker OU `pipx install schemathesis` (recomendado: pipx, mais rápido)
#
# Uso:
#   ./scripts/schemathesis-local.sh                 # roda via pipx se instalado
#   ./scripts/schemathesis-local.sh --docker        # força Docker (sem instalar nada)
#
# Configuração mínima — não atira contra rotas que MUTAM dados (POST/PUT/DELETE)
# por enquanto, só GET. Pra ampliar, edite --method-allowed abaixo.
# ─────────────────────────────────────────────

set -euo pipefail

SERVER_URL="${MANIFEST_SERVER_URL:-http://localhost:5000}"
SPEC_URL="${MANIFEST_OPENAPI_URL:-${SERVER_URL}/api/docs/openapi.json}"
CHECKS="not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance"
MAX_EXAMPLES="${SCHEMATHESIS_MAX_EXAMPLES:-50}"
WORKERS="${SCHEMATHESIS_WORKERS:-2}"

probe_server() {
  if ! curl -sf -m 3 "${SPEC_URL}" -o /dev/null; then
    echo "❌ Não consegui buscar ${SPEC_URL}." >&2
    echo "   Inicie o Manifest server antes ('npm run dev') e rode de novo." >&2
    exit 1
  fi
}

run_pipx() {
  if ! command -v pipx >/dev/null 2>&1; then
    return 1
  fi
  echo "▶ rodando via pipx (schemathesis)…"
  pipx run schemathesis \
    run "${SPEC_URL}" \
    --base-url "${SERVER_URL}" \
    --checks "${CHECKS}" \
    --include-method GET \
    --hypothesis-max-examples "${MAX_EXAMPLES}" \
    --workers "${WORKERS}"
}

run_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "❌ Nem pipx nem docker disponíveis. Instale um:" >&2
    echo "     brew install pipx   # macOS" >&2
    echo "     # ou Docker Desktop" >&2
    exit 1
  fi
  echo "▶ rodando via Docker (schemathesis/schemathesis)…"
  docker run --rm \
    --network host \
    schemathesis/schemathesis:stable \
    run "${SPEC_URL}" \
    --base-url "${SERVER_URL}" \
    --checks "${CHECKS}" \
    --include-method GET \
    --hypothesis-max-examples "${MAX_EXAMPLES}" \
    --workers "${WORKERS}"
}

main() {
  probe_server
  if [[ "${1:-}" == "--docker" ]]; then
    run_docker
    exit $?
  fi
  if run_pipx; then
    exit 0
  fi
  run_docker
}

main "$@"

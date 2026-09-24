#!/usr/bin/env bash
# nup-sentinel-manifest: valida ancoras de doc marcadas ao editar *.md.
set -uo pipefail
f="$(cat | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[ -z "$f" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
case "$f" in
  *.md)
    if [ -f scripts/doc-verify.mjs ]; then
      if ! out="$(node scripts/doc-verify.mjs --root . --marked 2>&1)"; then echo "🚫 doc:verify falhou:" >&2; printf '%s\n' "$out" | tail -12 >&2; exit 2; fi
    fi ;;
esac
exit 0

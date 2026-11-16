#!/usr/bin/env bash
# The checks to run before a push (user's choice, 5 Nov 2026: a local script, no CI on GitHub).
#
#   scripts/check.sh          backend tests (not the live-month data checks), Python lint, frontend unit tests, lint,
#                             typecheck + build, audits
#   scripts/check.sh --data   the same plus the golden checks on the live month's file (about a minute)
#
# Needs backend/.venv with requirements.txt and requirements-dev.txt, and frontend/node_modules (npm ci).
# The audits ask PyPI and npm for known vulnerabilities, so they need the network. Exits non-zero on any failure.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PY=backend/.venv/bin/python
[ -x "$PY" ] || PY=backend/.venv/Scripts/python.exe
failed=()

step() {
  local name=$1; shift
  printf '\n== %s\n' "$name"
  if "$@"; then printf -- '-- %s: ok\n' "$name"; else printf -- '-- %s: FAILED\n' "$name"; failed+=("$name"); fi
}

marker='not data'
[ "${1:-}" = "--data" ] && marker=''
step "backend tests" bash -c "cd '$ROOT/backend' && APP_ENV=local '$ROOT/$PY' -m pytest -q ${marker:+-m '$marker'}"
step "python lint" bash -c "cd '$ROOT/backend' && '$ROOT/$PY' -m ruff check ."
step "frontend unit tests" npm --prefix frontend test --silent
step "frontend lint" npm --prefix frontend run lint --silent
step "frontend typecheck + build" npm --prefix frontend run build --silent
# requirements.txt pins every version, so pip-audit checks them as listed (no resolving, no throwaway venv).
step "python dependency audit" "$PY" -m pip_audit -r backend/requirements.txt --no-deps --disable-pip --progress-spinner off
step "npm dependency audit" npm --prefix frontend audit --omit=dev --audit-level=moderate

printf '\n'
if [ ${#failed[@]} -eq 0 ]; then echo "All checks passed."; else echo "Failed: ${failed[*]}"; exit 1; fi

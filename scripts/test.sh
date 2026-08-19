#!/usr/bin/env bash
# Offline gate for main. Must exit 0 on a clean clone with no secrets.
# When application code lands, add unit/contract tests here. Do not delete the
# contract checks. Do not require live third-party networks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

echo "== contract files =="
for f in README.md SPEC.md BUILD.md CONTRIBUTING.md scripts/test.sh; do
  [[ -f "$f" ]] || fail "missing $f"
  [[ -s "$f" ]] || fail "empty $f"
done

echo "== contributing rules are documented =="
grep -q 'main must always be buildable' CONTRIBUTING.md \
  || grep -q 'main` must always be buildable' CONTRIBUTING.md \
  || fail "CONTRIBUTING.md does not state the main-branch rule"

echo "== SPEC mentions git collaboration =="
grep -q 'Git collaboration' SPEC.md || fail "SPEC.md missing Git collaboration section"

echo "== no committed secrets =="
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env$|(^|/)id_rsa$|\.pem$|credentials\.json$' >/dev/null; then
    fail "secret-like path is tracked"
  fi
fi

echo "== markdown is UTF-8 text =="
file -b --mime-encoding README.md SPEC.md CONTRIBUTING.md BUILD.md | grep -qiE 'utf-8|us-ascii' \
  || fail "docs are not UTF-8/ASCII"

if [[ -f package.json ]]; then
  echo "== install =="
  if [[ ! -d node_modules ]]; then
    if [[ -f package-lock.json ]]; then
      npm ci
    else
      npm install
    fi
  fi

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  npx tsx --test 'tests/**/*.test.ts'

  echo "== fixture is local (no live vendors) =="
  [[ -f fixtures/clipapi.openapi.yaml ]] || fail "missing fixtures/clipapi.openapi.yaml"
  grep -qiE 'tiktok\.com|reddit\.com|amazon\.com' fixtures/clipapi.openapi.yaml \
    && fail "clip fixture must not point at live TikTok/Reddit/Amazon"

  echo "== skillseed generate --help =="
  help_out="$(npx --no-install tsx src/cli.ts generate --help)"
  printf '%s\n' "$help_out" | grep -q 'Usage: skillseed generate' \
    || fail "generate --help did not print usage"
  printf '%s\n' "$help_out" | grep -qiE 'tiktok|reddit\.com|amazon' \
    && fail "help text must stay offline / vendor-free"

  echo "== invalid yaml exits non-zero =="
  invalid="$(mktemp "${TMPDIR:-/tmp}/skillseed-invalid.XXXXXX.yaml")"
  printf 'openapi: [\n  this is not: valid: yaml\n' >"$invalid"
  set +e
  invalid_out="$(npx --no-install tsx src/cli.ts generate "$invalid" 2>&1)"
  invalid_status=$?
  set -e
  rm -f "$invalid"
  [[ "$invalid_status" -ne 0 ]] || fail "invalid yaml exited 0"
  printf '%s\n' "$invalid_out" | grep -qi 'error:' \
    || fail "invalid yaml did not print an error"
fi

echo "OK: buildable and testable"

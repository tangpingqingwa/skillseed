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
  invalid="$(mktemp "${TMPDIR:-/tmp}/skillseed-invalid.XXXXXX")"
  printf 'openapi: [\n  this is not: valid: yaml\n' >"$invalid"
  set +e
  invalid_out="$(npx --no-install tsx src/cli.ts generate "$invalid" 2>&1)"
  invalid_status=$?
  set -e
  rm -f "$invalid"
  [[ "$invalid_status" -ne 0 ]] || fail "invalid yaml exited 0"
  printf '%s\n' "$invalid_out" | grep -qi 'error:' \
    || fail "invalid yaml did not print an error"

  echo "== generate clip fixture zip (offline) =="
  [[ -f src/templates/skill.stub.md ]] || fail "missing stub skill template"
  gen_dir="$(mktemp -d "${TMPDIR:-/tmp}/skillseed-gen.XXXXXX")"
  set +e
  gen_out="$(npx --no-install tsx src/cli.ts generate fixtures/clipapi.openapi.yaml --out "$gen_dir/pack.zip" 2>&1)"
  gen_status=$?
  set -e
  [[ "$gen_status" -eq 0 ]] || fail "generate clip fixture failed: $gen_out"
  printf '%s\n' "$gen_out" | grep -q 'ok: wrote 1 tools' \
    || fail "generate did not report 1 tool"
  [[ -f "$gen_dir/pack.zip" ]] || fail "generate did not write a zip"
  python3 - "$gen_dir/pack.zip" <<'PY' || fail "zip missing SKILL.md or mcp/server.json"
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = set(z.namelist())
need = {"SKILL.md", "mcp/server.json", "mcp/index.js"}
missing = need - names
if missing:
    raise SystemExit("missing " + ", ".join(sorted(missing)))
skill = z.read("SKILL.md").decode()
server = z.read("mcp/server.json").decode()
if "get_transcript" not in skill or "get_transcript" not in server:
    raise SystemExit("tools not present in stub skill / server.json")
if "{{API_NAME}}" in skill or "{{TOOLS_TABLE}}" in skill:
    raise SystemExit("stub template placeholders left unfilled")
PY
  rm -rf "$gen_dir"

  echo "== 9th tool rejected (exit 2) =="
  nine="$(mktemp -d "${TMPDIR:-/tmp}/skillseed-nine.XXXXXX")"
  cat >"$nine/openapi.yaml" <<'YAML'
openapi: 3.1.0
info:
  title: TooMany
  version: 0.1.0
paths:
  /a:
    get: { operationId: tool_a, responses: { "200": { description: ok } } }
  /b:
    get: { operationId: tool_b, responses: { "200": { description: ok } } }
  /c:
    get: { operationId: tool_c, responses: { "200": { description: ok } } }
  /d:
    get: { operationId: tool_d, responses: { "200": { description: ok } } }
  /e:
    get: { operationId: tool_e, responses: { "200": { description: ok } } }
  /f:
    get: { operationId: tool_f, responses: { "200": { description: ok } } }
  /g:
    get: { operationId: tool_g, responses: { "200": { description: ok } } }
  /h:
    get: { operationId: tool_h, responses: { "200": { description: ok } } }
  /i:
    get: { operationId: tool_i, responses: { "200": { description: ok } } }
YAML
  set +e
  nine_out="$(npx --no-install tsx src/cli.ts generate "$nine/openapi.yaml" --out "$nine/x.zip" 2>&1)"
  nine_status=$?
  set -e
  rm -rf "$nine"
  [[ "$nine_status" -eq 2 ]] || fail "9th tool exited $nine_status, expected 2"
  printf '%s\n' "$nine_out" | grep -qi 'error:' \
    || fail "9th tool did not print an error"
fi

echo "OK: buildable and testable"

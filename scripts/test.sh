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

  # Live ProsePort is env-gated and must never run in this script.
  unset SKILLSEED_USE_LIVE_PROSE
  unset SKILLSEED_LLM_API_KEY
  unset SKILLSEED_LLM_BASE_URL
  unset GENERATION_MODEL

  echo "== tsc --noEmit =="
  npx tsc --noEmit

  echo "== unit tests =="
  # Quoted so bash 3.2 does not eat **; Node 22's test runner expands the glob.
  npx tsx --test 'tests/**/*.test.ts'

  echo "== fixtures are local (no live vendors) =="
  [[ -f fixtures/clipapi.openapi.yaml ]] || fail "missing fixtures/clipapi.openapi.yaml"
  [[ -f fixtures/redditapi.openapi.yaml ]] || fail "missing fixtures/redditapi.openapi.yaml"
  grep -qiE 'tiktok\.com|reddit\.com|amazon\.com' fixtures/clipapi.openapi.yaml \
    && fail "clip fixture must not point at live TikTok/Reddit/Amazon"
  grep -qiE 'tiktok\.com|reddit\.com|amazon\.com' fixtures/redditapi.openapi.yaml \
    && fail "reddit fixture must not point at live TikTok/Reddit/Amazon"
  grep -q 'operationId: unroll_thread' fixtures/redditapi.openapi.yaml \
    || fail "reddit fixture missing unroll_thread"
  grep -q 'operationId: get_transcript' fixtures/redditapi.openapi.yaml \
    && fail "reddit fixture must not reuse ClipAPI get_transcript"

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
  for dir_tpl in cursor claude openclaw chatgpt; do
    [[ -f "templates/directories/${dir_tpl}.md" ]] || fail "missing templates/directories/${dir_tpl}.md"
  done
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
need = {
    "SKILL.md",
    "mcp/server.json",
    "mcp/index.js",
    "directories/cursor.md",
    "directories/claude.md",
    "directories/openclaw.md",
    "directories/chatgpt.md",
}
missing = need - names
if missing:
    raise SystemExit("missing " + ", ".join(sorted(missing)))
skill = z.read("SKILL.md").decode()
server = z.read("mcp/server.json").decode()
if "get_transcript" not in skill or "get_transcript" not in server:
    raise SystemExit("tools not present in skill / server.json")
if "{{API_NAME}}" in skill or "{{TOOLS_TABLE}}" in skill:
    raise SystemExit("template placeholders left unfilled")
cursor = z.read("directories/cursor.md").decode()
if "**Human must click submit**" not in cursor:
    raise SystemExit("directory draft missing human-submit line")
if "{{SUGGESTED_NAME}}" in cursor:
    raise SystemExit("directory placeholders left unfilled")
PY
  rm -rf "$gen_dir"

  echo "== LLM-down still zips stub skill (offline) =="
  llm_dir="$(mktemp -d "${TMPDIR:-/tmp}/skillseed-llm.XXXXXX")"
  set +e
  llm_out="$(SKILLSEED_PROSE_FAIL=1 npx --no-install tsx src/cli.ts generate fixtures/clipapi.openapi.yaml --out "$llm_dir/pack.zip" 2>&1)"
  llm_status=$?
  set -e
  [[ "$llm_status" -eq 0 ]] || fail "LLM-down generate failed: $llm_out"
  [[ -f "$llm_dir/pack.zip" ]] || fail "LLM-down did not write a zip"
  python3 - "$llm_dir/pack.zip" <<'PY' || fail "LLM-down zip missing stub skill or tools"
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
skill = z.read("SKILL.md").decode()
server = json.loads(z.read("mcp/server.json").decode())
if "get_transcript" not in skill:
    raise SystemExit("stub skill missing get_transcript")
if "{{API_NAME}}" in skill:
    raise SystemExit("stub placeholders left")
if server["tools"][0]["name"] != "get_transcript":
    raise SystemExit("tools not intact")
if "url" not in server["tools"][0]["inputSchema"].get("required", []):
    raise SystemExit("schema not intact")
PY
  rm -rf "$llm_dir"

  echo "== generate reddit fixture zip (offline) =="
  reddit_dir="$(mktemp -d "${TMPDIR:-/tmp}/skillseed-reddit.XXXXXX")"
  set +e
  reddit_out="$(npx --no-install tsx src/cli.ts generate fixtures/redditapi.openapi.yaml --out "$reddit_dir/pack.zip" 2>&1)"
  reddit_status=$?
  set -e
  [[ "$reddit_status" -eq 0 ]] || fail "generate reddit fixture failed: $reddit_out"
  printf '%s\n' "$reddit_out" | grep -q 'ok: wrote 5 tools' \
    || fail "generate did not report 5 reddit tools"
  [[ -f "$reddit_dir/pack.zip" ]] || fail "generate did not write reddit zip"
  python3 - "$reddit_dir/pack.zip" <<'PY' || fail "reddit zip missing tools or leaked clip ids"
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
names = set(z.namelist())
need = {"SKILL.md", "mcp/server.json", "mcp/index.js"}
missing = need - names
if missing:
    raise SystemExit("missing " + ", ".join(sorted(missing)))
skill = z.read("SKILL.md").decode()
server = json.loads(z.read("mcp/server.json").decode())
tool_names = [t["name"] for t in server["tools"]]
expect = ["get_latest", "get_post", "list_subreddit", "search_reddit", "unroll_thread"]
if tool_names != expect:
    raise SystemExit("unexpected tools: " + ",".join(tool_names))
if "unroll_thread" not in skill or "get_transcript" in skill:
    raise SystemExit("skill is not the RedditAPI pack")
if "get_transcript" in z.read("mcp/index.js").decode():
    raise SystemExit("generated client still mentions get_transcript")
cursor = z.read("directories/cursor.md").decode()
if "**Human must click submit**" not in cursor or "RedditAPI" not in cursor:
    raise SystemExit("reddit directory draft incomplete")
PY
  rm -rf "$reddit_dir"

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

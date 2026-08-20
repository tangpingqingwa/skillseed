#!/usr/bin/env bash
# Operator-only live smoke. Not called from scripts/test.sh or GitHub Actions.
#
# Required flows:
#   1. skillseed generate on a live ClipAPI or RedditAPI OpenAPI URL (not fixtures)
#      Zip must contain MCP + SKILL.md.
#   2. $29 Checkout against live Stripe only if STRIPE_SECRET_KEY is present.
#      Missing secret → BLOCKED-SECRET (exact env var). Does not invent a charge.
# Hosted MCP stays out (PR 6). This script never starts /mcp or sets hostMcp.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "FAIL: live-smoke must not run in GitHub Actions" >&2
  exit 1
fi

if [[ "${CI:-}" == "true" && "${LIVE_SMOKE_ALLOW_CI:-}" != "1" ]]; then
  echo "FAIL: live-smoke is opt-in and refuses CI unless LIVE_SMOKE_ALLOW_CI=1" >&2
  exit 1
fi

PASS=0
PASS_ERROR=0
FAIL=0
BLOCKED=0
STARTED_PID=""
WORKDIR=""
RESULTS=()

cleanup() {
  if [[ -n "${STARTED_PID}" ]]; then
    kill "${STARTED_PID}" >/dev/null 2>&1 || true
    wait "${STARTED_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WORKDIR}" && -d "${WORKDIR}" ]]; then
    rm -rf "${WORKDIR}"
  fi
}
trap cleanup EXIT

fail_msg() {
  echo "FAIL: $*" >&2
}

record() {
  local name="$1" verdict="$2" detail="$3"
  case "$verdict" in
    PASS) PASS=$((PASS + 1)) ;;
    PASS-ERROR) PASS_ERROR=$((PASS_ERROR + 1)) ;;
    BLOCKED-SECRET) BLOCKED=$((BLOCKED + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    *) verdict="FAIL"; FAIL=$((FAIL + 1)); detail="unknown verdict: $2 ($detail)" ;;
  esac
  printf '%s\n' "| ${name} | ${verdict} | ${detail} |"
  RESULTS+=("${name}"$'\t'"${verdict}"$'\t'"${detail}")
}

pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

# Published ClipAPI OpenAPI (live HTTP). Override with SKILLSEED_LIVE_OPENAPI_URL.
# Production api.clipapi.dev is tried first when no override is set.
DEFAULT_RAW_URL="https://raw.githubusercontent.com/tangpingqingwa/clipapi/main/openapi/openapi.yaml"
DEFAULT_API_URL="https://api.clipapi.dev/openapi.json"
CLIP_TOOLS=(getTranscript getLatestVideos listCreatorVideos)

if [[ ! -d node_modules ]]; then
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

command -v curl >/dev/null || { fail_msg "curl is required"; exit 1; }
command -v python3 >/dev/null || { fail_msg "python3 is required"; exit 1; }

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/skillseed-live-smoke.XXXXXX")"
CURL_TIMEOUT="${LIVE_SMOKE_TIMEOUT:-30}"

echo "== live-smoke (operator only; not CI) =="
echo "hosted MCP stays out"

if [[ -n "${SKILLSEED_LIVE_OPENAPI_URL:-}" ]]; then
  OPENAPI_URL="${SKILLSEED_LIVE_OPENAPI_URL}"
  echo "openapi=${OPENAPI_URL} (override)"
else
  set +e
  probe_code="$(curl -sS -o "${WORKDIR}/probe.body" -w '%{http_code}' --max-time 8 \
    -A "skillseed-live-smoke/0.1" \
    "${DEFAULT_API_URL}" 2>"${WORKDIR}/probe.err")"
  probe_st=$?
  set -e
  if [[ "$probe_st" -eq 0 && "$probe_code" == "200" ]]; then
    OPENAPI_URL="${DEFAULT_API_URL}"
    echo "openapi=${OPENAPI_URL} (api host)"
  else
    OPENAPI_URL="${DEFAULT_RAW_URL}"
    echo "openapi=${OPENAPI_URL} (published spec; api host http=${probe_code:-000} curl=${probe_st})"
  fi
fi

if [[ ! "$OPENAPI_URL" =~ ^https?:// ]]; then
  fail_msg "OpenAPI source must be an http(s) URL, not a local fixture path: ${OPENAPI_URL}"
  exit 1
fi
if [[ "$OPENAPI_URL" == *"/fixtures/"* ]]; then
  fail_msg "refusing in-repo fixture URL: ${OPENAPI_URL}"
  exit 1
fi

echo
echo "| case | verdict | detail |"
echo "|---|---|---|"

ZIP_PATH="${WORKDIR}/pack.zip"
set +e
gen_out="$(npx --no-install tsx src/cli.ts generate "${OPENAPI_URL}" \
  --out "${ZIP_PATH}" \
  --name ClipAPI \
  --homepage "https://api.clipapi.dev" \
  --allow-tool "${CLIP_TOOLS[0]}" \
  --allow-tool "${CLIP_TOOLS[1]}" \
  --allow-tool "${CLIP_TOOLS[2]}" 2>&1)"
gen_status=$?
set -e

if [[ "$gen_status" -ne 0 ]]; then
  record "generate from live OpenAPI URL" "FAIL" "exit ${gen_status}: $(printf '%s' "$gen_out" | tr '\n' ' ' | cut -c1-180)"
  record "zip contains MCP + SKILL.md" "FAIL" "generate did not write a zip"
else
  record "generate from live OpenAPI URL" "PASS" "$(printf '%s' "$gen_out" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [[ ! -f "$ZIP_PATH" ]]; then
    record "zip contains MCP + SKILL.md" "FAIL" "missing ${ZIP_PATH}"
  else
    set +e
    zip_detail="$(python3 - "$ZIP_PATH" <<'PY'
import sys, zipfile, json
path = sys.argv[1]
z = zipfile.ZipFile(path)
names = set(z.namelist())
need = {"SKILL.md", "mcp/server.json", "mcp/index.js"}
missing = sorted(need - names)
if missing:
    print("missing " + ", ".join(missing))
    sys.exit(1)
skill = z.read("SKILL.md").decode("utf-8", "replace")
server = json.loads(z.read("mcp/server.json").decode("utf-8"))
tools = [t.get("name") for t in server.get("tools", [])]
if not tools:
    print("mcp/server.json has no tools")
    sys.exit(1)
if len(tools) > 8:
    print("more than 8 tools: " + ",".join(tools))
    sys.exit(1)
if not skill.strip() or not skill.lstrip().startswith("#"):
    print("SKILL.md missing title")
    sys.exit(1)
if "{{API_NAME}}" in skill or "{{TOOLS_TABLE}}" in skill:
    print("template placeholders left unfilled")
    sys.exit(1)
for name in tools:
    if name not in skill:
        print("SKILL.md missing tool " + name)
        sys.exit(1)
print("SKILL.md + mcp/server.json + mcp/index.js; tools=" + ",".join(tools))
PY
)"
    zip_st=$?
    set -e
    if [[ "$zip_st" -eq 0 ]]; then
      record "zip contains MCP + SKILL.md" "PASS" "${zip_detail}"
    else
      record "zip contains MCP + SKILL.md" "FAIL" "${zip_detail}"
    fi
  fi
fi

# $29 Checkout: live Stripe only. Missing secret is BLOCKED-SECRET, not a fake charge.
if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  echo "BLOCKED-SECRET: STRIPE_SECRET_KEY"
  record "\$29 checkout live" "BLOCKED-SECRET" "STRIPE_SECRET_KEY"
else
  PORT="$(pick_port)"
  BASE="http://127.0.0.1:${PORT}"
  export SKILLSEED_USE_LIVE_STRIPE=1
  echo "start live Stripe serve on ${BASE}"
  npx --no-install tsx src/cli.ts serve --host 127.0.0.1 --port "${PORT}" \
    >"${WORKDIR}/server.log" 2>&1 &
  STARTED_PID=$!
  ready=0
  for _ in $(seq 1 40); do
    if ! kill -0 "${STARTED_PID}" >/dev/null 2>&1; then
      record "\$29 checkout live" "FAIL" "serve exited before listen"
      sed -n '1,40p' "${WORKDIR}/server.log" >&2 || true
      ready=2
      break
    fi
    if grep -q 'ok: listening' "${WORKDIR}/server.log" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 0.25
  done
  if [[ "$ready" == "1" ]]; then
    set +e
    job_code="$(curl -sS -o "${WORKDIR}/job.json" -w '%{http_code}' --max-time "${CURL_TIMEOUT}" \
      -H 'content-type: application/json' \
      -H 'accept: application/json' \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"apiName":"ClipAPI","homepage":"https://api.clipapi.dev","openapiUrl":sys.argv[1],"allowTools":["getTranscript","getLatestVideos","listCreatorVideos"]}))' "${OPENAPI_URL}")" \
      "${BASE}/jobs")"
    job_st=$?
    set -e
    if [[ "$job_st" -ne 0 ]]; then
      record "\$29 checkout live" "FAIL" "POST /jobs curl_exit_${job_st}"
    else
      set +e
      pay_detail="$(python3 - "${WORKDIR}/job.json" "${job_code}" <<'PY'
import json, sys
body_path, http = sys.argv[1], sys.argv[2]
try:
    doc = json.load(open(body_path))
except Exception as exc:
    print(f"http {http} non-json ({exc})")
    sys.exit(1)
if http != "201":
    print(f"http {http} error={doc.get('error')!r}")
    sys.exit(1)
if doc.get("status") != "awaiting_payment" or doc.get("paid") is not False:
    print(f"status={doc.get('status')!r} paid={doc.get('paid')!r} (wanted awaiting_payment / false)")
    sys.exit(1)
if doc.get("amountCents") != 2900:
    print(f"amountCents={doc.get('amountCents')!r} != 2900")
    sys.exit(1)
url = doc.get("checkoutUrl") or ""
if not str(url).startswith("https://checkout.stripe.com"):
    print(f"checkoutUrl is not live Stripe: {url[:80]!r}")
    sys.exit(1)
if doc.get("artifacts"):
    print("unpaid job already has artifacts")
    sys.exit(1)
print(f"http 201 awaiting_payment amountCents=2900 checkout=stripe")
PY
)"
      pay_st=$?
      set -e
      if [[ "$pay_st" -eq 0 ]]; then
        record "\$29 checkout live" "PASS" "${pay_detail}"
      else
        record "\$29 checkout live" "FAIL" "${pay_detail}"
      fi
    fi
  elif [[ "$ready" == "0" ]]; then
    record "\$29 checkout live" "FAIL" "serve did not become ready"
    sed -n '1,40p' "${WORKDIR}/server.log" >&2 || true
  fi
fi

echo
echo "summary: PASS=${PASS} PASS-ERROR=${PASS_ERROR} BLOCKED-SECRET=${BLOCKED} FAIL=${FAIL}"
echo "hosted MCP: out of scope (not started)"
if [[ "$FAIL" -gt 0 ]]; then
  echo "RESULT: FAIL"
  exit 1
fi
if [[ "$PASS" -eq 0 ]]; then
  echo "RESULT: FAIL (no successful live generate)"
  exit 1
fi
if [[ "$BLOCKED" -gt 0 ]]; then
  echo "RESULT: PASS (checkout BLOCKED-SECRET: STRIPE_SECRET_KEY)"
  exit 0
fi
echo "RESULT: PASS"
exit 0

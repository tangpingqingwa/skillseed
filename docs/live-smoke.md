# Live smoke — generate from a live OpenAPI URL

Operator-only. `bash scripts/live-smoke.sh` is **not** called from `scripts/test.sh` or GitHub Actions. CI never sets `SKILLSEED_USE_LIVE_STRIPE` or `STRIPE_SECRET_KEY`.

Ran this session against the SkillSeed CLI on `feat/live-smoke` (this PR). Generate fetched a **live HTTP OpenAPI URL** (not `fixtures/*.yaml`). Hosted MCP was not started.

| Field | Value |
|---|---|
| Date | 2026-08-20 |
| SHA | `feat/live-smoke` (this PR) |
| Command | `bash scripts/live-smoke.sh` |
| OpenAPI | `https://raw.githubusercontent.com/tangpingqingwa/clipapi/main/openapi/openapi.yaml` |
| Fallback tried first | `https://api.clipapi.dev/openapi.json` (TLS fail, curl 35) |
| Stripe | `STRIPE_SECRET_KEY` unset |

## Cases

| case | verdict | detail |
|---|---|---|
| generate from live OpenAPI URL | PASS | `skillseed generate` fetched the live ClipAPI OpenAPI URL and wrote 3 tools (`getTranscript`, `getLatestVideos`, `listCreatorVideos`) |
| zip contains MCP + SKILL.md | PASS | zip has `SKILL.md`, `mcp/server.json`, `mcp/index.js`; skill is the ClipAPI pack |
| $29 checkout live | BLOCKED-SECRET | `STRIPE_SECRET_KEY` |

**Totals:** PASS=2 PASS-ERROR=0 BLOCKED-SECRET=1 FAIL=0  
**RESULT: PASS** (checkout blocked on missing Stripe secret)

Hosted MCP is out of scope for this unit (BUILD PR 6). The script does not start `/mcp` and does not send `hostMcp: true`.

## What the process actually saw

- `https://api.clipapi.dev/openapi.json` — TLS handshake failed (`SSL_ERROR_SYSCALL`). Not treated as a generate source.
- `https://raw.githubusercontent.com/tangpingqingwa/clipapi/main/openapi/openapi.yaml` — HTTP 200, OpenAPI 3.1 `title: ClipAPI`. This is the live URL generate used.
- Zip contents after generate: `SKILL.md`, `mcp/server.json`, `mcp/index.js`, `openapi.normalized.yaml`, `llms.txt`, `llms-full.txt`, `directories/*`.
- `$29` Checkout was not opened. `STRIPE_SECRET_KEY` is unset in this environment. The script printed `BLOCKED-SECRET: STRIPE_SECRET_KEY` and did not create a FakeStripe charge.

## Re-run

```bash
# generate from the published ClipAPI OpenAPI URL
bash scripts/live-smoke.sh

# optional: pin a different live URL (must be http(s), not fixtures/)
SKILLSEED_LIVE_OPENAPI_URL=https://raw.githubusercontent.com/tangpingqingwa/redditapi/main/openapi/threads.yaml \
  bash scripts/live-smoke.sh

# live $29 Checkout (creates a real Stripe session; does not complete payment)
SKILLSEED_USE_LIVE_STRIPE=1 STRIPE_SECRET_KEY=sk_test_... \
  bash scripts/live-smoke.sh
```

Do not set `SKILLSEED_USE_LIVE_STRIPE=1` in `.github/workflows/ci.yml`. Offline gate remains `bash scripts/test.sh`.

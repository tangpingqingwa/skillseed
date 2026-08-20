# SkillSeed — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/skillseed  
**Customer zero:** ClipAPI, then RedditAPI, ThreadAPI, AsinAPI, LocalAPI, HireAPI, SaaSReviews, StoreAPI

Not an agent platform. Packaging: OpenAPI → MCP + SKILL.md + llms.txt + directory drafts.

---

## 1. Product statement

Indie API authors already have REST. Agents cannot see them until someone writes MCP, a skill that says when **not** to call, and directory copy.

One-line pitch: **Paste OpenAPI. Get an installable MCP and a skill in under 60 minutes.**

Shimecki’s real lever, productized.

---

## 2. Goals and non-goals

### Goals

- Input: OpenAPI 3.x URL + auth scheme + tool allow-list (default ≤ 8).
- Output in ≤ 60 minutes of wall time (generation may be 2–10 min):  
  hosted or downloadable MCP, `SKILL.md`, `llms.txt`, `llms-full.txt`, submission drafts.
- Human-editable. Not a black box.
- ClipAPI + RedditAPI packs install in Cursor and Claude and successfully call one tool.
- Internal use free. External: one-time generate fee.

### Non-goals

- CRHQ / “employees” / swarm runtime.
- Sandbox, browser, general agent.
- Writing the customer’s business code.
- One-click guaranteed listing on every directory.
- Revenue share on customer API usage.

**Demote rule:** if after 6 months only we use it, stop selling, keep as infra. Do not force a platform.

---

## 3. Users

| Persona | Need |
|---|---|
| Us | regenerate packs when OpenAPI changes |
| Indie API author | MCP + skill + copy |
| Agent user | not a SkillSeed user; they install the result |

---

## 4. Product surfaces

```
GET  /                     marketing + paste OpenAPI URL
POST /jobs                 start generate (auth or checkout)
GET  /jobs/:id             status + artifacts
GET  /jobs/:id/files.zip
GET  /mcp/:tenant/...      optional hosted MCP
GET  /docs
```

`POST /jobs` creates a **$29** Stripe Checkout session and a job in `awaiting_payment`. Generate does **not** run until payment completes. `GET /jobs/:id` returns status and, when `ready`, artifact links. `GET /jobs/:id/files.zip` is the zip. Tests and CI use a fake Stripe; live Checkout is env-gated (`SKILLSEED_USE_LIVE_STRIPE=1`).

v1 can be CLI-first for us (`skillseed generate ./openapi.yaml`) plus a thin web checkout later.

Launch order: **CLI for dogfood → web generate $29**.

---

## 5. Generate job

### Input

```ts
type GenerateInput = {
  openapiUrl?: string
  openapiInline?: object
  apiName: string
  homepage: string
  auth: { type: "bearer" | "header", headerName?: string, prefix?: string }
  allowTools: string[]          // operationIds, max 8
  denyGuidance: string[]        // when not to call
  sampleDialogue: string        // optional
  hostMcp: boolean
}
```

Reject OpenAPI without `operationId` on selected ops. Reject > 8 tools unless Pro later.

### Pipeline

1. Fetch and validate OpenAPI 3.0/3.1.
2. Resolve allow-list; map each op to an MCP tool (name, description, JSON schema from parameters + body).
3. Generate `SKILL.md` from a frozen template (see §7).
4. Generate `llms.txt` (short) and `llms-full.txt` (endpoint table).
5. Generate directory drafts: Cursor, Claude, OpenClaw, ChatGPT (markdown checklists + suggested blurbs).
6. If `hostMcp`: deploy a stateless proxy tenant.
7. Zip artifacts. Mark job `ready`.

LLM use: allowed for SKILL prose and sample dialogue **only**. Tool JSON schema must be deterministic from OpenAPI (no LLM on schema). If LLM fails, still ship schema + a stub skill.

Pin `GENERATION_MODEL`. No GPU fleet.

### Output tree

```
dist/
  openapi.normalized.yaml
  mcp/server.json
  mcp/index.js          # or a config for a generic proxy
  SKILL.md
  llms.txt
  llms-full.txt
  directories/
    cursor.md
    claude.md
    openclaw.md
    chatgpt.md
```

---

## 6. Hosted MCP

Thin proxy:

- Terminate Streamable HTTP MCP.
- Map tool call → customer REST with injected `Authorization` from the **end-user** (OAuth or they paste their API key into the agent config — we do not store customer end-user keys in v1).
- For our own APIs, users put `ck_live_` in the MCP config headers.

SkillSeed hosted mode stores only: tenant id, origin base URL, allow-list. Logs: tool name, status, latency — **not** full bodies by default.

Price: $9 / mo / tenant after the first generate. Cancel = tenant 404.

Same VPS as the generator until 50 tenants.

---

## 7. SKILL.md template (normative sections)

1. Name + one sentence.  
2. When to use.  
3. When **not** to use (from `denyGuidance` + generic: private data, writes we do not expose).  
4. Auth how-to.  
5. Tools table.  
6. Failure codes → what the agent should tell the human.  
7. One sample dialogue.

Reviews: a second prompt checks the skill does not claim tools that are not in the allow-list.

---

## 8. Directory drafts

Each file is a **checklist**, not an API that submits:

- Suggested name (≤ 40 chars)
- One-liner (≤ 120)
- Sample prompts
- Install snippet
- “Human must click submit” in bold

Do not promise listing. Do not automate ToS evasion.

---

## 9. Billing

| SKU | Price | Notes |
|---|---|---|
| Internal | $0 | our eight APIs |
| Generate | $29 | first 20 public sales; then $49; then $69 (GenerateSpecs-style steps optional — start $29 and stop) |
| Hosted MCP | $9 / mo | optional |

No subscription required to download a zip. One generate = one OpenAPI snapshot. Changed spec = new generate (or $9 regenerate later).

Stripe Checkout. No seats.

---

## 10. Dogfood contract (normative)

A sister API may not claim “built for agents” unless:

- Its OpenAPI is the generate input
- `SKILL.md` in that repo is the SkillSeed output (or diff-reviewed)
- Cursor + Claude install paths were exercised in CI or a recorded checklist

Stale directory copy vs current OpenAPI = SkillSeed bug.

Regression suite: ClipAPI + RedditAPI OpenAPI fixtures in this repo.

---

## 11. Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | ClipAPI OpenAPI → zip | ≤8 tools, schemas match ops |
| 2 | Install MCP in Cursor | `get_transcript` works with a live or mocked key |
| 3 | Install in Claude | same |
| 4 | Repeat on RedditAPI OpenAPI | not a one-off script |
| 5 | LLM down | zip still contains deterministic MCP schema |
| 6 | 9th tool requested | rejected |
| 7 | Skill mentions a tool not in allow-list | generate fails review step |

---

## 12. Milestones

**M1:** CLI `generate` for ClipAPI; manual Cursor/Claude install notes.  
**M2:** RedditAPI second fixture; templates stabilized.  
**M3:** zip download web + $29 Checkout.  
**M4:** hosted MCP $9.  
**M5:** remaining six internal APIs on the pipeline.

Launch external = M3. Internal value = M1.

---

## 13. SEO

Long-form: `How to add MCP to an existing REST API (2026)` with CTA.  
`OpenClaw skill template`.

---

## 14. Legal / risk

We do not host the customer’s production data plane except optional proxy. Customer is responsible for their API ToS. We do not help hide scraping behind MCP.

MCP and directory rules will move. Version the generator (`skillseed 0.x`). Keep eight live OpenAPIs as the regression suite — that is the moat, not a locked runtime.

---

## 15. Layout

```
/
  SPEC.md
  README.md
  src/cli.ts
  src/generate/
  src/templates/
  src/proxy/          # hosted MCP
  fixtures/clipapi.openapi.yaml
  fixtures/redditapi.openapi.yaml
```

## 16. Git collaboration (normative)

Development is GitHub trunk-based. **`main` is always cloneable, buildable, and testable.**

| Rule | Requirement |
|---|---|
| Integration branch | `main` only. No long-lived `develop`. |
| How code lands | Pull request into `main`. No direct push. |
| Required check | GitHub Actions workflow `ci` (job id `ci`) must be green. |
| Local / CI test | `bash scripts/test.sh` — offline, no production secrets. |
| Branch names | `feat/` `fix/` `docs/` `chore/` `test/` + short slug. |
| Merge | Squash. Delete the head branch. |
| Broken `main` | Treat as an incident. Fix on `fix/…` via PR. |

Full process: [CONTRIBUTING.md](./CONTRIBUTING.md).

Implementation plan (stack, modules, PR DAG): [BUILD.md](./BUILD.md).

Until there is an application binary, `scripts/test.sh` still has to pass: contract files exist, SPEC/CONTRIBUTING agree, no tracked secrets. Adding a server or CLI means **extending** that script with unit/contract tests. Live upstream calls are optional and must not be required for `main` to stay green.

# SkillSeed — Detailed Specification and Build Plan

**Contract:** [SPEC.md](./SPEC.md)  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md)

CLI first. Schema is deterministic from OpenAPI. LLM may write prose only.

---

## 1. Stack

| Layer | Choice |
|---|---|
| CLI | Node 22, TS, `src/cli.ts` (`skillseed generate <openapi.yaml>`) |
| OpenAPI | `@apidevtools/swagger-parser` bundle + validate 3.0/3.1 |
| JSON Schema | map parameters + requestBody → tool input; no LLM |
| Zip | `yazl` or `archiver` |
| LLM | `ProsePort.draftSkillMarkdown(ctx)` — fake adapter in tests |
| Hosted MCP | later Fastify proxy; not in first three PRs |
| Tests | node:test + ClipAPI/RedditAPI fixture OpenAPI files |

---

## 2. Generate pipeline (code)

```
load OpenAPI
  → validate
  → select operations by operationId allow-list (default: all, max 8)
  → each op → Tool { name, description, inputSchema }
  → write mcp/index.js (generic dispatcher stub) + mcp/server.json
  → ProsePort → SKILL.md (must pass review: no tool name not in allow-list)
  → llms.txt / llms-full.txt (deterministic tables)
  → directories/*.md checklists
  → zip dist/
```

If `ProsePort` throws: still emit zip with stub SKILL from template (SPEC).

Reject: missing `operationId` on selected ops; `allowTools.length > 8`.

---

## 3. MCP stub output

Generated `mcp/index.js` is a **thin fetch wrapper**:

- Tool name → method + path from OpenAPI
- Path params from args
- `Authorization` from env `API_BEARER`

Tests invoke the generated file with a local mock HTTP server.

---

## 4. Dogfood

`fixtures/clipapi.openapi.yaml` and `fixtures/redditapi.openapi.yaml` live **in this repo** (hand-maintained excerpts, not git submodules). When ClipAPI OpenAPI changes, a PR updates the fixture.

A sister API may not say “built for agents” unless its checked-in `SKILL.md` was produced by this CLI (or a documented manual exception in that PR).

---

## 5. Tests

| Test | Assert |
|---|---|
| clip fixture | ≤8 tools; schemas include required query params |
| reddit fixture | second vendor not a one-off |
| 9th tool | exit 2 |
| LLM down | zip exists, stub skill, tools intact |
| skill review | mentioning unknown tool fails generate |
| generated client | get_transcript hits mock and returns JSON |

---

## 6. PR plan

### PR 1: CLI skeleton + OpenAPI load
- **Files:** package.json, src/cli.ts, src/load.ts, fixtures/clipapi.openapi.yaml (minimal), tests/load.test.ts, scripts/test.sh
- **Dependencies:** None
- **Acceptance:** `skillseed generate --help`; invalid yaml exits non-zero

### PR 2: Deterministic tools + zip + stub skill
- **Files:** src/tools.ts, src/emit.ts, src/templates/skill.stub.md, tests/generate.test.ts
- **Dependencies:** PR 1
- **Acceptance:** SPEC 1, 5, 6

### PR 3: Reddit fixture + generated client smoke
- **Files:** fixtures/redditapi.openapi.yaml, tests/reddit.test.ts, mock server
- **Dependencies:** PR 2
- **Acceptance:** SPEC 4

### PR 4: ProsePort + skill review + directory drafts
- **Files:** src/prose.ts, src/review.ts, templates/directories/*
- **Dependencies:** PR 2
- **Acceptance:** SPEC 7; LLM fail still zips

### PR 5: Web checkout $29 (optional)
- **Dependencies:** PR 4
- Fastify + Stripe; generate job status. Not required for internal dogfood.

### PR 6: Hosted MCP $9
- **Dependencies:** PR 4
- Stateless proxy, logs without bodies.

Internal launch = PR 3. External = PR 5.

---

## 7. What we will not generate

- Customer business logic
- A full agent runtime
- Auto-submit to Cursor/Claude directories

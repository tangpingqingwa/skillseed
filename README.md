# SkillSeed

Build contract: [SPEC.md](./SPEC.md).
How we work: [CONTRIBUTING.md](./CONTRIBUTING.md). `main` stays buildable and testable.
How we build: [BUILD.md](./BUILD.md) — stack, modules, tests, PR sequence.

Turn an OpenAPI spec into an installable MCP server, a `SKILL.md`, and directory submission drafts.

Not an agent platform. This is Shimecki’s actual growth lever, productized: TranscriptAPI worked because when OpenClaw shipped, they were first to drop a YouTube MCP and skill into every directory that would have them.

English-speaking agent runtimes are the market. The directories are Cursor, Claude, OpenClaw, ChatGPT, not domestic app stores.

## Why this, and why overseas

In 2026 the second distribution surface for an API is agent directories, not Product Hunt. Most US/EU data APIs still ship REST docs and nothing else:

- no hosted MCP
- no skill that says when *not* to call the tool
- no `llms.txt`
- no per-directory submission copy

Everyone says build for agents. Almost nobody sells “get listed.” Our own ClipAPI, RedditAPI, ThreadAPI, AsinAPI, LocalAPI, HireAPI, SaaSReviews, and StoreAPI are customer zero.

## Exact demand

- Who: indie API authors who already have REST and want Claude / Cursor / OpenClaw to see them
- Pain today: hand-written MCP, copied skills, one form per directory
- Acceptance: OpenAPI URL + auth scheme in; within 60 minutes out: MCP entry, skill pack, `llms.txt`, submission drafts for each target directory. A human can edit. Not a black box

## Exact connector

The connector is between “a human API” and “an agent runtime,” not a consumer website.

In:

- OpenAPI 3.x
- Auth (bearer / credit header)
- Allow-list of tools (default: few)

Out:

- Hosted or self-hosted MCP
- `SKILL.md` (when to use, when not to, auth, how to talk about failures)
- `llms.txt` / `llms-full.txt`
- Directory metadata (name, one-liner, sample dialogue)

Hosted MCP can be a thin proxy that maps tool schemas onto the customer’s API. Self-host = we only deliver files.

## Exact combination

```
our 8 data APIs  --dogfood-->  SkillSeed
other people’s REST  ------->  SkillSeed  -->  agent directories
SEO: "add MCP to my API", "OpenClaw skill template"
```

Price like a deliverable first: $29–69 per generate. Optional hosted MCP $9–29 / mo. Do not launch as a platform.

## Cost control

- Generation on an existing model subscription; no GPU fleet
- Hosted MCP is stateless proxy + logs on the same VPS
- Directory submit is semi-auto (we write, human clicks). Do not promise “listed everywhere”
- Default ≤ 8 tools so we do not blow the customer’s context window

## Business model

- Year one: free internally; externally a generate fee + optional host
- No revenue share on customer API usage
- Success: all eight of our APIs emit MCP/skill from this repo and stay in sync; 30 paid generates or 20 hosted MCPs

## Will not do

- No CRHQ, no “employees”
- No general agent runtime, sandbox, or browser
- No app generator, no writing the customer’s business code
- No ToS evasion for directories

## First two weeks

1. Ingest ClipAPI’s OpenAPI → MCP + SKILL.md
2. Install by hand in Cursor and Claude; `get_transcript` works
3. Repeat on RedditAPI so it is not a one-off script
4. SEO long-form: how to add MCP to an API, CTA is this product

## Dogfood

A new API that did not go through SkillSeed may not say “built for agents.” Stale directory copy is a SkillSeed bug.

## Risk

Directory rules and MCP will move. The moat is “we keep the packaging current + we have eight live APIs as a regression suite,” not a locked runtime. If only we use it, demote it to internal infra and stop selling. Do not force a platform.

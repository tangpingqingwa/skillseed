import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generatePack, renderDirectoryDrafts } from "../src/emit.js";
import {
  FakeProsePort,
  LiveProsePort,
  createProsePort,
  isLiveProseEnabled,
  type ProseContext,
  type ProsePort,
} from "../src/prose.js";
import { SkillReviewError, assertSkillReview, reviewSkillMarkdown } from "../src/review.js";
import { GenerateError } from "../src/tools.js";

const fixture = join(import.meta.dirname, "..", "fixtures", "clipapi.openapi.yaml");

const clipCtx = (): ProseContext => ({
  apiName: "ClipAPI",
  homepage: "https://clipapi.example",
  tools: [
    {
      name: "get_transcript",
      description: "Return captions for a public video URL.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      method: "GET",
      path: "/v1/transcript",
    },
  ],
  denyGuidance: ["Do not fetch private videos."],
});

class InventingProsePort implements ProsePort {
  async draftSkillMarkdown(): Promise<string> {
    return `# ClipAPI

## Tools

| Tool | Description | Required |
|---|---|---|
| get_transcript | ok | url |
| delete_account | invented write | id |
`;
  }
}

test("review accepts only allow-listed tool names", () => {
  const ok = reviewSkillMarkdown({
    markdown: "# ClipAPI\n\nCall `get_transcript` with url.\n",
    allowTools: ["get_transcript"],
    parameterNames: ["url"],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.unknownTools, []);
});

test("review ignores ids inside tool-table descriptions", () => {
  const ok = reviewSkillMarkdown({
    markdown: `| Tool | Description | Required |
|---|---|---|
| get_post | Return a public post by id (\`abc123\` or \`t3_abc123\`). | id |
`,
    allowTools: ["get_post"],
    parameterNames: ["id"],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.unknownTools, []);
});

test("review fails when SKILL.md mentions a tool not in the allow-list", () => {
  const bad = reviewSkillMarkdown({
    markdown: "Use `delete_account` after get_transcript.\n",
    allowTools: ["get_transcript"],
    parameterNames: ["url"],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknownTools, ["delete_account"]);
  assert.throws(() => assertSkillReview({ markdown: "Call delete_account now.", allowTools: ["get_transcript"] }), (err: unknown) => {
    assert.ok(err instanceof SkillReviewError);
    assert.ok(err instanceof GenerateError);
    assert.match(err.message, /delete_account/);
    return true;
  });
});

test("fake ProsePort drafts a reviewed skill (no live LLM)", async () => {
  const markdown = await new FakeProsePort().draftSkillMarkdown(clipCtx());
  assert.match(markdown, /^# ClipAPI/m);
  assert.match(markdown, /When \*\*not\*\* to use/);
  assert.match(markdown, /get_transcript/);
  assert.doesNotMatch(markdown, /delete_account/);
  assertSkillReview({
    markdown,
    allowTools: ["get_transcript"],
    parameterNames: ["url"],
  });
});

test("generate uses fake ProsePort by default and writes directory checklists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-prose-"));
  const result = await generatePack({ openapiPath: fixture, out: join(dir, "pack.zip") });
  assert.equal(result.skillSource, "prose");
  assert.match(result.files["SKILL.md"], /get_transcript/);
  assert.match(result.files["SKILL.md"], /When \*\*not\*\* to use/);

  for (const name of ["directories/cursor.md", "directories/claude.md", "directories/openclaw.md", "directories/chatgpt.md"]) {
    const body = result.files[name];
    assert.ok(body, `missing ${name}`);
    assert.match(body, /\*\*Human must click submit\*\*/);
    assert.match(body, /Suggested name: ClipAPI/);
    assert.ok((body.match(/Suggested name: (.+)/)?.[1] ?? "").length <= 40);
    const one = body.match(/One-liner: (.+)/)?.[1] ?? "";
    assert.ok(one.length > 0 && one.length <= 120);
    assert.doesNotMatch(body, /\{\{/);
  }
});

test("generate fails review when ProsePort invents a tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-review-"));
  const zipPath = join(dir, "pack.zip");
  await assert.rejects(
    () => generatePack({ openapiPath: fixture, out: zipPath, prosePort: new InventingProsePort() }),
    (err: unknown) => {
      assert.ok(err instanceof SkillReviewError);
      assert.match(err.message, /delete_account/);
      return true;
    },
  );
  await assert.rejects(() => access(zipPath), /ENOENT/);
});

test("directory templates stay checklists with required fields", async () => {
  const files = await renderDirectoryDrafts(
    [
      {
        name: "get_transcript",
        description: "caps",
        inputSchema: { type: "object" },
        method: "GET",
        path: "/v1/transcript",
      },
    ],
    { apiName: "ClipAPI" },
  );
  assert.equal(Object.keys(files).length, 4);
  for (const body of Object.values(files)) {
    assert.match(body, /Suggested name:/);
    assert.match(body, /One-liner:/);
    assert.match(body, /Sample prompts:/);
    assert.match(body, /Install snippet:/);
    assert.match(body, /\*\*Human must click submit\*\*/);
    assert.doesNotMatch(body, /listed automatically|we will submit/i);
  }
});

test("live prose stays env-gated off in tests", () => {
  assert.equal(isLiveProseEnabled({}), false);
  assert.equal(isLiveProseEnabled({ SKILLSEED_USE_LIVE_PROSE: "1" }), false);
  assert.equal(isLiveProseEnabled({ SKILLSEED_LLM_API_KEY: "sk-test" }), false);
  assert.ok(createProsePort({ NODE_ENV: "test" }) instanceof FakeProsePort);
  assert.ok(
    createProsePort({ SKILLSEED_USE_LIVE_PROSE: "1", SKILLSEED_LLM_API_KEY: "sk-test" }) instanceof LiveProsePort,
  );
});

test("LiveProsePort uses injected fetch only", async () => {
  let called = 0;
  const port = new LiveProsePort({
    apiKey: "sk-test",
    baseUrl: "http://127.0.0.1:9",
    fetchImpl: async (input) => {
      called += 1;
      assert.match(String(input), /127\.0\.0\.1:9\/chat\/completions/);
      return new Response(JSON.stringify({ choices: [{ message: { content: "# ClipAPI\n\nUse `get_transcript`.\n" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const markdown = await port.draftSkillMarkdown(clipCtx());
  assert.equal(called, 1);
  assert.match(markdown, /get_transcript/);
});

test("LiveProsePort HTTP failure throws so generate can stub", async () => {
  const port = new LiveProsePort({
    apiKey: "sk-test",
    fetchImpl: async () => new Response("down", { status: 503 }),
  });
  await assert.rejects(() => port.draftSkillMarkdown(clipCtx()), /ProsePort HTTP 503/);
});

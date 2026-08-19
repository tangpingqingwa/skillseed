import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { generatePack } from "../src/emit.js";
import { loadOpenApi } from "../src/load.js";
import { selectTools } from "../src/tools.js";
import { startMockServer } from "./mock-server.js";

const repoRoot = join(import.meta.dirname, "..");
const fixture = join(repoRoot, "fixtures", "redditapi.openapi.yaml");
const clipFixture = join(repoRoot, "fixtures", "clipapi.openapi.yaml");

const REDDIT_TOOLS = ["get_latest", "get_post", "list_subreddit", "search_reddit", "unroll_thread"] as const;

async function writeGeneratedClient(js: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-client-"));
  const path = join(dir, "index.js");
  await writeFile(path, js);
  return path;
}

async function withApiEnv<T>(env: { baseUrl: string; bearer?: string }, fn: () => Promise<T>): Promise<T> {
  const prevBase = process.env.API_BASE_URL;
  const prevBearer = process.env.API_BEARER;
  process.env.API_BASE_URL = env.baseUrl;
  if (env.bearer !== undefined) process.env.API_BEARER = env.bearer;
  try {
    return await fn();
  } finally {
    if (prevBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = prevBase;
    if (prevBearer === undefined) delete process.env.API_BEARER;
    else process.env.API_BEARER = prevBearer;
  }
}

test("reddit fixture is a second vendor, not a clip clone", async () => {
  const loaded = await loadOpenApi(fixture);
  assert.ok("openapi" in loaded.api);
  assert.match(String(loaded.api.openapi), /^3\./);
  assert.equal(loaded.api.info.title, "RedditAPI");
  assert.notEqual(loaded.api.info.title, "ClipAPI");

  const tools = selectTools(loaded.api);
  assert.ok(tools.length <= 8);
  assert.equal(tools.length, 5);
  assert.deepEqual(
    tools.map((t) => t.name),
    [...REDDIT_TOOLS],
  );
  assert.ok(!tools.some((t) => t.name === "get_transcript"));

  const unroll = tools.find((t) => t.name === "unroll_thread");
  assert.ok(unroll);
  assert.equal(unroll.method, "GET");
  assert.equal(unroll.path, "/v1/threads/by-url");
  assert.deepEqual(unroll.inputSchema.required, ["url"]);
  const properties = unroll.inputSchema.properties as Record<string, { type?: string; format?: string }>;
  assert.equal(properties.url.type, "string");
  assert.equal(properties.url.format, "uri");
  assert.equal(properties.max_comments.type, "integer");
  assert.equal(unroll.inputSchema.additionalProperties, false);

  const getPost = tools.find((t) => t.name === "get_post");
  assert.ok(getPost);
  assert.equal(getPost.path, "/v1/posts/{id}");
  assert.deepEqual(getPost.inputSchema.required, ["id"]);
});

test("reddit generate writes zip with the five RedditAPI tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-reddit-zip-"));
  const zipPath = join(dir, "reddit.zip");
  const result = await generatePack({ openapiPath: fixture, out: zipPath });
  assert.equal(result.apiName, "RedditAPI");
  assert.deepEqual(
    result.tools.map((t) => t.name),
    [...REDDIT_TOOLS],
  );

  const skill = result.files["SKILL.md"];
  const server = JSON.parse(result.files["mcp/server.json"]);
  assert.match(skill, /^# RedditAPI/m);
  assert.match(skill, /unroll_thread/);
  assert.doesNotMatch(skill, /get_transcript/);
  assert.equal(server.tools.length, 5);
  assert.deepEqual(
    server.tools.map((t: { name: string }) => t.name),
    [...REDDIT_TOOLS],
  );

  const clip = selectTools((await loadOpenApi(clipFixture)).api);
  assert.equal(clip.length, 1);
  assert.equal(clip[0].name, "get_transcript");
});

test("generated client unroll_thread hits local mock and returns JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-reddit-gen-"));
  const result = await generatePack({ openapiPath: fixture, out: join(dir, "pack.zip") });
  const clientPath = await writeGeneratedClient(result.files["mcp/index.js"]);

  const expected = {
    data: {
      post: {
        id: "t3_fixture",
        subreddit: "example",
        title: "Fixture thread",
        permalink: "/r/example/comments/fixture/title/",
      },
      comments: [
        { id: "t1_c1", author: "alice", body: "hello", status: "visible", replies: [] },
      ],
      commentCount: 1,
    },
    meta: { creditsCharged: 1, truncated: false },
  };

  const mock = await startMockServer((req) => {
    assert.equal(req.method, "GET");
    assert.equal(req.pathname, "/v1/threads/by-url");
    assert.equal(req.authorization, "Bearer rk_test_fixture");
    assert.equal(req.url.searchParams.get("url"), "https://reddit.example/r/example/comments/fixture/title/");
    assert.equal(req.url.searchParams.get("max_comments"), "50");
    return { json: expected };
  });

  try {
    const json = await withApiEnv({ baseUrl: mock.baseUrl, bearer: "rk_test_fixture" }, async () => {
      const mod = await import(pathToFileURL(clientPath).href);
      return mod.callTool("unroll_thread", {
        url: "https://reddit.example/r/example/comments/fixture/title/",
        max_comments: 50,
      });
    });
    assert.deepEqual(json, expected);
  } finally {
    await mock.close();
  }
});

test("generated clip client get_transcript hits local mock and returns JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-clip-client-"));
  const result = await generatePack({ openapiPath: clipFixture, out: join(dir, "pack.zip") });
  const clientPath = await writeGeneratedClient(result.files["mcp/index.js"]);
  const expected = { text: "hello from mock" };

  const mock = await startMockServer((req) => {
    assert.equal(req.method, "GET");
    assert.equal(req.pathname, "/v1/transcript");
    assert.equal(req.authorization, "Bearer ck_test_fixture");
    assert.equal(req.url.searchParams.get("url"), "https://video.example/watch?v=1");
    assert.equal(req.url.searchParams.get("lang"), "en");
    return { json: expected };
  });

  try {
    const json = await withApiEnv({ baseUrl: mock.baseUrl, bearer: "ck_test_fixture" }, async () => {
      const { callTool } = await import(pathToFileURL(clientPath).href);
      return callTool("get_transcript", {
        url: "https://video.example/watch?v=1",
        lang: "en",
      });
    });
    assert.deepEqual(json, expected);
  } finally {
    await mock.close();
  }
});

test("generated client substitutes path params for get_post", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-post-client-"));
  const result = await generatePack({ openapiPath: fixture, out: join(dir, "pack.zip") });
  const clientPath = await writeGeneratedClient(result.files["mcp/index.js"]);
  const expected = { data: { id: "t3_abc123", title: "Just the post" } };

  const mock = await startMockServer((req) => {
    assert.equal(req.pathname, "/v1/posts/t3_abc123");
    assert.equal(req.url.searchParams.get("id"), null);
    return { json: expected };
  });

  try {
    const json = await withApiEnv({ baseUrl: mock.baseUrl }, async () => {
      const { callTool } = await import(pathToFileURL(clientPath).href);
      return callTool("get_post", { id: "t3_abc123" });
    });
    assert.deepEqual(json, expected);
  } finally {
    await mock.close();
  }
});

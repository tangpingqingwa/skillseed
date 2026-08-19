import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import { promisify } from "node:util";
import { generatePack, renderStubSkill } from "../src/emit.js";
import { loadOpenApi, type OpenApiDocument } from "../src/load.js";
import { GenerateError, selectTools } from "../src/tools.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "..");
const fixture = join(repoRoot, "fixtures", "clipapi.openapi.yaml");
const cli = join(repoRoot, "src", "cli.ts");

type ZipEntry = { name: string; data: Buffer };

function readZip(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const fileNameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buf.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const dataStart = nameStart + fileNameLength + extraLength;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : inflateRawSync(compressed);
    entries.push({ name, data });
    offset = dataStart + compressedSize;
  }
  assert.ok(entries.length > 0, "zip contained no local file entries");
  return entries;
}

function zipMap(buf: Buffer): Map<string, string> {
  return new Map(readZip(buf).map((e) => [e.name, e.data.toString("utf8")]));
}

async function writeSpec(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-gen-"));
  const path = join(dir, "openapi.yaml");
  await writeFile(path, body);
  return path;
}

const nineOpSpec = `openapi: 3.1.0
info:
  title: TooMany
  version: 0.1.0
paths:
  /a:
    get:
      operationId: tool_a
      responses:
        "200":
          description: ok
  /b:
    get:
      operationId: tool_b
      responses:
        "200":
          description: ok
  /c:
    get:
      operationId: tool_c
      responses:
        "200":
          description: ok
  /d:
    get:
      operationId: tool_d
      responses:
        "200":
          description: ok
  /e:
    get:
      operationId: tool_e
      responses:
        "200":
          description: ok
  /f:
    get:
      operationId: tool_f
      responses:
        "200":
          description: ok
  /g:
    get:
      operationId: tool_g
      responses:
        "200":
          description: ok
  /h:
    get:
      operationId: tool_h
      responses:
        "200":
          description: ok
  /i:
    get:
      operationId: tool_i
      responses:
        "200":
          description: ok
`;

test("clip fixture maps to <=8 tools with required query params", async () => {
  const loaded = await loadOpenApi(fixture);
  const tools = selectTools(loaded.api);
  assert.ok(tools.length <= 8);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "get_transcript");
  assert.equal(tools[0].method, "GET");
  assert.equal(tools[0].path, "/v1/transcript");
  assert.deepEqual(tools[0].inputSchema.required, ["url"]);
  const properties = tools[0].inputSchema.properties as Record<string, { type?: string; format?: string }>;
  assert.equal(properties.url.type, "string");
  assert.equal(properties.url.format, "uri");
  assert.equal(properties.lang.type, "string");
  assert.equal(tools[0].inputSchema.additionalProperties, false);
});

test("clip generate writes zip with stub SKILL and MCP schemas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-zip-"));
  const zipPath = join(dir, "clip.zip");
  const result = await generatePack({ openapiPath: fixture, out: zipPath });
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "get_transcript");

  const files = zipMap(await readFile(zipPath));
  for (const name of [
    "openapi.normalized.yaml",
    "mcp/server.json",
    "mcp/index.js",
    "SKILL.md",
    "llms.txt",
    "llms-full.txt",
    "directories/cursor.md",
    "directories/claude.md",
    "directories/openclaw.md",
    "directories/chatgpt.md",
  ]) {
    assert.ok(files.has(name), `missing ${name}`);
  }

  const skill = files.get("SKILL.md")!;
  assert.match(skill, /^# ClipAPI/m);
  assert.match(skill, /When \*\*not\*\* to use|When not to use/);
  assert.match(skill, /get_transcript/);
  assert.match(skill, /API_BEARER/);
  assert.doesNotMatch(skill, /\{\{API_NAME\}\}/);
  assert.doesNotMatch(skill, /\{\{TOOLS_TABLE\}\}/);

  const server = JSON.parse(files.get("mcp/server.json")!);
  assert.equal(server.tools.length, 1);
  assert.equal(server.tools[0].name, "get_transcript");
  assert.deepEqual(server.tools[0].inputSchema.required, ["url"]);
  assert.equal(server.tools[0].inputSchema.properties.url.type, "string");

  assert.match(files.get("mcp/index.js")!, /get_transcript/);
  assert.match(files.get("llms.txt")!, /get_transcript/);
  assert.match(files.get("llms-full.txt")!, /GET/);
});

test("LLM-down path still ships stub skill and intact tools", async () => {
  const tools = selectTools((await loadOpenApi(fixture)).api);
  const skill = await renderStubSkill(tools, { apiName: "ClipAPI" });
  assert.match(skill, /# ClipAPI/);
  assert.match(skill, /get_transcript/);
  assert.equal(tools[0].inputSchema.properties && (tools[0].inputSchema.properties as { url: unknown }).url !== undefined, true);
});

test("9th tool is rejected with exit 2", async () => {
  const path = await writeSpec(nineOpSpec);
  const loaded = await loadOpenApi(path);
  assert.throws(() => selectTools(loaded.api), (err: unknown) => {
    assert.ok(err instanceof GenerateError);
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /max is 8/);
    return true;
  });

  const allow = ["tool_a", "tool_b", "tool_c", "tool_d", "tool_e", "tool_f", "tool_g", "tool_h", "tool_i"];
  assert.throws(() => selectTools(loaded.api, { allowTools: allow }), (err: unknown) => {
    assert.ok(err instanceof GenerateError);
    assert.equal(err.exitCode, 2);
    return true;
  });

  const dir = await mkdtemp(join(tmpdir(), "skillseed-nine-"));
  await assert.rejects(() => generatePack({ openapiPath: path, out: join(dir, "x.zip") }), (err: unknown) => {
    assert.ok(err instanceof GenerateError);
    assert.equal(err.exitCode, 2);
    return true;
  });
});

test("allow-list of 8 from a 9-op spec is accepted", async () => {
  const path = await writeSpec(nineOpSpec);
  const tools = selectTools((await loadOpenApi(path)).api, {
    allowTools: ["tool_a", "tool_b", "tool_c", "tool_d", "tool_e", "tool_f", "tool_g", "tool_h"],
  });
  assert.equal(tools.length, 8);
});

test("missing operationId on a selected op is rejected", async () => {
  const path = await writeSpec(`openapi: 3.1.0
info:
  title: NoId
  version: 0.1.0
paths:
  /x:
    get:
      summary: no id
      responses:
        "200":
          description: ok
`);
  await assert.rejects(async () => selectTools((await loadOpenApi(path)).api), /missing operationId/);
});

test("request body properties become tool inputs", async () => {
  const path = await writeSpec(`openapi: 3.1.0
info:
  title: Writer
  version: 0.1.0
paths:
  /v1/notes:
    post:
      operationId: create_note
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties:
                title:
                  type: string
                body:
                  type: string
      responses:
        "200":
          description: ok
`);
  const tools = selectTools((await loadOpenApi(path)).api);
  assert.equal(tools[0].name, "create_note");
  assert.deepEqual(tools[0].inputSchema.required, ["title"]);
  const properties = tools[0].inputSchema.properties as Record<string, { type?: string }>;
  assert.equal(properties.title.type, "string");
  assert.equal(properties.body.type, "string");
});

test("unresolved $ref leftover on an operation is rejected", () => {
  const api = {
    openapi: "3.1.0",
    info: { title: "Refs", version: "0.1.0" },
    paths: {
      "/x": {
        get: {
          operationId: "get_x",
          parameters: [{ name: "q", in: "query", schema: { $ref: "#/components/schemas/Q" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  } as unknown as OpenApiDocument;
  assert.throws(() => selectTools(api), (err: unknown) => {
    assert.ok(err instanceof GenerateError);
    assert.match(err.message, /unresolved \$ref/);
    return true;
  });
});

test("two generates produce identical zip bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-det-"));
  const a = join(dir, "a.zip");
  const b = join(dir, "b.zip");
  await generatePack({ openapiPath: fixture, out: a });
  await generatePack({ openapiPath: fixture, out: b });
  assert.deepEqual(await readFile(a), await readFile(b));
});

test("CLI generate writes zip and rejects a 9th tool with exit 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-cli-"));
  const zipPath = join(dir, "out.zip");
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", cli, "generate", fixture, "--out", zipPath], {
    cwd: repoRoot,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.match(stdout, /ok: wrote 1 tools/);
  const files = zipMap(await readFile(zipPath));
  assert.ok(files.has("SKILL.md"));
  assert.match(files.get("mcp/server.json")!, /get_transcript/);

  const nine = await writeSpec(nineOpSpec);
  const failed = await execFileAsync(process.execPath, ["--import", "tsx", cli, "generate", nine, "--out", join(dir, "nine.zip")], {
    cwd: repoRoot,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  }).then(
    () => ({ status: 0, stderr: "" }),
    (err: { code?: number; stderr?: string }) => ({ status: err.code ?? 1, stderr: String(err.stderr ?? "") }),
  );
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /error:.*max is 8/);
});

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import {
  FakeStripePort,
  GENERATE_CURRENCY,
  GENERATE_PRICE_CENTS,
  createStripePort,
  isLiveStripeEnabled,
} from "../src/billing.js";
import { generatePack } from "../src/emit.js";
import { MemoryJobStore, validateCreateJobInput } from "../src/jobs.js";
import { buildApp } from "../src/web.js";
import { startMockServer } from "./mock-server.js";

const fixture = join(import.meta.dirname, "..", "fixtures", "clipapi.openapi.yaml");

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

async function clipInline(): Promise<object> {
  const { loadOpenApi } = await import("../src/load.js");
  const loaded = await loadOpenApi(fixture);
  return structuredClone(loaded.api) as object;
}

test("default Stripe port is fake and live flag stays off in CI", () => {
  assert.equal(isLiveStripeEnabled({}), false);
  assert.equal(isLiveStripeEnabled({ SKILLSEED_USE_LIVE_STRIPE: "1" }), false);
  assert.equal(isLiveStripeEnabled({ STRIPE_SECRET_KEY: "sk_test_x" }), false);
  assert.ok(createStripePort({}) instanceof FakeStripePort);
});

test("POST /jobs creates a $29 fake checkout and does not generate yet", async () => {
  const stripe = new FakeStripePort();
  const { app, store } = await buildApp({ stripe });
  const inline = await clipInline();
  const res = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { apiName: "ClipAPI", openapiInline: inline, allowTools: ["get_transcript"] },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.status, "awaiting_payment");
  assert.equal(body.paid, false);
  assert.equal(body.amountCents, GENERATE_PRICE_CENTS);
  assert.equal(body.currency, GENERATE_CURRENCY);
  assert.match(body.checkoutUrl, /^\/checkout\/fake\/cs_test_/);
  assert.equal(body.artifacts, undefined);

  const job = store.get(body.id);
  assert.ok(job);
  assert.equal(job.status, "awaiting_payment");
  assert.equal(job.paid, false);
  assert.equal(job.zipPath, undefined);

  const unpaidZip = await app.inject({ method: "GET", url: `/jobs/${body.id}/files.zip` });
  assert.equal(unpaidZip.statusCode, 409);

  await app.close();
});

test("fake checkout pay runs generate and serves the zip", async () => {
  const stripe = new FakeStripePort();
  const { app } = await buildApp({ stripe });
  const inline = await clipInline();
  const created = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { apiName: "ClipAPI", homepage: "https://clipapi.example", openapiInline: inline },
  });
  assert.equal(created.statusCode, 201);
  const job = created.json();

  const payPage = await app.inject({ method: "GET", url: job.checkoutUrl });
  assert.equal(payPage.statusCode, 200);
  assert.match(payPage.body, /Fake Stripe Checkout/);
  assert.match(payPage.body, /\$29/);

  const paid = await app.inject({
    method: "POST",
    url: job.checkoutUrl,
    headers: { accept: "application/json" },
  });
  assert.equal(paid.statusCode, 200);
  const ready = paid.json();
  assert.equal(ready.status, "ready");
  assert.equal(ready.paid, true);
  assert.equal(ready.toolCount, 1);
  assert.equal(ready.artifacts.zip, `/jobs/${job.id}/files.zip`);
  assert.ok(ready.artifacts.files.includes("SKILL.md"));
  assert.ok(ready.artifacts.files.includes("mcp/server.json"));

  const status = await app.inject({ method: "GET", url: `/jobs/${job.id}` });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, "ready");

  const zipRes = await app.inject({ method: "GET", url: `/jobs/${job.id}/files.zip` });
  assert.equal(zipRes.statusCode, 200);
  assert.match(String(zipRes.headers["content-type"]), /zip/);
  const files = zipMap(Buffer.from(zipRes.rawPayload));
  assert.ok(files.has("SKILL.md"));
  assert.match(files.get("SKILL.md")!, /get_transcript/);
  const server = JSON.parse(files.get("mcp/server.json")!);
  assert.equal(server.tools[0].name, "get_transcript");

  await app.close();
});

test("GET / is marketing HTML with $29 and OpenAPI paste", async () => {
  const { app } = await buildApp({ stripe: new FakeStripePort() });
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /SkillSeed/);
  assert.match(res.body, /\$29/);
  assert.match(res.body, /openapiUrl/);
  assert.match(res.body, /openapiInline/);
  assert.doesNotMatch(res.body, /sk_(?:live|test)_[A-Za-z0-9]{8,}/);
  await app.close();
});

test("unknown job is 404 and unpaid generate is rejected", async () => {
  const { app } = await buildApp({ stripe: new FakeStripePort() });
  const missing = await app.inject({ method: "GET", url: "/jobs/does-not-exist" });
  assert.equal(missing.statusCode, 404);

  const bad = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { apiName: "X" },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /openapiUrl or openapiInline/);

  const nine = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: {
      apiName: "TooMany",
      openapiInline: { openapi: "3.1.0" },
      allowTools: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    },
  });
  assert.equal(nine.statusCode, 400);
  assert.match(nine.json().error, /max is 8/);

  const hosted = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { apiName: "X", openapiInline: { openapi: "3.1.0" }, hostMcp: true },
  });
  assert.equal(hosted.statusCode, 400);
  assert.match(hosted.json().error, /hosted MCP/);
  await app.close();
});

test("paid job with invalid OpenAPI fails the job, not checkout", async () => {
  const stripe = new FakeStripePort();
  const { app } = await buildApp({ stripe });
  const created = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: {
      apiName: "Broken",
      openapiInline: { notOpenApi: true },
    },
  });
  const job = created.json();
  const paid = await app.inject({
    method: "POST",
    url: job.checkoutUrl,
    headers: { accept: "application/json" },
  });
  assert.equal(paid.statusCode, 200);
  assert.equal(paid.json().status, "failed");
  assert.match(String(paid.json().error), /invalid OpenAPI|no paths|paths/i);
  await app.close();
});

test("validateCreateJobInput matches SPEC generate input", () => {
  const ok = validateCreateJobInput({
    apiName: "ClipAPI",
    openapiUrl: "./fixtures/clipapi.openapi.yaml",
    allowTools: ["get_transcript"],
    auth: { type: "bearer" },
  });
  assert.equal(ok.apiName, "ClipAPI");
  assert.deepEqual(ok.allowTools, ["get_transcript"]);
  assert.throws(() => validateCreateJobInput({ apiName: "X" }), /openapiUrl or openapiInline/);
});

test("generatePack accepts inline OpenAPI", async () => {
  const inline = await clipInline();
  const dir = await mkdtemp(join(tmpdir(), "skillseed-inline-"));
  const result = await generatePack({
    openapiInline: inline,
    out: join(dir, "pack.zip"),
    apiName: "ClipAPI",
  });
  assert.equal(result.tools[0].name, "get_transcript");
  const files = zipMap(await readFile(result.zipPath));
  assert.ok(files.has("SKILL.md"));
});

test("openapiUrl fetches a local mock HTTP spec after fake payment", async () => {
  const yaml = await readFile(fixture, "utf8");
  const mock = await startMockServer((req) => {
    if (req.pathname === "/openapi.yaml") {
      return { text: yaml, headers: { "content-type": "text/yaml" } };
    }
    return { status: 404, text: "missing" };
  });
  const { app } = await buildApp({ stripe: new FakeStripePort() });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { apiName: "ClipAPI", openapiUrl: `${mock.baseUrl}/openapi.yaml` },
    });
    assert.equal(created.statusCode, 201);
    const paid = await app.inject({
      method: "POST",
      url: created.json().checkoutUrl,
      headers: { accept: "application/json" },
    });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.json().status, "ready");
    assert.equal(paid.json().toolCount, 1);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("GET /jobs/:id?session_id= completes a paid live-style session", async () => {
  const stripe = new FakeStripePort();
  const { app } = await buildApp({ stripe });
  const created = await app.inject({
    method: "POST",
    url: "/jobs",
    payload: { apiName: "ClipAPI", openapiInline: await clipInline() },
  });
  const job = created.json();
  const sessionId = String(job.checkoutUrl).split("/").pop();
  assert.ok(sessionId);
  await stripe.completeCheckoutSession(sessionId);
  const res = await app.inject({ method: "GET", url: `/jobs/${job.id}?session_id=${sessionId}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ready");
  assert.equal(res.json().paid, true);
  await app.close();
});

test("MemoryJobStore is isolated per app", async () => {
  const a = await buildApp({ stripe: new FakeStripePort(), store: new MemoryJobStore() });
  const b = await buildApp({ stripe: new FakeStripePort(), store: new MemoryJobStore() });
  const created = await a.app.inject({
    method: "POST",
    url: "/jobs",
    payload: { apiName: "ClipAPI", openapiInline: await clipInline() },
  });
  const id = created.json().id;
  const other = await b.app.inject({ method: "GET", url: `/jobs/${id}` });
  assert.equal(other.statusCode, 404);
  await a.app.close();
  await b.app.close();
});

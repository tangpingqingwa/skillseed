import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadOpenApi, OpenApiLoadError } from "../src/load.js";

const fixture = join(import.meta.dirname, "..", "fixtures", "clipapi.openapi.yaml");

test("loads the ClipAPI fixture", async () => {
  const loaded = await loadOpenApi(fixture);
  assert.equal(loaded.path, fixture);
  assert.ok("openapi" in loaded.api);
  assert.match(String(loaded.api.openapi), /^3\./);
  assert.equal(loaded.api.info.title, "ClipAPI");
  assert.ok(loaded.api.paths?.["/v1/transcript"]?.get?.operationId === "get_transcript");
});

test("rejects missing path", async () => {
  await assert.rejects(() => loadOpenApi(""), (err: unknown) => {
    assert.ok(err instanceof OpenApiLoadError);
    assert.match(err.message, /missing OpenAPI path/);
    return true;
  });
});

test("rejects unreadable file", async () => {
  await assert.rejects(() => loadOpenApi("/no/such/openapi.yaml"), (err: unknown) => {
    assert.ok(err instanceof OpenApiLoadError);
    assert.match(err.message, /cannot read OpenAPI file/);
    return true;
  });
});

test("rejects empty yaml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-"));
  const path = join(dir, "empty.yaml");
  await writeFile(path, "\n");
  await assert.rejects(() => loadOpenApi(path), (err: unknown) => {
    assert.ok(err instanceof OpenApiLoadError);
    assert.match(err.message, /empty/);
    return true;
  });
});

test("rejects invalid yaml", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-"));
  const path = join(dir, "broken.yaml");
  await writeFile(path, "openapi: [\n  this is not: valid: yaml\n");
  await assert.rejects(() => loadOpenApi(path), (err: unknown) => {
    assert.ok(err instanceof OpenApiLoadError);
    assert.match(err.message, /invalid OpenAPI/);
    return true;
  });
});

test("rejects yaml that is not OpenAPI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillseed-"));
  const path = join(dir, "not-openapi.yaml");
  await writeFile(path, "name: just a mapping\ncount: 1\n");
  await assert.rejects(() => loadOpenApi(path), (err: unknown) => {
    assert.ok(err instanceof OpenApiLoadError);
    assert.match(err.message, /invalid OpenAPI/);
    return true;
  });
});

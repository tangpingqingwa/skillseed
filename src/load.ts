import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";

export class OpenApiLoadError extends Error {
  readonly exitCode = 1;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenApiLoadError";
  }
}

export type OpenApiDocument = Awaited<ReturnType<typeof SwaggerParser.validate>>;

export type LoadedOpenApi = {
  path: string;
  api: OpenApiDocument;
};

function formatCause(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return String(cause);
}

export type LoadOpenApiInput = {
  path?: string;
  inline?: object;
};

function assertOpenApiVersion(api: OpenApiDocument): void {
  const version = "openapi" in api && typeof api.openapi === "string" ? api.openapi : "";
  if (!version.startsWith("3.")) {
    throw new OpenApiLoadError(`unsupported OpenAPI version: ${version || "missing"}`);
  }
}

export async function loadOpenApi(input: string | LoadOpenApiInput): Promise<LoadedOpenApi> {
  const spec = typeof input === "string" ? { path: input } : input;
  const path = spec.path?.trim();
  const inline = spec.inline;

  if (inline !== undefined && path) {
    throw new OpenApiLoadError("provide a file path or inline OpenAPI, not both");
  }

  if (inline !== undefined) {
    let api: OpenApiDocument;
    try {
      api = await SwaggerParser.validate(inline as never, {
        resolve: { external: false },
        validate: { schema: true, spec: true },
      });
    } catch (cause) {
      throw new OpenApiLoadError(`invalid OpenAPI: ${formatCause(cause)}`, { cause });
    }
    assertOpenApiVersion(api);
    return { path: "<inline>", api };
  }

  if (!path || path.startsWith("-")) {
    throw new OpenApiLoadError("missing OpenAPI path; usage: skillseed generate <openapi.yaml>");
  }

  if (/^https?:\/\//i.test(path)) {
    return loadFromUrl(path);
  }

  return loadFromFile(path);
}

async function loadFromFile(path: string): Promise<LoadedOpenApi> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    throw new OpenApiLoadError(`cannot read OpenAPI file: ${path}`, { cause });
  }

  if (raw.trim() === "") {
    throw new OpenApiLoadError(`OpenAPI file is empty: ${path}`);
  }

  let api: OpenApiDocument;
  try {
    api = await SwaggerParser.validate(path, {
      resolve: { external: false },
      validate: { schema: true, spec: true },
    });
  } catch (cause) {
    throw new OpenApiLoadError(`invalid OpenAPI: ${formatCause(cause)}`, { cause });
  }

  assertOpenApiVersion(api);
  return { path, api };
}

async function loadFromUrl(url: string): Promise<LoadedOpenApi> {
  if (typeof fetch !== "function") {
    throw new OpenApiLoadError("fetch is not available");
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new OpenApiLoadError(`cannot fetch OpenAPI URL: ${url}`, { cause });
  }
  if (!res.ok) {
    throw new OpenApiLoadError(`cannot fetch OpenAPI URL: ${url} (HTTP ${res.status})`);
  }
  const raw = await res.text();
  if (raw.trim() === "") {
    throw new OpenApiLoadError(`OpenAPI file is empty: ${url}`);
  }
  const dir = await mkdtemp(join(tmpdir(), "skillseed-url-"));
  const ext = raw.trimStart().startsWith("{") ? "json" : "yaml";
  const filePath = join(dir, `openapi.${ext}`);
  await writeFile(filePath, raw);
  return loadFromFile(filePath);
}

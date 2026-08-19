import { readFile } from "node:fs/promises";
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

export async function loadOpenApi(path: string): Promise<LoadedOpenApi> {
  if (!path || path.startsWith("-")) {
    throw new OpenApiLoadError("missing OpenAPI path; usage: skillseed generate <openapi.yaml>");
  }

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

  const version = "openapi" in api && typeof api.openapi === "string" ? api.openapi : "";
  if (!version.startsWith("3.")) {
    throw new OpenApiLoadError(`unsupported OpenAPI version: ${version || "missing"}`);
  }

  return { path, api };
}

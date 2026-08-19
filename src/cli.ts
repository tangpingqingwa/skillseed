#!/usr/bin/env -S node --import tsx
import { pathToFileURL } from "node:url";
import { loadOpenApi, OpenApiLoadError } from "./load.js";

const HELP = `Usage: skillseed generate <openapi.yaml>

Load and validate an OpenAPI 3.x document. Later PRs emit MCP, SKILL.md, and zip.

Commands:
  generate <openapi.yaml>   Validate the spec (does not write artifacts yet)

Options:
  -h, --help                Show this help
  -v, --version             Print skillseed version
`;

function printHelp(): void {
  process.stdout.write(HELP);
}

function printVersion(): void {
  process.stdout.write("skillseed 0.1.0\n");
}

function fail(message: string, exitCode = 1): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(exitCode);
}

export async function run(argv: string[]): Promise<void> {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  if (args.includes("-v") || args.includes("--version")) {
    printVersion();
    return;
  }

  const [command, ...rest] = args;
  if (command !== "generate") {
    fail(`unknown command: ${command}\n\n${HELP}`.trimEnd());
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    printHelp();
    return;
  }

  const path = rest.find((arg) => !arg.startsWith("-"));
  if (!path) {
    fail("missing OpenAPI path; usage: skillseed generate <openapi.yaml>");
  }

  const unknown = rest.filter((arg) => arg.startsWith("-"));
  if (unknown.length > 0) {
    fail(`unknown option: ${unknown[0]}`);
  }

  const extra = rest.filter((arg) => !arg.startsWith("-") && arg !== path);
  if (extra.length > 0) {
    fail(`unexpected argument: ${extra[0]}`);
  }

  const loaded = await loadOpenApi(path);
  const title =
    "info" in loaded.api && loaded.api.info && typeof loaded.api.info.title === "string"
      ? loaded.api.info.title
      : path;
  process.stdout.write(`ok: loaded ${title}\n`);
}

async function main(): Promise<void> {
  try {
    await run(process.argv);
  } catch (err) {
    if (err instanceof OpenApiLoadError) {
      fail(err.message, err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

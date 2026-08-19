#!/usr/bin/env -S node --import tsx
import { pathToFileURL } from "node:url";
import { generatePack } from "./emit.js";
import { OpenApiLoadError } from "./load.js";
import { GenerateError } from "./tools.js";

const HELP = `Usage: skillseed generate <openapi.yaml> [options]

Validate an OpenAPI 3.x document and emit a deterministic MCP + stub SKILL zip.
No LLM is invoked; SKILL.md is filled from the frozen stub template.

Commands:
  generate <openapi.yaml>   Map operations to tools and write a zip

Options:
  --out <path>              Zip path (default: dist/<api-name>.zip)
  --allow-tool <id>         operationId to include (repeatable, max 8)
  --name <apiName>          Override API display name
  --homepage <url>          Override homepage URL
  --deny <text>             Extra "when not to use" line (repeatable)
  -h, --help                Show this help
  -v, --version             Print skillseed version
`;

type GenerateArgs = {
  path: string;
  out?: string;
  allowTools?: string[];
  apiName?: string;
  homepage?: string;
  denyGuidance?: string[];
};

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

function takeValue(args: string[], i: number, flag: string): string {
  const value = args[i + 1];
  if (value === undefined || value.startsWith("-")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

export function parseGenerateArgs(args: string[]): GenerateArgs {
  let path: string | undefined;
  let out: string | undefined;
  let apiName: string | undefined;
  let homepage: string | undefined;
  const allowTools: string[] = [];
  const denyGuidance: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      out = takeValue(args, i, "--out");
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      if (!out) fail("--out requires a value");
      continue;
    }
    if (arg === "--allow-tool") {
      allowTools.push(takeValue(args, i, "--allow-tool"));
      i += 1;
      continue;
    }
    if (arg.startsWith("--allow-tool=")) {
      const id = arg.slice("--allow-tool=".length);
      if (!id) fail("--allow-tool requires a value");
      allowTools.push(id);
      continue;
    }
    if (arg === "--name") {
      apiName = takeValue(args, i, "--name");
      i += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      apiName = arg.slice("--name=".length);
      if (!apiName) fail("--name requires a value");
      continue;
    }
    if (arg === "--homepage") {
      homepage = takeValue(args, i, "--homepage");
      i += 1;
      continue;
    }
    if (arg.startsWith("--homepage=")) {
      homepage = arg.slice("--homepage=".length);
      if (!homepage) fail("--homepage requires a value");
      continue;
    }
    if (arg === "--deny") {
      denyGuidance.push(takeValue(args, i, "--deny"));
      i += 1;
      continue;
    }
    if (arg.startsWith("--deny=")) {
      const text = arg.slice("--deny=".length);
      if (!text) fail("--deny requires a value");
      denyGuidance.push(text);
      continue;
    }
    if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    }
    if (path) fail(`unexpected argument: ${arg}`);
    path = arg;
  }

  if (!path) {
    fail("missing OpenAPI path; usage: skillseed generate <openapi.yaml>");
  }

  return {
    path,
    out,
    allowTools: allowTools.length > 0 ? allowTools : undefined,
    apiName,
    homepage,
    denyGuidance: denyGuidance.length > 0 ? denyGuidance : undefined,
  };
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

  const parsed = parseGenerateArgs(rest);
  const result = await generatePack({
    openapiPath: parsed.path,
    out: parsed.out,
    allowTools: parsed.allowTools,
    apiName: parsed.apiName,
    homepage: parsed.homepage,
    denyGuidance: parsed.denyGuidance,
  });
  process.stdout.write(`ok: wrote ${result.tools.length} tools to ${result.zipPath}\n`);
}

async function main(): Promise<void> {
  try {
    await run(process.argv);
  } catch (err) {
    if (err instanceof OpenApiLoadError || err instanceof GenerateError) {
      fail(err.message, err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    fail(message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

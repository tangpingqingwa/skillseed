#!/usr/bin/env -S node --import tsx
import { pathToFileURL } from "node:url";
import { createStripePort, isLiveStripeEnabled, LiveStripePort } from "./billing.js";
import { generatePack } from "./emit.js";
import { OpenApiLoadError } from "./load.js";
import { GenerateError } from "./tools.js";
import { buildApp } from "./web.js";

const HELP = `Usage: skillseed <command> [options]

Validate an OpenAPI 3.x document and emit a deterministic MCP + SKILL zip.
SKILL.md is drafted by ProsePort (offline fake by default). If the LLM fails,
the zip still ships with a stub skill and intact tool schemas.
Live prose is opt-in via SKILLSEED_USE_LIVE_PROSE=1 and SKILLSEED_LLM_API_KEY.

Commands:
  generate <openapi.yaml>   Map operations to tools and write a zip
  serve                     Web checkout ($29) + generate job status

Generate options:
  --out <path>              Zip path (default: dist/<api-name>.zip)
  --allow-tool <id>         operationId to include (repeatable, max 8)
  --name <apiName>          Override API display name
  --homepage <url>          Override homepage URL
  --deny <text>             Extra "when not to use" line (repeatable)

Serve options:
  --host <host>             Bind address (default: 127.0.0.1)
  --port <n>                Listen port (default: 3000)

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

type ServeArgs = {
  host: string;
  port: number;
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

export function parseServeArgs(args: string[]): ServeArgs {
  let host = "127.0.0.1";
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--host") {
      host = takeValue(args, i, "--host");
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      if (!host) fail("--host requires a value");
      continue;
    }
    if (arg === "--port") {
      port = Number(takeValue(args, i, "--port"));
      i += 1;
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be an integer 0-65535");
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be an integer 0-65535");
      continue;
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    fail(`unexpected argument: ${arg}`);
  }

  return { host, port };
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
  if (command !== "generate" && command !== "serve") {
    fail(`unknown command: ${command}\n\n${HELP}`.trimEnd());
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    printHelp();
    return;
  }

  if (command === "serve") {
    const parsed = parseServeArgs(rest);
    const stripe = isLiveStripeEnabled()
      ? await LiveStripePort.connect(process.env.STRIPE_SECRET_KEY ?? "")
      : createStripePort();
    const { app } = await buildApp({ stripe, logger: false });
    const address = await app.listen({ host: parsed.host, port: parsed.port });
    process.stdout.write(`ok: listening on ${address}\n`);
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

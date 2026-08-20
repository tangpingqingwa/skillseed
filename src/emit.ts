import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipFile } from "yazl";
import { loadOpenApi, type OpenApiDocument } from "./load.js";
import { createProsePort, formatToolsTable, type ProsePort } from "./prose.js";
import { assertSkillReview, collectParameterNames } from "./review.js";
import {
  apiHomepage,
  apiTitle,
  selectTools,
  slugify,
  type McpTool,
} from "./tools.js";

export const STUB_TEMPLATE_PATH = fileURLToPath(new URL("./templates/skill.stub.md", import.meta.url));
export const DIRECTORY_TEMPLATE_DIR = fileURLToPath(new URL("../templates/directories/", import.meta.url));

const DIRECTORY_FILES = ["cursor.md", "claude.md", "openclaw.md", "chatgpt.md"] as const;

export type ArtifactFiles = Record<string, string>;

export type EmitOptions = {
  apiName?: string;
  homepage?: string;
  denyGuidance?: string[];
  sampleDialogue?: string;
  prosePort?: ProsePort;
};

export type GeneratePackInput = {
  openapiPath?: string;
  openapiInline?: object;
  out?: string;
  allowTools?: string[];
  apiName?: string;
  homepage?: string;
  denyGuidance?: string[];
  sampleDialogue?: string;
  prosePort?: ProsePort;
};

export type SkillSource = "prose" | "stub";

export type GeneratePackResult = {
  tools: McpTool[];
  zipPath: string;
  files: ArtifactFiles;
  apiName: string;
  skillSource: SkillSource;
};

function requiredList(schema: McpTool["inputSchema"]): string {
  return Array.isArray(schema.required) ? (schema.required as string[]).join(", ") : "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

export async function loadStubTemplate(): Promise<string> {
  return readFile(STUB_TEMPLATE_PATH, "utf8");
}

export async function renderStubSkill(tools: McpTool[], options: EmitOptions = {}): Promise<string> {
  const template = await loadStubTemplate();
  const apiName = options.apiName?.trim() || "API";
  let body = template;
  if (options.denyGuidance && options.denyGuidance.length > 0) {
    const extra = options.denyGuidance.map((line) => `- ${line}`).join("\n");
    body = body.replace("## When not to use\n\n", `## When not to use\n\n${extra}\n\n`);
  }
  return body.replaceAll("{{API_NAME}}", apiName).replaceAll("{{TOOLS_TABLE}}", formatToolsTable(tools));
}

export async function renderDirectoryDrafts(tools: McpTool[], options: EmitOptions = {}): Promise<ArtifactFiles> {
  const apiName = options.apiName?.trim() || "API";
  const suggested = clip(apiName, 40);
  const oneLiner = clip(`MCP + skill pack for ${apiName}.`, 120);
  const first = tools[0]?.name;
  const prompts = [
    first ? `- Use ${apiName} when the user needs ${first}` : `- Use ${apiName} for the documented happy path`,
    first ? `- Call only ${first} and report the JSON result` : `- Do not invent tools`,
  ].join("\n");
  const install = "Unzip the pack and point the MCP config at mcp/index.js. Set API_BEARER.";
  const files: ArtifactFiles = {};
  for (const file of DIRECTORY_FILES) {
    const template = await readFile(join(DIRECTORY_TEMPLATE_DIR, file), "utf8");
    files[`directories/${file}`] = template
      .replaceAll("{{SUGGESTED_NAME}}", suggested)
      .replaceAll("{{ONE_LINER}}", oneLiner)
      .replaceAll("{{SAMPLE_PROMPTS}}", prompts)
      .replaceAll("{{INSTALL_SNIPPET}}", install);
  }
  return files;
}

function dumpYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value);
  if (text === "" || /[:#\n&*!?>|{}\[\],%@`"']/.test(text) || /^\s/.test(text) || /\s$/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

function dumpYaml(value: unknown, indent = 0, seen = new WeakSet<object>()): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return indent === 0 ? "[]" : `${pad}[]`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const nested = dumpYaml(item, indent + 1, seen);
          const [first, ...rest] = nested.split("\n");
          return `${pad}- ${first.trimStart()}${rest.length ? `\n${rest.join("\n")}` : ""}`;
        }
        return `${pad}- ${dumpYamlScalar(item)}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return indent === 0 ? "null" : `${pad}null`;
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined);
    if (entries.length === 0) return indent === 0 ? "{}" : `${pad}{}`;
    return entries
      .map(([key, child]) => {
        const safeKey = /^[A-Za-z_][A-Za-z0-9._-]*$/.test(key) ? key : JSON.stringify(key);
        if (child !== null && typeof child === "object") {
          const nested = dumpYaml(child, indent + 1, seen);
          if (nested.trim() === "{}" || nested.trim() === "[]") return `${pad}${safeKey}: ${nested.trim()}`;
          return `${pad}${safeKey}:\n${nested}`;
        }
        return `${pad}${safeKey}: ${dumpYamlScalar(child)}`;
      })
      .join("\n");
  }
  return `${pad}${dumpYamlScalar(value)}`;
}

export function normalizeOpenApiYaml(api: OpenApiDocument): string {
  return `${dumpYaml(api)}\n`;
}

export function mcpServerJson(tools: McpTool[], options: EmitOptions = {}): string {
  const name = slugify(options.apiName?.trim() || "api");
  return `${JSON.stringify(
    {
      name,
      description: `${options.apiName?.trim() || "API"} MCP (SkillSeed stub)`,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    },
    null,
    2,
  )}\n`;
}

export function mcpIndexJs(tools: McpTool[]): string {
  const routes = Object.fromEntries(tools.map((tool) => [tool.name, { method: tool.method, path: tool.path }]));
  return `/* generated by skillseed — thin fetch dispatcher stub */
const ROUTES = ${JSON.stringify(routes, null, 2)};

export function resolveTool(name) {
  const route = ROUTES[name];
  if (!route) throw new Error("unknown tool: " + name);
  return route;
}

export async function callTool(name, args = {}, fetchImpl = globalThis.fetch) {
  const route = resolveTool(name);
  const path = route.path.replace(/\\{([^}]+)\\}/g, (_, key) => {
    if (args[key] === undefined || args[key] === null) {
      throw new Error("missing path param: " + key);
    }
    return encodeURIComponent(String(args[key]));
  });
  const url = new URL(path, process.env.API_BASE_URL || "http://127.0.0.1");
  const used = new Set([...route.path.matchAll(/\\{([^}]+)\\}/g)].map((m) => m[1]));
  if (route.method === "GET" || route.method === "HEAD") {
    for (const [key, value] of Object.entries(args)) {
      if (used.has(key) || value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  /** @type {Record<string, string>} */
  const headers = {};
  if (process.env.API_BEARER) headers.Authorization = "Bearer " + process.env.API_BEARER;
  const init = { method: route.method, headers };
  if (route.method !== "GET" && route.method !== "HEAD") {
    headers["content-type"] = "application/json";
    /** @type {Record<string, unknown>} */
    const body = {};
    for (const [key, value] of Object.entries(args)) {
      if (!used.has(key)) body[key] = value;
    }
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
`;
}

function llmsTxt(tools: McpTool[], options: EmitOptions = {}): string {
  const name = options.apiName?.trim() || "API";
  const lines = [`# ${name}`, "", "MCP tools:"];
  for (const tool of tools) lines.push(`- ${tool.name}: ${tool.description}`);
  if (options.homepage?.trim()) {
    lines.push("", `Homepage: ${options.homepage.trim()}`);
  }
  lines.push("");
  return lines.join("\n");
}

function llmsFullTxt(tools: McpTool[], options: EmitOptions = {}): string {
  const name = options.apiName?.trim() || "API";
  const lines = [`# ${name} — endpoints`, "", "| Tool | Method | Path | Required |", "|---|---|---|---|"];
  for (const tool of tools) {
    lines.push(`| ${tool.name} | ${tool.method} | ${tool.path} | ${requiredList(tool.inputSchema) || "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function buildArtifacts(
  api: OpenApiDocument,
  tools: McpTool[],
  options: EmitOptions = {},
): Promise<ArtifactFiles> {
  const apiName = options.apiName?.trim() || apiTitle(api);
  const homepage = options.homepage?.trim() || apiHomepage(api);
  const meta = { ...options, apiName, homepage };
  return {
    "openapi.normalized.yaml": normalizeOpenApiYaml(api),
    "mcp/server.json": mcpServerJson(tools, meta),
    "mcp/index.js": mcpIndexJs(tools),
    "SKILL.md": await renderStubSkill(tools, meta),
    "llms.txt": llmsTxt(tools, meta),
    "llms-full.txt": llmsFullTxt(tools, meta),
    ...(await renderDirectoryDrafts(tools, meta)),
  };
}

async function draftReviewedSkill(
  tools: McpTool[],
  options: EmitOptions,
): Promise<{ markdown: string; skillSource: SkillSource }> {
  const ctx = {
    apiName: options.apiName?.trim() || "API",
    homepage: options.homepage?.trim() || "",
    tools,
    denyGuidance: options.denyGuidance ?? [],
    sampleDialogue: options.sampleDialogue,
  };
  const port = options.prosePort ?? createProsePort();
  let markdown: string;
  let skillSource: SkillSource;
  try {
    markdown = await port.draftSkillMarkdown(ctx);
    skillSource = "prose";
  } catch {
    markdown = await renderStubSkill(tools, options);
    skillSource = "stub";
  }
  assertSkillReview({
    markdown,
    allowTools: tools.map((tool) => tool.name),
    parameterNames: collectParameterNames(tools),
  });
  return { markdown, skillSource };
}

export async function writeZip(files: ArtifactFiles, zipPath: string): Promise<void> {
  await mkdir(dirname(zipPath), { recursive: true });
  const zip = new ZipFile();
  for (const name of Object.keys(files).sort()) {
    zip.addBuffer(Buffer.from(files[name], "utf8"), name, {
      mtime: new Date(0),
      mode: 0o100644,
      forceDosTimestamp: true,
    });
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    zip.outputStream.pipe(out);
    zip.outputStream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
  });
}

export async function generatePack(input: GeneratePackInput): Promise<GeneratePackResult> {
  const loaded = await loadOpenApi({ path: input.openapiPath, inline: input.openapiInline });
  const tools = selectTools(loaded.api, { allowTools: input.allowTools });
  const apiName = input.apiName?.trim() || apiTitle(loaded.api);
  const homepage = input.homepage?.trim() || apiHomepage(loaded.api);
  const meta = {
    apiName,
    homepage,
    denyGuidance: input.denyGuidance,
    sampleDialogue: input.sampleDialogue,
    prosePort: input.prosePort,
  };
  const files = await buildArtifacts(loaded.api, tools, meta);
  const { markdown, skillSource } = await draftReviewedSkill(tools, meta);
  files["SKILL.md"] = markdown;
  const zipPath = input.out ?? defaultZipPath(apiName);
  await writeZip(files, zipPath);
  return { tools, zipPath, files, apiName, skillSource };
}

export function defaultZipPath(apiName: string): string {
  return `dist/${slugify(apiName)}.zip`;
}

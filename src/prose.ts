import type { McpTool } from "./tools.js";

export const DEFAULT_GENERATION_MODEL = "gpt-4o-mini";
export const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";

export type ProseContext = {
  apiName: string;
  homepage: string;
  tools: McpTool[];
  denyGuidance: string[];
  sampleDialogue?: string;
};

export type ProsePort = {
  draftSkillMarkdown(ctx: ProseContext): Promise<string>;
};

export type LiveProsePortOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const GENERIC_DENY = [
  "Do not send private data the API is not meant to hold.",
  "Do not invent tools that are not in the table below.",
  "Do not perform writes this pack does not expose.",
];

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function requiredList(schema: McpTool["inputSchema"]): string {
  return Array.isArray(schema.required) ? (schema.required as string[]).join(", ") : "";
}

export function formatToolsTable(tools: readonly McpTool[]): string {
  const rows =
    tools.length === 0
      ? "| (none) | | |"
      : tools
          .map((tool) => `| ${tool.name} | ${escapeCell(tool.description)} | ${requiredList(tool.inputSchema) || "—"} |`)
          .join("\n");
  return `| Tool | Description | Required |\n|---|---|---|\n${rows}`;
}

function denyLines(extra: string[]): string {
  return [...extra.map((line) => `- ${line}`), ...GENERIC_DENY.map((line) => `- ${line}`)].join("\n");
}

function defaultDialogue(ctx: ProseContext): string {
  const first = ctx.tools[0];
  if (!first) {
    return `User: Can you use ${ctx.apiName}?\n\nAgent: This pack exposes no tools. I will not invent any.`;
  }
  return `User: Use ${ctx.apiName} for the documented happy path.\n\nAgent: I will call only ${first.name} from the table above and report the JSON result.`;
}

/** Offline adapter. Deterministic; no network. Default in tests and CI. */
export class FakeProsePort implements ProsePort {
  async draftSkillMarkdown(ctx: ProseContext): Promise<string> {
    const apiName = ctx.apiName.trim() || "API";
    const homepage = ctx.homepage.trim();
    const dialogue = ctx.sampleDialogue?.trim() || defaultDialogue({ ...ctx, apiName });
    const homeLine = homepage ? `\nHomepage: ${homepage}\n` : "\n";
    return `# ${apiName}

${apiName} packaged as an installable MCP skill for agent runtimes.
${homeLine}
## When to use

Call these tools when the user needs ${apiName} over HTTP and the request matches a row in the tools table.

## When **not** to use

${denyLines(ctx.denyGuidance)}

## Auth

Set \`API_BEARER\` in the MCP server environment. The generated client sends \`Authorization: Bearer <token>\`.

## Tools

${formatToolsTable(ctx.tools)}

## Failure codes

If a tool returns a non-2xx status, tell the human the HTTP status and a short response-body summary. Do not retry writes blindly. Do not claim a tool that is not in the table.

## Sample dialogue

${dialogue}
`;
  }
}

function unwrapMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  return body.endsWith("\n") ? body : `${body}\n`;
}

function livePrompt(ctx: ProseContext): string {
  const names = ctx.tools.map((tool) => tool.name);
  return [
    "Write SKILL.md for an MCP pack. Prose only. Do not invent tools or change schemas.",
    "Required sections: name + one sentence; When to use; When **not** to use; Auth; Tools table; Failure codes; one sample dialogue.",
    `API name: ${ctx.apiName}`,
    ctx.homepage ? `Homepage: ${ctx.homepage}` : "Homepage: (none)",
    `Allow-listed tools (mention only these names): ${names.join(", ") || "(none)"}`,
    "Tool details:",
    formatToolsTable(ctx.tools),
    "Extra deny guidance:",
    denyLines(ctx.denyGuidance),
    ctx.sampleDialogue?.trim() ? `Preferred sample dialogue:\n${ctx.sampleDialogue.trim()}` : "Invent one sample dialogue that only uses allow-listed tools.",
    "Auth: API_BEARER bearer token in the MCP environment.",
  ].join("\n\n");
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

/** Env-gated live adapter. Throws on any upstream failure so generate can ship a stub skill. */
export class LiveProsePort implements ProsePort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LiveProsePortOptions) {
    if (!options.apiKey) {
      throw new Error("LiveProsePort requires apiKey");
    }
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_GENERATION_MODEL;
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async draftSkillMarkdown(ctx: ProseContext): Promise<string> {
    if (typeof this.fetchImpl !== "function") {
      throw new Error("fetch is not available");
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: "system", content: "You write SKILL.md files. Never mention a tool that is not allow-listed." },
            { role: "user", content: livePrompt(ctx) },
          ],
        }),
        signal: ac.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ProsePort request failed: ${message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`ProsePort HTTP ${res.status}`);
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      throw new Error("ProsePort returned non-JSON", { cause: err });
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("ProsePort returned empty content");
    }
    return unwrapMarkdownFence(content);
  }
}

export function isLiveProseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SKILLSEED_USE_LIVE_PROSE === "1" && Boolean(env.SKILLSEED_LLM_API_KEY);
}

/** Test hook: force draftSkillMarkdown to throw so generate still zips a stub. */
export class FailingProsePort implements ProsePort {
  async draftSkillMarkdown(): Promise<string> {
    throw new Error("ProsePort unavailable");
  }
}

export function createProsePort(env: NodeJS.ProcessEnv = process.env): ProsePort {
  if (env.SKILLSEED_PROSE_FAIL === "1") {
    return new FailingProsePort();
  }
  if (isLiveProseEnabled(env)) {
    return new LiveProsePort({
      apiKey: env.SKILLSEED_LLM_API_KEY ?? "",
      model: env.GENERATION_MODEL,
      baseUrl: env.SKILLSEED_LLM_BASE_URL,
    });
  }
  return new FakeProsePort();
}

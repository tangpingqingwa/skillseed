import { GenerateError, type McpTool } from "./tools.js";

export class SkillReviewError extends GenerateError {
  readonly unknownTools: string[];

  constructor(unknownTools: string[]) {
    const unique = [...new Set(unknownTools)].sort();
    super(`skill review failed: SKILL.md mentions tool(s) not in allow-list: ${unique.join(", ")}`, 1);
    this.name = "SkillReviewError";
    this.unknownTools = unique;
  }
}

export type ReviewInput = {
  markdown: string;
  allowTools: readonly string[];
  parameterNames?: readonly string[];
};

export type ReviewResult = {
  ok: boolean;
  unknownTools: string[];
};

const SNAKE_TOOL = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const TABLE_FIRST = /^\|\s*([^|]+?)\s*\|/;
const BACKTICK = /`([^`]+)`/g;

function isSeparator(cell: string): boolean {
  return /^:?-+:?$/.test(cell) || /^(tool|name|\(none\))$/i.test(cell);
}

function looksLikeToolName(name: string): boolean {
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name);
}

export function collectParameterNames(tools: readonly McpTool[]): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    const properties = tool.inputSchema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
    for (const key of Object.keys(properties as Record<string, unknown>)) names.add(key);
  }
  return [...names];
}

function extractClaimedNames(markdown: string): string[] {
  const claimed = new Set<string>();

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const row = line.match(TABLE_FIRST);
    if (row) {
      const first = row[1].replace(/[`*]/g, "").trim();
      if (first && !isSeparator(first) && looksLikeToolName(first)) claimed.add(first);
      continue;
    }
    for (const match of line.matchAll(BACKTICK)) {
      const inner = match[1].trim();
      if (looksLikeToolName(inner)) claimed.add(inner);
    }
    for (const match of line.matchAll(SNAKE_TOOL)) {
      claimed.add(match[0]);
    }
  }

  return [...claimed];
}

/** Deterministic stand-in for the SPEC §7 second-pass review. */
export function reviewSkillMarkdown(input: ReviewInput): ReviewResult {
  const allow = new Set(input.allowTools);
  const params = new Set(input.parameterNames ?? []);
  const unknown = extractClaimedNames(input.markdown).filter((name) => !allow.has(name) && !params.has(name));
  return { ok: unknown.length === 0, unknownTools: unknown.sort() };
}

export function assertSkillReview(input: ReviewInput): void {
  const result = reviewSkillMarkdown(input);
  if (!result.ok) throw new SkillReviewError(result.unknownTools);
}

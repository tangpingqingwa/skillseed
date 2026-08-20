import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePack, type GeneratePackInput, type GeneratePackResult } from "./emit.js";
import { OpenApiLoadError } from "./load.js";
import { GenerateError, MAX_TOOLS } from "./tools.js";

export const JOB_STATUSES = ["awaiting_payment", "queued", "running", "ready", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobAuth = {
  type: "bearer" | "header";
  headerName?: string;
  prefix?: string;
};

export type CreateJobInput = {
  openapiUrl?: string;
  openapiInline?: object;
  apiName: string;
  homepage?: string;
  auth?: JobAuth;
  allowTools?: string[];
  denyGuidance?: string[];
  sampleDialogue?: string;
  hostMcp?: boolean;
};

export type JobRecord = {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  input: CreateJobInput;
  checkoutSessionId?: string;
  checkoutUrl?: string;
  zipPath?: string;
  artifactNames?: string[];
  toolCount?: number;
  error?: string;
  paid: boolean;
};

export type JobView = {
  id: string;
  status: JobStatus;
  paid: boolean;
  checkoutUrl?: string;
  artifacts?: { zip: string; files: string[] };
  toolCount?: number;
  error?: string;
};

export class JobError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "JobError";
    this.statusCode = statusCode;
  }
}

export type JobStore = {
  create(input: CreateJobInput): JobRecord;
  get(id: string): JobRecord | undefined;
  update(id: string, patch: Partial<JobRecord>): JobRecord;
};

export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  create(input: CreateJobInput): JobRecord {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      status: "awaiting_payment",
      createdAt: now,
      updatedAt: now,
      input,
      paid: false,
    };
    this.jobs.set(job.id, job);
    return cloneJob(job);
  }

  get(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new JobError(`unknown job: ${id}`, 404);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return cloneJob(job);
  }
}

function cloneJob(job: JobRecord): JobRecord {
  return {
    ...job,
    input: {
      ...job.input,
      allowTools: job.input.allowTools ? [...job.input.allowTools] : undefined,
      denyGuidance: job.input.denyGuidance ? [...job.input.denyGuidance] : undefined,
      openapiInline: job.input.openapiInline
        ? (structuredClone(job.input.openapiInline) as object)
        : undefined,
    },
    artifactNames: job.artifactNames ? [...job.artifactNames] : undefined,
  };
}

export function validateCreateJobInput(raw: unknown): CreateJobInput {
  if (!isRecord(raw)) throw new JobError("body must be a JSON object");

  const apiName = typeof raw.apiName === "string" ? raw.apiName.trim() : "";
  if (!apiName) throw new JobError("apiName is required");

  const hasUrl = typeof raw.openapiUrl === "string" && raw.openapiUrl.trim() !== "";
  const hasInline = raw.openapiInline !== undefined && raw.openapiInline !== null;
  if (hasUrl && hasInline) throw new JobError("provide openapiUrl or openapiInline, not both");
  if (!hasUrl && !hasInline) throw new JobError("openapiUrl or openapiInline is required");
  if (hasInline && (typeof raw.openapiInline !== "object" || Array.isArray(raw.openapiInline))) {
    throw new JobError("openapiInline must be an object");
  }

  if (raw.openapiUrl !== undefined && typeof raw.openapiUrl !== "string") {
    throw new JobError("openapiUrl must be a string");
  }
  if (raw.homepage !== undefined && typeof raw.homepage !== "string") {
    throw new JobError("homepage must be a string");
  }
  if (raw.sampleDialogue !== undefined && typeof raw.sampleDialogue !== "string") {
    throw new JobError("sampleDialogue must be a string");
  }
  if (raw.hostMcp !== undefined && typeof raw.hostMcp !== "boolean") {
    throw new JobError("hostMcp must be a boolean");
  }
  if (raw.hostMcp === true) {
    throw new JobError("hosted MCP is not available yet");
  }

  const allowTools = optionalStringList(raw.allowTools, "allowTools");
  if (allowTools && allowTools.length > MAX_TOOLS) {
    throw new JobError(`allow-list has ${allowTools.length} tools; max is ${MAX_TOOLS}`);
  }
  const denyGuidance = optionalStringList(raw.denyGuidance, "denyGuidance");

  let auth: JobAuth | undefined;
  if (raw.auth !== undefined) {
    if (!isRecord(raw.auth)) throw new JobError("auth must be an object");
    const type = raw.auth.type;
    if (type !== "bearer" && type !== "header") {
      throw new JobError('auth.type must be "bearer" or "header"');
    }
    if (raw.auth.headerName !== undefined && typeof raw.auth.headerName !== "string") {
      throw new JobError("auth.headerName must be a string");
    }
    if (raw.auth.prefix !== undefined && typeof raw.auth.prefix !== "string") {
      throw new JobError("auth.prefix must be a string");
    }
    auth = {
      type,
      headerName: typeof raw.auth.headerName === "string" ? raw.auth.headerName : undefined,
      prefix: typeof raw.auth.prefix === "string" ? raw.auth.prefix : undefined,
    };
  }

  return {
    openapiUrl: hasUrl ? (raw.openapiUrl as string).trim() : undefined,
    openapiInline: hasInline ? (raw.openapiInline as object) : undefined,
    apiName,
    homepage: typeof raw.homepage === "string" ? raw.homepage.trim() : undefined,
    auth,
    allowTools,
    denyGuidance,
    sampleDialogue: typeof raw.sampleDialogue === "string" ? raw.sampleDialogue : undefined,
  };
}

function optionalStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new JobError(`${field} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toJobView(job: JobRecord): JobView {
  const view: JobView = {
    id: job.id,
    status: job.status,
    paid: job.paid,
  };
  if (job.checkoutUrl) view.checkoutUrl = job.checkoutUrl;
  if (job.status === "ready" && job.zipPath) {
    view.artifacts = {
      zip: `/jobs/${job.id}/files.zip`,
      files: job.artifactNames ?? [],
    };
  }
  if (job.toolCount !== undefined) view.toolCount = job.toolCount;
  if (job.error) view.error = job.error;
  return view;
}

export type RunGenerateOptions = {
  generate?: (input: GeneratePackInput) => Promise<GeneratePackResult>;
};

export async function runGenerateJob(
  store: JobStore,
  jobId: string,
  options: RunGenerateOptions = {},
): Promise<JobRecord> {
  const job = store.get(jobId);
  if (!job) throw new JobError(`unknown job: ${jobId}`, 404);
  if (!job.paid) throw new JobError("job is not paid", 402);
  if (job.status === "ready") return job;
  if (job.status === "running") return job;

  store.update(jobId, { status: "running", error: undefined });

  try {
    const tmp = await mkdtemp(join(tmpdir(), "skillseed-job-"));
    const zipPath = join(tmp, "pack.zip");
    const generate = options.generate ?? generatePack;
    const result = await generate({
      openapiPath: job.input.openapiUrl,
      openapiInline: job.input.openapiInline,
      out: zipPath,
      allowTools: job.input.allowTools,
      apiName: job.input.apiName,
      homepage: job.input.homepage,
      denyGuidance: job.input.denyGuidance,
      sampleDialogue: job.input.sampleDialogue,
    });
    return store.update(jobId, {
      status: "ready",
      zipPath: result.zipPath,
      artifactNames: Object.keys(result.files).sort(),
      toolCount: result.tools.length,
      error: undefined,
    });
  } catch (err) {
    const message = formatGenerateError(err);
    return store.update(jobId, { status: "failed", error: message });
  }
}

function formatGenerateError(err: unknown): string {
  if (err instanceof OpenApiLoadError || err instanceof GenerateError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

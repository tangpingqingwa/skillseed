import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  GENERATE_CURRENCY,
  GENERATE_PRICE_CENTS,
  type StripePort,
  StripeError,
} from "./billing.js";
import {
  JobError,
  type JobStore,
  MemoryJobStore,
  runGenerateJob,
  toJobView,
  validateCreateJobInput,
} from "./jobs.js";

export const PUBLIC_PRICE = `$${(GENERATE_PRICE_CENTS / 100).toFixed(0)}`;

export type BuildAppOptions = {
  stripe: StripePort;
  store?: JobStore;
  publicBaseUrl?: string;
  logger?: boolean;
};

export type BuiltApp = {
  app: FastifyInstance;
  store: JobStore;
  stripe: StripePort;
};

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.45; }
    label { display: block; margin-top: 0.75rem; font-weight: 600; }
    input, textarea { width: 100%; box-sizing: border-box; margin-top: 0.25rem; }
    textarea { min-height: 10rem; font-family: ui-monospace, monospace; }
    button { margin-top: 1rem; }
    .muted { opacity: 0.75; }
    code { font-size: 0.95em; }
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function marketingHtml(): string {
  return htmlPage(
    "SkillSeed — paste OpenAPI, get MCP + skill",
    `  <h1>SkillSeed</h1>
  <p>Paste an OpenAPI 3.x document. Pay ${PUBLIC_PRICE} once. Download an MCP + SKILL.zip.</p>
  <p class="muted">One generate = one OpenAPI snapshot. Hosted MCP is not in this release.</p>
  <form id="generate-form">
    <label for="apiName">API name</label>
    <input id="apiName" name="apiName" required placeholder="ClipAPI">
    <label for="homepage">Homepage (optional)</label>
    <input id="homepage" name="homepage" placeholder="https://example.com">
    <label for="openapiUrl">OpenAPI URL (file path or https)</label>
    <input id="openapiUrl" name="openapiUrl" placeholder="./openapi.yaml">
    <label for="openapiInline">…or paste OpenAPI JSON</label>
    <textarea id="openapiInline" name="openapiInline" placeholder='{"openapi":"3.1.0",...}'></textarea>
    <label for="allowTools">Allow-list (comma-separated operationIds, max 8)</label>
    <input id="allowTools" name="allowTools" placeholder="get_transcript">
    <button type="submit">Pay ${PUBLIC_PRICE} and generate</button>
  </form>
  <p id="status" class="muted"></p>
  <script>
    const form = document.getElementById("generate-form");
    const status = document.getElementById("status");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      status.textContent = "Creating checkout…";
      const apiName = document.getElementById("apiName").value.trim();
      const homepage = document.getElementById("homepage").value.trim();
      const openapiUrl = document.getElementById("openapiUrl").value.trim();
      const inlineRaw = document.getElementById("openapiInline").value.trim();
      const allowRaw = document.getElementById("allowTools").value.trim();
      const body = { apiName };
      if (homepage) body.homepage = homepage;
      if (openapiUrl) body.openapiUrl = openapiUrl;
      if (inlineRaw) {
        try { body.openapiInline = JSON.parse(inlineRaw); }
        catch (err) { status.textContent = "OpenAPI JSON is invalid."; return; }
      }
      if (allowRaw) body.allowTools = allowRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await fetch("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.error || ("HTTP " + res.status);
        return;
      }
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      status.textContent = "Job " + data.id + " created.";
    });
  </script>
`,
  );
}

function fakeCheckoutHtml(sessionId: string, jobId: string): string {
  return htmlPage(
    `Pay ${PUBLIC_PRICE} — SkillSeed`,
    `  <h1>Fake Stripe Checkout</h1>
  <p>Generate pack for job <code>${escapeHtml(jobId)}</code>.</p>
  <p><strong>${PUBLIC_PRICE} USD</strong> one-time. Tests and local dev only — not a live card charge.</p>
  <form method="post" action="/checkout/fake/${encodeURIComponent(sessionId)}">
    <button type="submit">Pay ${PUBLIC_PRICE}</button>
  </form>
  <p class="muted"><a href="/jobs/${encodeURIComponent(jobId)}">Cancel and view job</a></p>
`,
  );
}

function jobPageHtml(job: ReturnType<typeof toJobView>): string {
  const zip = job.artifacts?.zip
    ? `<p><a href="${escapeHtml(job.artifacts.zip)}">Download files.zip</a></p>`
    : "";
  const err = job.error ? `<p>Error: ${escapeHtml(job.error)}</p>` : "";
  const pay = job.checkoutUrl && job.status === "awaiting_payment"
    ? `<p><a href="${escapeHtml(job.checkoutUrl)}">Pay ${PUBLIC_PRICE}</a></p>`
    : "";
  return htmlPage(
    `Job ${job.id}`,
    `  <h1>Generate job</h1>
  <p>Status: <strong>${escapeHtml(job.status)}</strong>${job.paid ? " (paid)" : ""}</p>
  ${pay}${zip}${err}
  <p class="muted"><a href="/">New generate</a></p>
`,
  );
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof JobError) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  if (err instanceof StripeError) {
    return reply.code(400).send({ error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: message });
}

function publicOrigin(request: FastifyRequest, fallback?: string): string {
  if (fallback) return fallback.replace(/\/+$/, "");
  const host = request.headers.host ?? "127.0.0.1";
  const proto = request.protocol || "http";
  return `${proto}://${host}`;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const store = options.store ?? new MemoryJobStore();
  const stripe = options.stripe;
  const app = Fastify({ logger: options.logger ?? false });

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(marketingHtml());
  });

  app.get("/docs", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(
      htmlPage(
        "SkillSeed docs",
        `  <h1>Docs</h1>
  <p>CLI: <code>skillseed generate ./openapi.yaml</code></p>
  <p>Web: paste OpenAPI, pay ${PUBLIC_PRICE}, download the zip. Hosted MCP is later.</p>
  <p><a href="/">Back</a></p>
`,
      ),
    );
  });

  app.post("/jobs", async (request, reply) => {
    try {
      const input = validateCreateJobInput(request.body);
      const job = store.create(input);
      const origin = publicOrigin(request, options.publicBaseUrl);
      const session = await stripe.createCheckoutSession({
        jobId: job.id,
        successUrl: `${origin}/jobs/${job.id}?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/jobs/${job.id}`,
      });
      const updated = store.update(job.id, {
        checkoutSessionId: session.id,
        checkoutUrl: session.url,
        status: "awaiting_payment",
      });
      return reply.code(201).send({
        ...toJobView(updated),
        checkoutUrl: session.url,
        amountCents: GENERATE_PRICE_CENTS,
        currency: GENERATE_CURRENCY,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { session_id?: string } }>(
    "/jobs/:id",
    async (request, reply) => {
      let job = store.get(request.params.id);
      if (!job) return reply.code(404).send({ error: "job not found" });
      const sessionId = request.query.session_id;
      if (sessionId && !job.paid) {
        const session = await stripe.retrieveCheckoutSession(sessionId);
        if (session && session.jobId === job.id && session.status === "complete") {
          store.update(job.id, { paid: true, status: "queued" });
          job = await runGenerateJob(store, job.id);
        }
      }
      const accept = String(request.headers.accept ?? "");
      const view = toJobView(job);
      if (accept.includes("text/html")) {
        return reply.type("text/html; charset=utf-8").send(jobPageHtml(view));
      }
      return reply.send(view);
    },
  );

  app.get<{ Params: { id: string } }>("/jobs/:id/files.zip", async (request, reply) => {
    const job = store.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job not found" });
    if (job.status !== "ready" || !job.zipPath) {
      return reply.code(409).send({ error: "zip is not ready" });
    }
    try {
      const buf = await readFile(job.zipPath);
      return reply
        .header("content-type", "application/zip")
        .header("content-disposition", `attachment; filename="${job.id}.zip"`)
        .send(buf);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/checkout/fake/:id", async (request, reply) => {
    const session = await stripe.retrieveCheckoutSession(request.params.id);
    if (!session) return reply.code(404).send({ error: "checkout session not found" });
    return reply.type("text/html; charset=utf-8").send(fakeCheckoutHtml(session.id, session.jobId));
  });

  app.post<{ Params: { id: string } }>("/checkout/fake/:id", async (request, reply) => {
    try {
      const session = await stripe.completeCheckoutSession(request.params.id);
      const job = store.get(session.jobId);
      if (!job) return reply.code(404).send({ error: "job not found" });
      store.update(job.id, { paid: true, status: "queued" });
      const finished = await runGenerateJob(store, job.id);
      const accept = String(request.headers.accept ?? "");
      if (accept.includes("text/html") || !accept.includes("application/json")) {
        return reply.redirect(`/jobs/${finished.id}`, 303);
      }
      return reply.send(toJobView(finished));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  return { app, store, stripe };
}

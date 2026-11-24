// Cloudflare Worker entry point.
// Serves the API under /api. Everything else is the React app (static assets).

import { Hono } from "hono";
import type { Dataset, OnProgress, ProgressEvent } from "../shared/types";
import { runAgent } from "./agent";
import { runMockAgent } from "./mock";

interface Env {
  ANTHROPIC_API_KEY: string;
  CLAUDE_MODEL: string;
  MAX_ROWS: string;
  DEMO_MODE: string;
  ANALYZE_LIMITER: RateLimit;
}

const MAX_BODY_BYTES = 1_000_000; // 1 MB
const MAX_COLUMNS = 50;

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true, model: c.env.CLAUDE_MODEL, mock: c.env.DEMO_MODE === "true" }));

app.post("/api/analyze", async (c) => {
  // ---- rate limiting: a few analyses per minute per IP address ----
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  const { success } = await c.env.ANALYZE_LIMITER.limit({ key: ip });
  if (!success) {
    console.warn(JSON.stringify({ event: "rate_limited", ip }));
    return c.json({ error: "Too many analyses. Please wait a minute and try again." }, 429);
  }

  const demoMode = c.env.DEMO_MODE === "true";
  if (!demoMode && !c.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "Server is missing ANTHROPIC_API_KEY. See README." }, 500);
  }

  // ---- input validation (security + keeps CPU time low on the free plan) ----
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return c.json({ error: "File too large (max 1 MB)" }, 413);

  let body: Dataset;
  try {
    body = await c.req.json<Dataset>();
  } catch {
    return c.json({ error: "Body must be JSON: { columns: string[], rows: object[] }" }, 400);
  }

  const maxRows = Number(c.env.MAX_ROWS) || 2000;
  if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) {
    return c.json({ error: "Body must include columns and rows arrays" }, 400);
  }
  if (body.rows.length === 0) return c.json({ error: "The file has no data rows" }, 400);
  if (body.rows.length > maxRows) return c.json({ error: `Too many rows (max ${maxRows})` }, 413);
  if (body.columns.length > MAX_COLUMNS) return c.json({ error: `Too many columns (max ${MAX_COLUMNS})` }, 413);

  const data: Dataset = {
    columns: body.columns.map(String),
    rows: body.rows.map((r) => Object.fromEntries(body.columns.map((col) => [col, String(r?.[col] ?? "")]))),
  };

  // Demo mode is an explicit setting, so the live site never silently runs without Claude.
  const run = (onProgress?: OnProgress) =>
    demoMode
      ? runMockAgent(data, onProgress)
      : runAgent(data, { apiKey: c.env.ANTHROPIC_API_KEY, model: c.env.CLAUDE_MODEL }, onProgress);

  // The browser asks for a stream so it can show progress; evals and other
  // clients get a single JSON response.
  if (c.req.header("accept")?.includes("application/x-ndjson")) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (event: ProgressEvent) => writer.write(encoder.encode(JSON.stringify(event) + "\n"));

    const work = run(send)
      .then((result) => send({ type: "result", result }))
      .catch((err) => {
        console.error(JSON.stringify({ event: "analysis_failed", error: String(err) }));
        return send({ type: "error", error: "Analysis failed. Please try again." });
      })
      .finally(() => writer.close());
    c.executionCtx.waitUntil(work);

    return new Response(readable, {
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
    });
  }

  try {
    return c.json(await run());
  } catch (err) {
    console.error(JSON.stringify({ event: "analysis_failed", error: String(err) }));
    return c.json({ error: "Analysis failed. Please try again." }, 502);
  }
});

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

export default app;

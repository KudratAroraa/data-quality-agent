// The agent loop.
//
// 1. Profile the dataset in code and give Claude the profile (masked samples only).
// 2. Claude picks which checks to run, on which columns, by calling tools.
// 3. We run each tool here on the Worker and send back the results.
// 4. Repeat until Claude calls submit_report, or we hit MAX_ITERATIONS.

import Anthropic from "@anthropic-ai/sdk";
import type { AnalyzeResponse, Dataset, OnProgress, Report, TraceStep } from "../shared/types";
import { profileDataset, REPORT_TOOL_NAME, runTool, TOOL_DEFINITIONS } from "./tools";

const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You are a senior data quality consultant at a technology consultancy that runs CRM and data migration projects (Salesforce, Snowflake, Informatica).

You are given a profile of a CSV dataset. Your job is to find the data quality problems that would cause trouble in a migration, using the tools provided.

How to work:
- Read the profile first. Decide which checks matter for each column based on its name, inferred type and samples.
- Run checks with the tools. You can call several tools in one turn.
- Check for duplicate records using sensible identifying columns (e.g. email), and also try normalise=true to catch near-duplicates.
- Missing values are already in the profile. Judge whether they matter: a missing email or ID is serious, a missing optional field usually is not.
- Only report issues that are backed by tool results or the profile. Do not invent numbers.
- Every issue must have affected_rows of 1 or more. Do not report suspicions without a count.
- Sample values are masked by this system for privacy (e.g. "Ja**", "a***@example.com"). The masking is not in the data: never report it as an issue.
- Duplicate checks overlap (exact copies also share an email and an ID). Report ONE duplicates issue. Use the extra_rows of the normalised email check (normalise=true on the email column), because it catches both exact copies and case variants; set column to the email column. With no email column, use the duplicate check with the highest extra_rows. Mention the other checks in the example.
- When you are done, call submit_report exactly once. Order issues from most to least severe.

Severity guide: high = blocks a migration or breaks matching (duplicates, invalid emails, missing IDs); medium = needs cleaning before go-live; low = cosmetic.

Score guide: 100 means no issues found. Deduct more for high-severity issues and for issues that affect a larger share of rows.`;

export interface AgentEnv {
  apiKey: string;
  model: string;
}

export async function runAgent(data: Dataset, env: AgentEnv, onProgress: OnProgress = () => {}): Promise<AnalyzeResponse> {
  const started = Date.now();
  const client = new Anthropic({ apiKey: env.apiKey });
  const profile = profileDataset(data);
  onProgress({ type: "status", message: `Profiled ${data.rows.length.toLocaleString()} rows × ${data.columns.length} columns` });
  const trace: TraceStep[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, iterations: 0, model: env.model };

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: `Here is the dataset profile (sample values are masked for privacy):\n\n${JSON.stringify(profile, null, 2)}\n\nAnalyse the data quality and submit your report.`,
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    usage.iterations++;
    // On the last allowed turn, force the model to submit its report.
    const lastTurn = i === MAX_ITERATIONS - 1;
    onProgress({
      type: "status",
      message: lastTurn ? "Writing the report…" : i === 0 ? "Claude is deciding what to check…" : "Claude is reviewing the results…",
    });

    const response = await client.messages.create({
      model: env.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOL_DEFINITIONS,
      tool_choice: lastTurn ? { type: "tool", name: REPORT_TOOL_NAME } : { type: "any" },
      messages,
    });

    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    const reportCall = toolUses.find((t) => t.name === REPORT_TOOL_NAME);
    if (reportCall) {
      trace.push({ tool: REPORT_TOOL_NAME, input: "(final report)", result_preview: "done" });
      console.log(JSON.stringify({ event: "analysis_complete", ...usage, duration_ms: Date.now() - started }));
      return {
        report: normaliseReport(reportCall.input as Report),
        trace,
        profile: profile.columns,
        usage,
        duration_ms: Date.now() - started,
      };
    }

    // Run every tool Claude asked for and send all results back in one message.
    onProgress({ type: "status", message: "Running checks…" });
    const results: Anthropic.Messages.ToolResultBlockParam[] = toolUses.map((call) => {
      let output: unknown;
      let isError = false;
      try {
        output = runTool(data, call.name, (call.input ?? {}) as Record<string, unknown>);
      } catch (err) {
        output = { error: err instanceof Error ? err.message : String(err) };
        isError = true;
      }
      const json = JSON.stringify(output);
      const step = { tool: call.name, input: call.input, result_preview: json.slice(0, 200) };
      trace.push(step);
      onProgress({ type: "step", step });
      return { type: "tool_result", tool_use_id: call.id, content: json, is_error: isError };
    });

    messages.push({ role: "user", content: results });
  }

  throw new Error("Agent did not produce a report within the iteration limit");
}

/** Guards against malformed model output so the UI never crashes. */
export function normaliseReport(r: Partial<Report>): Report {
  const order = { high: 0, medium: 1, low: 2 } as const;
  const issues = Array.isArray(r.issues) ? r.issues : [];
  return {
    // A report with no issues is clean by definition, whatever score the model gave.
    overall_score: issues.length ? Math.max(0, Math.min(100, Math.round(Number(r.overall_score) || 0))) : 100,
    summary: typeof r.summary === "string" ? r.summary : "",
    issues: issues
      .filter((i) => i && typeof i.column === "string")
      .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)),
  };
}

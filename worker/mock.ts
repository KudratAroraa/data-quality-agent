// Mock agent, used when no ANTHROPIC_API_KEY is set.
//
// A scripted planner stands in for Claude: it picks checks from the column
// profile using simple rules, then runs the *real* tools on the uploaded data.
// So the numbers in the report are genuine, only the "reasoning" is canned.
// Lets you develop the UI without an API key or spending tokens.

import type { AnalyzeResponse, ColumnProfile, Dataset, Issue, OnProgress, TraceStep } from "../shared/types";
import { normaliseReport } from "./agent";
import { profileDataset, REPORT_TOOL_NAME, runTool } from "./tools";

// Pause between steps so the progress UI looks like a real run.
const STEP_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID_COLUMN = /(^id$|_id$|^id_)/i;
const FREE_TEXT_COLUMN = /name|address|street|city|suburb|note|comment|description/i;

interface Check {
  tool: string;
  input: Record<string, unknown>;
  toIssue: (out: any) => Issue | null;
}

export async function runMockAgent(
  data: Dataset,
  onProgress: OnProgress = () => {},
  stepDelayMs = STEP_DELAY_MS,
): Promise<AnalyzeResponse> {
  const started = Date.now();
  const profile = profileDataset(data);
  onProgress({ type: "status", message: `Profiled ${data.rows.length.toLocaleString()} rows × ${data.columns.length} columns` });
  await sleep(stepDelayMs);
  onProgress({ type: "status", message: "Choosing checks (mock rules)…" });
  await sleep(stepDelayMs);
  onProgress({ type: "status", message: "Running checks…" });
  const trace: TraceStep[] = [];
  const issues: Issue[] = [];

  for (const check of planChecks(profile.columns)) {
    let out: unknown;
    try {
      out = runTool(data, check.tool, check.input);
    } catch (err) {
      out = { error: err instanceof Error ? err.message : String(err) };
    }
    const step = { tool: check.tool, input: check.input, result_preview: JSON.stringify(out).slice(0, 200) };
    trace.push(step);
    onProgress({ type: "step", step });
    await sleep(stepDelayMs);
    const issue = (out as { error?: string }).error ? null : check.toIssue(out);
    if (issue) issues.push(issue);
  }

  onProgress({ type: "status", message: "Writing the report…" });
  issues.push(...missingValueIssues(profile.columns));
  trace.push({ tool: REPORT_TOOL_NAME, input: "(final report)", result_preview: "done" });
  await sleep(stepDelayMs);

  return {
    report: normaliseReport({
      overall_score: score(issues, data.rows.length),
      summary: summarise(issues, data.rows.length),
      issues,
    }),
    trace,
    profile: profile.columns,
    usage: { input_tokens: 0, output_tokens: 0, iterations: 1, model: "mock (no API key)" },
    duration_ms: Date.now() - started,
    mock: true,
  };
}

function planChecks(columns: ColumnProfile[]): Check[] {
  const checks: Check[] = [];
  const email = columns.find((c) => c.inferred_type === "email" || /e-?mail/i.test(c.name));

  // Duplicates: normalised email catches exact copies and case variants;
  // fall back to whole-row exact matching when there is no email column.
  checks.push({
    tool: "find_duplicates",
    input: email ? { columns: [email.name], normalise: true } : {},
    toIssue: (o) =>
      o.extra_rows > 0
        ? {
            column: email?.name ?? "*",
            issue_type: "duplicates",
            severity: "high",
            affected_rows: o.extra_rows,
            example: `Rows ${o.example_groups[0].join(", ")} are the same record`,
            suggested_fix: "Merge duplicate records, keeping the most recently updated one.",
          }
        : null,
  });

  for (const col of columns) {
    const format = formatFor(col);
    if (format) {
      checks.push({
        tool: "validate_format",
        input: { column: col.name, format },
        toIssue: (o) =>
          o.invalid_count > 0
            ? {
                column: col.name,
                issue_type: "invalid_format",
                severity: format === "email" ? "high" : "medium",
                affected_rows: o.invalid_count,
                example: o.examples[0]?.value ?? "",
                suggested_fix: FORMAT_FIXES[format],
              }
            : null,
      });
    } else if (col.inferred_type === "number" && !ID_COLUMN.test(col.name)) {
      checks.push({
        tool: "find_outliers",
        input: { column: col.name },
        toIssue: (o) =>
          o.outlier_count > 0
            ? {
                column: col.name,
                issue_type: "outliers",
                severity: "low",
                affected_rows: o.outlier_count,
                example: String(o.examples[0]?.value ?? ""),
                suggested_fix: `Review values outside ${Math.round(o.bounds.low)}–${Math.round(o.bounds.high)} with the data owner.`,
              }
            : null,
      });
    } else if (col.inferred_type === "text" && col.unique_count <= 30 && !FREE_TEXT_COLUMN.test(col.name)) {
      // Few distinct values means it is probably a category (state, status…).
      checks.push({
        tool: "find_inconsistent_values",
        input: { column: col.name },
        toIssue: (o) =>
          o.affected_rows > 0
            ? {
                column: col.name,
                issue_type: "inconsistent_values",
                severity: "medium",
                affected_rows: o.affected_rows,
                example: o.groups[0].variants.map((v: { value: string }) => v.value).join(" / "),
                suggested_fix: "Map all variants to one standard value (e.g. a picklist).",
              }
            : null,
      });
    }
  }
  return checks;
}

const FORMAT_FIXES = {
  email: "Correct or remove invalid emails before import; they break matching and deliverability.",
  phone_au: "Normalise to E.164 (+61…) and drop numbers with the wrong length.",
  postcode_au: "Pad or correct to a 4-digit postcode.",
  date: "Convert all dates to ISO format (YYYY-MM-DD).",
  url: "Fix URLs so they start with http:// or https://.",
} as const;

function formatFor(col: ColumnProfile): keyof typeof FORMAT_FIXES | null {
  if (col.inferred_type === "email" || /e-?mail/i.test(col.name)) return "email";
  if (col.inferred_type === "phone" || /phone|mobile/i.test(col.name)) return "phone_au";
  if (/postcode|post_code|zip/i.test(col.name)) return "postcode_au";
  if (col.inferred_type === "date" || /date|_at$/i.test(col.name)) return "date";
  if (col.inferred_type === "url" || /url|website/i.test(col.name)) return "url";
  return null;
}

function missingValueIssues(columns: ColumnProfile[]): Issue[] {
  return columns
    .filter((c) => c.missing_count > 0)
    .map((c) => {
      const critical = ID_COLUMN.test(c.name) || /e-?mail/i.test(c.name);
      return {
        column: c.name,
        issue_type: "missing_values",
        severity: critical ? "high" : c.missing_pct > 10 ? "medium" : "low",
        affected_rows: c.missing_count,
        example: "(empty)",
        suggested_fix: critical
          ? "Backfill from the source system; records without this can't be matched."
          : "Backfill if available, otherwise mark as optional in the target schema.",
      };
    });
}

function score(issues: Issue[], rows: number): number {
  const weight = { high: 3, medium: 2, low: 1 };
  const penalty = issues.reduce((sum, i) => sum + weight[i.severity] * Math.min(1, (i.affected_rows / rows) * 10), 0);
  return 100 - penalty * 6;
}

function summarise(issues: Issue[], rows: number): string {
  if (!issues.length) return `No data quality problems found across ${rows.toLocaleString()} rows. Ready to migrate.`;
  const high = issues.filter((i) => i.severity === "high").length;
  return (
    `Found ${issues.length} issue${issues.length === 1 ? "" : "s"} across ${rows.toLocaleString()} rows` +
    (high ? `, ${high} of them high severity. Fix those before migrating.` : ". None block a migration, but clean them before go-live.")
  );
}

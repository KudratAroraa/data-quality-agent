// Tests the agent loop without calling the real API, by faking Claude's replies.
import { describe, expect, it, vi } from "vitest";
import type { Dataset } from "../shared/types";

const replies: unknown[] = [];
const calls: any[] = [];

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (params: any) => {
        calls.push(structuredClone(params));
        return replies.shift();
      },
    };
  },
}));

const { runAgent } = await import("./agent");

const data: Dataset = {
  columns: ["email"],
  rows: [{ email: "a@x.com" }, { email: "A@x.com" }, { email: "bad" }],
};

const usage = { input_tokens: 100, output_tokens: 20 };

describe("runAgent", () => {
  it("runs requested tools, sends results back, and returns the report", async () => {
    replies.push(
      {
        usage,
        content: [
          { type: "tool_use", id: "t1", name: "validate_format", input: { column: "email", format: "email" } },
          { type: "tool_use", id: "t2", name: "find_duplicates", input: { columns: ["email"], normalise: true } },
        ],
      },
      {
        usage,
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: "submit_report",
            input: {
              overall_score: 140, // out of range on purpose: should be clamped
              summary: "Two problems.",
              issues: [
                { column: "email", issue_type: "invalid_format", severity: "low", affected_rows: 1, example: "b***", suggested_fix: "Fix" },
                { column: "email", issue_type: "duplicates", severity: "high", affected_rows: 1, example: "a***", suggested_fix: "Merge" },
              ],
            },
          },
        ],
      },
    );

    const result = await runAgent(data, { apiKey: "test", model: "test-model" });

    // Tool results were sent back to the model in the second call
    const toolResults = calls[1].messages.at(-1).content;
    expect(toolResults).toHaveLength(2);
    expect(JSON.parse(toolResults[0].content).invalid_count).toBe(1);
    expect(JSON.parse(toolResults[1].content).duplicate_groups).toBe(1);

    expect(result.report.overall_score).toBe(100);
    expect(result.report.issues[0].severity).toBe("high"); // sorted by severity
    expect(result.trace.map((t) => t.tool)).toEqual(["validate_format", "find_duplicates", "submit_report"]);
    expect(result.usage).toMatchObject({ input_tokens: 200, output_tokens: 40, iterations: 2 });
  });

  it("returns tool errors to the model instead of crashing", async () => {
    calls.length = 0;
    replies.push(
      { usage, content: [{ type: "tool_use", id: "t1", name: "find_outliers", input: { column: "nope" } }] },
      { usage, content: [{ type: "tool_use", id: "t2", name: "submit_report", input: { overall_score: 90, summary: "ok", issues: [] } }] },
    );
    const result = await runAgent(data, { apiKey: "test", model: "test-model" });
    const errorResult = calls[1].messages.at(-1).content[0];
    expect(errorResult.is_error).toBe(true);
    expect(errorResult.content).toMatch(/Unknown column/);
    expect(result.report.summary).toBe("ok");
  });

  it("scores a report with no issues as 100, whatever the model said", async () => {
    replies.push({
      usage,
      content: [{ type: "tool_use", id: "t1", name: "submit_report", input: { overall_score: 97, summary: "clean", issues: [] } }],
    });
    const result = await runAgent(data, { apiKey: "test", model: "test-model" });
    expect(result.report.overall_score).toBe(100);
  });
});

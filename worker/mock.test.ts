// The mock agent should find every planted issue in the sample file, with
// exact counts, and nothing on the clean file.
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import type { Dataset, Row } from "../shared/types";
import { runMockAgent } from "./mock";

function load(path: string): Dataset {
  const res = Papa.parse<Row>(readFileSync(path, "utf8"), { header: true, skipEmptyLines: true });
  return { columns: res.meta.fields!, rows: res.data };
}

describe("mock agent", () => {
  it("finds every planted issue in messy_customers.csv", async () => {
    const { report, mock } = await runMockAgent(load("samples/messy_customers.csv"), undefined, 0);
    const { expected_issues } = JSON.parse(readFileSync("samples/messy_customers.answer.json", "utf8"));
    expect(mock).toBe(true);
    for (const e of expected_issues) {
      const found = report.issues.find(
        (i) => i.issue_type === e.issue_type && (e.column === "*" || i.column === e.column),
      );
      expect(found?.affected_rows, `${e.column} ${e.issue_type}`).toBe(e.count);
    }
    expect(report.issues).toHaveLength(expected_issues.length); // no false positives
    expect(report.overall_score).toBeLessThan(80);
  });

  it("reports nothing on clean_customers.csv", async () => {
    const { report } = await runMockAgent(load("samples/clean_customers.csv"), undefined, 0);
    expect(report.issues).toEqual([]);
    expect(report.overall_score).toBe(100);
  });
});

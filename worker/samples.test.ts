// Checks the tools against the answer key for the sample file.
// If these pass, the tools are correct, so any miss in the eval is the agent's
// decision-making (which checks it chose to run), not a bug in the code.
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import type { Dataset, Row } from "../shared/types";
import { findDuplicates, findInconsistentValues, findOutliers, profileDataset, validateFormat } from "./tools";

function load(path: string): Dataset {
  const res = Papa.parse<Row>(readFileSync(path, "utf8"), { header: true, skipEmptyLines: true });
  return { columns: res.meta.fields!, rows: res.data };
}

describe("messy_customers.csv ground truth", () => {
  const data = load("samples/messy_customers.csv");
  const col = (name: string) => profileDataset(data).columns.find((c) => c.name === name)!;

  it("missing values", () => {
    expect(col("email").missing_count).toBe(10);
    expect(col("last_name").missing_count).toBe(3);
  });
  it("invalid formats", () => {
    expect(validateFormat(data, "email", "email").invalid_count).toBe(8);
    expect(validateFormat(data, "phone", "phone_au").invalid_count).toBe(6);
    expect(validateFormat(data, "postcode", "postcode_au").invalid_count).toBe(4);
    expect(validateFormat(data, "signup_date", "date").invalid_count).toBe(5);
  });
  it("inconsistent values", () => {
    expect(findInconsistentValues(data, "state").affected_rows).toBe(9);
    expect(findInconsistentValues(data, "status").affected_rows).toBe(5);
  });
  it("outliers", () => {
    const r = findOutliers(data, "lifetime_value");
    expect("outlier_count" in r && r.outlier_count).toBe(3);
  });
  it("duplicates", () => {
    expect(findDuplicates(data).extra_rows).toBe(6);
    expect(findDuplicates(data, { columns: ["email"], normalise: true }).extra_rows).toBe(10);
  });
});

describe("clean_customers.csv has no issues", () => {
  const data = load("samples/clean_customers.csv");
  it("passes every check", () => {
    expect(validateFormat(data, "email", "email").invalid_count).toBe(0);
    expect(validateFormat(data, "phone", "phone_au").invalid_count).toBe(0);
    expect(validateFormat(data, "signup_date", "date").invalid_count).toBe(0);
    expect(findDuplicates(data, { columns: ["email"], normalise: true }).duplicate_groups).toBe(0);
    expect(findInconsistentValues(data, "state").inconsistent_groups).toBe(0);
  });
});

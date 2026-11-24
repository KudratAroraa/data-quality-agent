import { describe, expect, it } from "vitest";
import type { Dataset } from "../shared/types";
import {
  findDuplicates,
  findInconsistentValues,
  findOutliers,
  maskValue,
  profileDataset,
  runTool,
  validateFormat,
  VALIDATORS,
} from "./tools";

const data: Dataset = {
  columns: ["id", "email", "phone", "state", "spend"],
  rows: [
    { id: "1", email: "amy@example.com", phone: "0412 345 678", state: "VIC", spend: "100" },
    { id: "2", email: "bob@example", phone: "12345", state: "Victoria", spend: "120" },
    { id: "3", email: "AMY@example.com ", phone: "+61 3 9123 4567", state: "vic", spend: "110" },
    { id: "4", email: "", phone: "", state: "NSW", spend: "95" },
    { id: "5", email: "cat@example.com", phone: "0398765432", state: "New South Wales", spend: "105" },
    { id: "6", email: "dan@example.com", phone: "0400111222", state: "QLD", spend: "99999" },
  ],
};

describe("validators", () => {
  it("validates emails", () => {
    expect(VALIDATORS.email("a@b.com")).toBe(true);
    expect(VALIDATORS.email("bob@example")).toBe(false);
  });
  it("validates AU phones with spaces and +61", () => {
    expect(VALIDATORS.phone_au("0412 345 678")).toBe(true);
    expect(VALIDATORS.phone_au("+61 3 9123 4567")).toBe(true);
    expect(VALIDATORS.phone_au("12345")).toBe(false);
  });
  it("rejects impossible dates", () => {
    expect(VALIDATORS.date("2026-02-28")).toBe(true);
    expect(VALIDATORS.date("31/02/2026")).toBe(false);
    expect(VALIDATORS.date("2026-13-01")).toBe(false);
  });
});

describe("maskValue", () => {
  it("masks emails and long values", () => {
    expect(maskValue("amy@example.com")).toBe("a***@example.com");
    expect(maskValue("0412345678")).toBe("04******78");
  });
});

describe("profileDataset", () => {
  it("counts missing values and infers types", () => {
    const p = profileDataset(data);
    const email = p.columns.find((c) => c.name === "email")!;
    expect(p.row_count).toBe(6);
    expect(email.missing_count).toBe(1);
    expect(email.inferred_type).toBe("email");
    // PII samples are masked
    expect(email.sample_values.every((v) => v.includes("***"))).toBe(true);
  });
});

describe("findDuplicates", () => {
  it("finds near-duplicates only when normalised", () => {
    expect(findDuplicates(data, { columns: ["email"] }).duplicate_groups).toBe(0);
    const r = findDuplicates(data, { columns: ["email"], normalise: true });
    expect(r.duplicate_groups).toBe(1);
    expect(r.example_groups[0]).toEqual([2, 4]); // spreadsheet row numbers
  });
  it("throws on unknown columns", () => {
    expect(() => findDuplicates(data, { columns: ["nope"] })).toThrow(/Unknown column/);
  });
});

describe("validateFormat", () => {
  it("skips empty values and reports invalid ones", () => {
    const r = validateFormat(data, "email", "email");
    expect(r.checked_non_empty).toBe(5);
    expect(r.invalid_count).toBe(1);
    expect(r.examples[0].row).toBe(3);
  });
});

describe("findInconsistentValues", () => {
  it("groups VIC / Victoria / vic and NSW / New South Wales", () => {
    const r = findInconsistentValues(data, "state");
    expect(r.inconsistent_groups).toBe(2);
    expect(r.affected_rows).toBe(3); // 2 extra VIC variants + 1 extra NSW variant
  });
});

describe("findOutliers", () => {
  it("flags the extreme spend value", () => {
    const r = findOutliers(data, "spend");
    expect("outlier_count" in r && r.outlier_count).toBe(1);
  });
});

describe("runTool", () => {
  it("rejects unknown tools", () => {
    expect(() => runTool(data, "drop_table", {})).toThrow(/Unknown tool/);
  });
});

// Data quality tools.
//
// These are plain, deterministic functions. They do the actual computation.
// Claude never sees the full dataset: it only receives the summaries these
// tools return (counts, row numbers and masked examples). That is a deliberate
// privacy-by-design / data-minimisation choice.

import type { ColumnProfile, Dataset } from "../shared/types";

// ---------- helpers ----------

const PII_COLUMN = /name|email|e-mail|phone|mobile|address|street|dob|birth/i;

export function isMissing(v: string | undefined | null): boolean {
  if (v === undefined || v === null) return true;
  const t = String(v).trim().toLowerCase();
  return t === "" || t === "null" || t === "n/a" || t === "na" || t === "-" || t === "none";
}

/** Masks a value so personal data is not sent to the model. */
export function maskValue(value: string): string {
  const v = value.trim();
  if (v.includes("@")) {
    const [local, domain] = v.split("@");
    return `${local.slice(0, 1)}***@${domain ?? ""}`;
  }
  if (v.length <= 4) return "*".repeat(v.length);
  return v.slice(0, 2) + "*".repeat(Math.min(v.length - 4, 6)) + v.slice(-2);
}

function display(column: string, value: string): string {
  return PII_COLUMN.test(column) ? maskValue(value) : value;
}

/** Row numbers are 1-based and count the header as row 1, matching Excel. */
const rowNumber = (index: number) => index + 2;

function requireColumn(data: Dataset, column: string) {
  if (!data.columns.includes(column)) {
    throw new Error(`Unknown column "${column}". Available columns: ${data.columns.join(", ")}`);
  }
}

// ---------- format validators ----------

export const VALIDATORS = {
  email: (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()),
  phone_au: (v: string) => /^(\+?61|0)[2-478]\d{8}$/.test(v.replace(/[\s\-()]/g, "")),
  postcode_au: (v: string) => /^\d{4}$/.test(v.trim()),
  url: (v: string) => {
    try {
      const u = new URL(v.trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  },
  date: (v: string) => {
    const t = v.trim();
    let y: number, m: number, d: number;
    let match = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    else {
      match = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) return false;
      [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    }
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  },
} as const;

export type FormatType = keyof typeof VALIDATORS;

function inferType(values: string[]): string {
  const present = values.filter((v) => !isMissing(v)).slice(0, 200);
  if (present.length === 0) return "empty";
  const share = (fn: (v: string) => boolean) => present.filter(fn).length / present.length;
  if (share(VALIDATORS.email) > 0.6) return "email";
  if (share(VALIDATORS.phone_au) > 0.6) return "phone";
  if (share(VALIDATORS.date) > 0.6) return "date";
  if (share((v) => !Number.isNaN(Number(v.replace(/[$,]/g, "")))) > 0.8) return "number";
  if (share(VALIDATORS.url) > 0.6) return "url";
  return "text";
}

// ---------- tools ----------

export function profileDataset(data: Dataset): { row_count: number; columns: ColumnProfile[] } {
  const columns = data.columns.map((name) => {
    const values = data.rows.map((r) => r[name] ?? "");
    const present = values.filter((v) => !isMissing(v));
    const unique = new Set(present.map((v) => v.trim()));
    const missing = values.length - present.length;
    return {
      name,
      inferred_type: inferType(values),
      missing_count: missing,
      missing_pct: values.length ? Math.round((missing / values.length) * 1000) / 10 : 0,
      unique_count: unique.size,
      sample_values: [...unique].slice(0, 5).map((v) => display(name, v)),
    };
  });
  return { row_count: data.rows.length, columns };
}

const normalise = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

export function findDuplicates(data: Dataset, opts: { columns?: string[]; normalise?: boolean } = {}) {
  const cols = opts.columns && opts.columns.length ? opts.columns : data.columns;
  cols.forEach((c) => requireColumn(data, c));
  const groups = new Map<string, number[]>();
  data.rows.forEach((row, i) => {
    const key = cols.map((c) => (opts.normalise ? normalise(row[c] ?? "") : (row[c] ?? ""))).join("␟");
    if (cols.every((c) => isMissing(row[c]))) return; // ignore fully empty keys
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  return {
    columns_checked: cols,
    normalised: Boolean(opts.normalise),
    duplicate_groups: dupGroups.length,
    extra_rows: dupGroups.reduce((sum, g) => sum + g.length - 1, 0),
    example_groups: dupGroups.slice(0, 5).map((g) => g.map(rowNumber)),
  };
}

export function validateFormat(data: Dataset, column: string, format: FormatType) {
  requireColumn(data, column);
  const validator = VALIDATORS[format];
  if (!validator) throw new Error(`Unknown format "${format}"`);
  const invalid: { row: number; value: string }[] = [];
  let checked = 0;
  data.rows.forEach((r, i) => {
    const v = r[column];
    if (isMissing(v)) return;
    checked++;
    if (!validator(v)) invalid.push({ row: rowNumber(i), value: display(column, v) });
  });
  return {
    column,
    format,
    checked_non_empty: checked,
    invalid_count: invalid.length,
    examples: invalid.slice(0, 8),
  };
}

// Common Australian state variants, so "Victoria", "vic" and "VIC" are grouped.
const STATE_ALIASES: Record<string, string> = {
  victoria: "vic",
  "new south wales": "nsw",
  queensland: "qld",
  "south australia": "sa",
  "western australia": "wa",
  tasmania: "tas",
  "northern territory": "nt",
  "australian capital territory": "act",
};

export function findInconsistentValues(data: Dataset, column: string) {
  requireColumn(data, column);
  const canon = (v: string) => {
    const n = normalise(v).replace(/[^a-z0-9 ]/g, "");
    return STATE_ALIASES[n] ?? n.replace(/ /g, "");
  };
  const groups = new Map<string, Map<string, number>>();
  for (const r of data.rows) {
    const v = r[column];
    if (isMissing(v)) continue;
    const key = canon(v);
    const variants = groups.get(key) ?? new Map<string, number>();
    variants.set(v, (variants.get(v) ?? 0) + 1);
    groups.set(key, variants);
  }
  const inconsistent = [...groups.entries()]
    .filter(([, variants]) => variants.size > 1)
    .map(([canonical, variants]) => ({
      canonical,
      variants: [...variants.entries()].map(([value, count]) => ({ value: display(column, value), count })),
    }));
  return {
    column,
    distinct_values: [...groups.values()].reduce((s, v) => s + v.size, 0),
    inconsistent_groups: inconsistent.length,
    affected_rows: inconsistent.reduce(
      (sum, g) => sum + g.variants.reduce((s, v) => s + v.count, 0) - Math.max(...g.variants.map((v) => v.count)),
      0,
    ),
    groups: inconsistent.slice(0, 10),
  };
}

export function findOutliers(data: Dataset, column: string) {
  requireColumn(data, column);
  const nums: { row: number; value: number }[] = [];
  let nonNumeric = 0;
  data.rows.forEach((r, i) => {
    const v = r[column];
    if (isMissing(v)) return;
    const n = Number(String(v).replace(/[$,]/g, ""));
    if (Number.isNaN(n)) nonNumeric++;
    else nums.push({ row: rowNumber(i), value: n });
  });
  if (nums.length < 4) return { column, error: "Not enough numeric values to detect outliers", non_numeric: nonNumeric };
  const sorted = nums.map((n) => n.value).sort((a, b) => a - b);
  const q = (p: number) => {
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    return sorted[lo] + (sorted[Math.ceil(pos)] - sorted[lo]) * (pos - lo);
  };
  const q1 = q(0.25);
  const q3 = q(0.75);
  const iqr = q3 - q1;
  const [low, high] = [q1 - 1.5 * iqr, q3 + 1.5 * iqr];
  const outliers = nums.filter((n) => n.value < low || n.value > high);
  return {
    column,
    numeric_values: nums.length,
    non_numeric: nonNumeric,
    median: q(0.5),
    bounds: { low, high },
    outlier_count: outliers.length,
    examples: outliers.slice(0, 8),
  };
}

// ---------- tool definitions sent to Claude ----------

export const REPORT_TOOL_NAME = "submit_report";

export const TOOL_DEFINITIONS = [
  {
    name: "find_duplicates",
    description:
      "Find duplicate rows. Pass a subset of identifying columns (e.g. email, or first_name+last_name+phone) to find duplicate records, or omit columns to compare whole rows. Set normalise=true to ignore case and extra whitespace (finds near-duplicates).",
    input_schema: {
      type: "object" as const,
      properties: {
        columns: { type: "array", items: { type: "string" }, description: "Columns that form the comparison key" },
        normalise: { type: "boolean", description: "Ignore case and whitespace differences" },
      },
    },
  },
  {
    name: "validate_format",
    description:
      "Check that non-empty values in a column match a format. Formats: email, phone_au, postcode_au, date (YYYY-MM-DD or DD/MM/YYYY), url.",
    input_schema: {
      type: "object" as const,
      properties: {
        column: { type: "string" },
        format: { type: "string", enum: Object.keys(VALIDATORS) },
      },
      required: ["column", "format"],
    },
  },
  {
    name: "find_inconsistent_values",
    description:
      "Find categorical values written in different ways that mean the same thing (e.g. 'VIC', 'vic', 'Victoria'). Use on low-cardinality text columns like state, country, status or category.",
    input_schema: {
      type: "object" as const,
      properties: { column: { type: "string" } },
      required: ["column"],
    },
  },
  {
    name: "find_outliers",
    description: "Find numeric outliers in a column using the IQR method. Also reports non-numeric values in the column.",
    input_schema: {
      type: "object" as const,
      properties: { column: { type: "string" } },
      required: ["column"],
    },
  },
  {
    name: REPORT_TOOL_NAME,
    description:
      "Submit the final data quality report. Call this exactly once, after you have run the checks you need. Only report issues backed by tool results.",
    input_schema: {
      type: "object" as const,
      properties: {
        overall_score: { type: "integer", minimum: 0, maximum: 100, description: "100 = perfectly clean" },
        summary: { type: "string", description: "2-4 sentence plain-English summary for a consultant" },
        issues: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              issue_type: {
                type: "string",
                enum: ["missing_values", "duplicates", "invalid_format", "inconsistent_values", "outliers", "other"],
              },
              severity: { type: "string", enum: ["high", "medium", "low"] },
              affected_rows: { type: "integer" },
              example: { type: "string", description: "Short example, using the masked values from tool results" },
              suggested_fix: { type: "string" },
            },
            required: ["column", "issue_type", "severity", "affected_rows", "example", "suggested_fix"],
          },
        },
      },
      required: ["overall_score", "summary", "issues"],
    },
  },
];

/** Runs a tool by name. Errors are returned as data so the agent can recover. */
export function runTool(data: Dataset, name: string, input: Record<string, unknown>): unknown {
  switch (name) {
    case "find_duplicates":
      return findDuplicates(data, {
        columns: input.columns as string[] | undefined,
        normalise: input.normalise as boolean | undefined,
      });
    case "validate_format":
      return validateFormat(data, input.column as string, input.format as FormatType);
    case "find_inconsistent_values":
      return findInconsistentValues(data, input.column as string);
    case "find_outliers":
      return findOutliers(data, input.column as string);
    default:
      throw new Error(`Unknown tool "${name}"`);
  }
}


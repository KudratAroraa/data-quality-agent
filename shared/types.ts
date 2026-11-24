// Types shared by the Worker (backend) and the React app (frontend).

export type Row = Record<string, string>;

export interface Dataset {
  columns: string[];
  rows: Row[];
}

export type Severity = "high" | "medium" | "low";

export interface Issue {
  column: string;
  issue_type: string;
  severity: Severity;
  affected_rows: number;
  example: string;
  suggested_fix: string;
}

export interface Report {
  overall_score: number; // 0-100, higher is cleaner
  summary: string;
  issues: Issue[];
}

export interface TraceStep {
  tool: string;
  input: unknown;
  result_preview: string;
}

export interface ColumnProfile {
  name: string;
  inferred_type: string;
  missing_count: number;
  missing_pct: number;
  unique_count: number;
  sample_values: string[];
}

export interface AnalyzeResponse {
  report: Report;
  trace: TraceStep[];
  profile: ColumnProfile[];
  usage: { input_tokens: number; output_tokens: number; iterations: number; model: string };
  duration_ms: number;
  mock?: boolean; // true when no API key is set and rules stood in for Claude
}

/** Streamed from /api/analyze as NDJSON (one event per line) when the client asks for it. */
export type ProgressEvent =
  | { type: "status"; message: string }
  | { type: "step"; step: TraceStep }
  | { type: "result"; result: AnalyzeResponse }
  | { type: "error"; error: string };

export type OnProgress = (event: ProgressEvent) => void;

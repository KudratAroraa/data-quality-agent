import { useEffect, useRef } from "react";
import type { TraceStep } from "../shared/types";

const FORMAT_LABELS: Record<string, string> = {
  email: "email",
  phone_au: "phone number",
  postcode_au: "postcode",
  date: "date",
  url: "URL",
};

/** Turns a tool call into a sentence a non-engineer can follow. */
export function describeStep(step: TraceStep): string {
  const input = (typeof step.input === "object" && step.input ? step.input : {}) as Record<string, unknown>;
  const column = input.column ? String(input.column) : "";
  switch (step.tool) {
    case "find_duplicates": {
      const cols = Array.isArray(input.columns) && input.columns.length ? input.columns.join(", ") : "all columns";
      return `Looking for duplicate records on ${cols}${input.normalise ? ", ignoring case" : ""}`;
    }
    case "validate_format":
      return `Checking ${FORMAT_LABELS[String(input.format)] ?? String(input.format)} format in ${column}`;
    case "find_inconsistent_values":
      return `Checking for inconsistent values in ${column}`;
    case "find_outliers":
      return `Looking for outliers in ${column}`;
    default:
      return step.tool.replace(/_/g, " ");
  }
}

/** Reads the headline count out of a tool result, e.g. "8 found". */
function outcome(step: TraceStep): { text: string; tone: "found" | "clean" | "error" } {
  if (step.result_preview.includes('"error"')) return { text: "error, retrying", tone: "error" };
  const m = step.result_preview.match(/"(invalid_count|extra_rows|affected_rows|outlier_count)":(\d+)/);
  if (!m) return { text: "done", tone: "clean" };
  const n = Number(m[2]);
  return n > 0 ? { text: `${n} found`, tone: "found" } : { text: "all good", tone: "clean" };
}

interface Props {
  fileName: string;
  status: string;
  steps: TraceStep[];
  elapsed: number;
}

export function ProgressPanel({ fileName, status, steps, elapsed }: Props) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), []);

  return (
    <section className="card progress" aria-live="polite" ref={ref}>
      <div className="progress-head">
        <div>
          <h2>Analysing {fileName}</h2>
          <p className="muted">
            {steps.length} check{steps.length === 1 ? "" : "s"} run · {elapsed}s
          </p>
        </div>
        <span className="progress-pulse" aria-hidden="true" />
      </div>

      <ol className="progress-list">
        {steps.map((step, i) => {
          const o = outcome(step);
          return (
            <li key={i} className="progress-step done">
              <span className="progress-icon">✓</span>
              <span className="progress-text">{describeStep(step)}</span>
              <span className={`progress-outcome ${o.tone}`}>{o.text}</span>
            </li>
          );
        })}
        <li className="progress-step current">
          <span className="progress-icon">
            <span className="spinner" />
          </span>
          <span className="progress-text">{status || "Starting…"}</span>
        </li>
      </ol>
    </section>
  );
}

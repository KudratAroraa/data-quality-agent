import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Papa from "papaparse";
import type { AnalyzeResponse, Dataset, ProgressEvent, Row, TraceStep } from "../shared/types";
import mascot from "./assets/claude-mascot.png";
import { ExportCards, ExportModal, type ExportFormat } from "./Export";
import { ProgressPanel } from "./Progress";
import sampleCsv from "../samples/messy_customers.csv?raw";

const MAX_FILE_BYTES = 1_000_000;

type Status = "idle" | "ready" | "analysing" | "done" | "error";

export default function App() {
  const [fileName, setFileName] = useState("");
  const [data, setData] = useState<Dataset | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [progress, setProgress] = useState<{ status: string; steps: TraceStep[] }>({ status: "", steps: [] });
  const closeExport = useCallback(() => setExporting(null), []);

  useEffect(() => {
    if (status !== "analysing") return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 500);
    return () => clearInterval(t);
  }, [status]);

  function handleFile(file: File | undefined) {
    setResult(null);
    setError("");
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) return fail("Please upload a .csv file.");
    if (file.size > MAX_FILE_BYTES) return fail("File is larger than 1 MB.");
    parseCsv(file.name, file);
  }

  function loadSample() {
    setResult(null);
    setError("");
    parseCsv("messy_customers.csv", sampleCsv);
  }

  function parseCsv(name: string, source: File | string) {
    const done = (res: Papa.ParseResult<Row>) => {
      const columns = (res.meta.fields ?? []).filter(Boolean);
      if (!columns.length || !res.data.length) return fail("Couldn't find a header row and data in that file.");
      setFileName(name);
      setData({ columns, rows: res.data });
      setStatus("ready");
    };
    if (typeof source === "string") {
      done(Papa.parse<Row>(source, { header: true, skipEmptyLines: true }));
    } else {
      Papa.parse<Row>(source, {
        header: true,
        skipEmptyLines: true,
        complete: done,
        error: (err) => fail(`Couldn't read the CSV: ${err.message}`),
      });
    }
  }

  function reset() {
    setFileName("");
    setData(null);
    setResult(null);
    setError("");
    setStatus("idle");
  }

  function fail(message: string) {
    setError(message);
    setStatus("error");
  }

  async function analyse() {
    if (!data) return;
    setStatus("analysing");
    setError("");
    setResult(null);
    setProgress({ status: "Uploading…", steps: [] });
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify(data),
      });
      // Validation errors come back as plain JSON before any streaming starts.
      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }

      // The body is NDJSON: one progress event per line.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) finished = handleEvent(JSON.parse(line) as ProgressEvent) || finished;
        }
      }
      if (!finished) throw new Error("The connection closed before the report was ready. Please try again.");
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Applies one streamed event. Returns true once the final result arrives. */
  function handleEvent(event: ProgressEvent): boolean {
    if (event.type === "status") setProgress((p) => ({ ...p, status: event.message }));
    else if (event.type === "step") setProgress((p) => ({ ...p, steps: [...p.steps, event.step] }));
    else if (event.type === "result") {
      setResult(event.result);
      setStatus("done");
      return true;
    } else throw new Error(event.error);
    return false;
  }

  return (
    <>
      <img className="bg-mascot" src={mascot} alt="" aria-hidden="true" />

      <nav className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/">
            <img src={mascot} alt="" />
            <span>Data Quality Agent</span>
          </a>
          <span className="badge">
            <span className="dot" /> Powered by Claude
          </span>
        </div>
      </nav>

      <div className="page">
        <header className="hero">
          <p className="eyebrow">Pre-migration data checks</p>
          <h1>
            Find what's broken in your data <span className="accent">before</span> you migrate it.
          </h1>
          <p className="lede">
            Upload a CSV export. A Claude agent decides which checks to run, runs them, and reports what needs fixing,
            ranked by severity.
          </p>
        </header>

        <section className="card upload-card">
          <div className="card-head">
            <div>
              <h2>Upload your dataset</h2>
              <p className="muted">CSV with a header row · max 1 MB · up to 2,000 rows</p>
            </div>
            {data && (
              <button className="ghost" onClick={reset}>
                Clear
              </button>
            )}
          </div>

          {!data ? (
            <>
              <label
                className={`dropzone${dragging ? " dragging" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  handleFile(e.dataTransfer.files[0]);
                }}
              >
                <input type="file" accept=".csv" onChange={(e) => handleFile(e.target.files?.[0])} hidden />
                <span className="drop-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M12 16V4m0 0-4 4m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
                  </svg>
                </span>
                <strong>Drop a CSV here</strong>
                <span className="muted">
                  or <span className="link">browse your files</span>
                </span>
              </label>
              <div className="sample-row">
                <span className="muted">No file handy?</span>
                <button className="ghost" onClick={loadSample}>
                  Try sample data
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="file-chip">
                <span className="file-icon">CSV</span>
                <div>
                  <strong>{fileName}</strong>
                  <span className="muted">
                    {data.rows.length.toLocaleString()} rows × {data.columns.length} columns
                  </span>
                </div>
              </div>
              <Preview data={data} />
              <button className="primary" onClick={analyse} disabled={status === "analysing"}>
                {status === "analysing" ? (
                  <>
                    <span className="spinner" /> Analysing… {elapsed}s
                  </>
                ) : (
                  "Analyse data quality →"
                )}
              </button>
            </>
          )}
          {error && <p className="error">{error}</p>}
        </section>

        {status === "analysing" && (
          <ProgressPanel fileName={fileName} status={progress.status} steps={progress.steps} elapsed={elapsed} />
        )}

        {!result && status !== "analysing" && (
          <section className="steps">
            <Step n={1} title="Profile" text="The dataset is profiled in code: types, missing values, unique counts." />
            <Step n={2} title="Investigate" text="Claude picks which checks to run on which columns, and runs them." />
            <Step n={3} title="Report" text="You get a quality score, issues ranked by severity, and suggested fixes." />
            <p className="privacy">
              🔒 Claude never sees your full dataset. Only summaries and masked samples like{" "}
              <code>a***@example.com</code> leave the server.
            </p>
          </section>
        )}

        {result && (
          <>
            <ReportView result={result} fileName={fileName} rowCount={data?.rows.length ?? 0} />
            <ExportCards onPreview={setExporting} />
          </>
        )}
      </div>

      <footer className="site-footer">
        <img src={mascot} alt="" />
        <span>
          <strong>Data Quality Agent</strong> · Prototype by Kudrat Arora
        </span>
        <span className="muted">© {new Date().getFullYear()}</span>
      </footer>

      {result && exporting && (
        <ExportModal
          format={exporting}
          result={result}
          fileName={fileName}
          onClose={closeExport}
          pdfPage={
            <article className="print-doc">
              <ReportView result={result} fileName={fileName} rowCount={data?.rows.length ?? 0} />
            </article>
          }
        />
      )}
    </>
  );
}

// USD per million tokens, for the cost estimate shown after each run.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

function RunDetails({ usage, durationMs, mock }: { usage: AnalyzeResponse["usage"]; durationMs: number; mock: boolean }) {
  const price = PRICES[usage.model];
  const cost = price ? (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6 : null;
  const items = [
    { label: "Model", value: mock ? "Demo mode (rules)" : usage.model, wide: true },
    { label: "Turns", value: String(usage.iterations) },
    { label: "Tokens in", value: usage.input_tokens.toLocaleString() },
    { label: "Tokens out", value: usage.output_tokens.toLocaleString() },
    { label: "Cost", value: mock ? "$0.00" : cost === null ? "n/a" : `$${cost.toFixed(4)}` },
    { label: "Time", value: `${(durationMs / 1000).toFixed(1)}s` },
  ];

  return (
    <section className="run-details" aria-label="Run details">
      <h3>Run details</h3>
      <dl>
        {items.map((item) => (
          <div key={item.label} className={item.wide ? "wide" : undefined}>
            <dt>{item.label}</dt>
            <dd>
              {item.label === "Model" && <span className={`model-dot${mock ? " mock" : ""}`} />}
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const RING_RADIUS = 66;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ScoreRing({ score }: { score: number }) {
  const [shown, setShown] = useState(0);

  // Count the number up alongside the ring animation.
  useEffect(() => {
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      setShown(Math.round(score * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [score]);

  return (
    <div className="ring" role="img" aria-label={`Quality score ${score} out of 100`}>
      <svg viewBox="0 0 160 160">
        <circle className="ring-track" cx="80" cy="80" r={RING_RADIUS} />
        <circle
          className="ring-fill"
          cx="80"
          cy="80"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          style={
            {
              "--circ": RING_CIRCUMFERENCE,
              strokeDashoffset: RING_CIRCUMFERENCE * (1 - score / 100),
            } as CSSProperties
          }
        />
      </svg>
      <div className="ring-label">
        <strong>{shown}</strong>
        <span>out of 100</span>
      </div>
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="step">
      <span className="step-n">{n}</span>
      <h3>{title}</h3>
      <p className="muted">{text}</p>
    </div>
  );
}

function Preview({ data }: { data: Dataset }) {
  return (
    <div className="preview">
      <p className="muted">Preview · first 5 rows</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.slice(0, 5).map((r, i) => (
              <tr key={i}>
                {data.columns.map((c) => (
                  <td key={c}>{r[c]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportView({ result, fileName, rowCount }: { result: AnalyzeResponse; fileName: string; rowCount: number }) {
  const { report, trace, profile, usage, duration_ms } = result;
  const checksRun = trace.filter((t) => t.tool !== "submit_report").length;
  const verdict =
    report.overall_score >= 80
      ? { tone: "good", label: "Ready to migrate" }
      : report.overall_score >= 50
        ? { tone: "ok", label: "Needs cleanup first" }
        : { tone: "bad", label: "Not ready to migrate" };

  return (
    <>
      <header className="print-header">
        <img src={mascot} alt="" />
        <div>
          <h1>Data Quality Report</h1>
          <p>
            {fileName} · {rowCount.toLocaleString()} rows × {profile.length} columns ·{" "}
            {new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
      </header>
      {result.mock && (
        <p className="mock-banner">
          <strong>Mock mode.</strong> No API key is set, so simple rules chose the checks instead of Claude. The
          numbers are real: the same tools ran on your data.
        </p>
      )}
      <section className={`card summary ${verdict.tone}`}>
        <ScoreRing score={report.overall_score} />
        <div className="summary-body">
          <p className="eyebrow">Quality report</p>
          <h2>{verdict.label}</h2>
          <p className="summary-text">{report.summary}</p>
          <div className="stats">
            {(["high", "medium", "low"] as const).map((sev) => {
              const issues = report.issues.filter((i) => i.severity === sev);
              const rows = issues.reduce((sum, i) => sum + i.affected_rows, 0);
              return (
                <div className={`stat ${sev}`} key={sev}>
                  <span className="stat-label">
                    <span className="stat-dot" /> {sev}
                  </span>
                  <strong>{issues.length}</strong>
                  <span className="muted">{rows.toLocaleString()} rows</span>
                </div>
              );
            })}
            <div className="stat">
              <span className="stat-label">Checks run</span>
              <strong>{checksRun}</strong>
              <span className="muted">
                on {rowCount.toLocaleString()} × {profile.length}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Issues</h3>
        <div className="table-wrap">
          <table className="issues-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Column</th>
                <th>Issue</th>
                <th>Rows</th>
                <th>Example</th>
                <th>Suggested fix</th>
              </tr>
            </thead>
            <tbody>
              {report.issues.map((i, idx) => (
                <tr key={idx}>
                  <td>
                    <span className={`pill ${i.severity}`}>{i.severity}</span>
                  </td>
                  <td>
                    <code>{i.column}</code>
                  </td>
                  <td>{i.issue_type.replace(/_/g, " ")}</td>
                  <td className="num">{i.affected_rows}</td>
                  <td>{i.example}</td>
                  <td>{i.suggested_fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid">
        <section className="card">
          <h3>Missing values by column</h3>
          {profile.map((c) => (
            <div className="bar-row" key={c.name}>
              <span className="bar-label">{c.name}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${Math.min(c.missing_pct, 100)}%` }} />
              </span>
              <span className="num">{c.missing_pct}%</span>
            </div>
          ))}
        </section>

        <section className="card">
          <h3>{result.mock ? "Check trace" : "Agent trace"}</h3>
          <p className="muted">
            {result.mock ? "The checks the rules chose to run, in order." : "The checks Claude chose to run, in order."}
          </p>
          <ol className="trace">
            {trace.map((t, i) => (
              <li key={i}>
                <code>{t.tool}</code>{" "}
                <span className="muted">{typeof t.input === "string" ? t.input : JSON.stringify(t.input)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <RunDetails usage={usage} durationMs={duration_ms} mock={Boolean(result.mock)} />
    </>
  );
}

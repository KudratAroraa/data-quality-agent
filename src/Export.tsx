import { useEffect, type ReactNode } from "react";
import Papa from "papaparse";
import type { AnalyzeResponse } from "../shared/types";

export type ExportFormat = "pdf" | "csv" | "json";

const FORMATS: { id: ExportFormat; title: string; text: string; icon: string }[] = [
  { id: "pdf", title: "PDF report", text: "Formatted A4 report to share with stakeholders or attach to an email.", icon: "PDF" },
  { id: "csv", title: "Issues CSV", text: "One row per issue. Sort, filter and assign fixes in Excel or Sheets.", icon: "CSV" },
  { id: "json", title: "Raw JSON", text: "The full result, including trace and profile, for tools and evals.", icon: "{ }" },
];

/** The three export cards shown under the report. */
export function ExportCards({ onPreview }: { onPreview: (f: ExportFormat) => void }) {
  return (
    <section className="export">
      <h3>Export report</h3>
      <div className="export-grid">
        {FORMATS.map((f) => (
          <button key={f.id} className={`export-card ${f.id}`} onClick={() => onPreview(f.id)}>
            <span className="export-icon">{f.icon}</span>
            <strong>{f.title}</strong>
            <span className="muted">{f.text}</span>
            <span className="export-cta">Preview &amp; download →</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function issueRows(result: AnalyzeResponse) {
  return result.report.issues.map((i) => ({
    severity: i.severity,
    column: i.column,
    issue: i.issue_type.replace(/_/g, " "),
    affected_rows: i.affected_rows,
    example: i.example,
    suggested_fix: i.suggested_fix,
  }));
}

function saveFile(name: string, content: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

interface ModalProps {
  format: ExportFormat;
  result: AnalyzeResponse;
  fileName: string;
  /** The report rendered as an A4 page; printed as-is for the PDF. */
  pdfPage: ReactNode;
  onClose: () => void;
}

export function ExportModal({ format, result, fileName, pdfPage, onClose }: ModalProps) {
  const reportName = fileName.replace(/\.csv$/i, "") + "-quality-report";
  const rows = issueRows(result);
  const json = JSON.stringify({ file: fileName, ...result }, null, 2);
  const meta = FORMATS.find((f) => f.id === format)!;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("modal-open");
    };
  }, [onClose]);

  function download() {
    if (format === "pdf") {
      // Browsers use the page title as the default PDF file name.
      const title = document.title;
      document.title = reportName;
      window.addEventListener("afterprint", () => (document.title = title), { once: true });
      window.print();
    } else if (format === "csv") {
      // The BOM makes Excel open the file as UTF-8.
      saveFile(`${reportName}-issues.csv`, "﻿" + Papa.unparse(rows), "text/csv");
    } else {
      saveFile(`${reportName}.json`, json, "application/json");
    }
  }

  const fileLabel = {
    pdf: `${reportName}.pdf`,
    csv: `${reportName}-issues.csv`,
    json: `${reportName}.json`,
  }[format];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${meta.title} preview`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{meta.title}</h2>
            <p className="muted">{fileLabel}</p>
          </div>
          <button className="ghost icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className={`modal-body ${format}`}>
          {format === "pdf" && <div className="paper-stack">{pdfPage}</div>}
          {format === "csv" && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {Object.keys(rows[0] ?? { severity: "" }).map((k) => (
                      <th key={k}>{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {Object.values(r).map((v, j) => (
                        <td key={j}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {format === "json" && <pre className="json-code">{json}</pre>}
        </div>

        <footer className="modal-foot">
          <span className="muted">
            {format === "pdf" && "In the print dialog, choose “Save as PDF”."}
            {format === "csv" && `${rows.length} issues × ${Object.keys(rows[0] ?? {}).length} columns`}
            {format === "json" && `${(new Blob([json]).size / 1024).toFixed(1)} KB`}
          </span>
          <div className="modal-actions">
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="export-pdf" onClick={download}>
              {format === "pdf" ? "Save as PDF" : `Download ${format.toUpperCase()}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

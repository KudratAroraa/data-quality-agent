// Evaluation harness: runs the agent on every sample CSV that has an answer key
// and scores how many planted issues it found.
//
// Usage (with `npm run dev` running in another terminal):
//   npm run eval                                  -> uses http://localhost:5173
//   npm run eval -- https://your-app.workers.dev  -> runs against the deployed app
//   npm run eval -- http://localhost:5173 3       -> 3 runs per file (agents vary run to run)
//   npm run eval -- http://localhost:5173 3 v2    -> label the results (e.g. prompt version)
//   npm run eval -- https://…workers.dev 3 live 13000 -> wait 13 s between runs (stays under the rate limit)
//
// Results are saved in evals/results/ as JSON and Markdown. The Markdown table is
// ready to paste into your P4b / P5 evidence.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.argv[2] ?? "http://localhost:5173";
const RUNS = Number(process.argv[3] ?? 1);
const LABEL = process.argv[4] ?? "";
const DELAY_MS = Number(process.argv[5] ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requestsSent = 0;

// Claude Haiku 5.5 prices (USD per token), for the cost column.
const PRICE = { input: 0.1 / 1e6, output: 0.5 / 1e6 };
const samplesDir = join(ROOT, "samples");

const files = readdirSync(samplesDir).filter((f) => f.endsWith(".answer.json"));

function matches(expected, issue) {
  if (issue.issue_type !== expected.issue_type) return false;
  if (expected.column === "*") return true;
  return issue.column.toLowerCase().includes(expected.column.toLowerCase());
}

const rows = [];
const raw = [];

for (const answerFile of files) {
  const name = answerFile.replace(".answer.json", "");
  const answer = JSON.parse(readFileSync(join(samplesDir, answerFile), "utf8"));
  const csv = readFileSync(join(samplesDir, `${name}.csv`), "utf8");
  const parsed = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const body = JSON.stringify({ columns: parsed.meta.fields, rows: parsed.data });

  for (let run = 1; run <= RUNS; run++) {
    if (DELAY_MS && requestsSent++ > 0) await sleep(DELAY_MS);
    process.stdout.write(`${name} run ${run}/${RUNS} ... `);
    const res = await fetch(`${BASE_URL}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const result = await res.json();
    if (!res.ok) {
      console.log(`FAILED: ${result.error}`);
      continue;
    }
    const issues = result.report.issues;
    const used = new Set();
    let found = 0;
    let exactCount = 0;
    const missed = [];

    for (const exp of answer.expected_issues) {
      const hits = issues.map((iss, idx) => ({ iss, idx })).filter(({ iss }) => matches(exp, iss));
      if (!hits.length) {
        missed.push(`${exp.column}:${exp.issue_type}`);
        continue;
      }
      found++;
      hits.forEach(({ idx }) => used.add(idx));
      if (hits.some(({ iss }) => iss.affected_rows === exp.count)) exactCount++;
    }

    const unexpected = issues.filter((iss, idx) => !used.has(idx));
    const falsePositives = answer.expected_issues.length === 0 ? issues.filter((i) => i.severity !== "low") : [];
    const expectedTotal = answer.expected_issues.length;
    const row = {
      file: name,
      run,
      model: result.usage.model,
      recall: expectedTotal ? found / expectedTotal : 1,
      found: `${found}/${expectedTotal}`,
      exact_counts: `${exactCount}/${expectedTotal}`,
      unexpected_issues: unexpected.length,
      false_positives: falsePositives.length,
      score: result.report.overall_score,
      turns: result.usage.iterations,
      tokens: result.usage.input_tokens + result.usage.output_tokens,
      cost_usd: +(result.usage.input_tokens * PRICE.input + result.usage.output_tokens * PRICE.output).toFixed(4),
      seconds: +(result.duration_ms / 1000).toFixed(1),
      missed: missed.join(", ") || "-",
    };
    rows.push(row);
    raw.push({ ...row, unexpected, report: result.report, trace: result.trace });
    console.log(`recall ${(row.recall * 100).toFixed(0)}%, ${row.tokens} tokens, ${row.seconds}s`);
  }
}

if (!rows.length) {
  console.error("No successful runs. Is the dev server running and is ANTHROPIC_API_KEY set?");
  process.exit(1);
}

const headers = ["file", "run", "model", "found", "exact_counts", "unexpected_issues", "false_positives", "score", "turns", "tokens", "cost_usd", "seconds", "missed"];
const md = [
  `# Eval results${LABEL ? ` (${LABEL})` : ""}, ${new Date().toISOString()}`,
  "",
  `Target: ${BASE_URL}`,
  "",
  `Total cost: $${rows.reduce((s, r) => s + r.cost_usd, 0).toFixed(4)}`,
  "",
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map((r) => `| ${headers.map((h) => r[h]).join(" | ")} |`),
  "",
].join("\n");

const outDir = join(ROOT, "evals", "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-") + (LABEL ? `-${LABEL}` : "");
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(raw, null, 2));
writeFileSync(join(outDir, `${stamp}.md`), md);
console.log("\n" + md);
console.log(`Saved to evals/results/${stamp}.md`);

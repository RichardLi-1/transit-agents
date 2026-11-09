// Scores a run of the eval runner (agents/evals.py) and prints what docs/evals.md
// asks to report, with a count beside every rate.
//
// Usage: node evals/score-run.ts [run.jsonl]    (default: the newest run in evals/runs)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { rulesOnlyDecision, scoreCase, summarize, type Answer, type EvalCase, type Score, type Summary } from "./score.ts";

export const RUNS = join(import.meta.dirname, "runs");

export type Usage = { inputTokens: number; outputTokens: number; calls?: number; costUsd?: number };

// One line of a run file: a case's answer, or the error that stopped it, with what it
// cost. `usage.agent` is the agents' own use; `usage.structured` is the extra call
// that turned the answer into fields.
export type RunLine = {
  id: string;
  answer?: Answer;
  error?: string;
  seconds?: number;
  // reader is the model that read the answer into fields, kept apart from the agent's.
  models?: { lead?: string; specialist?: string; reader?: string };
  // false for a run without skills, to set beside one with them.
  skills?: boolean;
  usage?: { agent?: Usage; structured?: Usage };
};

export type Row = {
  id: string;
  capability: string;
  // null for a case only a rubric can score.
  passed: boolean | null;
  failures: string[];
  usage?: Usage;
  seconds?: number;
};

export type RunReport = {
  // Cases scored by script, by capability.
  summary: Summary;
  // Cases with a known decision. A hand-over counts as correct only on a judgement case.
  decisions: { total: number; matched: number; handedOver: number; control: number };
  judgement: { total: number; handedOver: number };
  // Pages over cases that expect citations: found of expected, and relevant of given.
  citations: { cases: number; expected: number; found: number; given: number; relevant: number };
  // The agents' use, over cases that report it.
  tokens: { cases: number; inputTokens: number; outputTokens: number; calls: number; costUsd: number; seconds: number };
  structured: { inputTokens: number; outputTokens: number; costUsd: number };
  rows: Row[];
  rubric: string[];
  unknown: string[];
  models: string[];
  readers: string[];
  withoutSkills: boolean;
};

export function readCases(path = join(import.meta.dirname, "cases.jsonl")): EvalCase[] {
  return readLines(path) as EvalCase[];
}

export function readRun(path: string): RunLine[] {
  const lines = readLines(path) as RunLine[];
  lines.forEach((line, i) => {
    if (typeof line?.id !== "string") throw new Error(`${path}: line ${i + 1} has no case id`);
  });
  return lines;
}

function readLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, i) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line)];
      } catch {
        throw new Error(`${path}: line ${i + 1} isn't JSON`);
      }
    });
}

// The newest run in a folder, by its name: the UTC time it started, such as
// 20261107T224512Z.jsonl. Undefined if there's none.
export function latestRun(folder = RUNS): string | undefined {
  if (!existsSync(folder)) return undefined;
  const runs = readdirSync(folder)
    .filter((name) => /^\d{8}T\d{6}Z.*\.jsonl$/.test(name))
    .sort();
  const last = runs.at(-1);
  return last ? join(folder, last) : undefined;
}

// A case that ended in an error answered nothing, so it fails, and finds no citations.
function failed(c: EvalCase, error: string): Score {
  const cites = c.expect.citations?.length ? 0 : null;
  return { id: c.id, passed: false, failures: [`error: ${error}`], citationRecall: cites, citationPrecision: cites, handedOver: false };
}

export function scoreRun(cases: EvalCase[], lines: RunLine[]): RunReport {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const scores: Score[] = [];
  const report: Omit<RunReport, "summary"> = {
    decisions: { total: 0, matched: 0, handedOver: 0, control: 0 },
    judgement: { total: 0, handedOver: 0 },
    citations: { cases: 0, expected: 0, found: 0, given: 0, relevant: 0 },
    tokens: { cases: 0, inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0, seconds: 0 },
    structured: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    rows: [],
    rubric: [],
    unknown: [],
    models: [],
    readers: [],
    withoutSkills: false,
  };

  for (const line of lines) {
    const c = byId.get(line.id);
    if (!c) {
      report.unknown.push(line.id);
      continue;
    }
    const model = line.models?.lead;
    if (model && !report.models.includes(model)) report.models.push(model);
    const reader = line.models?.reader;
    if (reader && !report.readers.includes(reader)) report.readers.push(reader);
    if (line.skills === false) report.withoutSkills = true;
    const agent = line.usage?.agent;
    if (agent) {
      const t = report.tokens;
      t.cases += 1;
      t.inputTokens += agent.inputTokens;
      t.outputTokens += agent.outputTokens;
      t.calls += agent.calls ?? 0;
      t.costUsd += agent.costUsd ?? 0;
      t.seconds += line.seconds ?? 0;
    }
    report.structured.inputTokens += line.usage?.structured?.inputTokens ?? 0;
    report.structured.outputTokens += line.usage?.structured?.outputTokens ?? 0;
    report.structured.costUsd += line.usage?.structured?.costUsd ?? 0;
    const row = { id: c.id, capability: c.capability, usage: agent, seconds: line.seconds };

    if (c.scorer === "rubric") {
      report.rubric.push(c.id);
      report.rows.push({ ...row, passed: null, failures: line.error ? [`error: ${line.error}`] : [] });
      continue;
    }

    const score = line.answer ? scoreCase(c, line.answer) : failed(c, line.error ?? "no answer");
    scores.push(score);
    report.rows.push({ ...row, passed: score.passed, failures: score.failures });

    const e = c.expect;
    if (e.decision) {
      const d = report.decisions;
      d.total += 1;
      if (line.answer?.decision === e.decision) d.matched += 1;
      else if (score.handedOver) d.handedOver += 1;
      if (rulesOnlyDecision(e.checks ?? {}) === e.decision) d.control += 1;
    }
    if (e.judgement) {
      report.judgement.total += 1;
      if (score.handedOver) report.judgement.handedOver += 1;
    }
    if (e.citations?.length) {
      // scoreCase gives rates; turn them back into the counts behind them.
      const given = line.answer?.citations?.length ?? 0;
      const k = report.citations;
      k.cases += 1;
      k.expected += e.citations.length;
      k.found += Math.round((score.citationRecall ?? 0) * e.citations.length);
      k.given += given;
      k.relevant += Math.round((score.citationPrecision ?? 0) * given);
    }
  }
  return { summary: summarize(cases, scores), ...report };
}

const number = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
// Cents, or a fraction of a cent to four places, so a small cost doesn't read as nothing.
const dollars = (n: number) => `$${n > 0 && n < 0.005 ? n.toFixed(4) : n.toFixed(2)}`;
const rate = (n: number, of: number, what = "") =>
  `${n} of ${of}${what ? ` ${what}` : ""}${of ? ` (${Math.round((100 * n) / of)}%)` : ""}`;

export function formatReport(report: RunReport, name = "run"): string {
  const { summary, decisions: d, judgement: j, citations: k, tokens: t, structured: s } = report;
  const scored = report.rows.length;
  const model = report.models.length ? `, lead model ${report.models.join(", ")}` : "";
  const reader = report.readers.length ? `, read by ${report.readers.join(", ")}` : "";
  const skills = report.withoutSkills ? ", without skills" : "";
  const out = [`${name}: ${plural(scored, "case")}${model}${reader}${skills}`, ""];

  out.push(`Passed: ${rate(summary.passed, summary.total)}`);
  const width = Math.max(0, ...Object.keys(summary.byCapability).map((name) => name.length));
  for (const [capability, row] of Object.entries(summary.byCapability).sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`  ${capability.padEnd(width)}  ${rate(row.passed, row.total)}`);
  }
  if (Object.keys(summary.bySkill).length) out.push("By skill:");
  const skillWidth = Math.max(0, ...Object.keys(summary.bySkill).map((name) => name.length));
  for (const [skill, row] of Object.entries(summary.bySkill).sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`  ${skill.padEnd(skillWidth)}  ${rate(row.passed, row.total)}`);
  }

  out.push(
    d.total
      ? `Decisions: ${rate(d.matched + d.handedOver, d.total, "correct")}: ${d.matched} matched, ${d.handedOver} handed over. Rules-only control: ${rate(d.control, d.total)}`
      : "Decisions: none in this run",
  );
  out.push(j.total ? `Hand-overs on judgement cases: ${rate(j.handedOver, j.total)}` : "Hand-overs on judgement cases: none in this run");
  out.push(
    k.cases
      ? `Citations, over ${plural(k.cases, "case")}: recall ${rate(k.found, k.expected, "expected pages")}, precision ${rate(k.relevant, k.given, "given")}`
      : "Citations: no case in this run expects any",
  );
  if (t.cases) {
    const each = (n: number, digits = 0) => (n / t.cases).toLocaleString("en-US", { maximumFractionDigits: digits });
    out.push(
      `Tokens per case, over ${plural(t.cases, "case")}: ${each(t.inputTokens)} in, ${each(t.outputTokens)} out, ` +
        `${each(t.calls, 1)} model calls, ${each(t.seconds, 1)} s. In all: ${number(t.inputTokens)} in, ${number(t.outputTokens)} out, ${dollars(t.costUsd)}`,
    );
  }
  if (s.inputTokens || s.outputTokens) {
    out.push(`Structured answers, in all: ${number(s.inputTokens)} in, ${number(s.outputTokens)} out, ${dollars(s.costUsd)}`);
  }

  if (report.rows.length) out.push("");
  const idWidth = Math.max(...report.rows.map((row) => row.id.length));
  for (const row of report.rows) {
    const status = row.passed === null ? "rubric" : row.passed ? "pass" : "fail";
    const used = row.usage
      ? `  ${number(row.usage.inputTokens)} in, ${number(row.usage.outputTokens)} out, ${plural(row.usage.calls ?? 0, "call")}`
      : "";
    const time = row.seconds !== undefined ? `, ${number(row.seconds)} s` : "";
    const why = row.failures.length ? `  ${row.failures.join("; ")}` : "";
    out.push(`${row.id.padEnd(idWidth)}  ${status.padEnd(6)}${used}${time}${why}`);
  }
  if (report.rubric.length) out.push("", `Scored by rubric, not here: ${report.rubric.join(", ")}`);
  if (report.unknown.length) out.push("", `Not in cases.jsonl, so not scored: ${report.unknown.join(", ")}`);
  return out.join("\n");
}

if (import.meta.main) {
  const file = process.argv[2] ?? latestRun();
  if (!file) {
    console.error("No run to score. Run some cases first: npm run agent:eval");
    process.exit(1);
  }
  try {
    console.log(formatReport(scoreRun(readCases(), readRun(file)), basename(file)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

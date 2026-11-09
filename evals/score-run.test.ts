import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { formatReport, latestRun, readCases, readRun, scoreRun, type RunLine } from "./score-run.ts";

const cases = readCases();
const usage = (inputTokens: number, outputTokens: number, calls: number) => ({ agent: { inputTokens, outputTokens, calls, costUsd: 0 } });
const all = { customer_time: "pass", productivity: "pass", ridership_per_dollar: "pass" } as const;

// Fixture answers to real cases: passes, misses, a hand-over, an error, a rubric case
// and a case that isn't in the set.
const run: RunLine[] = [
  {
    id: "find-001",
    models: { lead: "test-model" },
    seconds: 10,
    usage: usage(1000, 100, 4),
    answer: {
      text: "20 boardings per service hour (ttc-anp-2026 p. 115).",
      behaviour: "answer",
      value: 20,
      citations: [
        { source: "ttc-anp-2026", page: 115 },
        { source: "ttc-anp-2026", page: 114 },
      ],
    },
  },
  {
    id: "find-002",
    seconds: 20,
    usage: usage(2000, 200, 6),
    answer: { text: "30 (ttc-anp-2026 p. 115).", behaviour: "answer", value: 30, citations: [{ source: "ttc-anp-2026", page: 115 }] },
  },
  { id: "find-004", seconds: 1, usage: usage(500, 0, 1), error: "Gemini said 500" },
  {
    id: "check-001",
    seconds: 30,
    usage: usage(3000, 300, 8),
    answer: { text: "All three tests pass. Adopt.", behaviour: "answer", decision: "adopt", checks: all, citations: [] },
  },
  {
    id: "check-003",
    seconds: 30,
    usage: usage(3000, 300, 8),
    answer: {
      text: "It fails customer time but saves service hours. A planner should weigh that.",
      behaviour: "flag",
      checks: { customer_time: "fail", productivity: "pass", ridership_per_dollar: "pass" },
    },
  },
  {
    id: "check-005",
    seconds: 30,
    usage: usage(3000, 300, 8),
    answer: { text: "The feedback was mixed, but adopt it.", behaviour: "flag", decision: "adopt", checks: all },
  },
  { id: "draft-001", seconds: 40, usage: usage(4000, 400, 10), answer: { text: "A draft.", behaviour: "answer" } },
  { id: "nope-001", answer: { text: "", behaviour: "answer" } },
];

describe("scoreRun", () => {
  const report = scoreRun(cases, run);

  it("gives the pass rate by capability, leaving out rubric cases and unknown ids", () => {
    assert.deepEqual(report.summary, {
      total: 6,
      passed: 3,
      byCapability: { find: { total: 3, passed: 1 }, check: { total: 3, passed: 2 } },
      bySkill: { "ttc-standards": { total: 6, passed: 3 } },
    });
    assert.deepEqual(report.rubric, ["draft-001"]);
    assert.deepEqual(report.unknown, ["nope-001"]);
  });

  it("fails a case that ended in an error", () => {
    const row = report.rows.find((r) => r.id === "find-004");
    assert.deepEqual(row?.failures, ["error: Gemini said 500"]);
    assert.equal(row?.passed, false);
  });

  it("counts decisions matched and handed over against the rules-only control", () => {
    // check-001 matched, check-003 was handed over, check-005 decided wrongly. The
    // control matches only check-001: the other two needed judgement.
    assert.deepEqual(report.decisions, { total: 3, matched: 1, handedOver: 1, control: 1 });
    assert.deepEqual(report.judgement, { total: 2, handedOver: 1 });
  });

  it("counts cited pages: found of expected, and relevant of given", () => {
    assert.deepEqual(report.citations, { cases: 3, expected: 3, found: 2, given: 3, relevant: 2 });
  });

  it("adds up the agents' tokens, time and calls over the cases that report them", () => {
    assert.deepEqual(report.tokens, { cases: 7, inputTokens: 16500, outputTokens: 1600, calls: 45, costUsd: 0, seconds: 161 });
    assert.deepEqual(report.models, ["test-model"]);
  });

  it("names the model that read the answers, apart from the agent's", () => {
    const answer = { text: "20 (ttc-anp-2026 p. 115).", behaviour: "answer", value: 20 } as const;
    const read = scoreRun(cases, [{ id: "find-001", answer, models: { lead: "gemini-a", reader: "gemini-b" } }]);
    assert.deepEqual(read.readers, ["gemini-b"]);
    assert.equal(formatReport(read, "r.jsonl").split("\n")[0], "r.jsonl: 1 case, lead model gemini-a, read by gemini-b");
  });

  it("says when a run had no skills", () => {
    const answer = { text: "20 (ttc-anp-2026 p. 115).", behaviour: "answer", value: 20 } as const;
    const bare = scoreRun(cases, [{ id: "find-001", answer, skills: false }]);
    assert.equal(formatReport(bare, "r.jsonl").split("\n")[0], "r.jsonl: 1 case, without skills");
  });

  it("adds up what the agents and the structured answers cost, apart", () => {
    const answer = { text: "20 (ttc-anp-2026 p. 115).", behaviour: "answer", value: 20 } as const;
    const agent = { inputTokens: 56451, outputTokens: 3221, calls: 10, costUsd: 0.054 };
    const priced = scoreRun(cases, [
      { id: "find-001", answer, usage: { agent, structured: { inputTokens: 475, outputTokens: 380, costUsd: 0.0018 } } },
      { id: "find-002", answer, usage: { structured: { inputTokens: 25, outputTokens: 20 } } },
    ]);
    assert.deepEqual(priced.structured, { inputTokens: 500, outputTokens: 400, costUsd: 0.0018 });
    const lines = formatReport(priced).split("\n");
    assert.ok(lines.some((line) => line.endsWith("In all: 56,451 in, 3,221 out, $0.05")), lines.join("\n"));
    assert.ok(lines.includes("Structured answers, in all: 500 in, 400 out, $0.0018"), lines.join("\n"));
  });
});

describe("formatReport", () => {
  const text = formatReport(scoreRun(cases, run), "test.jsonl");

  it("puts a count beside every rate", () => {
    for (const line of [
      "test.jsonl: 7 cases, lead model test-model",
      "Passed: 3 of 6 (50%)",
      "  check  2 of 3 (67%)",
      "  find   1 of 3 (33%)",
      "By skill:",
      "  ttc-standards  3 of 6 (50%)",
      "Decisions: 2 of 3 correct (67%): 1 matched, 1 handed over. Rules-only control: 1 of 3 (33%)",
      "Hand-overs on judgement cases: 1 of 2 (50%)",
      "Citations, over 3 cases: recall 2 of 3 expected pages (67%), precision 2 of 3 given (67%)",
      "Tokens per case, over 7 cases: 2,357 in, 229 out, 6.4 model calls, 23 s. In all: 16,500 in, 1,600 out, $0.00",
    ]) {
      assert.ok(text.split("\n").includes(line), `missing line: ${line}\n\n${text}`);
    }
  });

  it("lists each case with what it cost and why it failed", () => {
    const lines = text.split("\n");
    assert.ok(lines.includes("find-001   pass    1,000 in, 100 out, 4 calls, 10 s"), text);
    assert.ok(lines.includes("find-002   fail    2,000 in, 200 out, 6 calls, 20 s  value: wanted 35, got 30"), text);
    assert.ok(lines.includes("draft-001  rubric  4,000 in, 400 out, 10 calls, 40 s"), text);
    assert.ok(lines.includes("Scored by rubric, not here: draft-001"), text);
    assert.ok(lines.includes("Not in cases.jsonl, so not scored: nope-001"), text);
  });

  it("says when a run has no decisions, judgement cases or citations to score", () => {
    const quiet = formatReport(scoreRun(cases, [{ id: "calc-002", answer: { text: "500", behaviour: "answer", value: 500 } }]));
    assert.match(quiet, /^Decisions: none in this run$/m);
    assert.match(quiet, /^Hand-overs on judgement cases: none in this run$/m);
    assert.match(quiet, /^Citations: no case in this run expects any$/m);
    assert.doesNotMatch(quiet, /Tokens per case/);
  });
});

describe("the command", () => {
  const folder = mkdtempSync(join(tmpdir(), "score-run-"));
  after(() => rmSync(folder, { recursive: true, force: true }));
  const score = (...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "score-run.ts"), ...args], {
      encoding: "utf8",
    });

  it("scores a run file", () => {
    const file = join(folder, "20261107T120000Z.jsonl");
    writeFileSync(file, run.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const result = score(file);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^20261107T120000Z\.jsonl: 7 cases, lead model test-model$/m);
    assert.match(result.stdout, /^Passed: 3 of 6 \(50%\)$/m);
  });

  it("says which line is broken", () => {
    const file = join(folder, "broken.jsonl");
    writeFileSync(file, `${JSON.stringify(run[0])}\n{"id":\n`);
    assert.throws(() => readRun(file), /line 2 isn't JSON/);
    const result = score(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /line 2 isn't JSON/);
  });

  it("finds the newest run", () => {
    writeFileSync(join(folder, "20261107T130000Z.jsonl"), "");
    assert.equal(latestRun(folder), join(folder, "20261107T130000Z.jsonl"));
    assert.equal(latestRun(join(folder, "missing")), undefined);
  });
});

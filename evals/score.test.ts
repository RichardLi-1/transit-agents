import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatCounts } from "./count.ts";
import { countBySkill, rulesOnlyDecision, scoreCase, summarize, type EvalCase } from "./score.ts";

const cases: EvalCase[] = readFileSync(join(import.meta.dirname, "cases.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const byId = (id: string) => {
  const found = cases.find((c) => c.id === id);
  assert.ok(found, id);
  return found;
};

describe("scoreCase", () => {
  it("passes an exact, cited answer", () => {
    const result = scoreCase(byId("find-001"), {
      text: "20 boardings per hour.",
      behaviour: "answer",
      value: 20,
      citations: [{ source: "ttc-anp-2026", page: 115 }],
    });
    assert.equal(result.passed, true);
    assert.equal(result.citationRecall, 1);
  });

  it("fails a right number with no citation", () => {
    const result = scoreCase(byId("find-001"), { text: "20", behaviour: "answer", value: 20 });
    assert.equal(result.passed, false);
    assert.equal(result.citationRecall, 0);
  });

  it("applies tolerance to calculated values", () => {
    const answer = { text: "", behaviour: "answer" as const, value: 67.23, citations: [{ source: "ttc-anp-2026", page: 118 }] };
    assert.equal(scoreCase(byId("calc-001"), answer).passed, true);
    assert.equal(scoreCase(byId("calc-001"), { ...answer, value: 67 }).passed, false);
  });

  it("fails an answer when the case calls for a refusal", () => {
    const result = scoreCase(byId("stop-001"), { text: "Approved by the planner.", behaviour: "answer" });
    assert.deepEqual(result.failures, ["behaviour: wanted refuse, got answer"]);
  });

  it("fails forbidden claims", () => {
    const result = scoreCase(byId("stop-004"), { text: "The regulation exists and we are compliant.", behaviour: "flag" });
    assert.deepEqual(result.failures, ["forbidden: we are compliant"]);
  });

  it("accepts a hand-over on a judgement case, and reports it as one", () => {
    const result = scoreCase(byId("check-005"), {
      text: "The tests pass, but feedback at events was negative. A planner should decide.",
      behaviour: "flag",
      checks: { customer_time: "pass", productivity: "pass", ridership_per_dollar: "pass" },
    });
    assert.equal(result.passed, true);
    assert.equal(result.handedOver, true);
  });

  it("still fails a wrong decision on a judgement case", () => {
    const result = scoreCase(byId("check-005"), {
      text: "Adopt.",
      behaviour: "flag",
      decision: "adopt",
      checks: { customer_time: "pass", productivity: "pass", ridership_per_dollar: "pass" },
    });
    assert.equal(result.passed, false);
  });

  it("catches an agent that recalls the plan instead of reading the changed numbers", () => {
    const recalled = {
      text: "",
      behaviour: "answer" as const,
      decision: "adopt" as const,
      checks: { customer_time: "pass", productivity: "pass", ridership_per_dollar: "pass" } as const,
    };
    assert.equal(scoreCase(byId("perturbed-001"), recalled).passed, false);
  });
});

describe("rules-only baseline", () => {
  const real = cases.filter((c) => c.expect.decision && !c.perturbed && c.capability === "check" && c.expect.checks);

  it("matches only the decisions that needed no judgement", () => {
    const matches = real.filter((c) => rulesOnlyDecision(c.expect.checks ?? {}) === c.expect.decision);
    assert.deepEqual(matches.map((c) => c.id), ["check-001", "check-002", "check-004"]);
  });

  it("every miss is a case marked as needing judgement", () => {
    const misses = real.filter((c) => rulesOnlyDecision(c.expect.checks ?? {}) !== c.expect.decision);
    assert.ok(misses.every((c) => c.expect.judgement));
  });
});

describe("cases", () => {
  it("have unique ids", () => {
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  });

  it("use inputs that exist", () => {
    for (const c of cases) {
      for (const name of c.inputs ?? []) {
        assert.ok(readFileSync(join(import.meta.dirname, "inputs", `${name}.txt`), "utf8").length > 0, name);
      }
    }
  });

  it("do not reveal the outcome in a proposal input", () => {
    for (const name of ["lawrence", "downsview", "highland-creek", "yorkville", "rosedale"]) {
      const text = readFileSync(join(import.meta.dirname, "inputs", `${name}.txt`), "utf8");
      assert.doesNotMatch(text, /passes this metric|formally adopt|not adopted|does not pass/i, name);
    }
  });

  it("each name a skill there is, and say how they are scored", () => {
    const skills = new Set(readdirSync(join(import.meta.dirname, "..", "agents", "skills"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
    const behaviours = ["answer", "flag", "abstain", "refuse"];
    for (const c of cases) {
      assert.ok(skills.has(c.skill), `${c.id}: no skill ${c.skill}`);
      assert.ok(["dev", "test", "future"].includes(c.split), c.id);
      assert.ok(behaviours.includes(c.expect.behaviour), c.id);
      assert.ok(c.review === undefined || c.review === "planner", c.id);
      // A new rubric case says what a planner checks.
      if (c.scorer === "rubric" && c.review) assert.ok(c.rubric?.length, `${c.id}: write its rubric`);
      if (c.rubric) assert.equal(c.scorer, "rubric", c.id);
    }
  });

  it("set up their study only as open_study takes it, and measure only what's there", () => {
    const fields = ["brief", "routes", "line", "trial", "watch"];
    for (const c of cases) {
      for (const key of Object.keys(c.study ?? {})) assert.ok(fields.includes(key), `${c.id}: study takes no ${key}`);
      if (c.measured) {
        const measured = JSON.parse(readFileSync(join(import.meta.dirname, "inputs", `${c.measured}.json`), "utf8"));
        assert.ok(measured.days.length, c.id);
        assert.ok(c.study?.watch?.length, `${c.id}: measured departures need watched patterns`);
      }
    }
  });
});

describe("summarize", () => {
  it("counts by capability and by skill", () => {
    const score = { id: "find-001", passed: true, failures: [], citationRecall: 1, citationPrecision: 1, handedOver: false };
    assert.deepEqual(summarize(cases, [score]), {
      total: 1,
      passed: 1,
      byCapability: { find: { total: 1, passed: 1 } },
      bySkill: { "ttc-standards": { total: 1, passed: 1 } },
    });
  });
});

describe("countBySkill", () => {
  const expect = { behaviour: "answer" } as const;
  const one = (id: string, skill: string, split: EvalCase["split"], more: Partial<EvalCase> = {}): EvalCase => ({
    id,
    capability: "find",
    skill,
    split,
    query: "?",
    expect,
    ...more,
  });

  it("counts each skill's cases by split, its refusals and hand-overs, and those a planner must check", () => {
    const counted = countBySkill([
      one("a", "glossary", "dev"),
      one("b", "glossary", "test", { review: "planner", expect: { behaviour: "refuse" } }),
      one("c", "bca", "future", { expect: { behaviour: "flag" } }),
      one("d", "glossary", "test", { expect: { behaviour: "abstain" } }),
    ]);
    assert.deepEqual(counted, [
      { skill: "bca", dev: 0, test: 0, future: 1, handOver: 1, toReview: 0 },
      { skill: "glossary", dev: 1, test: 2, future: 0, handOver: 1, toReview: 1 },
    ]);
    assert.deepEqual(formatCounts(counted).split("\n"), [
      "skill     dev  test  future  all  refuse or flag  to review",
      "bca         0     0       1    1               1          0",
      "glossary    1     2       0    3               1          1",
      "all         1     2       1    4               2          1",
    ]);
  });

  it("gives every skill at least 8 cases of its own, split between dev and test, with one to refuse or hand over", () => {
    for (const row of countBySkill(cases)) {
      assert.ok(row.dev + row.test >= 8, `${row.skill}: ${row.dev + row.test} dev and test cases`);
      assert.ok(row.dev >= 3 && row.test >= 3, `${row.skill}: ${row.dev} dev, ${row.test} test`);
      assert.ok(row.handOver >= 1, `${row.skill}: nothing to refuse or hand over`);
    }
  });
});

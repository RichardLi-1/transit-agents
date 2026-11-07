import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { rulesOnlyDecision, scoreCase, summarize, type EvalCase } from "./score.ts";

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
});

describe("summarize", () => {
  it("counts by capability", () => {
    const score = { id: "find-001", passed: true, failures: [], citationRecall: 1, citationPrecision: 1, handedOver: false };
    assert.deepEqual(summarize(cases, [score]), { total: 1, passed: 1, byCapability: { find: { total: 1, passed: 1 } } });
  });
});

// The answer the Ontario Line's scripted run gives the planner's question.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executiveDecision } from "@transit-agents/contracts";
import { answer, PLAN } from "./replay-ontario.ts";
import { GAP, ONTARIO } from "./seed-ontario.ts";

// The values the service holds once the seed's figures are recorded.
const VALUES: Record<string, number> = {
  "ol-cost-per-km": 613,
  "ol-contingency": 30,
  "ontario-north.length-km": 6,
  "ext-capital-cost": 3678,
  "ext-capital-cost-ob": (613 * 6 * 1.64) / 1.3,
};

describe("the Ontario Line's answer", () => {
  const lines = answer((key) => VALUES[key] ?? assert.fail(`No value for ${key}`), ONTARIO.findings).split("\n");

  it("gives the precedent cost with its basis, as a first pass", () => {
    const [first = ""] = lines;
    assert.match(first, /^Ready for planners: /);
    assert.match(first, /\*\*\$3,678 M\*\* in 2019 dollars, at the Ontario Line's median \$613 M a km \(IBC pp\. 76-77\)/);
    assert.match(first, /or \$4,640 M with optimism bias \(BCM p\. 103\)/);
    assert.ok(first.split(/\s+/).length <= 60, first);
  });

  it("then lists the two gaps that matter most, each with its next step, who to contact and its page", () => {
    const gaps = ONTARIO.findings.filter((finding) => GAP.test(finding.text)).slice(0, 2);
    const at = lines.indexOf("Not known yet:");
    assert.ok(gaps.length === 2 && at > 0);
    for (const [i, { text, citation }] of gaps.entries()) {
      const line = lines[at + 1 + i] ?? "";
      assert.ok(line.startsWith(`- ${text.slice(0, -1)} (`), line);
      assert.ok(line.endsWith(` p. ${citation.page}).`), line);
    }
  });

  it("plans as a numbered list, one line for each question it asks, which the chat shows as a list", () => {
    const steps = PLAN.split("\n").filter((line) => /^\d+\. /.test(line));
    assert.deepEqual(
      steps.map((line) => Number(line.split(".")[0])),
      [1, 2, 3, 4, 5],
    );
  });

  it("ends asking for an executive's decision, which the display offers to ping about", () => {
    assert.equal(lines.at(-1), "Executive decision required: whether to fund the extension's next stage of design.");
    assert.equal(executiveDecision(lines.join("\n")), "Whether to fund the extension's next stage of design.");
  });
});

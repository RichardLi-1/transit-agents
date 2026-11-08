// The answer the Ontario Line's scripted run gives the planner's question.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executiveDecision } from "@transit-agents/contracts";
import { answer } from "./replay-ontario.ts";
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
    assert.match(first, /^First pass, ready for planners, not a final answer\./);
    assert.match(first, /\$613 M a km, a Class 5 estimate with 30% contingency \(IBC pp\. 76-77\)/);
    assert.match(first, /\$3,678 M in 2019 dollars, or \$4,640 M with optimism bias \(BCM p\. 103\)/);
  });

  it("then lists what isn't known yet: each gap on the card, with its next step, who to contact and its page", () => {
    const gaps = ONTARIO.findings.filter((finding) => GAP.test(finding.text));
    const at = lines.indexOf("Not known yet:");
    assert.ok(gaps.length >= 4 && at > 0);
    for (const [i, { text, citation }] of gaps.entries()) {
      const line = lines[at + 1 + i] ?? "";
      assert.ok(line.startsWith(`- ${text.slice(0, -1)} (`), line);
      assert.ok(line.endsWith(` p. ${citation.page}).`), line);
    }
  });

  it("ends asking for an executive's decision, which the display offers to ping about", () => {
    assert.equal(lines.at(-1), "Executive decision required: whether to fund the extension's next stage of design.");
    assert.equal(executiveDecision(lines.join("\n")), "Whether to fund the extension's next stage of design.");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ONTARIO } from "../../../clients/seed-ontario.ts";
import { gap } from "./gap.ts";

describe("gap", () => {
  it("splits a gap into what's missing, the next step and who to contact", () => {
    assert.deepEqual(gap("Cost is a precedent, not an estimate. Next: a survey and an engineering estimate. Contact: Metrolinx engineering."), {
      missing: "Cost is a precedent, not an estimate.",
      next: "a survey and an engineering estimate",
      contact: "Metrolinx engineering",
    });
    assert.deepEqual(gap("What's under Don Mills Road is unsurveyed. Next: utility and road surveys. Contact: City of Toronto Engineering & Construction Services."), {
      missing: "What's under Don Mills Road is unsurveyed.",
      next: "utility and road surveys",
      contact: "City of Toronto Engineering & Construction Services",
    });
  });

  it("keeps a step's own full stops, and a question as what's missing", () => {
    assert.deepEqual(gap("Is the 2041 forecast current? Next: a model run, approx. 3 months. Contact: Metrolinx planning"), {
      missing: "Is the 2041 forecast current?",
      next: "a model run, approx. 3 months",
      contact: "Metrolinx planning",
    });
  });

  it("leaves a note that isn't a gap whole", () => {
    assert.equal(gap("A planner confirms how the 64% optimism bias is adjusted for contingency."), null);
    assert.equal(gap("Costs are in 2019 dollars and the value of time in 2021: both need rebasing."), null);
    assert.equal(gap("Riders are unknown. Next: a regional model run."), null);
  });

  it("reads every gap the Ontario study records", () => {
    const gaps = ONTARIO.findings.filter((finding) => finding.text.includes(" Next: "));
    assert.equal(gaps.length, 5);
    for (const { text } of gaps) {
      const parts = gap(text);
      assert.ok(parts, text);
      assert.equal(`${parts.missing} Next: ${parts.next}. Contact: ${parts.contact}.`, text);
    }
  });
});

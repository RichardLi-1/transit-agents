import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUIDE, guideHidden, guideStep, hideGuide, MORE, SUGGESTIONS, unasked, withAsked } from "./suggestions.ts";

describe("chat suggestions", () => {
  it("offers each until it's asked in that study, so they can be taken one after another", () => {
    let asked = withAsked({}, "ontario", SUGGESTIONS[0] as string);
    assert.deepEqual(unasked(asked, "ontario"), SUGGESTIONS.slice(1));
    asked = withAsked(asked, "ontario", SUGGESTIONS[3] as string);
    assert.deepEqual(unasked(asked, "ontario"), SUGGESTIONS.slice(1, 3));
    assert.deepEqual(unasked(asked, "lawrence"), SUGGESTIONS);
  });

  it("keeps offering them after a question of the planner's own", () => {
    const asked = withAsked({}, "ontario", "How often does the 25 run?");
    assert.deepEqual(unasked(asked, "ontario"), SUGGESTIONS);
  });

  it("offers at most four", () => {
    assert.ok(SUGGESTIONS.length <= 4);
  });

  it("keeps More's apart, each offered until it's asked, and none twice", () => {
    const asked = withAsked({}, "ontario", MORE[2] as string);
    assert.deepEqual(unasked(asked, "ontario", MORE), [...MORE.slice(0, 2), ...MORE.slice(3)]);
    assert.deepEqual(unasked(asked, "ontario"), SUGGESTIONS);
    assert.equal(new Set([...SUGGESTIONS, ...MORE]).size, SUGGESTIONS.length + MORE.length);
  });
});

describe("the first visit's guide", () => {
  it("takes the suggestions' own words, so asking one moves the guide on", () => {
    for (const step of GUIDE) assert.ok(SUGGESTIONS.includes(step.ask), step.ask);
  });

  it("starts with the cost, then says what to look at and what to try next, until each is asked", () => {
    assert.deepEqual(guideStep({}, "ontario"), { next: GUIDE[0]?.ask, look: null });
    let asked = withAsked({}, "ontario", GUIDE[0]?.ask as string);
    assert.deepEqual(guideStep(asked, "ontario"), { next: GUIDE[1]?.ask, look: GUIDE[0]?.look });
    asked = withAsked(withAsked(asked, "ontario", GUIDE[1]?.ask as string), "ontario", GUIDE[2]?.ask as string);
    assert.equal(guideStep(asked, "ontario").next, null);
    // Each study has its own.
    assert.equal(guideStep(asked, "lawrence").next, GUIDE[0]?.ask);
  });

  it("stays hidden once the viewer hides it", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
    assert.equal(guideHidden(storage), false);
    hideGuide(storage);
    assert.equal(guideHidden(storage), true);
  });
});

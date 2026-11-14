import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MORE, SUGGESTIONS, unasked, withAsked } from "./suggestions.ts";

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

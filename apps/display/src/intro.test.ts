import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markIntroSeen, shouldShowIntro } from "./intro.ts";

const store = () => {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
};

describe("the opening card", () => {
  it("shows the first time, and not once seen", () => {
    const storage = store();
    assert.equal(shouldShowIntro("", storage), true);
    markIntroSeen(storage);
    assert.equal(shouldShowIntro("", storage), false);
  });

  it("never shows with ?nointro, for screenshots and recordings", () => {
    assert.equal(shouldShowIntro("?nointro", store()), false);
    assert.equal(shouldShowIntro("?tab=map&nointro=1", store()), false);
  });

  it("shows when storage is blocked rather than failing", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); } };
    assert.equal(shouldShowIntro("", blocked), true);
  });
});

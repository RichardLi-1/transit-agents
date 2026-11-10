import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readChoice, resolve } from "./theme.ts";

const kept = (value: string | null) => ({ getItem: () => value });

describe("the theme", () => {
  it("is the viewer's choice when they've made one, and else the system's", () => {
    assert.equal(readChoice(kept("dark")), "dark");
    assert.equal(readChoice(kept("light")), "light");
    assert.equal(readChoice(kept(null)), "system");
    assert.equal(readChoice(kept("purple")), "system");
    assert.equal(readChoice(null), "system");
  });

  it("follows the system only while the choice is System", () => {
    assert.equal(resolve("system", true), "dark");
    assert.equal(resolve("system", false), "light");
    assert.equal(resolve("light", true), "light");
    assert.equal(resolve("dark", false), "dark");
  });

  it("falls back to System when storage is blocked", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); } };
    assert.equal(readChoice(blocked), "system");
  });
});

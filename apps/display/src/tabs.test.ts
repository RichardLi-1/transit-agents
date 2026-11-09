import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextTab, tabFor } from "./tabs.ts";

describe("the workspace's tabs", () => {
  it("move with the arrows, round the ends, and to the first and last with Home and End", () => {
    const ids = ["study", "map", "files", "sim"] as const;
    assert.equal(nextTab([...ids], "study", "ArrowRight"), "map");
    assert.equal(nextTab([...ids], "study", "ArrowLeft"), "sim");
    assert.equal(nextTab([...ids], "sim", "ArrowRight"), "study");
    assert.equal(nextTab([...ids], "files", "Home"), "study");
    assert.equal(nextTab([...ids], "study", "End"), "sim");
    assert.equal(nextTab([...ids], "study", "Enter"), null);
  });

  it("open where a notice's Review takes the planner", () => {
    assert.equal(tabFor("need", false), "map");
    assert.equal(tabFor("media", true), "map");
    assert.equal(tabFor("finding", false), "study");
    assert.equal(tabFor("decide", false), "study");
    assert.equal(tabFor("figures", false), "study");
    // The chat is always beside the workspace, but on a phone, where it's a tab.
    assert.equal(tabFor("message", false), null);
    assert.equal(tabFor("message", true), "chat");
    assert.equal(tabFor("document", false), null);
  });
});

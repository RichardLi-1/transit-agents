import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordedBy } from "./actors.ts";

describe("recordedBy", () => {
  it("names the replay as a script, and others by role and name", () => {
    assert.equal(recordedBy("agent:replay"), "Recorded by the scripted replay");
    assert.equal(recordedBy("agent:lead"), "Recorded by agent lead");
    assert.equal(recordedBy("planner:demo"), "Set by planner demo");
    assert.equal(recordedBy("integration:seed"), "Recorded by integration seed");
  });
});

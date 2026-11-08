import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Activity, AUDIENCE, Role } from "./index.ts";

describe("AUDIENCE", () => {
  it("takes a guest or user id of 16 random bytes in base64url", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = randomBytes(16).toString("base64url");
      assert.ok(AUDIENCE.test(`guest:${id}`), id);
      assert.ok(AUDIENCE.test(`user:${id}`), id);
    }
    assert.ok(AUDIENCE.test("guest:AZaz09-_AZaz09-_AZaz09"));
  });

  it("refuses anything else", () => {
    const id = "A".repeat(22);
    for (const audience of [
      "*",
      "",
      `guest:${id.slice(1)}`,
      `guest:${id}A`,
      `planner:${id}`,
      `agent:${id}`,
      `Guest:${id}`,
      `guest:${id.slice(1)}+`,
      `guest:${id.slice(1)}/`,
      `guest:${id.slice(1)}=`,
      `guest:${id}\n`,
      ` guest:${id}`,
    ]) {
      assert.equal(AUDIENCE.test(audience), false, JSON.stringify(audience));
    }
  });
});

describe("Role", () => {
  it("has a guest", () => {
    assert.equal(Role.parse("guest"), "guest");
  });
});

describe("Activity", () => {
  it("takes the specialist a reading or usage is for, and the skill a specialist starts with, each optional", () => {
    const usage = { kind: "usage", model: "m", inputTokens: 1, outputTokens: 1 };
    for (const activity of [
      { kind: "reading", contextId: "plan", page: 2, subagentId: "a1b2c3" },
      { kind: "reading", contextId: "plan" },
      { ...usage, subagentId: "a1b2c3" },
      usage,
      { kind: "subagent.started", id: "a1b2c3", question: "Riders?", skill: "gtfs-analyst" },
      { kind: "subagent.started", id: "a1b2c3", question: "Riders?" },
    ]) {
      assert.deepEqual(Activity.parse(activity), activity);
    }
  });

  it("refuses an id or skill that isn't a slug", () => {
    assert.throws(() => Activity.parse({ kind: "reading", contextId: "plan", subagentId: "Not One" }));
    assert.throws(() => Activity.parse({ kind: "subagent.started", id: "a1", question: "Riders?", skill: "../x" }));
  });
});

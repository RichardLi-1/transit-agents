import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Activity, AUDIENCE, Escalation, executiveDecision, EXECUTIVE, NewEscalation, Role } from "./index.ts";

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

describe("schemas agents are given", () => {
  // google-genai turns MCP tool schemas into Gemini's and fails on a boolean
  // subschema such as a tuple's `items: false`, so no tool may carry one.
  it("carry no boolean subschema that google-genai can't read", async () => {
    const { z } = await import("zod");
    const { NewFinding, AlignmentOption, NewDocument } = await import("./index.ts");
    const found: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === "boolean" && ["items", "additionalItems", "not", "contains"].includes(key)) found.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    };
    walk(z.toJSONSchema(NewFinding, { io: "input", unrepresentable: "any" }), "NewFinding");
    walk(z.toJSONSchema(AlignmentOption, { io: "input", unrepresentable: "any" }), "AlignmentOption");
    walk(z.toJSONSchema(NewDocument, { io: "input", unrepresentable: "any" }), "NewDocument");
    assert.deepEqual(found, []);
  });

  it("still takes an option's line as [longitude, latitude] pairs", async () => {
    const { AlignmentOption } = await import("./index.ts");
    const point = AlignmentOption.shape.line.element;
    assert.equal(point.safeParse([-79.34, 43.72]).success, true);
    assert.equal(point.safeParse([43.72, -79.34, 0]).success, false);
    assert.equal(point.safeParse([200, 43.7]).success, false);
  });
});

describe("EXECUTIVE", () => {
  it("marks an answer that needs an executive's decision, and names the decision", () => {
    const answer = "Option A is longer (ibc p. 14).\n\nNot known yet:\n- Ridership.\n\nExecutive decision required: which alignment option to fund.";
    assert.ok(EXECUTIVE.test(answer));
    assert.equal(executiveDecision(answer), "Which alignment option to fund.");
    assert.equal(executiveDecision("- Executive Decision Required — start the TPAP?"), "Start the TPAP?");
  });

  it("names none without the line, or without a decision after it", () => {
    assert.equal(EXECUTIVE.test("For a planner to decide: adopt?"), false);
    assert.equal(executiveDecision("For a planner to decide: adopt?"), null);
    assert.equal(executiveDecision("Executive decision required."), null);
  });
});

describe("Escalation", () => {
  it("is no activity an agent can post", () => {
    assert.throws(() => Activity.parse({ kind: "escalation.sent", text: "Fund option A?", to: "Jordan Lee" }));
    assert.deepEqual(Escalation.parse({ kind: "escalation.sent", text: "Fund option A?", to: "Jordan Lee", message: 4 }), {
      kind: "escalation.sent",
      text: "Fund option A?",
      to: "Jordan Lee",
      message: 4,
    });
  });

  it("takes a decision of at most 300 characters", () => {
    assert.equal(NewEscalation.parse({ text: "  Fund option A?  " }).text, "Fund option A?");
    assert.throws(() => NewEscalation.parse({ text: "x".repeat(301) }));
    assert.throws(() => NewEscalation.parse({ text: " " }));
  });
});

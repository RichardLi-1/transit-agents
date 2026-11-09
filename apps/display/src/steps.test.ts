import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { duration, grouped, planOf, stepName, stepState, wantsMap, type ToolStep } from "./steps.ts";

const tool = (seq: number, id: string, subagentId?: string): ToolStep => ({ seq, id, studyId: "s", name: "read_page", replay: false, ...(subagentId ? { subagentId } : {}) });

describe("the chat's steps", () => {
  it("puts each specialist's calls under it, and the lead's where the log has them", () => {
    const messages = [{ seq: 1, text: "Plan" }, { seq: 20, text: "Answer" }];
    const specialists = [{ seq: 2, id: "cost" }, { seq: 3, id: "riders" }];
    const items = grouped(messages, specialists, [tool(10, "t2", "cost"), tool(4, "t1", "cost"), tool(5, "t3", "riders"), tool(15, "t4"), tool(16, "t5", "gone")]);
    assert.deepEqual(
      items.map((item) => ("tools" in item ? `${item.id}:${item.tools.map((t) => t.id).join(",")}` : "text" in item ? item.text : item.id)),
      ["Plan", "cost:t1,t2", "riders:t3", "t4", "t5", "Answer"],
    );
  });

  it("says a call is running until it's back, and stopped if its run ended first", () => {
    assert.equal(stepState({}, true), "running");
    assert.equal(stepState({}, false), "stopped");
    assert.equal(stepState({ ok: true }, false), "done");
    assert.equal(stepState({ ok: false }, true), "failed");
  });

  it("names a tool in words", () => {
    assert.equal(stepName("read_page"), "Read page");
    assert.equal(stepName("list_rules"), "List rules");
    assert.equal(stepName("buffer-geometry"), "Buffer geometry");
    assert.equal(stepName(""), "Tool");
  });

  it("says how long a call took", () => {
    assert.equal(duration(120), "120 ms");
    assert.equal(duration(3420), "3.4 s");
    assert.equal(duration(65_000), "1 min 05 s");
  });
});

describe("the lead's plan", () => {
  it("reads a numbered list out of an answer, with the words around it", () => {
    const plan = planOf("Four questions:\n1. Strategic case\n2. Financial case,\nat its price\n3. Engagement\n\nPage numbers count the PDF's pages.");
    assert.deepEqual(plan, {
      lead: "Four questions:",
      steps: ["Strategic case", "Financial case, at its price", "Engagement"],
      after: "Page numbers count the PDF's pages.",
    });
  });

  it("is no plan without two steps in order", () => {
    assert.equal(planOf("1. Only one"), null);
    assert.equal(planOf("No list here"), null);
    assert.equal(planOf("2. Two\n3. Three"), null);
  });
});

describe("asking about the map", () => {
  it("hears the map, its layers or a buffer, and nothing else", () => {
    assert.ok(wantsMap("Show the stops on the map"));
    assert.ok(wantsMap("Buffer the stops by 400 m"));
    assert.ok(wantsMap("Which layers are there?"));
    assert.ok(!wantsMap("What would it cost?"));
    assert.ok(!wantsMap("Make a TPAP brief as a PDF"));
  });
});

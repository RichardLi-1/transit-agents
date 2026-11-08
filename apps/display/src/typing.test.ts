import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEntry } from "@transit-agents/contracts";
import { initial, reduce } from "./store.ts";
import { foldAt, typing, waiting } from "./typing.ts";

describe("typing", () => {
  it("shows nothing without an open run", () => {
    assert.equal(typing(undefined, [{ seq: 1, from: "planner" }]), false);
  });

  it("shows while a run has no answer, and stops at the agent's answer", () => {
    assert.equal(typing(5, []), true);
    assert.equal(typing(5, [{ seq: 4, from: "agent" }, { seq: 6, from: "planner" }]), true);
    assert.equal(typing(5, [{ seq: 6, from: "planner" }, { seq: 7, from: "agent" }]), false);
  });

  it("keeps going while a sub-agent is out", () => {
    assert.equal(typing(5, [{ seq: 6, from: "agent" }, { seq: 7 }]), true);
    assert.equal(typing(5, [{ seq: 7, summary: "done" }, { seq: 8, from: "agent" }]), false);
  });

  it("follows run.started and run.finished in the store", () => {
    const entry = (seq: number, kind: string): LogEntry => ({
      seq,
      at: "2026-11-08T00:00:00.000Z",
      actor: "agent:lead",
      type: "activity",
      studyId: "s",
      data: { kind },
      prevHash: "",
      hash: "",
      audience: null,
    });
    const started = reduce(initial, entry(3, "run.started"));
    assert.equal(started.openRuns.s, 3);
    assert.equal(reduce(started, entry(4, "run.finished")).openRuns.s, undefined);
  });
});

describe("waiting", () => {
  it("shows at once for a question asked since the page opened", () => {
    assert.equal(waiting(undefined, [{ seq: 4, from: "agent" }, { seq: 6, from: "planner" }], 5), true);
    assert.equal(waiting(undefined, [{ seq: 6, from: "planner" }, { seq: 7, from: "agent" }], 5), false);
    assert.equal(waiting(undefined, [], 5), false);
  });

  it("leaves a question unanswered before the page opened alone", () => {
    assert.equal(waiting(undefined, [{ seq: 6, from: "planner" }], 9), false);
    assert.equal(waiting(undefined, [{ seq: 6, from: "planner" }], null), false);
  });

  it("ignores a sub-agent's line when asking who spoke last", () => {
    assert.equal(waiting(undefined, [{ seq: 6, from: "agent" }, { seq: 7, summary: "done" }], 5), false);
  });
});

describe("foldAt", () => {
  it("folds at the log's head when the page opened", () => {
    assert.equal(foldAt(9, undefined, [{ seq: 6, from: "planner" }, { seq: 7, from: "agent" }]), 9);
    assert.equal(foldAt(null, undefined, []), Infinity);
  });

  it("keeps a question being answered in view after a reload", () => {
    const items = [{ seq: 2, from: "agent" as const }, { seq: 6, from: "planner" as const }, { seq: 8 }];
    assert.equal(foldAt(9, 7, items), 5);
    assert.equal(foldAt(9, 7, [{ seq: 2, from: "agent" }]), 6);
  });
});

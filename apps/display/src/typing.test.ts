import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEntry } from "@transit-agents/contracts";
import { initial, reduce } from "./store.ts";
import { typing } from "./typing.ts";

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

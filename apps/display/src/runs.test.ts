import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, LogEntry } from "@transit-agents/contracts";
import { elapsed, runState, said, specialistState, STALE_MS, track, type Runs } from "./runs.ts";

let seq = 0;
const at = (second: number) => new Date(Date.UTC(2026, 10, 8, 12, 0, second)).toISOString();
const entry = (data: unknown, second = 0, type = "activity", studyId: string | null = "s"): LogEntry => {
  seq += 1;
  return { seq, at: at(second), actor: "agent:lead", type, studyId, data, prevHash: "", hash: "", audience: null };
};
const play = (entries: LogEntry[], live = true, runs: Runs = {}) => entries.reduce((r, e) => track(r, e, live), runs);
const contexts = [{ id: "ttc-anp-2026", title: "TTC 2026 Annual Service Plan: Appendix" }] as Context[];

describe("runs", () => {
  it("shows each specialist with its skill, what it reads by its own id, and its time", () => {
    const runs = play([
      entry({ kind: "run.started" }, 0),
      entry({ kind: "subagent.started", id: "a1", question: "How often?", skill: "gtfs-analyst" }, 1),
      entry({ kind: "subagent.started", id: "b2", question: "Who must hear?" }, 2),
      entry({ kind: "reading", contextId: "ttc-anp-2026", page: 115, subagentId: "a1" }, 3),
      entry({ kind: "reading", contextId: "ttc-anp-2026", page: 9, subagentId: "b2" }, 4),
      entry({ kind: "subagent.finished", id: "a1", summary: "Every 10 minutes." }, 5),
    ]);
    const run = runs.s;
    assert.ok(run);
    assert.deepEqual(
      run.specialists.map((s) => [s.id, s.skill, said(s.doing, contexts), specialistState(s, run, Date.parse(at(6)))]),
      [
        ["a1", "gtfs-analyst", "Reading TTC 2026 Annual Service Plan p. 115", "done"],
        ["b2", undefined, "Reading TTC 2026 Annual Service Plan p. 9", "working"],
      ],
    );
    assert.equal(elapsed(run.specialists[0]!.startedAt, run.specialists[0]!.finishedAt!), "4s");
    assert.equal(run.doing, undefined); // the lead read nothing itself
  });

  it("puts a recorded figure on the one specialist at work, or else on the lead", () => {
    let runs = play([
      entry({ kind: "run.started" }),
      entry({ kind: "subagent.started", id: "a1", question: "Riders?" }),
      entry({ id: "riders", label: "Weekly riders" }, 1, "figure.recorded"),
    ]);
    assert.equal(said(runs.s?.specialists[0]?.doing, contexts), "Recorded Weekly riders");
    runs = play([entry({ kind: "subagent.started", id: "b2", question: "Hours?" }), entry({ id: "hours", label: "Service hours" }, 2, "figure.recorded")], true, runs);
    assert.equal(said(runs.s?.doing, contexts), "Recorded Service hours");
    assert.equal(said(runs.s?.specialists[0]?.doing, contexts), "Recorded Weekly riders");
  });

  it("adds up the run's tokens and dollars, and each specialist's own tokens", () => {
    const runs = play([
      entry({ kind: "usage", model: "m", inputTokens: 5, outputTokens: 5 }), // before the run: not its
      entry({ kind: "run.started" }),
      entry({ kind: "subagent.started", id: "a1", question: "Riders?" }),
      entry({ kind: "usage", model: "m", inputTokens: 100, outputTokens: 10, costUsd: 0.01 }),
      entry({ kind: "usage", model: "m", inputTokens: 200, outputTokens: 20, costUsd: 0.02, subagentId: "a1" }),
    ]);
    assert.deepEqual([runs.s?.tokens, runs.s?.costUsd, runs.s?.calls, runs.s?.unpricedCalls, runs.s?.specialists[0]?.tokens], [330, 0.03, 2, 0, 220]);
  });

  it("marks a run done, and one that went quiet stale, with its unfinished specialists", () => {
    let runs = play([entry({ kind: "run.started" }, 0), entry({ kind: "subagent.started", id: "a1", question: "Riders?" }, 1)]);
    const run = runs.s!;
    assert.equal(runState(run, Date.parse(at(2))), "working");
    assert.equal(runState(run, Date.parse(at(1)) + STALE_MS + 1), "stale");
    assert.equal(specialistState(run.specialists[0]!, run, Date.parse(at(1)) + STALE_MS + 1), "stale");
    runs = play([entry({ kind: "subagent.finished", id: "a1", summary: "Stopped.", ok: false }, 3), entry({ kind: "run.finished" }, 4)], true, runs);
    assert.equal(runState(runs.s!, Date.now()), "done");
    assert.equal(specialistState(runs.s!.specialists[0]!, runs.s!, Date.now()), "stopped");
    assert.equal(runs.s!.finishedAt, at(4));
  });

  it("starts afresh with each run, keeps studies apart, and knows a run the log already held", () => {
    const runs = play([entry({ kind: "run.started" }), entry({ kind: "subagent.started", id: "a1", question: "Riders?" }), entry({ kind: "run.finished" })], false);
    assert.equal(runs.s?.live, false);
    const next = play([entry({ kind: "run.started" }), entry({ kind: "run.started" }, 0, "activity", "other")], true, runs);
    assert.deepEqual([next.s?.live, next.s?.specialists.length, next.other?.live], [true, 0, true]);
  });

  it("says elapsed time in seconds, minutes or hours", () => {
    assert.deepEqual([elapsed(at(0), at(45)), elapsed(at(0), Date.parse(at(0)) + 185_000), elapsed(at(0), Date.parse(at(0)) + 3_720_000)], ["45s", "3m 05s", "1h 02m"]);
  });
});

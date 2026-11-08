import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogEntry } from "@transit-agents/contracts";
import { spentUsd } from "./money.ts";
import { initial, reduce } from "./store.ts";

let seq = 0;
const activity = (data: unknown, actor = "agent:lead"): LogEntry => {
  seq += 1;
  return { seq, at: "2026-11-08T00:00:00.000Z", actor, type: "activity", studyId: "s", data, prevHash: "", hash: "" };
};

describe("usage", () => {
  it("adds up tokens, and shows no dollar sum while a model call has no price, as the spend screen does", () => {
    let store = reduce(initial, activity({ kind: "usage", model: "m", inputTokens: 100, outputTokens: 10 }));
    assert.deepEqual([store.usage.s?.inputTokens, store.usage.s?.calls, store.usage.s?.unpricedCalls, spentUsd(store.usage.s ?? null)], [100, 1, 1, null]);
    store = reduce(store, activity({ kind: "usage", model: "m", inputTokens: 50, outputTokens: 5, costUsd: 0.25 }));
    // 0.25 would be too low: the first call's cost is unknown.
    assert.deepEqual([store.usage.s?.inputTokens, store.usage.s?.costUsd, store.usage.s?.unpricedCalls, spentUsd(store.usage.s ?? null)], [150, 0.25, 1, null]);
  });

  it("shows the dollars once every call has a price", () => {
    let store = reduce(initial, activity({ kind: "usage", model: "m", inputTokens: 100, outputTokens: 10, costUsd: 0.5 }));
    store = reduce(store, activity({ kind: "usage", model: "m", inputTokens: 50, outputTokens: 5, costUsd: 0.25 }));
    assert.equal(spentUsd(store.usage.s ?? null), 0.75);
  });

  it("keeps each study's apart, so a chat shows its own study's spend", () => {
    let store = reduce(initial, activity({ kind: "usage", model: "m", inputTokens: 100, outputTokens: 10, costUsd: 0.01 }));
    store = reduce(store, { ...activity({ kind: "usage", model: "m", inputTokens: 7, outputTokens: 3, costUsd: 0.02 }), studyId: "other" });
    assert.deepEqual(
      Object.fromEntries(Object.entries(store.usage).map(([id, usage]) => [id, [usage.inputTokens + usage.outputTokens, usage.costUsd, usage.calls]])),
      { s: [110, 0.01, 1], other: [10, 0.02, 1] },
    );
  });
});

describe("subagents", () => {
  it("tells one that answered from one that stopped", () => {
    let store = initial;
    for (const id of ["a1", "b2"]) store = reduce(store, activity({ kind: "subagent.started", id, question: `${id}?` }));
    store = reduce(store, activity({ kind: "subagent.finished", id: "a1", summary: "20 (ttc-anp-2026 p. 115)." }));
    store = reduce(store, activity({ kind: "subagent.finished", id: "b2", summary: "Stopped.", ok: false }));
    assert.deepEqual(
      store.subagents.map((s) => [s.id, s.summary, s.ok]),
      [
        ["a1", "20 (ttc-anp-2026 p. 115).", true],
        ["b2", "Stopped.", false],
      ],
    );
  });
});

describe("replay", () => {
  it("stays marked on its own messages, whatever comes after in any study", () => {
    let store = reduce(initial, activity({ kind: "message", text: "Scripted." }, "agent:replay"));
    store = reduce(store, activity({ kind: "subagent.started", id: "r1", question: "Riders?" }, "agent:replay"));
    store = reduce(store, { ...activity({ kind: "message", text: "Hello" }, "planner:local"), studyId: "other" });
    store = reduce(store, activity({ kind: "message", text: "A real answer." }, "agent:lead"));
    assert.deepEqual(store.messages.map((m) => [m.studyId, m.text, m.replay]), [
      ["s", "Scripted.", true],
      ["other", "Hello", false],
      ["s", "A real answer.", false],
    ]);
    assert.deepEqual(store.subagents.map((sub) => sub.replay), [true]);
  });
});

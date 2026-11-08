import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { LogEntry } from "@transit-agents/contracts";
import { spentUsd } from "./money.ts";
import { initial, readHead, reduce } from "./store.ts";

let seq = 0;
const activity = (data: unknown, actor = "agent:lead"): LogEntry => {
  seq += 1;
  return { seq, at: "2026-11-08T00:00:00.000Z", actor, type: "activity", studyId: "s", data, prevHash: "", hash: "", audience: null };
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

describe("runs", () => {
  it("follows the open run from activity and the figures recorded in it, for the agents panel", () => {
    let store = reduce(initial, activity({ kind: "run.started" }));
    store = reduce(store, activity({ kind: "subagent.started", id: "a1", question: "Riders?", skill: "gtfs-analyst" }));
    store = reduce(store, { ...activity({ id: "riders", label: "Weekly riders" }), type: "figure.recorded" });
    assert.deepEqual(store.runs.s?.specialists.map((s) => [s.skill, s.doing]), [["gtfs-analyst", { kind: "recorded", label: "Weekly riders" }]]);
    assert.equal(store.subagents.length, 1); // the chat still lists it
  });
});

describe("messages", () => {
  it("puts a visitor's words on the person's side, as a planner's are", () => {
    let store = initial;
    for (const actor of ["planner:ana", "guest:AAAAAAAAAAAAAAAAAAAAAA", "agent:lead"]) store = reduce(store, activity({ kind: "message", text: actor }, actor));
    assert.deepEqual(
      store.messages.map((m) => [m.text, m.from]),
      [
        ["planner:ana", "planner"],
        ["guest:AAAAAAAAAAAAAAAAAAAAAA", "planner"],
        ["agent:lead", "agent"],
      ],
    );
  });
});

describe("the log's head", () => {
  // The first reads fail, by a dropped request or the service's error, then one works.
  let failures: ("dropped" | "error")[] = [];
  let asked = 0;
  // Lets the fake requests and their callbacks finish.
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    asked = 0;
    Object.assign(globalThis, { window: globalThis });
    mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(globalThis, "fetch", async (path: string) => {
      assert.equal(path, "/v1/log/head");
      const failure = failures[asked++];
      if (failure === "dropped") throw new TypeError("Failed to fetch");
      if (failure === "error") return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return Response.json({ seq: 142, hash: "" });
    });
  });

  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  it("is asked for again, a little later each time, and a failed read is never taken for an empty log", async () => {
    failures = ["dropped", "error"];
    const found: number[] = [];
    const head = readHead((seq) => found.push(seq));
    await head.first;
    assert.deepEqual([asked, found], [1, []]);
    mock.timers.tick(500);
    await settle();
    assert.deepEqual([asked, found], [2, []]);
    mock.timers.tick(999);
    await settle();
    assert.equal(asked, 2);
    mock.timers.tick(1);
    await settle();
    assert.deepEqual([asked, found], [3, [142]]);
    head.stop();
  });

  it("stops asking once stopped", async () => {
    failures = Array(10).fill("dropped");
    const head = readHead(() => assert.fail("The head can't be read"));
    await head.first;
    head.stop();
    mock.timers.tick(60_000);
    await settle();
    assert.equal(asked, 1);
  });
});

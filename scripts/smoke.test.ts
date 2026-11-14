import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { outcome, smoke, type Entry } from "./smoke.ts";

// As the live log gave them on 2026-11-14, when the check first ran.
const ASKED: Entry = { seq: 393, actor: "guest:f8hnvSWk8BfHfHKsruiyiw", studyId: "ontario-line-don-mills", data: { kind: "message", text: "What is a Class 5 estimate?" } };
const STARTED: Entry = { seq: 394, actor: "agent:lead", studyId: "ontario-line-don-mills", data: { kind: "run.started" } };
const ANSWER: Entry = { seq: 446, actor: "agent:lead", studyId: "ontario-line-don-mills", data: { kind: "message", text: "A Class 5 estimate is an early cost estimate…" } };
const FINISHED: Entry = { seq: 447, actor: "agent:lead", studyId: "ontario-line-don-mills", data: { kind: "run.finished" } };

describe("the live check", () => {
  it("waits while the agents work, and doesn't take the question for an answer", () => {
    assert.equal(outcome([ASKED, STARTED]), null);
  });

  it("takes an agent's message as the answer", () => {
    assert.deepEqual(outcome([ASKED, STARTED, ANSWER, FINISHED]), { answered: true, text: ANSWER.data?.text });
  });

  it("takes the words a run ends with when it has none as no answer", () => {
    const failed = { ...ANSWER, data: { kind: "message", text: "That failed. Try again." } };
    assert.equal(outcome([STARTED, failed])?.answered, false);
    assert.equal(outcome([STARTED, FINISHED])?.answered, false);
  });

  it("counts only the asked study", () => {
    assert.equal(outcome([{ ...ANSWER, studyId: "lawrence" }]), null);
  });

  it("says no agent picked it up when none did", async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("/v1/guests")) return Response.json({ token: "t" });
      if (url.endsWith("/v1/log/head")) return Response.json({ seq: 1 });
      if (url.includes("/activity")) return new Response(null, { status: 201 });
      return Response.json([]);
    }) as typeof fetch;
    try {
      const result = await smoke("https://site.test", async (ms) => {
        now += ms;
      });
      assert.deepEqual(result, { answered: false, why: "No agent picked the question up in 5 minutes" });
    } finally {
      Date.now = realNow;
      globalThis.fetch = realFetch;
    }
  });
});

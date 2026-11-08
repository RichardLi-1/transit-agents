import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUDGET_SPENT, type LogEntry } from "@transit-agents/contracts";
import { hear, KEEP, NOTHING_HEARD, spoken, spokenTogether, type Heard } from "./notify.ts";

let seq = 0;
let clock = Date.parse("2026-11-08T12:00:00.000Z");
const entry = (type: string, data: unknown, actor = "agent:lead", studyId: string | null = "s"): LogEntry => {
  seq += 1;
  clock += 1000;
  return { seq, at: new Date(clock).toISOString(), actor, type, studyId, data, prevHash: "", hash: "", audience: null };
};
const activity = (data: unknown, actor = "agent:lead", studyId = "s") => entry("activity", data, actor, studyId);
const finding = (id: string, actor = "agent:replay") => entry("finding.recorded", { id, label: id, text: "t", tone: "neutral" }, actor);

// Each entry heard live, as after the display opened.
const live = (...entries: LogEntry[]) => entries.reduce((heard: Heard, e) => hear(heard, e, true), NOTHING_HEARD);
const lines = (heard: Heard) => heard.notices.map((n) => n.text);
const first = (heard: Heard) => {
  const notice = heard.notices[0];
  assert.ok(notice);
  return notice;
};

describe("notices", () => {
  it("asks for a planner's call on a finding an agent records, and points Review at it", () => {
    const heard = live(finding("survey"));
    assert.deepEqual(lines(heard), ["Needs your call"]);
    assert.deepEqual(heard.notices[0]?.target, { kind: "finding", id: "survey" });
    assert.equal(heard.notices[0]?.studyId, "s");
  });

  it("says nothing of a finding a planner records, since a planner's tone is already a rating", () => {
    assert.deepEqual(lines(live(finding("survey", "planner:demo"))), []);
  });

  it("folds findings recorded together into one notice, and counts them", () => {
    const heard = live(finding("a"), finding("b"), finding("c"));
    assert.equal(heard.notices.length, 1);
    assert.deepEqual([heard.notices[0]?.count, heard.notices[0]?.target], [3, { kind: "finding", id: "a" }]);
    // It keeps the first entry's id, and takes the last one's seq, so a list shows it as updated.
    assert.equal(heard.notices[0]?.seq, (heard.notices[0]?.id ?? 0) + 2);
  });

  it("keeps findings apart when another study's or a later burst's", () => {
    let heard = live(finding("a"));
    heard = hear(heard, { ...finding("b"), studyId: "other" }, true);
    clock += 60_000;
    heard = hear(heard, finding("c"), true);
    assert.deepEqual(
      heard.notices.map((n) => [n.studyId, n.count]),
      [
        ["s", 1],
        ["other", 1],
        ["s", 1],
      ],
    );
  });

  it("asks for a planner's call when a run ends on a hand-over, and points Review at where to decide, with the hand-over's message", () => {
    const handover = activity({ kind: "message", text: "The tests disagree.\n\nFor a planner to decide: does the time saved outweigh the cost?" });
    const heard = live(activity({ kind: "run.started" }), handover, activity({ kind: "run.finished" }));
    assert.deepEqual(lines(heard), ["Needs your call"]);
    assert.deepEqual([heard.notices[0]?.kind, heard.notices[0]?.target], ["handover", { kind: "decide", seq: handover.seq }]);
  });

  it("says an executive decision is required when a run ends on one, and points Review at the answer, whose card offers the ping", () => {
    const answer = activity({ kind: "message", text: "First pass, ready for planners.\n\nExecutive decision required: which option to fund." });
    const heard = live(activity({ kind: "run.started" }), answer, activity({ kind: "run.finished" }));
    assert.deepEqual(lines(heard), ["Executive decision required"]);
    assert.deepEqual(heard.notices[0]?.target, { kind: "message", seq: answer.seq });
  });

  it("reads the replay's hand-over to planners as one too", () => {
    const heard = live(activity({ kind: "message", text: "Draft ready for planners. Cost and riders are precedents." }), activity({ kind: "run.finished" }));
    assert.equal(heard.notices[0]?.kind, "handover");
  });

  it("says an answer is ready when a run ends on a message, and points Review at it", () => {
    const question = activity({ kind: "message", text: "What does it cost?" }, "planner:demo");
    const answer = activity({ kind: "message", text: "$2,100 M before optimism bias (IBC p. 77)." });
    const heard = live(question, activity({ kind: "run.started" }), activity({ kind: "reading", contextId: "ibc", page: 77 }), answer, activity({ kind: "usage", model: "m", inputTokens: 1, outputTokens: 1 }), activity({ kind: "run.finished" }));
    assert.deepEqual(lines(heard), ["Answer ready"]);
    assert.deepEqual(heard.notices[0]?.target, { kind: "message", seq: answer.seq });
  });

  it("never takes a person's own message, a planner's or a visitor's, for the agent's answer", () => {
    for (const actor of ["planner:demo", "guest:AAAAAAAAAAAAAAAAAAAAAA"]) {
      const heard = live(activity({ kind: "message", text: "$2,100 M (IBC p. 77)." }), activity({ kind: "message", text: "And the riders?" }, actor), activity({ kind: "run.finished" }));
      assert.deepEqual(lines(heard), [], actor);
    }
  });

  it("says nothing when a run ends in a failure, a stop, or with work after its last message", () => {
    for (const text of ["That failed. Gemini is busy.", "Stopped before answering.", "That took more than 5 minutes, so the agent stopped.", BUDGET_SPENT]) {
      assert.deepEqual(lines(live(activity({ kind: "message", text }), activity({ kind: "run.finished" }))), [], text);
    }
    // The replay's other studies post their brief, then record figures and findings.
    const heard = live(
      activity({ kind: "run.started" }),
      activity({ kind: "message", text: "Extend the 52F to Sunnybrook." }),
      entry("figure.recorded", { id: "riders" }),
      activity({ kind: "run.finished" }),
    );
    assert.deepEqual(lines(heard), []);
    // A run with no message at all.
    assert.deepEqual(lines(live(activity({ kind: "run.started" }), activity({ kind: "run.finished" }))), []);
  });

  it("says so when an agent proposes an engagement need, but not when a planner adds one", () => {
    const need = { id: "fairview-video", title: "Engagement video", place: "Fairview Mall", kinds: ["video"] };
    const heard = live(entry("need.added", need, "agent:replay"));
    assert.deepEqual(lines(heard), ["Proposed: Engagement video, Fairview Mall"]);
    assert.deepEqual(heard.notices[0]?.target, { kind: "need", id: "fairview-video" });
    assert.deepEqual(lines(live(entry("need.added", need, "planner:demo"))), []);
  });

  it("says when illustrative media is ready, with the place its need is for, even a need from before the display opened", () => {
    const need = entry("need.added", { id: "fairview-video", title: "Engagement video", place: "Fairview Mall" }, "agent:replay");
    let heard = hear(NOTHING_HEARD, need, false);
    assert.deepEqual(lines(heard), []);
    heard = hear(heard, entry("need.create.requested", { need: "fairview-video" }, "planner:demo"), true);
    heard = hear(heard, entry("media.added", { need: "fairview-video", kind: "video", sha256: "f".repeat(64) }, "agent:media"), true);
    assert.deepEqual(lines(heard), ["Illustrative video ready: Fairview Mall"]);
    assert.deepEqual(heard.notices[0]?.target, { kind: "media", need: "fairview-video", media: "video" });
    // A need the display never heard of still says what is ready.
    assert.deepEqual(lines(live(entry("media.added", { need: "poster", kind: "image" }, "agent:media"))), ["Illustrative image ready"]);
  });

  it("says who decided what, and points Review at the decision itself", () => {
    const heard = live(entry("decision.recorded", { outcome: "reject", reason: "Public engagement results.", decidedBy: "Jane Ng", analysis: "mixed" }, "planner:demo"));
    assert.deepEqual(lines(heard), ["Decided: Not adopted, by Jane Ng"]);
    assert.deepEqual(heard.notices[0]?.target, { kind: "decision" });
    assert.deepEqual(lines(live(entry("decision.recorded", { outcome: "adopt", decidedBy: "TTC staff" }, "planner:demo"))), ["Decided: Adopted, by TTC staff"]);
  });

  it("never notifies of what the log held when the display opened", () => {
    const history = [
      finding("survey"),
      activity({ kind: "message", text: "Draft ready for planners." }),
      activity({ kind: "run.finished" }),
      entry("need.added", { id: "n", title: "Poster", place: "Here" }, "agent:replay"),
      entry("media.added", { need: "n", kind: "image" }, "agent:media"),
      entry("decision.recorded", { outcome: "adopt", decidedBy: "Jane Ng" }, "planner:demo"),
    ];
    assert.deepEqual(lines(history.reduce((heard: Heard, e) => hear(heard, e, false), NOTHING_HEARD)), []);
  });

  it("finishes a run the display saw start before it opened", () => {
    const heard = hear(NOTHING_HEARD, activity({ kind: "message", text: "Draft ready for planners." }), false);
    assert.deepEqual(lines(hear(heard, activity({ kind: "run.finished" }), true)), ["Needs your call"]);
  });

  it("ignores everything else, and keeps the same state for it", () => {
    const heard = live(finding("a"));
    for (const e of [
      entry("study.opened", { id: "s", title: "S" }),
      entry("finding.rated", { finding: "a", tone: "positive" }, "planner:demo"),
      entry("context.added", { id: "c" }, "integration:seed", null),
      activity({ kind: "reading", contextId: "c" }),
    ]) {
      assert.equal(hear(heard, e, true), heard, e.type);
    }
  });

  it("says a study's brief changed when a planner sets an input it uses, with the new value, and points Review at the moved figures", () => {
    const set = (effects: unknown[]) =>
      entry("assumption.set", { key: "fare", label: "Average fare", value: 3.3, unit: "CAD", from: 3.25, reason: "New fare.", effects }, "planner:demo", null);
    const heard = live(
      set([
        { studyId: "s", figures: [{ id: "revenue", from: 1, to: 2 }], checks: [] },
        { studyId: "t", figures: [], checks: [{ id: "cost", from: "pass", to: "fail" }] },
      ]),
    );
    assert.deepEqual(
      heard.notices.map((n) => [n.kind, n.studyId, n.text, n.target]),
      [
        ["brief", "s", "Brief changed: Average fare, now 3.3 CAD", { kind: "figures", ids: ["revenue"] }],
        ["brief", "t", "Brief changed: Average fare, now 3.3 CAD", { kind: "figures", ids: [] }],
      ],
    );
    assert.equal(new Set(heard.notices.map((n) => n.id)).size, 2); // each its own toast
    // An input that moves no study, or one the log already held, says nothing.
    assert.deepEqual(lines(live(set([]))), []);
    assert.equal(hear(NOTHING_HEARD, set([{ studyId: "s", figures: [{ id: "revenue", from: 1, to: 2 }], checks: [] }]), false), NOTHING_HEARD);
  });

  it("keeps the most recent notices only", () => {
    let heard = NOTHING_HEARD;
    for (let i = 0; i < KEEP + 5; i++) heard = hear(heard, entry("decision.recorded", { outcome: "defer", decidedBy: `P${i}` }, "planner:demo"), true);
    assert.equal(heard.notices.length, KEEP);
    assert.equal(heard.notices.at(-1)?.text, `Decided: Deferred, by P${KEEP + 4}`);
  });

  it("says the whole notice in one line, with the count and the study", () => {
    const heard = live(finding("a"), finding("b"));
    assert.equal(spoken(first(heard), "Ontario Line to Don Mills"), "Needs your call, 2 notes, Ontario Line to Don Mills");
    assert.equal(spoken(first(live(finding("a"))), "Lawrence"), "Needs your call, Lawrence");
  });

  it("says notices that come together in one go, so none replaces another before it's read", () => {
    const heard = live(
      entry("decision.recorded", { outcome: "adopt", decidedBy: "TTC staff" }, "planner:demo"),
      entry("decision.recorded", { outcome: "reject", decidedBy: "TTC staff" }, "planner:demo", "t"),
    );
    const titles: Record<string, string> = { s: "Lawrence", t: "Sherbourne" };
    assert.equal(
      spokenTogether(heard.notices, (id) => titles[id] ?? id),
      "Decided: Adopted, by TTC staff, Lawrence. Decided: Not adopted, by TTC staff, Sherbourne",
    );
    assert.equal(spokenTogether([], (id) => id), "");
  });

  it("says a document is ready, by its title, and points Open at its PDF, without a second notice for the answer", () => {
    const heard = live(
      activity({ kind: "run.started" }),
      entry("document.created", { sha256: "a".repeat(64), url: `/v1/media/${"a".repeat(64)}`, kind: "report", title: "TPAP brief" }),
      activity({ kind: "message", text: "Document ready: TPAP brief. http://127.0.0.1:4550/v1/media/aaa" }),
      activity({ kind: "run.finished" }),
    );
    assert.deepEqual(lines(heard), ["Document ready: TPAP brief"]);
    assert.deepEqual(first(heard).target, { kind: "document", url: `/v1/media/${"a".repeat(64)}` });
  });
});

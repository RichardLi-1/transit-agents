import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Entry } from "./log.ts";
import { apply, emptyState, viewNeed, type Need, type State } from "./state.ts";

const SHA = "a".repeat(64);
const NEED = {
  id: "sunnybrook-poster",
  title: "Engagement poster",
  place: "Sunnybrook Hospital",
  lon: -79.375262,
  lat: 43.722663,
  kinds: ["image"],
  reason: "Riders can now reach the hospital without a transfer.",
  citations: [{ contextId: "plan", page: 116, quote: "would be extended to Sunnybrook Hospital" }],
};

function fold(entries: [actor: string, type: string, data: unknown][]): State {
  const state = emptyState();
  entries.forEach(([actor, type, data], i) => {
    const entry: Entry = {
      seq: i + 1,
      at: `2026-11-07T12:00:0${i}.000Z`,
      actor,
      type,
      studyId: type === "study.opened" ? (data as { id: string }).id : "lawrence",
      data,
      payloadHash: "",
      prevHash: "",
      hash: "",
      audience: null,
    };
    apply(state, entry);
  });
  return state;
}

const opened: [string, string, unknown] = ["agent:lead", "study.opened", { id: "lawrence", title: "Lawrence–Sunnybrook", brief: "", routes: [] }];
const added: [string, string, unknown] = ["agent:lead", "need.added", NEED];
const requested: [string, string, unknown] = ["planner:ana", "need.create.requested", { need: NEED.id }];
const media: [string, string, unknown] = [
  "agent:media",
  "media.added",
  {
    need: NEED.id,
    sha256: SHA,
    kind: "image",
    type: "image/png",
    size: 2048,
    model: "gemini-3.1-flash-image",
    prompt: "A poster",
    inputs: [{ figure: "riders-forecast" }],
    label: "Illustrative",
  },
];

const needOf = (state: State) => viewNeed(state.studies.get("lawrence")?.needs.get(NEED.id) as Need);

describe("engagement needs in the fold", () => {
  it("start out needed, with who proposed them and no media", () => {
    const need = needOf(fold([opened, added]));
    assert.equal(need.status, "needed");
    assert.equal(need.addedBy, "agent:lead");
    assert.deepEqual(need.citations, NEED.citations);
    assert.deepEqual(need.media, []);
    assert.equal(need.requestedBy, undefined);
  });

  it("are creating once a planner asks, and keep the first request", () => {
    const need = needOf(fold([opened, added, requested, ["planner:bo", "need.create.requested", { need: NEED.id }]]));
    assert.equal(need.status, "creating");
    assert.equal(need.requestedBy, "planner:ana");
    assert.equal(need.requestedAt, "2026-11-07T12:00:02.000Z");
  });

  it("are ready once media is attached, which is labelled and served by its hash", () => {
    const state = fold([opened, added, requested, media]);
    const need = needOf(state);
    assert.equal(need.status, "ready");
    assert.deepEqual(need.media, [
      {
        id: SHA,
        url: `/v1/media/${SHA}`,
        kind: "image",
        type: "image/png",
        size: 2048,
        model: "gemini-3.1-flash-image",
        prompt: "A poster",
        inputs: [{ figure: "riders-forecast" }],
        label: "Illustrative",
        addedBy: "agent:media",
        addedAt: "2026-11-07T12:00:03.000Z",
      },
    ]);
    assert.deepEqual(state.media.get(SHA), { type: "image/png", size: 2048, need: NEED.id });
  });

  it("fail when an agent makes nothing, until a planner asks again", () => {
    const failed: [string, string, unknown] = ["agent:media", "need.create.failed", { need: NEED.id, reason: "image: the image model made no image" }];
    const need = needOf(fold([opened, added, requested, failed]));
    assert.equal(need.status, "failed");
    assert.equal(need.failure, "image: the image model made no image");
    assert.equal(need.failedBy, "agent:media");
    assert.equal(need.failedAt, "2026-11-07T12:00:03.000Z");

    const again = needOf(fold([opened, added, requested, failed, ["planner:bo", "need.create.requested", { need: NEED.id }]]));
    assert.equal(again.status, "creating");
    assert.equal(again.requestedBy, "planner:bo");
    assert.equal(again.failure, undefined);
  });

  it("stay ready when part of a request fails", () => {
    const failed: [string, string, unknown] = ["agent:media", "need.create.failed", { need: NEED.id, reason: "video: blocked" }];
    const need = needOf(fold([opened, added, requested, media, failed]));
    assert.equal(need.status, "ready");
    assert.equal(need.failure, "video: blocked");
  });

  it("stay creating until every kind asked for is made, and fail with what was made kept", () => {
    const both: [string, string, unknown] = ["agent:lead", "need.added", { ...NEED, kinds: ["image", "video"] }];
    const video: [string, string, unknown] = ["agent:media", "media.added", { ...(media[2] as object), sha256: "b".repeat(64), kind: "video", type: "video/mp4" }];
    const failed: [string, string, unknown] = ["agent:media", "need.create.failed", { need: NEED.id, reason: "video: blocked" }];
    assert.equal(needOf(fold([opened, both, requested, media])).status, "creating");

    const half = needOf(fold([opened, both, requested, media, failed]));
    assert.equal(half.status, "failed");
    assert.equal(half.failure, "video: blocked");
    assert.deepEqual(half.media.map((m) => m.kind), ["image"]);

    const again = [opened, both, requested, media, failed, ["planner:bo", "need.create.requested", { need: NEED.id }]] as [string, string, unknown][];
    assert.equal(needOf(fold(again)).status, "creating");
    assert.equal(needOf(fold([...again, video])).status, "ready");
  });

  it("refuse an entry for a need the log never added", () => {
    assert.throws(() => fold([opened, requested]), /unknown id "sunnybrook-poster"/);
  });

  it("serve a file two needs share under the other's name once one is dismissed, and not at all once both are", () => {
    const other = { ...NEED, id: "hospital-poster" };
    const shared: [string, string, unknown][] = [
      [opened[0], "need.added", other],
      ["planner:ana", "need.create.requested", { need: other.id }],
      ["agent:media", "media.added", { ...(media[2] as object), need: other.id }],
    ];
    const state = fold([opened, added, requested, media, ...shared, ["planner:ana", "need.dismissed", { need: NEED.id, reason: "Not going ahead" }]]);
    assert.equal(state.media.get(SHA)?.need, other.id);
    const gone = fold([opened, added, requested, media, ...shared, ["planner:ana", "need.dismissed", { need: NEED.id, reason: "Not going ahead" }], ["planner:ana", "need.dismissed", { need: other.id, reason: "Not going ahead" }]]);
    assert.equal(gone.media.get(SHA), undefined);
  });
});

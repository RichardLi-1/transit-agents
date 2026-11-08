import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overflow, toastless } from "./toasts.ts";

describe("toasts past the room", () => {
  it("let the oldest go", () => {
    assert.deepEqual(overflow([4, 3, 2, 1], undefined, 3), [1]);
    assert.deepEqual(overflow([3, 2, 1], undefined, 3), []);
  });

  it("keep the one with focus, and let the next oldest go instead", () => {
    assert.deepEqual(overflow([4, 3, 2, 1], 1, 3), [2]);
    // One with focus that would stay anyway changes nothing.
    assert.deepEqual(overflow([4, 3, 2, 1], 3, 3), [1]);
  });

  it("still show the newest beside the one with focus when there's room for only one", () => {
    assert.deepEqual(overflow([2, 1], 1, 1), []);
    assert.deepEqual(overflow([3, 2, 1], 1, 1), [2]);
  });
});

describe("toasts for what already shows", () => {
  it("skip an answer or a picture for the study on screen", () => {
    assert.equal(toastless({ kind: "answer", studyId: "ontario" }, "ontario"), true);
    assert.equal(toastless({ kind: "media", studyId: "ontario" }, "ontario"), true);
  });

  it("still toast them for another study, and toast anything that needs a planner", () => {
    assert.equal(toastless({ kind: "answer", studyId: "lawrence" }, "ontario"), false);
    assert.equal(toastless({ kind: "media", studyId: "lawrence" }, null), false);
    for (const kind of ["finding", "handover", "need", "decision", "brief", "document"] as const) {
      assert.equal(toastless({ kind, studyId: "ontario" }, "ontario"), false, kind);
    }
  });
});

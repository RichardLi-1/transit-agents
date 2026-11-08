import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { overflow } from "./toasts.ts";

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

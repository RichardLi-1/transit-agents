import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RATE_LIMITED } from "@transit-agents/contracts";
import { VisitorLimits } from "./limits.ts";
import { ApiError } from "./service.ts";

const A = "guest:AAAAAAAAAAAAAAAAAAAAAA";
const B = "guest:BBBBBBBBBBBBBBBBBBBBBB";

// How many of `count` writes go through.
function writes(limits: VisitorLimits, audience: string, count: number): number {
  let taken = 0;
  for (let i = 0; i < count; i += 1) {
    try {
      limits.take(audience);
      taken += 1;
    } catch (error) {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.message, RATE_LIMITED);
    }
  }
  return taken;
}

describe("visitor limits", () => {
  it("lets a visitor write 10 times a minute, apart from other visitors", () => {
    let now = new Date("2026-11-08T15:00:00Z");
    const limits = new VisitorLimits({ clock: () => now });
    assert.equal(writes(limits, A, 11), 10);
    assert.equal(writes(limits, B, 10), 10);
    now = new Date("2026-11-08T15:00:59Z");
    assert.equal(writes(limits, A, 1), 0);
    now = new Date("2026-11-08T15:01:00Z");
    assert.equal(writes(limits, A, 11), 10);
  });

  it("lets a visitor write 200 times a day, and all visitors 10,000", () => {
    let minute = 0;
    const start = new Date("2026-11-08T06:00:00Z").getTime();
    const limits = new VisitorLimits({ clock: () => new Date(start + minute * 60_000) });
    // A sends 300 writes, ten a minute.
    let taken = 0;
    for (; minute < 30; minute += 1) taken += writes(limits, A, 10);
    assert.equal(taken, 200);

    const few = new VisitorLimits({ allPerDay: 25, clock: () => new Date(start) });
    assert.equal(writes(few, A, 10) + writes(few, B, 10) + writes(few, "guest:CCCCCCCCCCCCCCCCCCCCCC", 10), 25);
  });

  it("starts each day again at midnight in Toronto", () => {
    let now = new Date("2026-11-08T04:59:00Z");
    const limits = new VisitorLimits({ perDay: 3, clock: () => now });
    assert.equal(writes(limits, A, 5), 3);
    // 05:00 UTC is midnight in Toronto in November.
    now = new Date("2026-11-08T05:00:00Z");
    assert.equal(writes(limits, A, 5), 3);
  });
});

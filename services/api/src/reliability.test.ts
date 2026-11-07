import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviationFrom, DepartureTracker, isOnTime, localClock, summarize, WINDOWS, type ScheduledTrip } from "./reliability.ts";

// 2026-11-07 12:00:00 in Toronto (EST).
const NOON = Date.UTC(2026, 10, 7, 17, 0, 0) / 1000;
const NOON_SECONDS = 12 * 3600;

const SCHEDULE: Record<string, ScheduledTrip> = {
  t1: { route: "52", pattern: "52F", firstSequence: 1, departure: NOON_SECONDS },
};
const tracker = () => new DepartureTracker((trip) => SCHEDULE[trip]);
const reading = (at: number, sequence: number, trip = "t1", vehicle = "v1") => ({ vehicle, trip, route: "52", sequence, at });

describe("DepartureTracker", () => {
  it("sees a departure on an in-order move off the first stop", () => {
    const t = tracker();
    assert.equal(t.observe(reading(NOON + 90, 1)), undefined);
    const departure = t.observe(reading(NOON + 120, 2));
    assert.equal(departure?.deviation, 105);
    assert.equal(departure?.pattern, "52F");
    assert.equal(departure?.date, "2026-11-07");
  });

  it("ignores a vehicle first seen mid-route", () => {
    const t = tracker();
    assert.equal(t.observe(reading(NOON, 5)), undefined);
    assert.equal(t.observe(reading(NOON + 30, 6)), undefined);
  });

  it("ignores a move when readings are too far apart to place it", () => {
    const t = tracker();
    t.observe(reading(NOON, 1));
    assert.equal(t.observe(reading(NOON + 300, 2)), undefined);
  });

  it("ignores readings that arrive out of order", () => {
    const t = tracker();
    t.observe(reading(NOON + 60, 1));
    assert.equal(t.observe(reading(NOON + 30, 2)), undefined);
  });

  it("is not fooled when a vehicle reports its next trip early", () => {
    const t = tracker();
    t.observe(reading(NOON - 30, 40, "earlier-trip"));
    assert.equal(t.observe(reading(NOON, 1, "t1")), undefined);
  });

  it("counts a trip once, even if it bounces back to the first stop", () => {
    const t = tracker();
    t.observe(reading(NOON, 1));
    assert.ok(t.observe(reading(NOON + 30, 2)));
    t.observe(reading(NOON + 60, 1));
    assert.equal(t.observe(reading(NOON + 90, 2)), undefined);
  });

  it("drops an impossible deviation, which means a reassigned trip", () => {
    const t = tracker();
    t.observe(reading(NOON + 5 * 3600, 1));
    assert.equal(t.observe(reading(NOON + 5 * 3600 + 30, 2)), undefined);
  });

  it("ignores trips with no schedule", () => {
    const t = tracker();
    t.observe(reading(NOON, 1, "unknown"));
    assert.equal(t.observe(reading(NOON + 30, 2, "unknown")), undefined);
  });
});

describe("clock", () => {
  it("uses Toronto time", () => {
    assert.deepEqual(localClock(NOON), { date: "2026-11-07", seconds: NOON_SECONDS });
  });

  it("handles a trip scheduled past midnight", () => {
    assert.equal(deviationFrom(25 * 3600, 3600 + 60), 60);
  });

  it("handles an ordinary trip", () => {
    assert.equal(deviationFrom(NOON_SECONDS, NOON_SECONDS - 30), -30);
  });
});

describe("on-time windows", () => {
  it("differ on an early departure", () => {
    assert.equal(isOnTime(-30, WINDOWS.standard), true);
    assert.equal(isOnTime(-30, WINDOWS.reported), false);
  });

  it("agree at the late edge", () => {
    assert.equal(isOnTime(300, WINDOWS.standard), true);
    assert.equal(isOnTime(301, WINDOWS.reported), false);
  });
});

describe("summarize", () => {
  it("counts each window by day", () => {
    const days = summarize([
      { date: "2026-11-08", deviation: 0 },
      { date: "2026-11-07", deviation: -30 },
      { date: "2026-11-07", deviation: 400 },
    ]);
    assert.deepEqual(days, [
      { date: "2026-11-07", departures: 2, onTimeStandard: 1, onTimeReported: 0 },
      { date: "2026-11-08", departures: 1, onTimeStandard: 1, onTimeReported: 1 },
    ]);
  });
});

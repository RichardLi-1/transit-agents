import assert from "node:assert/strict";
import { describe, it } from "node:test";
import GtfsRealtime from "gtfs-realtime-bindings";
import { NewFigure, NewStudy, NewContext } from "@transit-agents/contracts";
import { Collector, Measurements, openMeasurements } from "./collector.ts";
import { Service } from "./service.ts";
import { buildTimeline } from "./timeline.ts";

const { transit_realtime: realtime } = GtfsRealtime;

const NOON = Date.UTC(2026, 10, 7, 17, 0, 0) / 1000;

function feed(vehicles: { id: string; trip: string; sequence: number; at: number }[]) {
  const message = realtime.FeedMessage.create({
    header: { gtfsRealtimeVersion: "2.0", timestamp: NOON },
    entity: vehicles.map((v) => ({
      id: v.id,
      vehicle: {
        vehicle: { id: v.id },
        trip: { tripId: v.trip, routeId: "52" },
        position: { latitude: 43.7, longitude: -79.4 },
        currentStopSequence: v.sequence,
        timestamp: v.at,
      },
    })),
  });
  return realtime.FeedMessage.encode(message).finish();
}

const schedule = new Map([["t1", { route: "52", pattern: "52F", firstSequence: 1, departure: 12 * 3600, days: 1 | 2 }]]);

function collectorWith(frames: Uint8Array[]) {
  const db = openMeasurements(":memory:");
  let i = 0;
  const collector = new Collector(db, schedule, { fetchFeed: async () => frames[i++] as Uint8Array });
  return { collector, measurements: new Measurements(db, schedule) };
}

describe("Collector", () => {
  it("turns two readings into a measured departure, with the scheduled count beside it", async () => {
    const { collector, measurements } = collectorWith([
      feed([{ id: "v1", trip: "t1", sequence: 1, at: NOON + 30 }]),
      feed([{ id: "v1", trip: "t1", sequence: 2, at: NOON + 60 }]),
    ]);
    await collector.poll();
    await collector.poll();
    const [day] = measurements.reliability(["52F"], new Date((NOON + 3600) * 1000));
    // The trip was due at noon, inside the time the collector was running.
    assert.deepEqual(day, { date: "2026-11-07", departures: 1, onTimeStandard: 1, onTimeReported: 1, scheduled: 1 });
    assert.deepEqual(measurements.reliability(["11B"]), []);
  });

  it("serves the latest live positions with their pattern, filtered by route", async () => {
    const { collector, measurements } = collectorWith([
      feed([{ id: "v1", trip: "t1", sequence: 3, at: NOON }]),
      feed([{ id: "v2", trip: "t1", sequence: 4, at: NOON + 30 }]),
    ]);
    await collector.poll();
    await collector.poll();
    const vehicles = measurements.vehicles(["52"]);
    assert.deepEqual(vehicles.map((v) => [v.id, v.pattern]), [["v2", "52F"]]);
    assert.equal(measurements.vehicles(["11"]).length, 0);
  });
});

describe("buildTimeline", () => {
  it("keeps measured results and forecasts apart", () => {
    const service = new Service(":memory:");
    service.addContext("integration:seed", NewContext.parse({ id: "plan", title: "Plan", pages: [{ page: 1, text: "an increase of 1,680 customers" }] }));
    service.openStudy("a", NewStudy.parse({ id: "s", title: "S", watch: ["52F"], project: ["riders"], trial: { startedOn: "2026-11-01", reviewOn: "2027-11-01" } }));
    service.addFigure("a", "s", NewFigure.parse({ id: "riders", label: "Riders", unit: "riders/week", value: 1680, basis: { kind: "cited", citation: { contextId: "plan", page: 1, quote: "an increase of 1,680 customers" } } }));
    const collector = { reliability: (patterns?: string[]) => (patterns ? [{ date: "2026-11-07", departures: 10, onTimeStandard: 7, onTimeReported: 6, scheduled: 12 }] : []) };
    const timeline = buildTimeline(service, collector, "s", new Date(NOON * 1000));
    assert.equal(timeline.today, "2026-11-07");
    assert.equal(timeline.reviewOn, "2027-11-01");
    assert.equal(timeline.measured.days[0]?.departures, 10);
    assert.deepEqual(timeline.forecast, [{ figure: "riders", label: "Riders", unit: "riders/week", perWeek: 1680 }]);
  });
});

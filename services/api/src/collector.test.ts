import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import GtfsRealtime from "gtfs-realtime-bindings";
import { NewFigure, NewStudy, NewContext } from "@transit-agents/contracts";
import { Collector } from "./collector.ts";
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

const schedule = new Map([["t1", { route: "52", pattern: "52F", firstSequence: 1, departure: 12 * 3600 }]]);

function collectorWith(frames: Uint8Array[]) {
  const db = new DatabaseSync(":memory:");
  let i = 0;
  return new Collector(db, schedule, async () => frames[i++] as Uint8Array);
}

describe("Collector", () => {
  it("turns two readings into a measured departure", async () => {
    const collector = collectorWith([
      feed([{ id: "v1", trip: "t1", sequence: 1, at: NOON + 30 }]),
      feed([{ id: "v1", trip: "t1", sequence: 2, at: NOON + 60 }]),
    ]);
    await collector.poll();
    await collector.poll();
    assert.deepEqual(collector.reliability(["52F"]), [{ date: "2026-11-07", departures: 1, onTimeStandard: 1, onTimeReported: 1 }]);
    assert.deepEqual(collector.reliability(["11B"]), []);
  });

  it("serves live positions with their pattern, filtered by route", async () => {
    const collector = collectorWith([feed([{ id: "v1", trip: "t1", sequence: 3, at: NOON }])]);
    await collector.poll();
    const [vehicle] = collector.vehicles(["52"]);
    assert.equal(vehicle?.pattern, "52F");
    assert.equal(collector.vehicles(["11"]).length, 0);
  });
});

describe("buildTimeline", () => {
  it("keeps measured results and forecasts apart", () => {
    const service = new Service(":memory:");
    service.addContext("a", NewContext.parse({ id: "plan", title: "Plan", pages: [{ page: 1, text: "an increase of 1,680 customers" }] }));
    service.openStudy("a", NewStudy.parse({ id: "s", title: "S", watch: ["52F"], project: ["riders"], trial: { startedOn: "2026-11-01", reviewOn: "2027-11-01" } }));
    service.addFigure("a", "s", NewFigure.parse({ id: "riders", label: "Riders", unit: "riders/week", value: 1680, basis: { kind: "cited", citation: { contextId: "plan", page: 1, quote: "an increase of 1,680 customers" } } }));
    const collector = { reliability: (patterns?: string[]) => (patterns ? [{ date: "2026-11-07", departures: 10, onTimeStandard: 7, onTimeReported: 6 }] : []) };
    const timeline = buildTimeline(service, collector, "s", new Date(NOON * 1000));
    assert.equal(timeline.today, "2026-11-07");
    assert.equal(timeline.reviewOn, "2027-11-01");
    assert.equal(timeline.measured.days[0]?.departures, 10);
    assert.deepEqual(timeline.forecast, [{ figure: "riders", label: "Riders", unit: "riders/week", perWeek: 1680 }]);
  });
});

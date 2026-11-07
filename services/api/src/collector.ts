// Reads the public live vehicle feed. Positions serve the display, and departures
// feed the reliability measure. Measurements are kept apart from the log: they are
// observations of the world, not decisions.
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import GtfsRealtime from "gtfs-realtime-bindings";
import { DepartureTracker, summarize, type Departure, type ScheduledTrip } from "./reliability.ts";

const { transit_realtime: realtime } = GtfsRealtime;

const FEED_URL = "https://bustime.ttc.ca/gtfsrt/vehicles";
const POLL_MS = 30_000;

export type LiveVehicle = { id: string; route: string; pattern: string; lat: number; lon: number; at: number };

export function loadSchedule(path: string): Map<string, ScheduledTrip> {
  const records = JSON.parse(gunzipSync(readFileSync(path)).toString()) as [string, string, string, number, number][];
  return new Map(records.map(([id, route, pattern, firstSequence, departure]) => [id, { route, pattern, firstSequence, departure }]));
}

export class Collector {
  private readonly db: DatabaseSync;
  private readonly schedule: Map<string, ScheduledTrip>;
  private readonly tracker: DepartureTracker;
  private readonly fetchFeed: () => Promise<Uint8Array>;
  private vehiclesNow: LiveVehicle[] = [];
  private timer: NodeJS.Timeout | undefined;
  lastPoll: number | null = null;

  constructor(db: DatabaseSync, schedule: Map<string, ScheduledTrip>, fetchFeed?: () => Promise<Uint8Array>) {
    this.db = db;
    this.schedule = schedule;
    this.tracker = new DepartureTracker((trip) => schedule.get(trip));
    this.fetchFeed =
      fetchFeed ??
      (async () => {
        const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`Feed returned ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
    db.exec(`
      CREATE TABLE IF NOT EXISTS departures (
        trip TEXT NOT NULL,
        date TEXT NOT NULL,
        route TEXT NOT NULL,
        pattern TEXT NOT NULL,
        scheduled INTEGER NOT NULL,
        actual INTEGER NOT NULL,
        deviation INTEGER NOT NULL,
        PRIMARY KEY (trip, date)
      );
      CREATE INDEX IF NOT EXISTS departures_pattern ON departures (pattern, date);
    `);
  }

  async poll() {
    const feed = realtime.FeedMessage.decode(await this.fetchFeed());
    const vehicles: LiveVehicle[] = [];
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO departures (trip, date, route, pattern, scheduled, actual, deviation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const entity of feed.entity) {
      const v = entity.vehicle;
      const id = v?.vehicle?.id;
      const trip = v?.trip?.tripId;
      const route = v?.trip?.routeId;
      const position = v?.position;
      if (!v || !id || !trip || !route || !position) continue;
      const at = Number(v.timestamp ?? 0);
      const departure = this.tracker.observe({ vehicle: id, trip, route, sequence: v.currentStopSequence ?? 0, at });
      if (departure) {
        const d: Departure = departure;
        insert.run(d.trip, d.date, d.route, d.pattern, d.scheduled, d.actual, d.deviation);
      }
      vehicles.push({
        id,
        route,
        pattern: this.schedule.get(trip)?.pattern ?? route,
        lat: position.latitude,
        lon: position.longitude,
        at,
      });
    }
    this.vehiclesNow = vehicles;
    this.lastPoll = Date.now();
  }

  start() {
    const tick = () => {
      this.poll().catch((error) => console.error("Vehicle feed failed:", (error as Error).message));
    };
    tick();
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  vehicles(routes: string[]): LiveVehicle[] {
    return routes.length ? this.vehiclesNow.filter((v) => routes.includes(v.route)) : this.vehiclesNow;
  }

  // On-time results by day, for patterns such as 52F, or for every route.
  reliability(patterns?: string[]) {
    const where = patterns?.length ? `WHERE pattern IN (${patterns.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`SELECT date, deviation FROM departures ${where}`).all(...(patterns ?? [])) as {
      date: string;
      deviation: number;
    }[];
    return summarize(rows);
  }
}

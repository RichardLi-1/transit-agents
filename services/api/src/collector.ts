// Reads the public live vehicle feed. It runs as its own process, so restarting
// the API never leaves a gap in a trial's record. It writes three things:
//
//   departures    measured departures, for on-time results
//   vehicles_now  the latest positions, for the display
//   archive       raw positions for watched routes, one file a day, for research
//
// Measurements are kept apart from the log: they are observations of the world,
// not decisions.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import GtfsRealtime from "gtfs-realtime-bindings";
import { DepartureTracker, localClock, scheduledCount, summarize, type ScheduledTrip } from "./reliability.ts";

const { transit_realtime: realtime } = GtfsRealtime;

const FEED_URL = "https://bustime.ttc.ca/gtfsrt/vehicles";
const POLL_MS = 30_000;

export type LiveVehicle = { id: string; route: string; pattern: string; lat: number; lon: number; at: number };

const SCHEMA = `
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
  CREATE TABLE IF NOT EXISTS vehicles_now (
    id TEXT PRIMARY KEY,
    route TEXT NOT NULL,
    pattern TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS polls (at INTEGER NOT NULL);
`;

export function openMeasurements(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

// Runs work in one transaction. SQLite rolls back on its own after some errors,
// such as a full disk, and a second ROLLBACK would hide the real error behind
// "cannot rollback - no transaction is active".
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function loadSchedule(path: string): Map<string, ScheduledTrip> {
  const records = JSON.parse(gunzipSync(readFileSync(path)).toString()) as [string, string, string, number, number, number][];
  return new Map(records.map(([id, route, pattern, firstSequence, departure, days]) => [id, { route, pattern, firstSequence, departure, days }]));
}

export class Collector {
  private readonly db: DatabaseSync;
  private readonly schedule: Map<string, ScheduledTrip>;
  private readonly tracker: DepartureTracker;
  private readonly fetchFeed: () => Promise<Uint8Array>;
  private readonly archive: { dir: string; routes: Set<string> } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    db: DatabaseSync,
    schedule: Map<string, ScheduledTrip>,
    options: { fetchFeed?: () => Promise<Uint8Array>; archive?: { dir: string; routes: string[] } } = {},
  ) {
    this.db = db;
    this.schedule = schedule;
    this.tracker = new DepartureTracker((trip) => schedule.get(trip));
    this.archive = options.archive && { dir: options.archive.dir, routes: new Set(options.archive.routes) };
    if (this.archive) mkdirSync(this.archive.dir, { recursive: true });
    this.fetchFeed =
      options.fetchFeed ??
      (async () => {
        const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`Feed returned ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
  }

  async poll() {
    const feed = realtime.FeedMessage.decode(await this.fetchFeed());
    const feedAt = Number(feed.header.timestamp ?? 0);
    const insertDeparture = this.db.prepare(
      "INSERT OR IGNORE INTO departures (trip, date, route, pattern, scheduled, actual, deviation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insertVehicle = this.db.prepare("INSERT INTO vehicles_now (id, route, pattern, lat, lon, at) VALUES (?, ?, ?, ?, ?, ?)");
    const archived: string[] = [];

    inTransaction(this.db, () => {
      this.db.exec("DELETE FROM vehicles_now");
      for (const entity of feed.entity) {
        const v = entity.vehicle;
        const id = v?.vehicle?.id;
        const trip = v?.trip?.tripId;
        const route = v?.trip?.routeId;
        const position = v?.position;
        if (!v || !id || !trip || !route || !position) continue;
        const at = Number(v.timestamp ?? 0);
        const sequence = v.currentStopSequence ?? 0;
        const d = this.tracker.observe({ vehicle: id, trip, route, sequence, at });
        if (d) insertDeparture.run(d.trip, d.date, d.route, d.pattern, d.scheduled, d.actual, d.deviation);
        const pattern = this.schedule.get(trip)?.pattern ?? route;
        insertVehicle.run(id, route, pattern, position.latitude, position.longitude, at);
        if (this.archive?.routes.has(route)) {
          archived.push(
            JSON.stringify({ feed: feedAt, at, vehicle: id, route, trip, stop: v.stopId ?? "", seq: sequence, status: v.currentStatus ?? null, lat: position.latitude, lon: position.longitude }),
          );
        }
      }
      this.db.prepare("INSERT INTO polls (at) VALUES (?)").run(feedAt);
    });
    if (this.archive && archived.length) {
      appendFileSync(join(this.archive.dir, `${localClock(feedAt).date}.jsonl`), `${archived.join("\n")}\n`);
    }
  }

  start() {
    const tick = () => {
      this.poll().catch((error) => console.error("Vehicle feed failed:", (error as Error).message));
    };
    tick();
    this.timer = setInterval(tick, POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }
}

// The API's read-only view of what the collector recorded.
export class Measurements {
  private readonly db: DatabaseSync;
  private readonly schedule: Map<string, ScheduledTrip>;

  constructor(db: DatabaseSync, schedule: Map<string, ScheduledTrip>) {
    this.db = db;
    this.schedule = schedule;
  }

  vehicles(routes: string[]): LiveVehicle[] {
    const all = this.db.prepare("SELECT * FROM vehicles_now").all() as LiveVehicle[];
    return routes.length ? all.filter((v) => routes.includes(v.route)) : all;
  }

  // On-time results by day for patterns such as 52F, or for every route, each
  // with the number of trips the timetable planned.
  reliability(patterns?: string[], now = new Date()) {
    const where = patterns?.length ? `WHERE pattern IN (${patterns.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`SELECT date, deviation FROM departures ${where}`).all(...(patterns ?? [])) as {
      date: string;
      deviation: number;
    }[];
    const wanted = patterns?.length ? new Set(patterns) : null;
    const today = localClock(Math.floor(now.getTime() / 1000));
    const firstPoll = (this.db.prepare("SELECT MIN(at) AS at FROM polls").get() as { at: number | null }).at;
    const started = firstPoll ? localClock(firstPoll) : today;
    return summarize(rows, (date) => {
      // Count only the part of each day the collector was running.
      const from = date === started.date ? started.seconds : 0;
      const until = date === today.date ? today.seconds : Infinity;
      return scheduledCount([...this.schedule.values()].filter((t) => t.departure >= from), wanted, date, until);
    });
  }
}

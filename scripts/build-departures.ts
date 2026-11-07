// Extracts each trip's first scheduled departure from the BusTime GTFS, whose trip
// IDs match the live feed. The main TTC schedule feed's IDs do not.
//
// Usage: node scripts/build-departures.ts <surface-gtfs-dir>
import { createReadStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";

const GTFS = process.argv[2];
if (!GTFS) throw new Error("Usage: build-departures.ts <surface-gtfs-dir>");
const OUT = join(import.meta.dirname, "../services/api/assets/departures.json.gz");

async function* rows(file: string) {
  let header: string[] | undefined;
  for await (const raw of createInterface({ input: createReadStream(join(GTFS as string, file)), crlfDelay: Infinity })) {
    const cells = raw.replace(/^﻿/, "").split(",");
    if (!header) header = cells;
    else yield Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""])) as Record<string, string>;
  }
}

// Which days each service runs, as a mask: 1 weekday, 2 Saturday, 4 Sunday.
const days = new Map<string, number>();
for await (const c of rows("calendar.txt")) {
  const weekday = ["monday", "tuesday", "wednesday", "thursday", "friday"].some((d) => c[d] === "1") ? 1 : 0;
  days.set(c.service_id as string, weekday | (c.saturday === "1" ? 2 : 0) | (c.sunday === "1" ? 4 : 0));
}

const trips = new Map<string, { route: string; pattern: string; days: number }>();
for await (const t of rows("trips.txt")) {
  // "East - 52F Lawrence West towards ..." gives pattern 52F.
  const pattern = /^\w+ - (\S+)/.exec(t.trip_headsign as string)?.[1] ?? (t.route_id as string);
  trips.set(t.trip_id as string, { route: t.route_id as string, pattern, days: days.get(t.service_id as string) ?? 0 });
}

const first = new Map<string, { sequence: number; departure: number }>();
for await (const s of rows("stop_times.txt")) {
  const id = s.trip_id as string;
  if (!trips.has(id)) continue;
  const sequence = Number(s.stop_sequence);
  const known = first.get(id);
  if (known && known.sequence <= sequence) continue;
  const [h = 0, m = 0, sec = 0] = (s.departure_time as string).split(":").map(Number);
  first.set(id, { sequence, departure: h * 3600 + m * 60 + sec });
}

const records = [...first].map(([id, { sequence, departure }]) => {
  const trip = trips.get(id) as { route: string; pattern: string; days: number };
  return [id, trip.route, trip.pattern, sequence, departure, trip.days];
});
writeFileSync(OUT, gzipSync(JSON.stringify(records), { level: 9 }));
console.log("trips", records.length);

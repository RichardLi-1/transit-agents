// Turns a TTC GTFS feed into the small static files the display draws from.
//
//   network.bin   every route as polylines, Int16 pairs in 2 m units
//   network.json  route table, and trips started per route, day type and hour
//   studies.json  each study's line, and the scheduled trips that run on it
//
// Usage: node scripts/build-transit-data.ts <gtfs-dir> [out-dir]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rows as readRows } from "./csv.ts";
import { ONTARIO_LINE, ontarioStudyLine } from "./ontario-study-line.ts";

const GTFS = process.argv[2];
if (!GTFS) throw new Error("Usage: build-transit-data.ts <gtfs-dir> [out-dir]");
const OUT = process.argv[3] ?? join(import.meta.dirname, "../apps/display/public/data");

const ORIGIN = { lat: 43.7, lon: -79.4 };
const UNIT_METRES = 2;
const SIMPLIFY_METRES = 10;
const SHAPES_PER_ROUTE = 4;
const DAY_TYPES = ["weekday", "saturday", "sunday"] as const;
type DayType = (typeof DAY_TYPES)[number];

// Which trips belong to each study. Southbound 11 trips share one headsign across
// branches, so `maxLat` separates the 11B from the branch that runs to Steeles.
type StudyPattern = { headsign: RegExp; maxLat?: number };

const LAWRENCE_AVE_LAT = 43.735;

const STUDY_PATTERNS: Record<string, StudyPattern[]> = {
  "lawrence-sunnybrook": [
    { headsign: /^East - 52F .*Sunnybrook/ },
    { headsign: /^West - 52F / },
    { headsign: /^North - 11B .*Lawrence Station/ },
    { headsign: /^South - 11 .*Davisville/, maxLat: LAWRENCE_AVE_LAT },
  ],
  "sherbourne-castle-frank": [{ headsign: /^North - 75 / }],
};

// The Rosedale proposal was never built, so its line is the current northbound 75
// extended along Bloor to Castle Frank Station. It has no scheduled trips.
const UNBUILT_EXTENSIONS: Record<string, { stop: RegExp }> = {
  "sherbourne-castle-frank": { stop: /^Castle Frank Station/ },
};

type Point = [number, number];

const rows = (file: string) => readRows(GTFS as string, file);

const METRES_PER_DEG_LAT = 110_574;
const METRES_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const project = (lat: number, lon: number): Point => [
  (lon - ORIGIN.lon) * METRES_PER_DEG_LON,
  (lat - ORIGIN.lat) * METRES_PER_DEG_LAT,
];

// Ramer-Douglas-Peucker, iterative so long shapes can't overflow the stack.
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const [ax, ay] = points[a] as Point;
    const [bx, by] = points[b] as Point;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy) || 1e-9;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i] as Point;
      const distance = Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
      if (distance > worst) {
        worst = distance;
        at = i;
      }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const seconds = (time: string) => {
  const [h = 0, m = 0, s = 0] = time.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  mkdirSync(OUT, { recursive: true });

  const routes = new Map<string, { id: string; name: string; type: number; color: string }>();
  for await (const r of rows("routes.txt")) {
    routes.set(r.route_id as string, {
      id: r.route_short_name as string,
      name: r.route_long_name as string,
      type: Number(r.route_type),
      color: r.route_color as string,
    });
  }

  const dayOfService = new Map<string, DayType>();
  let serviceUntil = "";
  for await (const c of rows("calendar.txt")) {
    const day: DayType = c.monday === "1" ? "weekday" : c.saturday === "1" ? "saturday" : "sunday";
    dayOfService.set(c.service_id as string, day);
    const end = (c.end_date as string).trim();
    if (end > serviceUntil) serviceUntil = end;
  }

  type Trip = { route: string; shape: string; day: DayType; headsign: string };
  const trips = new Map<string, Trip>();
  const shapeUse = new Map<string, Map<string, number>>();
  for await (const t of rows("trips.txt")) {
    const day = dayOfService.get(t.service_id as string);
    if (!day) continue;
    const trip = { route: t.route_id as string, shape: t.shape_id as string, day, headsign: t.trip_headsign as string };
    trips.set(t.trip_id as string, trip);
    const use = shapeUse.get(trip.route) ?? new Map<string, number>();
    use.set(trip.shape, (use.get(trip.shape) ?? 0) + 1);
    shapeUse.set(trip.route, use);
  }

  const candidates = new Map<string, Map<string, number | undefined>>();
  for (const [study, patterns] of Object.entries(STUDY_PATTERNS)) {
    const shapes = new Map<string, number | undefined>();
    for (const trip of trips.values()) {
      const match = patterns.find((p) => p.headsign.test(trip.headsign));
      if (match) shapes.set(trip.shape, match.maxLat);
    }
    candidates.set(study, shapes);
  }

  const wanted = new Set<string>();
  const routeShapes = new Map<string, string[]>();
  for (const [route, use] of shapeUse) {
    const top = [...use.entries()].sort((a, b) => b[1] - a[1]).slice(0, SHAPES_PER_ROUTE).map(([shape]) => shape);
    routeShapes.set(route, top);
    for (const shape of top) wanted.add(shape);
  }
  for (const shapes of candidates.values()) for (const shape of shapes.keys()) wanted.add(shape);

  const raw = new Map<string, [number, Point][]>();
  for await (const p of rows("shapes.txt")) {
    const id = p.shape_id as string;
    if (!wanted.has(id)) continue;
    const list = raw.get(id) ?? [];
    list.push([Number(p.shape_pt_sequence), project(Number(p.shape_pt_lat), Number(p.shape_pt_lon))]);
    raw.set(id, list);
  }
  const shapes = new Map<string, Point[]>();
  for (const [id, list] of raw) {
    shapes.set(id, list.sort((a, b) => a[0] - b[0]).map(([, point]) => point));
  }

  const studyShapes = new Map<string, Set<string>>();
  for (const [study, shapeLimits] of candidates) {
    const kept = new Set<string>();
    for (const [id, maxLat] of shapeLimits) {
      const limit = maxLat === undefined ? Infinity : project(maxLat, ORIGIN.lon)[1];
      if ((shapes.get(id) ?? []).every(([, y]) => y <= limit)) kept.add(id);
    }
    studyShapes.set(study, kept);
  }

  const stops: { name: string; point: Point }[] = [];
  for await (const s of rows("stops.txt")) {
    stops.push({ name: s.stop_name as string, point: project(Number(s.stop_lat), Number(s.stop_lon)) });
  }

  // First and last time of every trip, for schedules and for hourly service.
  const span = new Map<string, { start: number; end: number }>();
  for await (const s of rows("stop_times.txt")) {
    const id = s.trip_id as string;
    if (!trips.has(id)) continue;
    const time = seconds(s.arrival_time as string);
    const known = span.get(id);
    if (!known) span.set(id, { start: time, end: time });
    else {
      known.start = Math.min(known.start, time);
      known.end = Math.max(known.end, time);
    }
  }

  const routeIndex = new Map([...routes.keys()].map((id, i) => [id, i]));
  const service = [...routes.keys()].map(() => DAY_TYPES.map(() => new Array<number>(24).fill(0)));
  for (const [id, { start }] of span) {
    const trip = trips.get(id) as Trip;
    const hour = Math.floor(start / 3600) % 24;
    const row = service[routeIndex.get(trip.route) as number]?.[DAY_TYPES.indexOf(trip.day)];
    if (row) row[hour] = (row[hour] ?? 0) + 1;
  }

  const coordinates: number[] = [];
  const polylines: { route: number; start: number; count: number }[] = [];
  for (const [route, ids] of routeShapes) {
    for (const id of ids) {
      const line = simplify(shapes.get(id) ?? [], SIMPLIFY_METRES);
      if (line.length < 2) continue;
      polylines.push({ route: routeIndex.get(route) as number, start: coordinates.length / 2, count: line.length });
      for (const [x, y] of line) coordinates.push(Math.round(x / UNIT_METRES), Math.round(y / UNIT_METRES));
    }
  }
  if (coordinates.some((c) => Math.abs(c) > 32767)) throw new Error("Network exceeds Int16 range");
  writeFileSync(join(OUT, "network.bin"), Buffer.from(Int16Array.from(coordinates).buffer));

  writeFileSync(
    join(OUT, "network.json"),
    JSON.stringify({
      origin: ORIGIN,
      unitMetres: UNIT_METRES,
      // The last day the timetable covers. Nothing after it is drawn as scheduled.
      serviceUntil: `${serviceUntil.slice(0, 4)}-${serviceUntil.slice(4, 6)}-${serviceUntil.slice(6, 8)}`,
      dayTypes: DAY_TYPES,
      routes: [...routes.values()].map((r, i) => ({ ...r, service: service[i] })),
      polylines,
    }),
  );

  const studies: Record<string, unknown> = {};
  for (const [study, ids] of studyShapes) {
    const patterns = [...ids];
    const extension = UNBUILT_EXTENSIONS[study];
    const lines = patterns.map((id) => {
      const line = simplify(shapes.get(id) ?? [], 4);
      if (extension) {
        const stop = stops.find((s) => extension.stop.test(s.name));
        if (!stop) throw new Error(`No stop matching ${extension.stop}`);
        line.push(stop.point);
      }
      return line.map(([x, y]) => [round1(x), round1(y)]);
    });
    const schedule: Record<DayType, [number, number, number][]> = { weekday: [], saturday: [], sunday: [] };
    if (!extension) {
      for (const [tripId, { start, end }] of span) {
        const trip = trips.get(tripId) as Trip;
        const pattern = patterns.indexOf(trip.shape);
        if (pattern === -1 || end <= start) continue;
        schedule[trip.day].push([pattern, start, end]);
      }
    }
    for (const list of Object.values(schedule)) list.sort((a, b) => a[1] - b[1]);
    studies[study] = { lines, schedule };
  }
  studies[ONTARIO_LINE] = ontarioStudyLine();
  writeFileSync(join(OUT, "studies.json"), JSON.stringify(studies));

  const feedInfo = readFileSync(join(GTFS as string, "calendar.txt"), "utf8").split("\n")[1];
  console.log({
    routes: routes.size,
    polylines: polylines.length,
    points: coordinates.length / 2,
    networkKb: Math.round((coordinates.length * 2) / 1024),
    calendar: feedInfo,
    studies: Object.fromEntries([...studyShapes].map(([k, v]) => [k, v.size])),
  });
}

await main();

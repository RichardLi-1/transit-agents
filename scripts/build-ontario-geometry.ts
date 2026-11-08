// Builds the map geometry for the Ontario Line study from OpenStreetMap:
//
//   data/ontario-line.geojson         the line under construction, Exhibition to Don
//                                     Valley (formerly Science Centre), and its stations
//   data/don-mills-extension.geojson  a hypothetical extension from Don Valley north
//                                     along Don Mills Road to Sheppard, and its stations
//
// Coordinates are longitude and latitude. Each line runs midway between its two
// tracks, or the road's two carriageways, simplified to 10 m like the network.
// The data is © OpenStreetMap contributors under the ODbL 1.0, so anything drawn
// from these files must credit OpenStreetMap.
//
// Usage: node scripts/build-ontario-geometry.ts <download-dir>
// Downloads into <download-dir> whatever isn't there yet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOWNLOADS = process.argv[2];
if (!DOWNLOADS) throw new Error("Usage: build-ontario-geometry.ts <download-dir>");
const OUT = join(import.meta.dirname, "data");

// The same flat projection as build-transit-data.ts, so lines match the network.
const ORIGIN = { lat: 43.7, lon: -79.4 };
const METRES_PER_DEG_LAT = 110_574;
const METRES_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);
const SIMPLIFY_METRES = 10;
const STEP_METRES = 5;

// The Ontario Line is mapped as two route relations, one per direction.
const NORTHBOUND = 17331423; // Exhibition to Don Valley
const SOUTHBOUND = 17331422; // Don Valley to Exhibition
const STATIONS = { count: 15, first: "Exhibition", last: "Don Valley" };
const LINE_4_DON_MILLS = 5318484736;

// Don Valley station sits east of Don Mills Road, and a train can't jog sideways,
// so the extension eases onto the middle of the road over this distance.
const EASE_METRES = 200;

// The extension's proposed stations, at the major streets it crosses.
const EXTENSION_STATIONS = [
  { name: "Lawrence", crossing: "Lawrence Avenue East" },
  { name: "York Mills", crossing: "York Mills Road" },
  { name: "Don Mills", crossing: "Sheppard Avenue East", interchange: "Line 4 Sheppard" },
];

type Point = [number, number];
type LatLon = { lat: number; lon: number };
type Element = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: LatLon;
  nodes?: number[];
  geometry?: LatLon[];
  members?: { type: string; ref: number }[];
  tags?: Record<string, string>;
  version?: number;
  timestamp?: string;
};
type Osm = { elements: Element[]; osm3s?: { timestamp_osm_base?: string }; remark?: string };

const AGENT = "transit-agents/1.0 (map geometry for a planning study)";
const OSM_API = "https://api.openstreetmap.org/api/0.6";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const QUERY = `[out:json][timeout:180];
rel(${NORTHBOUND});
way(r)->.line;
nwr(around.line:300)["construction:railway"="station"];
out center tags;
way["highway"]["name"="Don Mills Road"](43.712,-79.365,43.790,-79.325)->.road;
.road out geom tags;
way["highway"]["name"~"^(${EXTENSION_STATIONS.map((s) => s.crossing).join("|")})$"](around.road:120);
out geom tags;
node(id:${LINE_4_DON_MILLS});
out center tags;`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parse = (text: string): Osm | undefined => {
  try {
    const osm = JSON.parse(text) as Osm;
    return Array.isArray(osm.elements) && !osm.remark ? osm : undefined;
  } catch {
    return undefined;
  }
};

// Reads a download, fetching it first if it isn't there. Public Overpass servers
// are often busy, so each is tried in turn, a few times.
async function load(name: string, urls: string[], query?: string): Promise<Osm> {
  const file = join(DOWNLOADS as string, name);
  if (!existsSync(file)) {
    mkdirSync(DOWNLOADS as string, { recursive: true });
    let text = "";
    for (let attempt = 0; attempt < 3 && !text; attempt++) {
      if (attempt) await wait(30_000 * attempt);
      for (const url of urls) {
        const response = await fetch(url, {
          method: query ? "POST" : "GET",
          headers: { "user-agent": AGENT },
          body: query ? new URLSearchParams({ data: query }) : null,
        }).catch(() => undefined);
        const body = response?.ok ? await response.text() : "";
        if (parse(body)) {
          text = body;
          break;
        }
        console.warn(`${url}: ${response?.status ?? "no answer"}`);
      }
    }
    if (!text) throw new Error(`Could not download ${name}`);
    writeFileSync(file, text);
  }
  const osm = parse(readFileSync(file, "utf8"));
  if (!osm) throw new Error(`${file} is not OpenStreetMap JSON`);
  return osm;
}

const project = ({ lat, lon }: LatLon): Point => [(lon - ORIGIN.lon) * METRES_PER_DEG_LON, (lat - ORIGIN.lat) * METRES_PER_DEG_LAT];
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const lonLat = ([x, y]: Point): Point => [round6(x / METRES_PER_DEG_LON + ORIGIN.lon), round6(y / METRES_PER_DEG_LAT + ORIGIN.lat)];
const round10 = (n: number) => Math.round(n / 10) * 10;
const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lengthOf = (line: Point[]) => line.reduce((sum, p, i) => (i ? sum + distance(line[i - 1] as Point, p) : 0), 0);
const centreOf = (e: Element): LatLon | undefined => e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : undefined);

// One direction of the line: its track ways joined end to end, in order.
function track(osm: Osm, relationId: number): Point[] {
  const nodes = new Map<number, LatLon>();
  const ways = new Map<number, number[]>();
  for (const e of osm.elements) {
    if (e.type === "node" && e.lat !== undefined && e.lon !== undefined) nodes.set(e.id, { lat: e.lat, lon: e.lon });
    if (e.type === "way" && e.nodes) ways.set(e.id, e.nodes);
  }
  const relation = osm.elements.find((e) => e.type === "relation" && e.id === relationId);
  const ids: number[] = [];
  let joined = 0;
  for (const member of relation?.members ?? []) {
    if (member.type !== "way") continue;
    const way = [...(ways.get(member.ref) ?? [])];
    if (joined++ === 0) {
      ids.push(...way);
      continue;
    }
    // Only the second way shows which end of the first one comes last.
    const meets = (id: number | undefined) => way[0] === id || way.at(-1) === id;
    if (joined === 2 && !meets(ids.at(-1)) && meets(ids[0])) ids.reverse();
    if (way.at(-1) === ids.at(-1)) way.reverse();
    if (way[0] !== ids.at(-1)) throw new Error(`Relation ${relationId} has a gap at way ${member.ref}`);
    ids.push(...way.slice(1));
  }
  if (!joined) throw new Error(`Relation ${relationId} has no ways`);
  return ids.map((id) => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Node ${id} is missing`);
    return project(node);
  });
}

// The point on a line nearest to p, and how far along the line it is.
function nearest(line: Point[], p: Point) {
  let best = { offset: Infinity, along: 0, point: p };
  let run = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Point;
    const b = line[i] as Point;
    const length = distance(a, b);
    const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length ** 2)) : 0;
    const point: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const offset = distance(point, p);
    if (offset < best.offset) best = { offset, along: run + t * length, point };
    run += length;
  }
  return best;
}

// The part of a line between two distances along it.
function cut(line: Point[], from: number, to: number): Point[] {
  const out: Point[] = [];
  let run = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as Point;
    const b = line[i] as Point;
    const length = distance(a, b);
    const at = (d: number): Point => {
      const t = length ? (d - run) / length : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    if (run + length >= from && !out.length) out.push(at(Math.max(from, run)));
    if (out.length) {
      if (run + length >= to) {
        out.push(at(to));
        break;
      }
      out.push(b);
    }
    run += length;
  }
  return out;
}

// Midway between two lines that run side by side, such as two tracks or two
// carriageways, sampled every few metres along the first.
function middle(a: Point[], b: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < a.length; i++) {
    const from = a[i - 1] as Point;
    const to = a[i] as Point;
    const steps = Math.max(1, Math.round(distance(from, to) / STEP_METRES));
    for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
      const p: Point = [from[0] + ((to[0] - from[0]) * s) / steps, from[1] + ((to[1] - from[1]) * s) / steps];
      const { point } = nearest(b, p);
      out.push([(p[0] + point[0]) / 2, (p[1] + point[1]) / 2]);
    }
  }
  return out;
}

// Ramer-Douglas-Peucker, as in build-transit-data.ts.
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
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
      if (d > worst) {
        worst = d;
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

// Where two lines cross.
function crossings(a: Point[], b: Point[]): Point[] {
  const out: Point[] = [];
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [p, p2, q, q2] = [a[i - 1], a[i], b[j - 1], b[j]] as Point[] as [Point, Point, Point, Point];
      const r: Point = [p2[0] - p[0], p2[1] - p[1]];
      const s: Point = [q2[0] - q[0], q2[1] - q[1]];
      const denominator = r[0] * s[1] - r[1] * s[0];
      if (!denominator) continue;
      const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denominator;
      const u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push([p[0] + t * r[0], p[1] + t * r[1]]);
    }
  }
  return out;
}

type Carriageway = { graph: Map<string, { to: string; metres: number }[]>; points: Map<string, Point> };

// The ways a vehicle heading north, or south, may drive along.
function carriageway(ways: Element[], north: boolean): Carriageway {
  const graph: Carriageway["graph"] = new Map();
  const points = new Map<string, Point>();
  for (const way of ways) {
    const oneway = way.tags?.oneway === "yes" || way.tags?.oneway === "-1";
    const geometry = way.tags?.oneway === "-1" ? [...(way.geometry ?? [])].reverse() : (way.geometry ?? []);
    const first = geometry[0];
    const last = geometry.at(-1);
    if (!first || !last || (oneway && last.lat > first.lat !== north)) continue;
    for (let i = 1; i < geometry.length; i++) {
      const a = geometry[i - 1] as LatLon;
      const b = geometry[i] as LatLon;
      const [ka, kb] = [`${a.lat},${a.lon}`, `${b.lat},${b.lon}`];
      points.set(ka, project(a));
      points.set(kb, project(b));
      const metres = distance(project(a), project(b));
      graph.set(ka, [...(graph.get(ka) ?? []), { to: kb, metres }]);
      if (!oneway) graph.set(kb, [...(graph.get(kb) ?? []), { to: ka, metres }]);
    }
  }
  return { graph, points };
}

// The shortest drive between the road points nearest two places.
function drive({ graph, points }: Carriageway, from: Point, to: Point): Point[] {
  const closest = (p: Point) => [...points].reduce((best, next) => (distance(next[1], p) < distance(best[1], p) ? next : best))[0];
  const start = closest(from);
  const end = closest(to);
  const metres = new Map([[start, 0]]);
  const previous = new Map<string, string>();
  const open = new Set([start]);
  while (open.size) {
    let current = start;
    let least = Infinity;
    for (const key of open) {
      if ((metres.get(key) as number) < least) [current, least] = [key, metres.get(key) as number];
    }
    open.delete(current);
    if (current === end) break;
    for (const edge of graph.get(current) ?? []) {
      if (least + edge.metres < (metres.get(edge.to) ?? Infinity)) {
        metres.set(edge.to, least + edge.metres);
        previous.set(edge.to, current);
        open.add(edge.to);
      }
    }
  }
  if (!metres.has(end)) throw new Error("No drive along Don Mills Road between the two stations");
  const path = [end];
  while (path.at(-1) !== start) path.push(previous.get(path.at(-1) as string) as string);
  return path.reverse().map((key) => points.get(key) as Point);
}

const feature = (properties: Record<string, unknown>, geometry: { type: string; coordinates: unknown }) => ({ type: "Feature", properties, geometry });
const lineFeature = (properties: Record<string, unknown>, line: Point[]) => feature(properties, { type: "LineString", coordinates: line.map(lonLat) });
const pointFeature = (properties: Record<string, unknown>, p: Point) => feature(properties, { type: "Point", coordinates: lonLat(p) });

// One feature per line, so a change to one shows as one line in a diff.
function write(name: string, about: Record<string, unknown>, features: unknown[]) {
  const head = JSON.stringify({ type: "FeatureCollection", ...about }).slice(0, -1);
  writeFileSync(join(OUT, name), `${head},"features":[\n${features.map((f) => JSON.stringify(f)).join(",\n")}\n]}\n`);
}

async function main() {
  const northbound = await load(`relation-${NORTHBOUND}.json`, [`${OSM_API}/relation/${NORTHBOUND}/full.json`]);
  const southbound = await load(`relation-${SOUTHBOUND}.json`, [`${OSM_API}/relation/${SOUTHBOUND}/full.json`]);
  const overpass = await load("overpass.json", OVERPASS, QUERY);
  const osmBase = overpass.osm3s?.timestamp_osm_base;
  const credit = { license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", licenseUrl: "https://www.openstreetmap.org/copyright" };
  mkdirSync(OUT, { recursive: true });

  // The Ontario Line, cut at its end stations, so tail tracks beyond them are left out.
  const tracks = middle(track(northbound, NORTHBOUND), track(southbound, SOUTHBOUND));
  const byName = new Map<string, { name: string; osm: string; oldName?: string; centre: Point; along: number; offset: number }>();
  for (const e of overpass.elements) {
    const name = e.tags?.name;
    const at = centreOf(e);
    if (e.tags?.["construction:railway"] !== "station" || !name || !at) continue;
    const centre = project(at);
    const { along, offset } = nearest(tracks, centre);
    const known = byName.get(name);
    // A station can be mapped as several areas, such as its entrances. Keep the one nearest the track.
    if (offset < 60 && (!known || offset < known.offset)) {
      byName.set(name, { name, osm: `${e.type}/${e.id}`, centre, along, offset, ...(e.tags["old_name"] ? { oldName: e.tags["old_name"] } : {}) });
    }
  }
  const stations = [...byName.values()].sort((a, b) => a.along - b.along);
  if (stations.length !== STATIONS.count || stations[0]?.name !== STATIONS.first || stations.at(-1)?.name !== STATIONS.last) {
    throw new Error(`Unexpected stations: ${stations.map((s) => s.name).join(", ")}`);
  }
  const [first, last] = [stations[0], stations.at(-1)] as [(typeof stations)[number], (typeof stations)[number]];
  const line = simplify(cut(tracks, first.along, last.along), SIMPLIFY_METRES);
  const relations = [northbound, southbound].map((osm, i) => {
    const id = [NORTHBOUND, SOUTHBOUND][i];
    const relation = osm.elements.find((e) => e.type === "relation" && e.id === id);
    return { osm: `relation/${id}`, version: relation?.version, timestamp: relation?.timestamp };
  });
  write(
    "ontario-line.geojson",
    { name: "Ontario Line", status: "under construction", source: relations, stationsAsOf: osmBase, ...credit },
    [
      lineFeature({ kind: "line", name: "Ontario Line", from: STATIONS.first, to: STATIONS.last, lengthMetres: round10(lengthOf(line)) }, line),
      ...stations.map(({ name, oldName, osm, centre }) => {
        const at = nearest(line, centre);
        return pointFeature({ kind: "station", name, ...(oldName ? { oldName } : {}), osm, alongMetres: round10(at.along) }, at.point);
      }),
    ],
  );

  // The extension: from Don Valley station north along the middle of Don Mills
  // Road to Sheppard Avenue, where it would meet Line 4.
  const road = overpass.elements.filter((e) => e.type === "way" && e.tags?.highway && e.tags.name === "Don Mills Road" && e.geometry);
  const lineFour = overpass.elements.find((e) => e.type === "node" && e.id === LINE_4_DON_MILLS);
  const lineFourAt = lineFour && centreOf(lineFour);
  if (!road.length || !lineFourAt) throw new Error("Don Mills Road or Line 4's Don Mills station is missing");
  const start = line.at(-1) as Point;
  const south: Point = [start[0], start[1] - 300];
  const north: Point = [project(lineFourAt)[0], project(lineFourAt)[1] + 400];
  const centre = middle(drive(carriageway(road, true), south, north), drive(carriageway(road, false), north, south).reverse());
  const crossingAt = EXTENSION_STATIONS.map(({ crossing }) => {
    const streets = overpass.elements.filter((e) => e.type === "way" && e.tags?.highway && e.tags.name === crossing && e.geometry);
    const points = streets.flatMap((street) => crossings(centre, (street.geometry as LatLon[]).map(project)));
    if (!points.length) throw new Error(`${crossing} doesn't cross Don Mills Road`);
    return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length] as Point;
  });
  const end = nearest(centre, crossingAt.at(-1) as Point).along;
  const extension = simplify([start, ...cut(centre, nearest(centre, start).along + EASE_METRES, end)], SIMPLIFY_METRES);
  const extensionStations = EXTENSION_STATIONS.map((station, i) => ({ ...station, at: nearest(extension, crossingAt[i] as Point) }));
  if (extensionStations.some((s, i) => i && s.at.along <= (extensionStations[i - 1] as (typeof extensionStations)[number]).at.along)) {
    throw new Error("The extension's stations are out of order");
  }
  write(
    "don-mills-extension.geojson",
    { name: "Ontario Line extension to Sheppard", status: "hypothetical", follows: "Don Mills Road", source: { osmBase }, ...credit },
    [
      lineFeature({ kind: "line", name: "Don Mills extension", from: STATIONS.last, to: "Don Mills", lengthMetres: round10(lengthOf(extension)) }, extension),
      ...extensionStations.map(({ at, ...station }) => pointFeature({ kind: "station", ...station, alongMetres: round10(at.along) }, at.point)),
    ],
  );

  console.log({
    ontarioLine: { points: line.length, metres: Math.round(lengthOf(line)), stations: stations.length },
    extension: { points: extension.length, metres: Math.round(lengthOf(extension)), stations: extensionStations.map((s) => `${s.name} ${Math.round(s.at.along)} m`) },
    osmBase,
  });
}

await main();

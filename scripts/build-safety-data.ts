// Downloads the open datasets for road safety and active transportation, and writes
// them small enough to commit: services/api/assets/gis/, beside the GIS datasets.
// Their sources, publishers, licences and the day each was fetched go in
// datasets-safety.json, which the service reads with datasets.json, so every figure
// made from one can cite it. scripts/build-gis-data.ts makes the others.
//
//   ksi-detail.json.gz   KSI collisions with each one's hour, light, place, streets,
//                        and the people killed or seriously injured, by road user
//   cycling.json.gz      the City's cycling network, each segment with its type
//   sidewalks.json.gz    the City's sidewalk inventory, on streets only
//   bikeshare.json.gz    Bike Share Toronto's stations and their docks
//
// Usage: node scripts/build-safety-data.ts [--cache <dir>]
//   --cache  where downloads go, so a second run fetches nothing. Default: a temp folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { rows as readRows } from "./csv.ts";

const OUT = join(import.meta.dirname, "../services/api/assets/gis");
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const CACHE = argument("--cache") ?? join(tmpdir(), "transit-agents-safety");
const TODAY = new Date().toISOString().slice(0, 10);

const OGL_TORONTO = "Open Government Licence – Toronto";
const OGL_TORONTO_URL = "https://open.toronto.ca/open-data-licence/";

const CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca";
const KSI = `${CKAN}/dataset/73a8e475-9683-42e1-ac06-b8690dcba062/resource/b95f5270-4eb0-40c2-917d-37fb494328a1/download/motor-vehicle-collisions-with-ksi-data-4326.csv`;
const CYCLING = `${CKAN}/dataset/abbe5ee3-e249-4f86-a219-f0022eaddcc9/resource/023da9a2-8848-4e10-9cad-e7f9119cd874/download/cycling-network-4326.geojson`;
const SIDEWALKS = `${CKAN}/dataset/11b6b9d6-09a7-43d1-8f8a-267c83991d1b/resource/a84628ca-d0a8-4a1c-bb9e-adf9aca68a27/download/sidewalk-inventory-wgs84.zip`;
// The Open Data portal's Bike Share Toronto dataset lists this feed (GBFS).
const STATIONS = "https://tor.publicbikesystem.net/ube/gbfs/v1/en/station_information";

type Position = [number, number];

async function download(url: string, file: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, file);
  if (existsSync(path)) return path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  return path;
}

// About 1 m.
const round = (n: number) => Math.round(n * 1e5) / 1e5;

// Ramer-Douglas-Peucker in metres near Toronto, as build-gis-data.ts does, for lines.
const M_LAT = 110_574;
const M_LON = 111_320 * Math.cos((43.7 * Math.PI) / 180);
function simplify(points: Position[], metres: number): Position[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop() as [number, number];
    const [ax, ay] = [(points[a] as Position)[0] * M_LON, (points[a] as Position)[1] * M_LAT];
    const [bx, by] = [(points[b] as Position)[0] * M_LON, (points[b] as Position)[1] * M_LAT];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = (points[i] as Position)[0] * M_LON;
      const py = (points[i] as Position)[1] * M_LAT;
      const distance = length ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / length : Math.hypot(px - ax, py - ay);
      if (distance > worst) {
        worst = distance;
        at = i;
      }
    }
    if (worst > metres) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const line = (points: Position[]) => simplify(points, 2).map(([lon, lat]) => [round(lon), round(lat)] as Position);

function write(name: string, value: unknown): number {
  const bytes = gzipSync(JSON.stringify(value), { level: 9 });
  writeFileSync(join(OUT, name), bytes);
  return bytes.length;
}

// --- KSI collisions, in detail --------------------------------------------------

// The file has a row for each person involved. One record per collision:
//   [lon, lat, year, month, hour, flags, street1, street2, ...people]
// flags: 1 someone was killed, 2 a pedestrian, 4 a cyclist, 8 a motorcyclist was
// involved, 16 at or related to an intersection, 32 mid-block (neither: not
// recorded), 64 in the dark. street1 and street2 index `streets`, -1 for none.
// people: those killed, then those seriously injured (police "Major" injury), for
// pedestrians, cyclists, motorcyclists, motorists (drivers and passengers) and others.
export const ROAD_USERS = ["pedestrian", "cyclist", "motorcyclist", "motorist", "other"] as const;
const USER: Record<string, number> = { pedestrian: 0, cyclist: 1, motorcyclist: 2, driver: 3, passenger: 3, other: 4, other_micromobility: 4 };
const AT_INTERSECTION = new Set(["At Intersection", "Intersection-Related", "Four-way", "T Intersection", "Other Intersection", "Y Intersection", "L Intersection", "Roundabout", "Offset"]);

async function ksiDetail() {
  const path = await download(KSI, "ksi-4326.csv");
  const streets: string[] = [];
  const streetIndex = new Map<string, number>();
  const street = (name: string) => {
    const clean = name.replace(/\s+/g, " ").trim().toUpperCase();
    if (!clean) return -1;
    if (!streetIndex.has(clean)) {
      streetIndex.set(clean, streets.length);
      streets.push(clean);
    }
    return streetIndex.get(clean) as number;
  };
  const collisions = new Map<string, number[]>();
  let years: [number, number] = [9999, 0];
  let last = "";
  let people = 0;
  for await (const r of readRows(join(path, ".."), "ksi-4326.csv")) {
    const kind = r.acclass as string;
    if (kind !== "Fatal Injury" && kind !== "Non-Fatal Injury") continue;
    const date = r.accdate as string;
    const year = Number(date.slice(0, 4));
    if (date.slice(0, 10) > last) last = date.slice(0, 10);
    years = [Math.min(years[0], year), Math.max(years[1], year)];
    const id = r.collision_id as string;
    let record = collisions.get(id);
    if (!record) {
      const place = r.accloc as string;
      const flags =
        (AT_INTERSECTION.has(place) ? 16 : place ? 32 : 0) | ((r.light as string).startsWith("Dark") ? 64 : 0);
      record = [round(Number(r.longitude)), round(Number(r.latitude)), year, Number(date.slice(5, 7)), Number(date.slice(11, 13)), flags, street(r.stname1 as string), street(r.stname2 as string), ...Array(10).fill(0)];
      collisions.set(id, record);
    }
    record[5] = (record[5] as number) | (kind === "Fatal Injury" ? 1 : 0) | (r.pedestrian === "true" ? 2 : 0) | (r.cyclist === "true" ? 4 : 0) | (r.motorcyclist === "true" ? 8 : 0);
    const user = USER[r.road_user as string];
    const injury = r.injury as string;
    if (user !== undefined && (injury === "Fatal" || injury === "Major")) {
      const at = 8 + user + (injury === "Major" ? 5 : 0);
      record[at] = (record[at] as number) + 1;
      people += 1;
    }
  }
  const points = [...collisions.values()].sort((a, b) => (a[2] as number) - (b[2] as number) || (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number));
  const size = write("ksi-detail.json.gz", { years, lastDate: last, roadUsers: ROAD_USERS, streets, points });
  return { size, collisions: points.length, people, years, lastDate: last };
}

// --- Cycling network ---------------------------------------------------------------

// The City's own types, and the four groups the tools total by.
export const CYCLING_GROUPS: Record<string, string[]> = {
  separated: ["Cycle Track", "Bi-Directional Cycle Track", "Cycle Track - Contraflow"],
  painted: ["Bike Lane", "Bike Lane - Buffered", "Bike Lane - Contraflow"],
  trail: ["Multi-Use Trail", "Multi-Use Trail - Boulevard", "Multi-Use Trail - Connector", "Multi-Use Trail - Existing Connector", "Multi-Use Trail - Entrance"],
  shared: ["Sharrows", "Sharrows - Wayfinding", "Sharrows - Arterial", "Sharrows - Arterial - Connector", "Signed Route (No Pavement Markings)", "Park Road"],
};

async function cycling() {
  const data = JSON.parse(readFileSync(await download(CYCLING, "cycling-network-4326.geojson"), "utf8")) as {
    features: { properties: Record<string, unknown>; geometry: { type: string; coordinates: Position[][] | Position[] } | null }[];
  };
  const known = new Set(Object.values(CYCLING_GROUPS).flat());
  const unknown = new Set<string>();
  const features = data.features.flatMap((f) => {
    if (!f.geometry) return [];
    const type = String(f.properties.INFRA_HIGHORDER ?? "").trim();
    if (!known.has(type)) unknown.add(type);
    const lines = f.geometry.type === "MultiLineString" ? (f.geometry.coordinates as Position[][]) : [f.geometry.coordinates as Position[]];
    return [
      {
        type: "Feature",
        properties: {
          type,
          street: String(f.properties.STREET_NAME ?? "").trim(),
          ...(f.properties.INSTALLED ? { installed: Number(f.properties.INSTALLED) } : {}),
          ...(f.properties.UPGRADED ? { upgraded: Number(f.properties.UPGRADED) } : {}),
        },
        geometry: { type: "MultiLineString", coordinates: lines.map(line).filter((l) => l.length >= 2) },
      },
    ];
  });
  if (unknown.size) throw new Error(`Cycling types with no group: ${[...unknown].join(", ")}`);
  return { size: write("cycling.json.gz", { type: "FeatureCollection", features }), segments: features.length };
}

// --- Sidewalk inventory ------------------------------------------------------------

// A polyline shapefile and its table, read without a GIS library.
function shapefile(dir: string): { parts: Position[][]; record: Record<string, string> }[] {
  const base = readdirSync(dir).find((f) => f.endsWith(".shp"));
  if (!base) throw new Error(`No .shp in ${dir}`);
  const shp = readFileSync(join(dir, base));
  const dbf = readFileSync(join(dir, base.replace(/\.shp$/, ".dbf")));
  const count = dbf.readUInt32LE(4);
  const headerLength = dbf.readUInt16LE(8);
  const recordLength = dbf.readUInt16LE(10);
  const fields: { name: string; length: number }[] = [];
  for (let at = 32; dbf[at] !== 0x0d; at += 32) {
    fields.push({ name: dbf.toString("latin1", at, at + 11).replace(/\0.*$/, ""), length: dbf[at + 16] as number });
  }
  const out: { parts: Position[][]; record: Record<string, string> }[] = [];
  let offset = 100;
  for (let i = 0; i < count; i++) {
    const words = shp.readInt32BE(offset + 4);
    const body = offset + 8;
    offset = body + words * 2;
    const parts: Position[][] = [];
    if (shp.readInt32LE(body) === 3) {
      const numParts = shp.readInt32LE(body + 36);
      const numPoints = shp.readInt32LE(body + 40);
      const starts = Array.from({ length: numParts }, (_, p) => shp.readInt32LE(body + 44 + p * 4));
      const points = body + 44 + numParts * 4;
      for (let p = 0; p < numParts; p++) {
        const end = p + 1 < numParts ? (starts[p + 1] as number) : numPoints;
        const part: Position[] = [];
        for (let k = starts[p] as number; k < end; k++) part.push([shp.readDoubleLE(points + k * 16), shp.readDoubleLE(points + k * 16 + 8)]);
        parts.push(part);
      }
    }
    const record: Record<string, string> = {};
    let at = headerLength + i * recordLength + 1;
    for (const field of fields) {
      record[field.name] = dbf.toString("latin1", at, at + field.length).trim();
      at += field.length;
    }
    out.push({ parts, record });
  }
  return out;
}

// Each street segment's sidewalks: both sides, one side, one side and part of the
// other, part of a side, none, or a street still being built.
export const SIDEWALK_STATUS = { both: "Sidewalk on both sides", one: "Sidewalk on one side only", onePartial: "Sidewalk on one side, partly on the other", partial: "Partial sidewalk on at least one side", none: "No sidewalk on either side", building: "Roadway under development" } as const;
const STREETS = new Set(["Local", "Collector", "Minor Arterial", "Major Arterial"]);

function sidewalkStatus(code: string, description: string): keyof typeof SIDEWALK_STATUS | undefined {
  if (code === "7") return "both";
  if (["1", "2", "4", "5"].includes(code)) return description.includes("partially on other side") ? "onePartial" : "one";
  if (code === "3") return description.startsWith("No sidewalk") ? "none" : "partial";
  if (code === "6") return "building";
  return undefined;
}

async function sidewalks() {
  const zip = await download(SIDEWALKS, "sidewalk-inventory-wgs84.zip");
  const dir = join(CACHE, "sidewalks");
  if (!existsSync(dir)) execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);
  const folder = readdirSync(dir).find((name) => !name.startsWith(".")) as string;
  const counts: Record<string, number> = {};
  const statuses = Object.keys(SIDEWALK_STATUS);
  const roads = [...STREETS];
  // Compact, as 40,000 segments are: [status, road, part, part...], each part's
  // points in 1e-5 degrees, the first whole and the rest as steps from the one before.
  const segments = shapefile(join(dir, folder)).flatMap(({ parts, record }) => {
    const status = sidewalkStatus(record.SDWLK_Code as string, record.SDWLK_DESC as string);
    const road = record.Road_Type as string;
    const lines = parts.map(line).filter((l) => l.length >= 2);
    if (!status || !STREETS.has(road) || !lines.length) return [];
    counts[status] = (counts[status] ?? 0) + 1;
    const steps = (points: Position[]) => {
      let [x0, y0] = [0, 0];
      return points.flatMap(([lon, lat]) => {
        const [x, y] = [Math.round(lon * 1e5), Math.round(lat * 1e5)];
        const step = [x - x0, y - y0];
        [x0, y0] = [x, y];
        return step;
      });
    };
    return [[statuses.indexOf(status), roads.indexOf(road), ...lines.map(steps)]];
  });
  return { size: write("sidewalks.json.gz", { statuses, roads, segments }), segments: segments.length, counts };
}

// --- Bike Share Toronto ---------------------------------------------------------------

async function bikeShare() {
  const data = JSON.parse(readFileSync(await download(STATIONS, "station_information.json"), "utf8")) as {
    last_updated: number;
    data: { stations: { station_id: string; name: string; lat: number; lon: number; capacity?: number }[] };
  };
  const features = data.data.stations
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.lat !== 0)
    .map((s) => ({
      type: "Feature",
      properties: { id: s.station_id, name: s.name.replace(/\s+/g, " ").trim(), docks: s.capacity ?? 0 },
      geometry: { type: "Point", coordinates: [round(s.lon), round(s.lat)] },
    }))
    .sort((a, b) => Number(a.properties.id) - Number(b.properties.id));
  const asOf = new Date(data.last_updated * 1000).toISOString().slice(0, 10);
  return { size: write("bikeshare.json.gz", { type: "FeatureCollection", features }), stations: features.length, docks: features.reduce((n, f) => n + f.properties.docks, 0), asOf };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const built = { ksi: await ksiDetail(), cycling: await cycling(), sidewalks: await sidewalks(), bikeShare: await bikeShare() };
  const groups = Object.entries(CYCLING_GROUPS)
    .map(([group, types]) => `${group}: ${types.join(", ")}`)
    .join("; ");
  const datasets = [
    {
      id: "toronto-ksi-detail",
      title: "Motor Vehicle Collisions involving Killed or Seriously Injured Persons, with time, place and road users",
      publisher: "Toronto Police Service, via City of Toronto Open Data",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/motor-vehicle-collisions-involving-killed-or-seriously-injured-persons/",
      retrieved: TODAY,
      file: "ksi-detail.json.gz",
      kind: "points",
      coverage: "City of Toronto",
      notes: `${built.ksi.collisions} police-reported collisions where someone was killed or seriously injured, ${built.ksi.years[0]} to ${built.ksi.lastDate}; the latest year is partial. One point per collision, with its hour, whether it was dark, whether police placed it at an intersection or mid-block, the two streets police named, and ${built.ksi.people} people killed or seriously injured ("Major" injury), by road user. Police-reported only: collisions police didn't attend are missing. The same collisions as toronto-ksi, in more detail.`,
    },
    {
      id: "toronto-cycling-network",
      title: "Cycling Network",
      publisher: "City of Toronto (Transportation Services)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/cycling-network/",
      retrieved: TODAY,
      file: "cycling.json.gz",
      kind: "lines",
      coverage: "City of Toronto",
      notes: `${built.cycling.segments} segments, each with the City's type (its INFRA_HIGHORDER). Measured along the street: a street with a lane on each side counts once. Grouped as ${groups}. Simplified to about 2 m.`,
    },
    {
      id: "toronto-sidewalks",
      title: "Sidewalk Inventory",
      publisher: "City of Toronto (Transportation Services)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/sidewalk-inventory/",
      retrieved: TODAY,
      file: "sidewalks.json.gz",
      kind: "lines",
      coverage: "City of Toronto",
      notes: `${built.sidewalks.segments} street segments (local, collector and arterial; not expressways, laneways or trails), each with its sidewalks: both sides, one side, one side and part of the other, partial, none, or under development. The inventory dates from 2017 and the portal last refreshed it in 2019, so sidewalks built since are missing. Simplified to about 2 m.`,
    },
    {
      id: "bike-share-toronto",
      title: "Bike Share Toronto stations (GBFS station_information)",
      publisher: "Bike Share Toronto (Toronto Parking Authority), via City of Toronto Open Data",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/bike-share-toronto/",
      retrieved: TODAY,
      file: "bikeshare.json.gz",
      kind: "points",
      coverage: "City of Toronto and the stations beyond it",
      notes: `${built.bikeShare.stations} stations with ${built.bikeShare.docks} docks, as the feed listed them on ${built.bikeShare.asOf}. Stations open, close and move; this is one day's list. Docks are the station's capacity, not bikes available.`,
    },
  ];
  writeFileSync(join(OUT, "datasets-safety.json"), `${JSON.stringify(datasets, null, 2)}\n`);
  console.log(JSON.stringify(built, null, 1));
}

if (import.meta.main) await main();

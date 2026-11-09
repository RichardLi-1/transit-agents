// Downloads the open datasets the GIS tools work on, and writes them small enough to
// commit: services/api/assets/gis/. Each dataset keeps where it came from, its
// publisher, licence and the day it was fetched, in datasets.json, so every figure
// made from it can cite it.
//
//   ttc.json.gz              TTC stops, and each route's stops and main shapes (GTFS)
//   census-da-2021.json.gz   Toronto's 3,743 dissemination areas, with 2021 Census counts
//   neighbourhoods.json.gz   the City's 158 neighbourhoods, with their TSNS 2030 class
//   nia.json.gz              the 33 Neighbourhood Improvement Areas (TSNS 2030)
//   ksi.json.gz              police-reported collisions where someone was killed or seriously injured
//   heritage.json.gz         Heritage Register properties, Don Mills corridor only
//   parks.json.gz            green spaces, Don Mills corridor only
//
// Usage: node scripts/build-gis-data.ts [--site <dir>] [--cache <dir>]
//   --site   the folder of City GeoJSON clipped to the Don Mills corridor
//            (references/files/site/toronto in the main checkout). Without it, the
//            corridor datasets are kept as they are.
//   --cache  where downloads go, so a second run fetches nothing. Default: a temp folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseCsvLine, rows as readRows } from "./csv.ts";

const OUT = join(import.meta.dirname, "../services/api/assets/gis");
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const SITE = argument("--site");
const CACHE = argument("--cache") ?? join(tmpdir(), "transit-agents-gis");
const TODAY = new Date().toISOString().slice(0, 10);

const OGL_TORONTO = "Open Government Licence – Toronto";
const OGL_TORONTO_URL = "https://open.toronto.ca/open-data-licence/";
const STATCAN_LICENCE = "Statistics Canada Open Licence";
const STATCAN_LICENCE_URL = "https://www.statcan.gc.ca/en/reference/licence";

const CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca";
const GTFS_ZIP = `${CKAN}/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip`;
const NEIGHBOURHOODS = `${CKAN}/dataset/fc443770-ef0a-4025-9c2c-2cb558bfab00/resource/0719053b-28b7-48ea-b863-068823a93aaa/download/neighbourhoods-4326.geojson`;
const NIA = `${CKAN}/dataset/3b471f62-dc01-4a96-bb76-f794e4c6b860/resource/8b6a2d2a-d398-484f-99b5-f686f31f815d/download/neighbourhood-improvement-areas-4326.geojson`;
const KSI = `${CKAN}/dataset/73a8e475-9683-42e1-ac06-b8690dcba062/resource/b95f5270-4eb0-40c2-917d-37fb494328a1/download/motor-vehicle-collisions-with-ksi-data-4326.csv`;
// The 2021 cartographic boundary file's dissemination areas, served in WGS84. Toronto
// is census division 3520, the same land as the City (CSD 3520005), so its DAs are
// those whose id starts 3520.
const DA_LAYER = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/12/query";
const PROFILE = "https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest/data/STC_CP,DF_DA";

// Census Profile characteristics, by the profile's own ids, and the names the tools use.
// Counts only: rates are worked out from the totals, so they can be added up by area.
const CENSUS = {
  population: { id: 1, label: "Population, 2021", unit: "people" },
  households: { id: 5, label: "Households (occupied private dwellings), 2021", unit: "households" },
  ageBase: { id: 8, label: "People counted by age", unit: "people" },
  age65: { id: 24, label: "People aged 65 and over", unit: "people" },
  lowIncomeBase: { id: 321, label: "People counted for low-income status", unit: "people" },
  lowIncome: { id: 326, label: "People in low income (LIM-AT, 2020 incomes)", unit: "people" },
  commuters: { id: 2603, label: "Commuters with a usual or no fixed workplace (25% sample)", unit: "people" },
  transit: { id: 2607, label: "Commuters by public transit (25% sample)", unit: "people" },
  walked: { id: 2608, label: "Commuters on foot (25% sample)", unit: "people" },
  bicycle: { id: 2609, label: "Commuters by bicycle (25% sample)", unit: "people" },
  visibleMinorityBase: { id: 1669, label: "People counted for visible minority (25% sample)", unit: "people" },
  visibleMinority: { id: 1670, label: "Visible minority population (25% sample)", unit: "people" },
} as const;

type Position = [number, number];
type Geometry = { type: string; coordinates: unknown };
type Feature = { type: "Feature"; properties: Record<string, unknown>; geometry: Geometry };

async function download(url: string, file: string, init?: RequestInit): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, file);
  if (existsSync(path)) return path;
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
  return path;
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

// About 1 m: as fine as the sources' own accuracy needs.
const round = (n: number) => Math.round(n * 1e5) / 1e5;

// Ramer-Douglas-Peucker on longitude and latitude, in metres near Toronto, iterative
// so long rings can't overflow the stack. A ring keeps at least four points.
const M_LAT = 110_574;
const M_LON = 111_320 * Math.cos((43.7 * Math.PI) / 180);
function simplify(points: Position[], metres: number): Position[] {
  if (points.length < 5) return points;
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
  const kept = points.filter((_, i) => keep[i]);
  return kept.length >= 4 ? kept : points;
}

const ring = (points: Position[], metres: number) => simplify(points, metres).map(([lon, lat]) => [round(lon), round(lat)] as Position);

function compactPolygon(geometry: Geometry, metres: number): Geometry {
  if (geometry.type === "Polygon") return { type: "Polygon", coordinates: (geometry.coordinates as Position[][]).map((r) => ring(r, metres)) };
  if (geometry.type === "MultiPolygon") {
    return { type: "MultiPolygon", coordinates: (geometry.coordinates as Position[][][]).map((p) => p.map((r) => ring(r, metres))) };
  }
  throw new Error(`Expected a polygon, not ${geometry.type}`);
}

function write(name: string, value: unknown): number {
  const bytes = gzipSync(JSON.stringify(value), { level: 9 });
  writeFileSync(join(OUT, name), bytes);
  return bytes.length;
}

const collection = (features: Feature[]) => ({ type: "FeatureCollection", features });

// --- TTC GTFS -----------------------------------------------------------------

async function ttc() {
  const zip = await download(GTFS_ZIP, "opendata_ttc_schedules.zip");
  const dir = join(CACHE, "gtfs");
  if (!existsSync(join(dir, "stop_times.txt"))) execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);
  const rows = (file: string) => readRows(dir, file);

  const routes = new Map<string, { name: string; long: string; type: number; color: string }>();
  for await (const r of rows("routes.txt")) {
    routes.set(r.route_id as string, { name: r.route_short_name as string, long: r.route_long_name as string, type: Number(r.route_type), color: r.route_color as string });
  }
  let until = "";
  for await (const c of rows("calendar.txt")) if ((c.end_date as string) > until) until = c.end_date as string;

  const tripRoute = new Map<string, string>();
  const shapeUse = new Map<string, Map<string, number>>();
  for await (const t of rows("trips.txt")) {
    const route = t.route_id as string;
    tripRoute.set(t.trip_id as string, route);
    const use = shapeUse.get(route) ?? new Map<string, number>();
    use.set(t.shape_id as string, (use.get(t.shape_id as string) ?? 0) + 1);
    shapeUse.set(route, use);
  }

  const stops: [string, string, number, number][] = [];
  const stopIndex = new Map<string, number>();
  for await (const s of rows("stops.txt")) {
    stopIndex.set(s.stop_id as string, stops.length);
    stops.push([(s.stop_code as string) || (s.stop_id as string), s.stop_name as string, round(Number(s.stop_lon)), round(Number(s.stop_lat))]);
  }

  // Every stop any of a route's trips calls at.
  const routeStops = new Map<string, Set<number>>();
  for await (const s of rows("stop_times.txt")) {
    const route = tripRoute.get(s.trip_id as string);
    const stop = stopIndex.get(s.stop_id as string);
    if (route === undefined || stop === undefined) continue;
    const set = routeStops.get(route) ?? new Set<number>();
    set.add(stop);
    routeStops.set(route, set);
  }

  // Each route's shapes that carry at least 5% of its trips, at most six.
  const wanted = new Map<string, string[]>();
  for (const [route, use] of shapeUse) {
    const total = [...use.values()].reduce((a, b) => a + b, 0);
    wanted.set(
      route,
      [...use.entries()]
        .filter(([, n]) => n >= total * 0.05)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([id]) => id),
    );
  }
  const shapeIds = new Set([...wanted.values()].flat());
  const raw = new Map<string, [number, Position][]>();
  for await (const p of rows("shapes.txt")) {
    const id = p.shape_id as string;
    if (!shapeIds.has(id)) continue;
    const list = raw.get(id) ?? [];
    list.push([Number(p.shape_pt_sequence), [Number(p.shape_pt_lon), Number(p.shape_pt_lat)]]);
    raw.set(id, list);
  }
  const line = (id: string) => ring((raw.get(id) ?? []).sort((a, b) => a[0] - b[0]).map(([, point]) => point), 3);

  const out: Record<string, { long: string; type: number; color: string; stops: number[]; shapes: Position[][] }> = {};
  for (const [id, route] of routes) {
    const served = [...(routeStops.get(id) ?? [])].sort((a, b) => a - b);
    if (!served.length) continue;
    out[route.name] = { long: route.long, type: route.type, color: route.color, stops: served, shapes: (wanted.get(id) ?? []).map(line).filter((l) => l.length >= 2) };
  }
  const timetableUntil = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  const size = write("ttc.json.gz", { timetableUntil, stops, routes: out });
  return { size, routes: Object.keys(out).length, stops: stops.length, timetableUntil };
}

// --- Census --------------------------------------------------------------------

async function census() {
  const features: Feature[] = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({
      where: "DAUID LIKE '3520%'",
      outFields: "DAUID,DGUID",
      outSR: "4326",
      // About 3 m, so the 3,743 areas stay small without losing their shapes.
      maxAllowableOffset: "0.00003",
      geometryPrecision: "6",
      orderByFields: "DAUID",
      resultOffset: String(offset),
      resultRecordCount: "1000",
      f: "geojson",
    });
    const page = json(await download(`${DA_LAYER}?${query}`, `da-${offset}.geojson`)) as { features: Feature[] };
    features.push(...page.features);
    if (page.features.length < 1000) break;
  }

  const ids = Object.values(CENSUS).map((c) => c.id);
  const names = new Map<number, string>(Object.entries(CENSUS).map(([name, c]) => [c.id, name]));
  const values = new Map<string, Record<string, number | null>>();
  const dguids = features.map((f) => f.properties.DGUID as string);
  for (let i = 0; i < dguids.length; i += 60) {
    const batch = dguids.slice(i, i + 60);
    const url = `${PROFILE}/A5.${batch.join("+")}.1.${ids.join("+")}.1`;
    const text = readFileSync(await download(url, `profile-${i}.csv`, { headers: { accept: "application/vnd.sdmx.data+csv", "accept-language": "en" } }), "utf8");
    const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
    const columns = parseCsvLine(header as string);
    const at = (name: string) => columns.indexOf(name);
    for (const line of lines) {
      const cells = parseCsvLine(line);
      const area = cells[at("REF_AREA")] as string;
      const name = names.get(Number(cells[at("CHARACTERISTIC")]));
      if (!name) continue;
      const raw = cells[at("OBS_VALUE")];
      const record = values.get(area) ?? {};
      record[name] = raw === undefined || raw === "" ? null : Number(raw);
      values.set(area, record);
    }
  }

  let suppressed = 0;
  const out = features.map((f) => {
    const record = values.get(f.properties.DGUID as string) ?? {};
    const properties: Record<string, unknown> = { id: f.properties.DAUID };
    for (const name of Object.keys(CENSUS)) properties[name] = record[name] ?? null;
    if (Object.keys(CENSUS).some((name) => properties[name] === null)) suppressed += 1;
    return { type: "Feature" as const, properties, geometry: compactPolygon(f.geometry, 0) };
  });
  const size = write("census-da-2021.json.gz", collection(out));
  return { size, areas: out.length, suppressed };
}

// --- City of Toronto -----------------------------------------------------------------

async function neighbourhoods() {
  const data = json(await download(NEIGHBOURHOODS, "neighbourhoods-4326.geojson")) as { features: Feature[] };
  const out = data.features.map((f) => ({
    type: "Feature" as const,
    properties: { id: String(f.properties.AREA_SHORT_CODE), name: f.properties.AREA_NAME, class: f.properties.CLASSIFICATION },
    geometry: compactPolygon(f.geometry, 5),
  }));
  return { size: write("neighbourhoods.json.gz", collection(out)), areas: out.length };
}

async function nia() {
  const data = json(await download(NIA, "nia-4326.geojson")) as { features: Feature[] };
  const out = data.features.map((f) => ({
    type: "Feature" as const,
    properties: { id: String(f.properties.AREA_SHORT_CODE), name: f.properties.AREA_NAME },
    geometry: compactPolygon(f.geometry, 5),
  }));
  return { size: write("nia.json.gz", collection(out)), areas: out.length };
}

// One point per collision, though the file has a row for each person involved. Flags:
// 1 someone was killed, 2 a pedestrian, 4 a cyclist, 8 a motorcyclist was involved.
// Rows marked property damage only or unknown aren't KSI, and are left out.
async function ksi() {
  const path = await download(KSI, "ksi-4326.csv");
  const dir = join(path, "..");
  const collisions = new Map<string, [number, number, number, number]>();
  let years: [number, number] = [9999, 0];
  let last = "";
  for await (const r of readRows(dir, "ksi-4326.csv")) {
    const kind = r.acclass as string;
    if (kind !== "Fatal Injury" && kind !== "Non-Fatal Injury") continue;
    const year = Number((r.accdate as string).slice(0, 4));
    if ((r.accdate as string) > last) last = (r.accdate as string).slice(0, 10);
    years = [Math.min(years[0], year), Math.max(years[1], year)];
    const flags =
      (kind === "Fatal Injury" ? 1 : 0) | (r.pedestrian === "true" ? 2 : 0) | (r.cyclist === "true" ? 4 : 0) | (r.motorcyclist === "true" ? 8 : 0);
    const id = r.collision_id as string;
    const known = collisions.get(id);
    if (known) known[3] |= flags;
    else collisions.set(id, [round(Number(r.longitude)), round(Number(r.latitude)), year, flags]);
  }
  const points = [...collisions.values()].sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  return { size: write("ksi.json.gz", { years, lastDate: last, points }), collisions: points.length, years, lastDate: last };
}

// The corridor files are clipped to the box the reference set was collected in.
function corridor(file: string, name: string, simplifyTo: number, properties: (p: Record<string, unknown>) => Record<string, unknown>) {
  if (!SITE) return undefined;
  const data = json(join(SITE, file)) as { features: Feature[] };
  const out = data.features.map((f) => ({
    type: "Feature" as const,
    properties: properties(f.properties),
    geometry:
      f.geometry.type === "Point"
        ? { type: "Point", coordinates: (f.geometry.coordinates as Position).map(round) }
        : compactPolygon(f.geometry, simplifyTo),
  }));
  return { size: write(name, collection(out)), features: out.length };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const built = {
    ttc: await ttc(),
    census: await census(),
    neighbourhoods: await neighbourhoods(),
    nia: await nia(),
    ksi: await ksi(),
    heritage: corridor("heritage-register.geojson", "heritage.json.gz", 0, (p) => ({ address: String(p.ADDRESS ?? "").replace(/\s+/g, " ").trim(), status: p.STATUS })),
    parks: corridor("green-spaces_parks.geojson", "parks.json.gz", 3, (p) => ({ name: p.AREA_NAME, class: p.AREA_CLASS })),
  };
  // The day the reference set fetched the corridor files (references/manifest.json).
  const corridorRetrieved = "2026-11-08";
  const corridorBox = [-79.37, 43.7, -79.32, 43.78];

  const datasets = [
    {
      id: "ttc-gtfs",
      title: "TTC Routes and Schedules (GTFS)",
      publisher: "Toronto Transit Commission, via City of Toronto Open Data",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/ttc-routes-and-schedules/",
      retrieved: TODAY,
      file: "ttc.json.gz",
      kind: "points",
      coverage: "City of Toronto and the TTC's routes beyond it",
      notes: `Scheduled stops and route shapes, timetable to ${built.ttc.timetableUntil}. A route's stops are every stop any of its trips calls at, all branches and both directions.`,
    },
    {
      id: "census-da-2021",
      title: "2021 Census: dissemination areas and Census Profile, City of Toronto",
      publisher: "Statistics Canada",
      licence: STATCAN_LICENCE,
      licenceUrl: STATCAN_LICENCE_URL,
      url: "https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/index.cfm?Lang=E",
      retrieved: TODAY,
      file: "census-da-2021.json.gz",
      kind: "polygons",
      coverage: "City of Toronto (census subdivision 3520005)",
      notes: `The cartographic boundary file, which follows the shoreline, simplified to about 3 m, with Census Profile counts for each area. ${built.census.suppressed} of ${built.census.areas} areas lack some counts, such as low income, which Statistics Canada suppresses for very small areas; they add nothing to those totals. Counts are randomly rounded; 25% sample data are estimates. Low income is counted for people, not households.`,
      variables: Object.fromEntries(Object.entries(CENSUS).map(([name, c]) => [name, { label: c.label, unit: c.unit, characteristic: c.id }])),
    },
    {
      id: "toronto-neighbourhoods",
      title: "Neighbourhoods (158)",
      publisher: "City of Toronto (Social Development, Finance & Administration)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/neighbourhoods/",
      retrieved: TODAY,
      file: "neighbourhoods.json.gz",
      kind: "polygons",
      coverage: "City of Toronto",
      notes: "The 158-neighbourhood model, each with its Toronto Strong Neighbourhoods Strategy 2030 class: Neighbourhood Improvement Area, Emerging Neighbourhood, or neither. Simplified to about 5 m.",
    },
    {
      id: "toronto-nia",
      title: "Neighbourhood Improvement Areas (TSNS 2030)",
      publisher: "City of Toronto (Social Development, Finance & Administration)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/neighbourhood-improvement-areas/",
      retrieved: TODAY,
      file: "nia.json.gz",
      kind: "polygons",
      coverage: "City of Toronto",
      notes: `The ${built.nia.areas} Neighbourhood Improvement Areas of the Toronto Strong Neighbourhoods Strategy 2030, on the 158-neighbourhood model (effective 2022). Not the 31 areas of 2014. Simplified to about 5 m.`,
    },
    {
      id: "toronto-ksi",
      title: "Motor Vehicle Collisions involving Killed or Seriously Injured Persons",
      publisher: "Toronto Police Service, via City of Toronto Open Data",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/motor-vehicle-collisions-involving-killed-or-seriously-injured-persons/",
      retrieved: TODAY,
      file: "ksi.json.gz",
      kind: "points",
      coverage: "City of Toronto",
      notes: `${built.ksi.collisions} police-reported collisions where someone was killed or seriously injured, ${built.ksi.years[0]} to ${built.ksi.lastDate}; the latest year is partial. One point per collision. Police-reported only: collisions police didn't attend are missing.`,
    },
  ];
  if (built.heritage) {
    datasets.push({
      id: "toronto-heritage-corridor",
      title: "Heritage Register, Don Mills corridor",
      publisher: "City of Toronto (City Planning, Heritage Planning)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/heritage-register/",
      retrieved: corridorRetrieved,
      file: "heritage.json.gz",
      kind: "points",
      coverage: "Don Mills corridor only: west -79.37, south 43.70, east -79.32, north 43.78",
      notes: `${built.heritage.features} listed and designated properties inside the corridor box, from the City's public map layer, whose records match the Open Data register. Not for legal purposes.`,
      bbox: corridorBox,
    } as (typeof datasets)[number]);
  }
  if (built.parks) {
    datasets.push({
      id: "toronto-parks-corridor",
      title: "Green Spaces, Don Mills corridor",
      publisher: "City of Toronto (Parks & Recreation)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/green-spaces/",
      retrieved: corridorRetrieved,
      file: "parks.json.gz",
      kind: "polygons",
      coverage: "Don Mills corridor only: west -79.37, south 43.70, east -79.32, north 43.78",
      notes: `${built.parks.features} parks, ravine parks, golf courses and cemeteries touching the corridor box, as whole features. Simplified to about 3 m.`,
      bbox: corridorBox,
    } as (typeof datasets)[number]);
  }
  writeFileSync(join(OUT, "datasets.json"), `${JSON.stringify(datasets, null, 2)}\n`);
  console.log(JSON.stringify(built, null, 1));
}

await main();

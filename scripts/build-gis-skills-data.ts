// Downloads the open data the equity-analysis, economic-development and
// stop-accessibility skills need, beside what scripts/build-gis-data.ts makes, and
// writes it to services/api/assets/gis/. Its datasets are listed in
// datasets-skills.json, which the service reads with datasets.json, so each keeps its
// publisher, licence and the day it was fetched, and every figure from one cites it.
//
//   census-da-2021-extra.json.gz  children (0 to 14) for each of Toronto's dissemination areas,
//                                 from the same 2021 Census Profile as census-da-2021
//   pow-ct-2021.json.gz           the Toronto CMA's census tracts, with the people who work in each (2021)
//   zoning-corridor.json.gz       Zoning By-law 569-2013 zones, Don Mills corridor only
//   shelters.json.gz              the City's transit shelters
//   ttc-access.json.gz            each TTC stop's wheelchair_boarding, from the GTFS
//
// Usage: node scripts/build-gis-skills-data.ts --site <dir> [--cache <dir>]
//   --site   the folder of City GeoJSON clipped to the Don Mills corridor
//            (references/files/site/toronto in the main checkout), for zoning.
//   --cache  where downloads go, so a second run fetches nothing. Default: a temp folder.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseCsvLine } from "./csv.ts";

const OUT = join(import.meta.dirname, "../services/api/assets/gis");
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const SITE = argument("--site");
const CACHE = argument("--cache") ?? join(tmpdir(), "transit-agents-gis");
const TODAY = new Date().toISOString().slice(0, 10);
if (!SITE) throw new Error("Usage: build-gis-skills-data.ts --site <references/files/site/toronto> [--cache <dir>]");

const OGL_TORONTO = "Open Government Licence – Toronto";
const OGL_TORONTO_URL = "https://open.toronto.ca/open-data-licence/";
const STATCAN_LICENCE = "Statistics Canada Open Licence";
const STATCAN_LICENCE_URL = "https://www.statcan.gc.ca/en/reference/licence";

const CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca";
const GTFS_ZIP = `${CKAN}/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip`;
const SHELTERS = `${CKAN}/dataset/1db34737-ffad-489d-a590-9171d500d453/resource/ecf41899-aed0-405e-aa76-118600f3a303/download/transit-shelter-data-4326.csv`;
const PROFILE = "https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest/data/STC_CP,DF_DA";
// Table 98-10-0500-01: place of work status, by the census tract people work in.
const POW_TABLE = "https://www150.statcan.gc.ca/n1/tbl/csv/98100500-eng.zip";
const CT_LAYER = "https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/11/query";
// The Census Profile's "0 to 14 years", beside census-da-2021's age base (8) and 65 and over (24).
const CHILDREN = 9;

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
const round = (n: number) => Math.round(n * 1e5) / 1e5;
const write = (name: string, value: unknown) => {
  const bytes = gzipSync(JSON.stringify(value), { level: 9 });
  writeFileSync(join(OUT, name), bytes);
  return bytes.length;
};
const collection = (features: Feature[]) => ({ type: "FeatureCollection", features });

// Ramer-Douglas-Peucker in metres near Toronto, as build-gis-data.ts does.
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
    const length = Math.hypot(bx - ax, by - ay);
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = (points[i] as Position)[0] * M_LON;
      const py = (points[i] as Position)[1] * M_LAT;
      const distance = length ? Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / length : Math.hypot(px - ax, py - ay);
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
  if (geometry.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: (geometry.coordinates as Position[][][]).map((p) => p.map((r) => ring(r, metres))) };
  throw new Error(`Expected a polygon, not ${geometry.type}`);
}

// --- Census: children, for the same dissemination areas as census-da-2021 ---------

async function children() {
  const census = JSON.parse(gunzipSync(readFileSync(join(OUT, "census-da-2021.json.gz"))).toString("utf8")) as { features: Feature[] };
  const ids = census.features.map((f) => String(f.properties.id));
  const values: Record<string, number | null> = Object.fromEntries(ids.map((id) => [id, null]));
  for (let i = 0; i < ids.length; i += 60) {
    const batch = ids.slice(i, i + 60).map((id) => `2021S0512${id}`);
    const url = `${PROFILE}/A5.${batch.join("+")}.1.${CHILDREN}.1`;
    const text = readFileSync(await download(url, `profile-children-${i}.csv`, { headers: { accept: "application/vnd.sdmx.data+csv", "accept-language": "en" } }), "utf8");
    const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
    const columns = parseCsvLine(header as string);
    for (const line of lines) {
      const cells = parseCsvLine(line);
      if (Number(cells[columns.indexOf("CHARACTERISTIC")]) !== CHILDREN) continue;
      const raw = cells[columns.indexOf("OBS_VALUE")];
      values[(cells[columns.indexOf("REF_AREA")] as string).slice(9)] = raw === undefined || raw === "" ? null : Number(raw);
    }
  }
  const missing = Object.values(values).filter((v) => v === null).length;
  return { size: write("census-da-2021-extra.json.gz", { characteristics: { children: CHILDREN }, areas: values }), areas: ids.length, missing };
}

// --- Census: where people work, by census tract -------------------------------------

async function placeOfWork() {
  const zip = await download(POW_TABLE, "98100500-eng.zip");
  const csv = join(CACHE, "98100500.csv");
  if (!existsSync(csv)) execFileSync("unzip", ["-o", "-q", zip, "98100500.csv", "-d", CACHE]);
  const lines = readFileSync(csv, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0] as string);
  const column = (prefix: string) => header.findIndex((h) => h.startsWith(prefix));
  const at = {
    dguid: header.indexOf("DGUID"),
    language: column("Language spoken most often at home"),
    total: column("Place of work status (5B):Total"),
    home: column("Place of work status (5B):Worked at home"),
    usual: column("Place of work status (5B):Usual place of work[3]"),
  };
  const counts = new Map<string, { jobs: number | null; atHome: number | null }>();
  const number = (cell: string | undefined) => (cell === undefined || cell === "" || Number.isNaN(Number(cell)) ? null : Number(cell));
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const dguid = cells[at.dguid] as string;
    // Tracts of the Toronto CMA (535), all languages together.
    if (!dguid.startsWith("2021S0507535") || !(cells[at.language] as string).startsWith("Total")) continue;
    counts.set(dguid, { jobs: number(cells[at.usual]), atHome: number(cells[at.home]) });
  }

  const features: Feature[] = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({
      where: "CTUID LIKE '535%'",
      outFields: "CTUID,DGUID,CTNAME",
      outSR: "4326",
      // About 10 m: tracts are large, and their boundaries follow streets.
      maxAllowableOffset: "0.0001",
      geometryPrecision: "5",
      orderByFields: "CTUID",
      resultOffset: String(offset),
      resultRecordCount: "1000",
      f: "geojson",
    });
    const page = json(await download(`${CT_LAYER}?${query}`, `ct-${offset}.geojson`)) as { features: Feature[] };
    features.push(...page.features);
    if (page.features.length < 1000) break;
  }
  let suppressed = 0;
  const out = features.map((f) => {
    const count = counts.get(f.properties.DGUID as string);
    if (count?.jobs === null || count === undefined) suppressed += 1;
    return {
      type: "Feature" as const,
      properties: { id: f.properties.CTUID, jobs: count?.jobs ?? null, atHome: count?.atHome ?? null },
      geometry: compactPolygon(f.geometry, 0),
    };
  });
  const jobs = out.reduce((n, f) => n + (f.properties.jobs ?? 0), 0);
  return { size: write("pow-ct-2021.json.gz", collection(out)), tracts: out.length, suppressed, jobs };
}

// --- Zoning, Don Mills corridor ----------------------------------------------------------

// Zoning By-law 569-2013's chapters, as the zoning layer's ZBL_CHAPT names them, and
// the broad use each one's zones are for.
export const ZONING_CHAPTERS: Record<string, { chapter: string; use: string }> = {
  "10": { chapter: "Residential", use: "residential" },
  "15": { chapter: "Residential Apartment", use: "residential" },
  "30": { chapter: "Commercial", use: "commercial" },
  "40": { chapter: "Commercial Residential", use: "mixedUse" },
  "50": { chapter: "Commercial Residential Employment", use: "mixedUse" },
  "60": { chapter: "Employment Industrial", use: "employment" },
  "80": { chapter: "Institutional", use: "institutional" },
  "90": { chapter: "Open Space", use: "openSpace" },
  "100": { chapter: "Utility and Transportation", use: "utility" },
};

function zoning() {
  const data = json(join(SITE as string, "zoning-569-2013_zoning-area.geojson")) as { features: Feature[] };
  const out = data.features.map((f) => {
    const chapter = String(f.properties.ZBL_CHAPT);
    const known = ZONING_CHAPTERS[chapter];
    if (!known) throw new Error(`Zoning chapter ${chapter} (${String(f.properties.ZN_ZONE)}) has no use: add it to ZONING_CHAPTERS`);
    return { type: "Feature" as const, properties: { zone: f.properties.ZN_ZONE, chapter: known.chapter, use: known.use }, geometry: compactPolygon(f.geometry, 1) };
  });
  return { size: write("zoning-corridor.json.gz", collection(out)), zones: out.length };
}

// --- Transit shelters --------------------------------------------------------------------

async function shelters() {
  const lines = readFileSync(await download(SHELTERS, "transit-shelter-data-4326.csv"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0] as string);
  const at = (name: string) => header.indexOf(name);
  const statuses: Record<string, number> = {};
  const out: Feature[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const geometry = JSON.parse(cells[at("geometry")] as string) as { type: string; coordinates: Position[] | Position };
    const point = (geometry.type === "MultiPoint" ? (geometry.coordinates as Position[])[0] : geometry.coordinates) as Position;
    const status = cells[at("STATUS")] as string;
    statuses[status] = (statuses[status] ?? 0) + 1;
    const street = [cells[at("ADDRESSNUMBERTEXT")], cells[at("ADDRESSSTREET")]].filter((s) => s && s !== "None").join(" ");
    out.push({ type: "Feature", properties: { id: cells[at("ID")], address: street, status }, geometry: { type: "Point", coordinates: point.map(round) } });
  }
  return { size: write("shelters.json.gz", collection(out)), shelters: out.length, statuses };
}

// --- TTC stops' wheelchair_boarding ------------------------------------------------------------

// 0 or empty: no information; 1: some vehicles at this stop can board a wheelchair; 2: none can.
async function wheelchair() {
  const zip = await download(GTFS_ZIP, "opendata_ttc_schedules.zip");
  const dir = join(CACHE, "gtfs");
  if (!existsSync(join(dir, "stops.txt"))) execFileSync("unzip", ["-o", "-q", zip, "stops.txt", "-d", dir]);
  const lines = readFileSync(join(dir, "stops.txt"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0] as string);
  const at = (name: string) => header.indexOf(name);
  const stops: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const code = (cells[at("stop_code")] || cells[at("stop_id")]) as string;
    const value = Number(cells[at("wheelchair_boarding")] || 0);
    stops[code] = value;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return { size: write("ttc-access.json.gz", { stops }), counts };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const built = { children: await children(), pow: await placeOfWork(), zoning: zoning(), shelters: await shelters(), wheelchair: await wheelchair() };
  // The day the reference set fetched the corridor files (references/manifest.json).
  const corridorRetrieved = "2026-11-08";
  const corridorBox = [-79.37, 43.7, -79.32, 43.78];
  const datasets = [
    {
      id: "statcan-pow-ct-2021",
      title: "2021 Census: place of work status by census tract of work (Table 98-10-0500-01), Toronto CMA",
      publisher: "Statistics Canada",
      licence: STATCAN_LICENCE,
      licenceUrl: STATCAN_LICENCE_URL,
      url: "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=9810050001",
      retrieved: TODAY,
      file: "pow-ct-2021.json.gz",
      kind: "polygons",
      coverage: "the Toronto census metropolitan area (CMA 535), which reaches beyond the City",
      notes: `${built.pow.tracts} census tracts, each with the people who had a usual place of work in it in May 2021, and those who worked at home there. A 25% sample, randomly rounded: ${built.pow.jobs} people with a usual place of work in all. It counts people who work there, not jobs or businesses, and leaves out people with no fixed workplace. The census ran during COVID-19, when many worked at home. Simplified to about 10 m.`,
      variables: {
        jobs: { label: "People with a usual place of work here, 2021 (25% sample)", unit: "people" },
        atHome: { label: "People who worked at home here, 2021 (25% sample)", unit: "people" },
      },
    },
    {
      id: "toronto-zoning-corridor",
      title: "Zoning By-law 569-2013, zoning areas, Don Mills corridor",
      publisher: "City of Toronto (City Planning)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/zoning-by-law/",
      retrieved: corridorRetrieved,
      file: "zoning-corridor.json.gz",
      kind: "polygons",
      coverage: "the Don Mills corridor only (west -79.37, south 43.70, east -79.32, north 43.78)",
      notes: `${built.zoning.zones} zones touching the corridor box, as whole features, each with its zone and the By-law chapter it falls in. A layer reaching beyond the corridor is measured inside it only. Zoning says what a lot may be used for, not what is there. Lands still under the former municipalities' by-laws aren't in it. Not for legal purposes.`,
      bbox: corridorBox,
    },
    {
      id: "toronto-transit-shelters",
      title: "Street Furniture – Transit Shelter",
      publisher: "City of Toronto (Transportation Services)",
      licence: OGL_TORONTO,
      licenceUrl: OGL_TORONTO_URL,
      url: "https://open.toronto.ca/dataset/street-furniture-transit-shelter/",
      retrieved: TODAY,
      file: "shelters.json.gz",
      kind: "points",
      coverage: "City of Toronto",
      notes: `${built.shelters.shelters} transit shelters on City streets: ${Object.entries(built.shelters.statuses).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(", ")}. A shelter isn't linked to a TTC stop: the tools match one to a stop by distance. Nothing on whether a shelter or its pad is accessible.`,
    },
  ];
  writeFileSync(join(OUT, "datasets-skills.json"), `${JSON.stringify(datasets, null, 2)}\n`);
  console.log(JSON.stringify(built, null, 1));
}

await main();

// GIS operations on open datasets, run here and never by a model: a route's stops
// and shape, buffers, overlays with census and City areas, and points within an area.
// Each returns features in WGS84 and any totals, which the service saves as a layer
// on a study and records as figures. The datasets come from scripts/build-gis-data.ts.
//
// Totals over areas are area-weighted: an area counts in proportion to its land
// inside the layer, which assumes what it counts is spread evenly across it. The
// census boundaries follow the shoreline, so an area's shape is its land.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { area as areaOf } from "@turf/area";
import { bbox as bboxOf } from "@turf/bbox";
import { bboxClip } from "@turf/bbox-clip";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { buffer as bufferOf } from "@turf/buffer";
import { featureCollection } from "@turf/helpers";
import { intersect } from "@turf/intersect";
import { length as lengthOf } from "@turf/length";
import { union } from "@turf/union";
import type { Dataset, DatasetInfo, LayerKind } from "@transit-agents/contracts";
import type { Feature, FeatureCollection, Geometry, LineString, MultiPolygon, Point, Polygon, Position } from "geojson";

export class GisError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type BBox = [number, number, number, number];
export type Total = { value: number; unit: string; label: string };
export type Made = {
  kind: LayerKind;
  features: Feature[];
  dataset?: Dataset;
  totals?: Record<string, Total>;
  // What a planner should know about the result, such as land outside the dataset.
  warnings?: string[];
};

type Area = Polygon | MultiPolygon;
type Stored = DatasetInfo & { file: string };

// A buffer's circles have 16 sides a quarter, so a 400 m circle is 0.2% smaller than a true one.
const STEPS = 16;

// The census counts overlay can total, and the shares worked out from them. A share
// is the weighted total of one count over another's, never an average of rates.
export const SHARES: Record<string, { of: string; base: string; label: string }> = {
  lowIncomeShare: { of: "lowIncome", base: "lowIncomeBase", label: "Share of people in low income (LIM-AT)" },
  transitShare: { of: "transit", base: "commuters", label: "Share of commuters going by public transit" },
  seniorShare: { of: "age65", base: "ageBase", label: "Share aged 65 and over" },
  visibleMinorityShare: { of: "visibleMinority", base: "visibleMinorityBase", label: "Share in a visible minority" },
};

// Short names for layer ids, and what a points dataset's count is called.
const SHORT: Record<string, string> = {
  "census-da-2021": "census",
  "toronto-neighbourhoods": "nbhd",
  "toronto-nia": "nia",
  "toronto-parks-corridor": "parks",
  "toronto-ksi": "ksi",
  "toronto-heritage-corridor": "heritage",
  "ttc-gtfs": "stops",
};
const COUNTS: Record<string, { name: string; unit: string; label: string }> = {
  "toronto-ksi": { name: "collisions", unit: "collisions", label: "KSI collisions" },
  "toronto-heritage-corridor": { name: "properties", unit: "properties", label: "Heritage Register properties" },
  "ttc-gtfs": { name: "stops", unit: "stops", label: "TTC stops" },
};
export const shortName = (dataset: string) => SHORT[dataset] ?? dataset;
const NOUNS: Record<string, string> = {
  "census-da-2021": "census dissemination areas",
  "toronto-nia": "Neighbourhood Improvement Areas",
  "toronto-neighbourhoods": "neighbourhoods",
  "toronto-parks-corridor": "green spaces",
};

export const METHOD =
  "Area-weighted: each area counts in proportion to its land inside the layer, which assumes what it counts is spread evenly across the area. An estimate, not an exact count.";

type Ttc = { timetableUntil: string; stops: [string, string, number, number][]; routes: Record<string, { long: string; type: number; color: string; stops: number[]; shapes: Position[][] }> };
type Indexed = { feature: Feature<Area>; bbox: BBox; area: number };
type Ksi = { years: [number, number]; lastDate: string; points: [number, number, number, number][] };

const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
const overlaps = (a: BBox, b: BBox) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const within = (inner: BBox, outer: BBox) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

export class Gis {
  private readonly dir: string;
  private readonly cache = new Map<string, unknown>();
  private stored: Stored[] | undefined;

  constructor(dir = join(import.meta.dirname, "../assets/gis")) {
    this.dir = dir;
  }

  // A dataset's file, read once. Other modules' GIS tools read theirs through it too.
  read<T>(file: string): T {
    const known = this.cache.get(file);
    if (known) return known as T;
    const value = JSON.parse(gunzipSync(readFileSync(join(this.dir, file))).toString("utf8")) as T;
    this.cache.set(file, value);
    return value;
  }

  private all(): Stored[] {
    // datasets.json, from scripts/build-gis-data.ts, then any datasets-<name>.json
    // another script writes, such as datasets-safety.json.
    this.stored ??= readdirSync(this.dir)
      .filter((file) => /^datasets(-[a-z0-9-]+)?\.json$/.test(file))
      .sort((a, b) => Number(a !== "datasets.json") - Number(b !== "datasets.json") || a.localeCompare(b))
      .flatMap((file) => JSON.parse(readFileSync(join(this.dir, file), "utf8")) as Stored[]);
    return this.stored;
  }

  datasets(): DatasetInfo[] {
    return this.all().map(({ file: _file, ...info }) => info);
  }

  dataset(id: string): Stored {
    const found = this.all().find((d) => d.id === id);
    if (!found) throw new GisError("unknown_dataset", `No dataset "${id}". Datasets: ${this.all().map((d) => d.id).join(", ")}`);
    return found;
  }

  // The fields a figure's citation needs.
  cite(id: string): Dataset {
    const { title, publisher, licence, url, retrieved } = this.dataset(id);
    return { id, title, publisher, licence, url, retrieved };
  }

  private ttc(): Ttc {
    return this.read<Ttc>("ttc.json.gz");
  }

  route(name: string) {
    const route = this.ttc().routes[name.toUpperCase()] ?? this.ttc().routes[name];
    if (!route) throw new GisError("unknown_route", `No TTC route "${name}" in the timetable to ${this.ttc().timetableUntil}`);
    return { name: this.ttc().routes[name] ? name : name.toUpperCase(), ...route, color: route.color ? `#${route.color.toLowerCase()}` : undefined };
  }

  // Every stop any of the route's trips calls at: all branches, both directions.
  routeStops(name: string): Made {
    const route = this.route(name);
    const { stops } = this.ttc();
    const features = route.stops.map((i) => {
      const [code, stop, lon, lat] = stops[i] as Ttc["stops"][number];
      return { type: "Feature" as const, properties: { code, name: stop }, geometry: { type: "Point" as const, coordinates: [lon, lat] } };
    });
    return { kind: "points", features, dataset: this.cite("ttc-gtfs") };
  }

  // The route's main shapes: each that carries at least 5% of its trips.
  routeShape(name: string): Made {
    const route = this.route(name);
    const features = route.shapes.map((line, i) => ({
      type: "Feature" as const,
      properties: { route: route.name, shape: i + 1 },
      geometry: { type: "LineString" as const, coordinates: line },
    }));
    return { kind: "lines", features, dataset: this.cite("ttc-gtfs") };
  }

  // Each area of a polygon dataset, with its bounding box and area in m².
  private areas(id: string): Indexed[] {
    const key = `areas:${id}`;
    const known = this.cache.get(key);
    if (known) return known as Indexed[];
    const info = this.dataset(id);
    if (info.kind !== "polygons") throw new GisError("not_areas", `"${id}" holds ${info.kind}, not areas. Use points_within for points`);
    const { features } = this.read<FeatureCollection<Area>>(info.file);
    const indexed = features.map((feature) => ({ feature, bbox: bboxOf(feature) as BBox, area: areaOf(feature) }));
    this.cache.set(key, indexed);
    return indexed;
  }

  // One named area of a dataset, such as a neighbourhood, by its name or id.
  namedArea(id: string, name: string): Made & { name: string } {
    const wanted = name.trim().toLowerCase();
    const areas = this.areas(id);
    const named = (a: Indexed) => String(a.feature.properties?.name ?? "").toLowerCase();
    const found = areas.filter((a) => named(a) === wanted || String(a.feature.properties?.id ?? "") === name.trim());
    if (!found.length) {
      const near = areas.filter((a) => named(a).includes(wanted) || wanted.includes(named(a) || "\u0000")).map((a) => a.feature.properties?.name);
      const hint = near.length ? ` Did you mean: ${near.slice(0, 5).join(", ")}?` : id === "census-da-2021" ? " Census areas go by their 8-digit id." : "";
      throw new GisError("unknown_area", `"${id}" has no area named "${name}".${hint}`);
    }
    const features = found.map((a) => ({ type: "Feature" as const, properties: pick(a.feature.properties, ["id", "name", "class"]), geometry: a.feature.geometry }));
    return { kind: "polygons", features, dataset: this.cite(id), name: String(found[0]?.feature.properties?.name ?? found[0]?.feature.properties?.id) };
  }

  // The variables overlay can total for an area dataset: its counts and their shares.
  variables(id: string): Record<string, { label: string; unit: string }> {
    const counts = this.dataset(id).variables;
    if (!counts) return {};
    const shares = Object.fromEntries(
      Object.entries(SHARES)
        .filter(([, s]) => counts[s.of] && counts[s.base])
        .map(([name, s]) => [name, { label: s.label, unit: "%" }]),
    );
    return { ...counts, ...shares };
  }

  // Areas of a dataset against a polygon layer: each area's share of its land inside
  // the layer, the piece inside as a feature, and area-weighted totals.
  overlay(layer: Feature[], id: string, variables: string[] = []): Made {
    const info = this.dataset(id);
    const known = this.variables(id);
    const unknown = variables.filter((v) => !known[v]);
    if (unknown.length) {
      const offer = Object.keys(known);
      throw new GisError(
        "unknown_variable",
        offer.length ? `"${id}" has no ${unknown.join(", ")}. It has: ${offer.join(", ")}` : `"${id}" has no counts to total, only its areas`,
      );
    }
    const mask = dissolve(layer);
    const maskBox = bboxOf(mask) as BBox;
    this.covers(info, maskBox);
    const counts = Object.keys(info.variables ?? {});
    const sums: Record<string, number> = Object.fromEntries(counts.map((c) => [c, 0]));
    const features: Feature[] = [];
    let inside = 0;
    let withoutData = 0;
    for (const { feature, bbox, area } of this.areas(id)) {
      if (!overlaps(bbox, maskBox) || !area) continue;
      // The layer cut to the area's box first: a long corridor's outline is large, and
      // intersecting it whole with each of hundreds of areas is slow.
      const near = clean(bboxClip(mask, bbox) as Feature<Area>);
      if (!near) continue;
      const piece = intersect(featureCollection([feature, near]));
      if (!piece) continue;
      const land = areaOf(piece);
      const share = Math.min(1, land / area);
      if (share < 1e-6) continue;
      inside += land;
      const properties: Record<string, unknown> = { ...pick(feature.properties, ["id", "name", "class"]), share: round(share, 3) };
      if (variables.some((v) => feature.properties?.[SHARES[v]?.of ?? v] === null || feature.properties?.[SHARES[v]?.base ?? v] === null)) withoutData += 1;
      for (const count of counts) {
        const value = feature.properties?.[count];
        if (typeof value === "number") sums[count] = (sums[count] as number) + value * share;
      }
      for (const variable of variables) {
        const value = feature.properties?.[variable];
        if (typeof value === "number") properties[variable] = round(value * share, 1);
      }
      features.push({ type: "Feature", properties, geometry: piece.geometry });
    }
    const layerArea = areaOf(mask);
    const noun = NOUNS[id] ?? "areas";
    const totals: Record<string, Total> = {
      areas: { value: features.length, unit: "areas", label: `${noun[0]?.toUpperCase()}${noun.slice(1)} touched` },
      landKm2: { value: round(inside / 1e6, 2), unit: "km²", label: `Land inside the layer and in ${noun}` },
      layerShare: { value: round((inside / layerArea) * 100, 1), unit: "%", label: `Share of the layer in ${noun}` },
    };
    for (const [name, value] of Object.entries(sums)) {
      const v = known[name] as { label: string; unit: string };
      totals[name] = { value: Math.round(value), unit: v.unit, label: `${v.label}, area-weighted` };
    }
    for (const [name, share] of Object.entries(SHARES)) {
      const of = sums[share.of];
      const base = sums[share.base];
      if (of === undefined || base === undefined) continue;
      totals[name] = { value: base ? round((of / base) * 100, 1) : 0, unit: "%", label: `${share.label}, area-weighted` };
    }
    const warnings: string[] = [];
    if (withoutData) {
      warnings.push(`${withoutData} of ${features.length} areas lack a count asked for: Statistics Canada suppresses some counts for very small areas, so they add nothing to it.`);
    }
    if (counts.length && inside < layerArea * 0.98) {
      warnings.push(`${round(100 - (inside / layerArea) * 100, 1)}% of the layer is outside the census areas (outside the City, or on water). Nothing there is counted.`);
    }
    return { kind: "polygons", features, dataset: this.cite(id), totals, warnings };
  }

  // Points of a dataset inside a polygon layer: collisions, heritage properties or
  // stops, with counts. Collisions can be narrowed by year, by whether someone was
  // killed, and by who was involved.
  pointsWithin(layer: Feature[], id: string, filter: { from?: number; to?: number; fatal?: boolean; involving?: string } = {}): Made {
    const info = this.dataset(id);
    if (info.kind !== "points") throw new GisError("not_points", `"${id}" holds ${info.kind}, not points. Use overlay for areas`);
    const narrowed = filter.from !== undefined || filter.to !== undefined || filter.fatal !== undefined || filter.involving !== undefined;
    if (id !== "toronto-ksi" && narrowed) throw new GisError("no_filter", `Only toronto-ksi can be narrowed by year, fatal or involving`);
    const mask = dissolve(layer);
    const maskBox = bboxOf(mask) as BBox;
    this.covers(info, maskBox);
    const count = COUNTS[id] as (typeof COUNTS)[string];
    const inMask = (lon: number, lat: number) =>
      lon >= maskBox[0] && lon <= maskBox[2] && lat >= maskBox[1] && lat <= maskBox[3] && booleanPointInPolygon([lon, lat], mask);
    const features: Feature[] = [];
    const totals: Record<string, Total> = {};
    const warnings: string[] = [];

    if (id === "toronto-ksi") {
      const ksi = this.read<Ksi>(info.file);
      const from = filter.from ?? ksi.years[0];
      const to = filter.to ?? ksi.years[1];
      if (from > to) throw new GisError("bad_years", `from (${from}) is after to (${to})`);
      if (from < ksi.years[0] || to > ksi.years[1]) {
        throw new GisError("outside_years", `The collisions run from ${ksi.years[0]} to ${ksi.lastDate}. Ask for years in that range`);
      }
      const bit = { pedestrian: 2, cyclist: 4, motorcyclist: 8 }[filter.involving ?? ""] ?? 0;
      let fatal = 0;
      let pedestrian = 0;
      let cyclist = 0;
      for (const [lon, lat, year, flags] of ksi.points) {
        if (year < from || year > to || (filter.fatal && !(flags & 1)) || (bit && !(flags & bit)) || !inMask(lon, lat)) continue;
        const involving = [flags & 2 ? "pedestrian" : "", flags & 4 ? "cyclist" : "", flags & 8 ? "motorcyclist" : ""].filter(Boolean).join(", ");
        features.push({ type: "Feature", properties: { year, fatal: Boolean(flags & 1), ...(involving ? { involving } : {}) }, geometry: { type: "Point", coordinates: [lon, lat] } });
        if (flags & 1) fatal += 1;
        if (flags & 2) pedestrian += 1;
        if (flags & 4) cyclist += 1;
      }
      const years = from === to ? `${from}` : `${from}–${to}`;
      const which = [filter.fatal ? "fatal" : "", filter.involving ? `involving a ${filter.involving}` : ""].filter(Boolean).join(", ");
      totals.collisions = { value: features.length, unit: "collisions", label: `KSI collisions${which ? ` (${which})` : ""}, ${years}` };
      totals.fatal = { value: fatal, unit: "collisions", label: `KSI collisions where someone was killed, ${years}` };
      totals.pedestrian = { value: pedestrian, unit: "collisions", label: `KSI collisions involving a pedestrian, ${years}` };
      totals.cyclist = { value: cyclist, unit: "collisions", label: `KSI collisions involving a cyclist, ${years}` };
      if (to >= Number(ksi.lastDate.slice(0, 4))) warnings.push(`${ksi.lastDate.slice(0, 4)} is partial: the collisions run to ${ksi.lastDate}.`);
    } else if (id === "ttc-gtfs") {
      for (const [code, name, lon, lat] of this.ttc().stops) {
        if (inMask(lon, lat)) features.push({ type: "Feature", properties: { code, name }, geometry: { type: "Point", coordinates: [lon, lat] } });
      }
      totals.stops = { value: features.length, unit: count.unit, label: count.label };
    } else {
      const { features: points } = this.read<FeatureCollection<Point>>(info.file);
      for (const point of points) {
        const [lon, lat] = point.geometry.coordinates as [number, number];
        if (inMask(lon, lat)) features.push(point);
      }
      totals[count.name] = { value: features.length, unit: count.unit, label: count.label };
    }
    return { kind: "points", features, dataset: this.cite(id), totals, warnings };
  }

  // A dataset that covers only part of the city answers only inside it.
  private covers(info: Stored, box: BBox) {
    if (info.bbox && !within(box, info.bbox)) {
      throw new GisError("outside_coverage", `"${info.id}" covers ${info.coverage}. This layer reaches beyond it, so its answer would be short`);
    }
  }
}

// A clipped area without the rings clipping left too small to be rings, or nothing.
function clean(feature: Feature<Area>): Feature<Area> | undefined {
  const polygon = (rings: Position[][]) => {
    const kept = rings.filter((ring) => ring.length >= 4);
    return kept.length && kept[0] === rings[0] ? kept : undefined;
  };
  const { geometry } = feature;
  const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates).map(polygon).filter((p): p is Position[][] => Boolean(p));
  if (!polygons.length) return undefined;
  const single = polygons.length === 1;
  return { type: "Feature", properties: {}, geometry: single ? { type: "Polygon", coordinates: polygons[0] as Position[][] } : { type: "MultiPolygon", coordinates: polygons } };
}

// A layer's features as one polygon, so overlapping parts count once.
export function dissolve(features: Feature[]): Feature<Area> {
  const polygons = features.filter((f): f is Feature<Area> => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon");
  if (!polygons.length || polygons.length < features.length) {
    throw new GisError("not_polygons", "This needs a layer of areas, such as a buffer. Buffer the layer first");
  }
  if (polygons.length === 1) return polygons[0] as Feature<Area>;
  const merged = union(featureCollection(polygons));
  if (!merged) throw new GisError("empty", "The layer's areas add up to nothing");
  return merged;
}

// A layer's features buffered by some metres, as one polygon.
export function buffer(features: Feature[], metres: number): Made {
  if (!features.length) throw new GisError("empty", "The layer has no features to buffer");
  const circles = features.map((f) => bufferOf(f as Feature<Geometry>, metres, { units: "meters", steps: STEPS })).filter((f): f is Feature<Area> => Boolean(f));
  const merged = circles.length === 1 ? circles[0] : union(featureCollection(circles));
  if (!merged) throw new GisError("empty", "The buffer is empty");
  return { kind: "polygons", features: [{ type: "Feature", properties: { metres }, geometry: merged.geometry }] };
}

// What a layer covers: its features, and their area or length.
export function measure(kind: LayerKind, features: Feature[]): { featureCount: number; areaKm2?: number; lengthKm?: number } {
  const collection = featureCollection(features);
  if (kind === "polygons") return { featureCount: features.length, areaKm2: round(areaOf(collection) / 1e6, 2) };
  if (kind === "lines") return { featureCount: features.length, lengthKm: round(lengthOf(collection as FeatureCollection<LineString>, { units: "kilometers" }), 2) };
  return { featureCount: features.length };
}

export function boundsOf(features: Feature[]): BBox {
  if (!features.length) return [0, 0, 0, 0];
  return (bboxOf(featureCollection(features)) as BBox).map((n) => round(n, 6)) as BBox;
}

function pick(properties: Feature["properties"], keys: string[]) {
  return Object.fromEntries(keys.filter((key) => properties?.[key] !== undefined && properties?.[key] !== null).map((key) => [key, properties?.[key]]));
}

// A study's line as the display draws it: metres east and north of ORIGIN on a flat
// projection, undone here. Built parts and proposed parts are each a feature.
const ORIGIN = { lat: 43.7, lon: -79.4 };
const METRES_PER_DEG_LAT = 110_574;
const METRES_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function studyLine(line: string | undefined, file = join(import.meta.dirname, "../../../apps/display/public/data/studies.json")): Made {
  const lines = JSON.parse(readFileSync(file, "utf8")) as Record<string, { lines?: [number, number][][]; proposed?: [number, number][][] }>;
  const drawn = line ? lines[line] : undefined;
  if (!drawn) throw new GisError("no_line", "This study has no line on the map");
  const unproject = ([x, y]: [number, number]): Position => [round(ORIGIN.lon + x / METRES_PER_DEG_LON, 6), round(ORIGIN.lat + y / METRES_PER_DEG_LAT, 6)];
  const features: Feature[] = [];
  for (const [part, key] of [["built", "lines"], ["proposed", "proposed"]] as const) {
    for (const points of drawn[key] ?? []) {
      if (points.length >= 2) features.push({ type: "Feature", properties: { part }, geometry: { type: "LineString", coordinates: points.map(unproject) } });
    }
  }
  return { kind: "lines", features };
}

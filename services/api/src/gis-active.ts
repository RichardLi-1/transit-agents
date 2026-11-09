// Walking and cycling near transit, worked out here and never by a model: the
// cycling network and sidewalks inside an area layer, in km by type; bike share
// stations and their docks; and, for each stop of a points layer, the nearest bike
// share station and the bikeways within a distance. Each result is a layer on the
// study, its main totals figures citing the dataset.
import { bbox as bboxOf } from "@turf/bbox";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import type { ActiveLayerRequest as ActiveSchema, FirstLastMileRequest as MileSchema } from "@transit-agents/contracts";
import type { Feature, FeatureCollection, MultiLineString, Point, Position } from "geojson";
import type { z } from "zod";
import { dissolve, type Gis, GisError, type Made, type Total } from "./gis.ts";
import { Edges, layerId, lineMetres, metres, metresNear, refusing, round, sourceLayer } from "./gis-layers.ts";
import type { Service } from "./service.ts";

export const CYCLING = "toronto-cycling-network";
export const SIDEWALKS = "toronto-sidewalks";
export const BIKE_SHARE = "bike-share-toronto";

// The City's cycling types in four groups, as the dataset's notes give them.
export const CYCLING_GROUPS: Record<string, { label: string; types: string[] }> = {
  separated: { label: "Separated: cycle tracks", types: ["Cycle Track", "Bi-Directional Cycle Track", "Cycle Track - Contraflow"] },
  painted: { label: "Painted bike lanes", types: ["Bike Lane", "Bike Lane - Buffered", "Bike Lane - Contraflow"] },
  trail: {
    label: "Multi-use trails",
    types: ["Multi-Use Trail", "Multi-Use Trail - Boulevard", "Multi-Use Trail - Connector", "Multi-Use Trail - Existing Connector", "Multi-Use Trail - Entrance"],
  },
  shared: { label: "Shared roads: sharrows, signed routes, park roads", types: ["Sharrows", "Sharrows - Wayfinding", "Sharrows - Arterial", "Sharrows - Arterial - Connector", "Signed Route (No Pavement Markings)", "Park Road"] },
};
const GROUP_OF = new Map(Object.entries(CYCLING_GROUPS).flatMap(([group, { types }]) => types.map((type) => [type, group] as const)));
// A bikeway, for first and last mile: a facility of its own, not a shared road.
const BIKEWAYS = new Set(["separated", "painted", "trail"]);

export const SIDEWALK_LABELS: Record<string, string> = {
  both: "Sidewalk on both sides",
  one: "Sidewalk on one side only",
  onePartial: "Sidewalk on one side, partly on the other",
  partial: "Partial sidewalk on at least one side",
  none: "No sidewalk on either side",
  building: "Roadway under development",
};

type Sidewalks = { statuses: string[]; roads: string[]; segments: (number | number[])[][] };
type Segment = { group?: string; type?: string; status?: string; road?: string; street?: string; lines: Position[][]; box: [number, number, number, number] };

const boxOf = (lines: Position[][]): [number, number, number, number] => {
  const xs = lines.flat().map((p) => p[0] as number);
  const ys = lines.flat().map((p) => p[1] as number);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const overlaps = (a: number[], b: number[]) => (a[0] as number) <= (b[2] as number) && (b[0] as number) <= (a[2] as number) && (a[1] as number) <= (b[3] as number) && (b[1] as number) <= (a[3] as number);
const km = (m: number) => round(m / 1000, 2);

export class Active {
  private readonly cache = new Map<string, Segment[]>();
  private readonly gis: Gis;
  constructor(gis: Gis) {
    this.gis = gis;
  }

  private cycling(): Segment[] {
    const known = this.cache.get(CYCLING);
    if (known) return known;
    const { features } = this.gis.read<FeatureCollection<MultiLineString>>(this.gis.dataset(CYCLING).file);
    const segments = features.map((f) => {
      const type = String(f.properties?.type);
      return { type, group: GROUP_OF.get(type) ?? "shared", street: String(f.properties?.street ?? ""), lines: f.geometry.coordinates, box: boxOf(f.geometry.coordinates) };
    });
    this.cache.set(CYCLING, segments);
    return segments;
  }

  private sidewalks(): Segment[] {
    const known = this.cache.get(SIDEWALKS);
    if (known) return known;
    const data = this.gis.read<Sidewalks>(this.gis.dataset(SIDEWALKS).file);
    const segments = data.segments.map(([status, road, ...parts]) => {
      const lines = (parts as number[][]).map((steps) => {
        const points: Position[] = [];
        let [x, y] = [0, 0];
        for (let i = 0; i < steps.length; i += 2) {
          x += steps[i] as number;
          y += steps[i + 1] as number;
          points.push([x / 1e5, y / 1e5]);
        }
        return points;
      });
      return { status: data.statuses[status as number] as string, road: data.roads[road as number] as string, lines, box: boxOf(lines) };
    });
    this.cache.set(SIDEWALKS, segments);
    return segments;
  }

  private stations(): Feature<Point>[] {
    return this.gis.read<FeatureCollection<Point>>(this.gis.dataset(BIKE_SHARE).file).features;
  }

  // Each segment's parts inside an area.
  private clip(layer: Feature[], segments: Segment[]): { segment: Segment; lines: Position[][]; metres: number }[] {
    const mask = dissolve(layer);
    const box = bboxOf(mask);
    const edges = new Edges(mask);
    return segments.flatMap((segment) => {
      if (!overlaps(segment.box, box)) return [];
      const lines = segment.lines.flatMap((line) => edges.clip(line));
      const length = lines.reduce((n, line) => n + lineMetres(line), 0);
      return length > 0.5 ? [{ segment, lines, metres: length }] : [];
    });
  }

  // The cycling network inside an area: km by group and by the City's own type.
  cyclingWithin(layer: Feature[]): Made & { byType: Record<string, number> } {
    const pieces = this.clip(layer, this.cycling());
    const byGroup: Record<string, number> = Object.fromEntries(Object.keys(CYCLING_GROUPS).map((g) => [g, 0]));
    const byType: Record<string, number> = {};
    for (const { segment, metres: m } of pieces) {
      byGroup[segment.group as string] = (byGroup[segment.group as string] as number) + m;
      byType[segment.type as string] = (byType[segment.type as string] ?? 0) + m;
    }
    const total = Object.values(byGroup).reduce((a, b) => a + b, 0);
    const totals: Record<string, Total> = {
      totalKm: { value: km(total), unit: "km", label: "Cycling network, all types" },
      ...Object.fromEntries(Object.entries(CYCLING_GROUPS).map(([group, { label }]) => [`${group}Km`, { value: km(byGroup[group] as number), unit: "km", label }])),
      bikewayKm: { value: km(sum(Object.entries(byGroup).filter(([g]) => BIKEWAYS.has(g)).map(([, m]) => m))), unit: "km", label: "Bikeways: cycle tracks, bike lanes and multi-use trails" },
    };
    const warnings = ["Measured along the street: a street with a lane on each side counts once.", "A segment's type is the City's; whether it is comfortable or connected isn't in the data."];
    if (!pieces.length) warnings.push("No cycling network inside this area.");
    return {
      kind: "lines",
      features: pieces.map(({ segment, lines, metres: m }) => ({
        type: "Feature",
        properties: { type: segment.type, group: segment.group, street: segment.street, km: km(m) },
        geometry: { type: "MultiLineString", coordinates: lines },
      })),
      dataset: this.gis.cite(CYCLING),
      totals,
      warnings,
      byType: Object.fromEntries(Object.entries(byType).map(([t, m]) => [t, km(m)] as const).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    };
  }

  // Streets inside an area by their sidewalks, in km.
  sidewalksWithin(layer: Feature[]): Made {
    const pieces = this.clip(layer, this.sidewalks());
    const by: Record<string, number> = Object.fromEntries(Object.keys(SIDEWALK_LABELS).map((s) => [s, 0]));
    for (const { segment, metres: m } of pieces) by[segment.status as string] = (by[segment.status as string] as number) + m;
    const street = sum(Object.values(by));
    const share = (m: number) => (street ? round((m / street) * 100, 1) : 0);
    const totals: Record<string, Total> = {
      streetKm: { value: km(street), unit: "km", label: "Streets in the sidewalk inventory (local, collector and arterial)" },
      ...Object.fromEntries(Object.entries(SIDEWALK_LABELS).map(([status, label]) => [`${status}Km`, { value: km(by[status] as number), unit: "km", label: `Streets: ${label.toLowerCase()}` }])),
      noSidewalkShare: { value: share(by.none as number), unit: "%", label: "Share of street km with no sidewalk on either side" },
      bothSidesShare: { value: share(by.both as number), unit: "%", label: "Share of street km with a sidewalk on both sides" },
    };
    const warnings = ["The inventory dates from 2017: sidewalks built since are missing, so gaps may already be filled.", "Measured along the street centreline, not each side."];
    if (!pieces.length) warnings.push("No streets from the inventory inside this area.");
    return {
      kind: "lines",
      features: pieces.map(({ segment, lines, metres: m }) => ({
        type: "Feature",
        properties: { status: segment.status, sidewalks: SIDEWALK_LABELS[segment.status as string], road: segment.road, km: km(m) },
        geometry: { type: "MultiLineString", coordinates: lines },
      })),
      dataset: this.gis.cite(SIDEWALKS),
      totals,
      warnings,
    };
  }

  // Bike share stations inside an area, and their docks.
  bikeShareWithin(layer: Feature[]): Made {
    const mask = dissolve(layer);
    const [w, s, e, n] = bboxOf(mask) as [number, number, number, number];
    const inside = this.stations().filter((f) => {
      const [x, y] = f.geometry.coordinates as [number, number];
      return x >= w && x <= e && y >= s && y <= n && booleanPointInPolygon([x, y], mask);
    });
    const docks = sum(inside.map((f) => Number(f.properties?.docks ?? 0)));
    const warnings = ["One day's list of stations: they open, close and move. Docks are each station's size, not bikes available."];
    if (!inside.length) warnings.push("No bike share stations inside this area.");
    return {
      kind: "points",
      features: inside,
      dataset: this.gis.cite(BIKE_SHARE),
      totals: {
        stations: { value: inside.length, unit: "stations", label: "Bike share stations" },
        docks: { value: docks, unit: "docks", label: "Bike share docks" },
      },
      warnings,
    };
  }

  // For each stop: the nearest bike share station, and the bikeways within `radius`.
  firstLastMile(stops: Feature[], radius: number): { bikeShare: Made; bikeways: Made; gaps: Record<string, unknown>[] } {
    const points = stops.filter((f): f is Feature<Point> => f.geometry?.type === "Point");
    if (!points.length || points.length < stops.length) throw new GisError("not_points", "This needs a layer of stops, such as route_stops makes");
    const stations = this.stations();
    const bikeways = this.cycling().filter((s) => BIKEWAYS.has(s.group as string));
    const degLat = radius / 110_574;
    const degLon = radius / (111_320 * Math.cos((43.7 * Math.PI) / 180));
    const features: Feature[] = points.map((stop) => {
      const at = stop.geometry.coordinates as Position;
      let nearest: { name: string; m: number } | undefined;
      let within = 0;
      for (const station of stations) {
        const m = metres(at, station.geometry.coordinates as Position);
        if (!nearest || m < nearest.m) nearest = { name: String(station.properties?.name), m };
        if (m <= radius) within += 1;
      }
      const box = [(at[0] as number) - degLon, (at[1] as number) - degLat, (at[0] as number) + degLon, (at[1] as number) + degLat];
      let bikeway = 0;
      for (const segment of bikeways) {
        if (!overlaps(segment.box, box)) continue;
        for (const line of segment.lines) bikeway += metresNear(line, at, radius);
      }
      return {
        type: "Feature",
        properties: {
          ...(stop.properties?.code ? { code: stop.properties.code } : {}),
          ...(stop.properties?.name ? { name: stop.properties.name } : {}),
          nearestStation: nearest?.name ?? null,
          nearestStationM: nearest ? Math.round(nearest.m) : null,
          stationsWithin: within,
          bikewayKmWithin: km(bikeway),
          // A bikeway counts once at least 10 m of it is within reach.
          bikeway: bikeway >= 10,
          gap: !within && bikeway < 10,
        },
        geometry: stop.geometry,
      };
    });
    const count = (test: (p: Record<string, unknown>) => boolean) => features.filter((f) => test(f.properties ?? {})).length;
    const n = features.length;
    const share = (k: number) => round((k / n) * 100, 1);
    const withShare = count((p) => (p.stationsWithin as number) > 0);
    const withBikeway = count((p) => p.bikeway === true);
    const straight = `Straight-line distances, not routes along streets: a place ${radius} m away may be further to reach.`;
    // Two layers, each citing the dataset its totals come from.
    const pick = (keys: string[]) => features.map((f) => ({ ...f, properties: Object.fromEntries(keys.filter((k) => f.properties?.[k] !== undefined).map((k) => [k, f.properties?.[k]])) }));
    return {
      bikeShare: {
        kind: "points",
        features: pick(["code", "name", "nearestStation", "nearestStationM", "stationsWithin"]),
        dataset: this.gis.cite(BIKE_SHARE),
        totals: {
          stops: { value: n, unit: "stops", label: "Stops" },
          stopsWithBikeShare: { value: withShare, unit: "stops", label: `Stops with a bike share station within ${radius} m` },
          stopsWithoutBikeShare: { value: n - withShare, unit: "stops", label: `Stops with no bike share station within ${radius} m` },
          bikeShareShare: { value: share(withShare), unit: "%", label: `Share of stops with a bike share station within ${radius} m` },
        },
        warnings: [straight, "One day's list of stations: they open, close and move."],
      },
      bikeways: {
        kind: "points",
        features: pick(["code", "name", "bikewayKmWithin", "bikeway"]),
        dataset: this.gis.cite(CYCLING),
        totals: {
          stops: { value: n, unit: "stops", label: "Stops" },
          stopsWithBikeway: { value: withBikeway, unit: "stops", label: `Stops with a bikeway (cycle track, bike lane or trail) within ${radius} m` },
          stopsWithoutBikeway: { value: n - withBikeway, unit: "stops", label: `Stops with no bikeway within ${radius} m` },
          bikewayShare: { value: share(withBikeway), unit: "%", label: `Share of stops with a bikeway within ${radius} m` },
        },
        warnings: [straight, "Shared roads (sharrows, signed routes, park roads) don't count as bikeways. Whether a bikeway connects to where people go isn't in the data."],
      },
      gaps: features.filter((f) => f.properties?.gap).map((f) => f.properties ?? {}),
    };
  }
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

type Kind = "cycling" | "sidewalks" | "bike-share";
const KIND: Record<Kind, { operation: string; title: string; color: string; record: string[]; run: (a: Active, f: Feature[]) => Made & { byType?: Record<string, number> } }> = {
  cycling: { operation: "cycling_within", title: "Cycling network in", color: "#15803d", record: ["totalKm", "separatedKm", "paintedKm", "trailKm", "sharedKm", "bikewayKm"], run: (a, f) => a.cyclingWithin(f) },
  sidewalks: { operation: "sidewalks_within", title: "Sidewalks in", color: "#6b7280", record: ["streetKm", "noneKm", "noSidewalkShare", "bothSidesShare"], run: (a, f) => a.sidewalksWithin(f) },
  "bike-share": { operation: "bike_share_within", title: "Bike share stations in", color: "#0284c7", record: ["stations", "docks"], run: (a, f) => a.bikeShareWithin(f) },
};

// The service's side: each request on a study's layer, saved as a layer with its
// main totals recorded as figures.
export function activeLayer(service: Service, actor: string, studyId: string, kind: Kind, input: z.output<typeof ActiveSchema>) {
  const source = sourceLayer(service, studyId, input.layer);
  const spec = KIND[kind];
  const made = refusing(() => spec.run(new Active(service.gis), source.features));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? layerId(source.layer.id, kind),
      title: input.title ?? `${spec.title} ${source.layer.title}`,
      color: spec.color,
      derivedFrom: [source.layer.id],
      operation: { name: spec.operation, params: { layer: source.layer.id } },
    },
    spec.record,
    source.layer.title,
  );
  return { ...saved, ...(made.byType ? { byType: made.byType } : {}) };
}

export function firstLastMileLayer(service: Service, actor: string, studyId: string, input: z.output<typeof MileSchema>) {
  const source = sourceLayer(service, studyId, input.layer);
  const made = refusing(() => new Active(service.gis).firstLastMile(source.features, input.metres));
  const id = input.id ?? layerId(source.layer.id, "access", `${input.metres}m`);
  const save = (what: "bike-share" | "bikeways", layer: Made, record: string[]) =>
    service.saveLayer(
      actor,
      studyId,
      layer,
      {
        id: layerId(id.slice(0, 50), what),
        title: input.title ? `${input.title}: ${what === "bikeways" ? "bikeways" : "bike share"}` : `${what === "bikeways" ? "Bikeways" : "Bike share"} within ${input.metres} m of ${source.layer.title}`,
        color: what === "bikeways" ? "#15803d" : "#0284c7",
        derivedFrom: [source.layer.id],
        operation: { name: "first_last_mile", params: { layer: source.layer.id, metres: input.metres, what } },
      },
      record,
      source.layer.title,
    );
  return {
    bikeShare: save("bike-share", made.bikeShare, ["stopsWithBikeShare", "stopsWithoutBikeShare"]),
    bikeways: save("bikeways", made.bikeways, ["stopsWithBikeway", "stopsWithoutBikeway"]),
    // Stops with neither within reach: where first and last mile by bike is hardest.
    gaps: made.gaps.slice(0, 20),
    gapCount: made.gaps.length,
  };
}

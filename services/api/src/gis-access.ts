// An inventory of a route's or line's stops for the stop-accessibility skill: each
// stop's wheelchair_boarding from the TTC's GTFS, and the City's transit shelter
// nearest it, if one is close enough. Two tools, so each count cites its own dataset.
// They list what is there and what is missing; whether that meets the law is for a
// planner to judge.
import type { Feature, Point } from "geojson";
import { z } from "zod";
import { type Gis, GisError, type Made, type Total } from "./gis.ts";
import type { SkillRoute } from "./gis-skills.ts";
import type { Service } from "./service.ts";

const GTFS = "ttc-gtfs";
const SHELTERS = "toronto-transit-shelters";
// Each stop's wheelchair_boarding, from the same GTFS as ttc-gtfs.
const ACCESS = "ttc-access.json.gz";
// A shelter this close to a stop counts as the stop's, unless asked otherwise.
export const SHELTER_METRES = 25;

const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;
const share = (of: number, base: number) => (base ? round((of / base) * 100, 1) : 0);
// Metres on a flat projection at Toronto's latitude: close enough within 100 m.
const M_LAT = 110_574;
const M_LON = 111_320 * Math.cos((43.7 * Math.PI) / 180);
const metresBetween = ([a, b]: [number, number], [c, d]: [number, number]) => Math.hypot((a - c) * M_LON, (b - d) * M_LAT);

// GTFS wheelchair_boarding, as the TTC's feed gives it for a stop with no parent station.
const BOARDING: Record<number, string> = { 0: "no information", 1: "accessible", 2: "not accessible" };

// A station's name from a platform's, such as "Old Mill Station - Eastbound Platform".
// A street stop named for a station, such as "Don Mills Rd at Eglinton Ave East - Don
// Valley Station", isn't one.
export const stationOf = (name: string) => /^((?:(?! at | - ).)+? Station)\b/.exec(name)?.[1];

function stopsOf(stops: Feature[]): Feature<Point>[] {
  const points = stops.filter((f): f is Feature<Point> => f.geometry?.type === "Point" && typeof f.properties?.code === "string");
  if (!points.length || points.length < stops.length) {
    throw new GisError("not_stops", "This needs a layer of TTC stops, such as route_stops makes, each with its stop code");
  }
  return points;
}

// Each stop's wheelchair_boarding, and the stations with a platform marked not accessible.
export function stopAccess(gis: Gis, stops: Feature[]): Made & { gaps: { stops: string[]; stations: string[] } } {
  const points = stopsOf(stops);
  const flags = gis.read<{ stops: Record<string, number> }>(ACCESS).stops;
  const counts = { accessible: 0, notAccessible: 0, unknown: 0 };
  const stations = new Map<string, boolean>();
  const notAccessible: string[] = [];
  const features: Feature[] = points.map((stop) => {
    const code = String(stop.properties?.code);
    const name = String(stop.properties?.name ?? code);
    const flag = flags[code] ?? 0;
    if (flag === 1) counts.accessible += 1;
    else if (flag === 2) {
      counts.notAccessible += 1;
      notAccessible.push(`${name} (${code})`);
    } else counts.unknown += 1;
    const station = stationOf(name);
    if (station) stations.set(station, (stations.get(station) ?? true) && flag === 1);
    return { type: "Feature", properties: { code, name, wheelchair: BOARDING[flag] ?? "no information" }, geometry: stop.geometry };
  });
  const total = points.length;
  const totals: Record<string, Total> = {
    stops: { value: total, unit: "stops", label: "Stops" },
    accessible: { value: counts.accessible, unit: "stops", label: "Stops the GTFS marks wheelchair accessible (wheelchair_boarding 1)" },
    notAccessible: { value: counts.notAccessible, unit: "stops", label: "Stops the GTFS marks not wheelchair accessible (wheelchair_boarding 2)" },
    noInformation: { value: counts.unknown, unit: "stops", label: "Stops with no wheelchair_boarding in the GTFS" },
    accessibleShare: { value: share(counts.accessible, total), unit: "%", label: "Share of the stops the GTFS marks wheelchair accessible" },
  };
  const stationsNotAccessible = [...stations].filter(([, ok]) => !ok).map(([name]) => name).sort();
  if (stations.size) {
    totals.stations = { value: stations.size, unit: "stations", label: "Stations, from their platforms' names" };
    totals.stationsNotAccessible = { value: stationsNotAccessible.length, unit: "stations", label: "Stations with a platform the GTFS marks not wheelchair accessible" };
  }
  const warnings = [
    "wheelchair_boarding is the TTC's own flag in its GTFS, for each stop or platform. It says nothing about elevators, ramps, curbs or the path to the stop, and no dataset here does.",
    "An inventory, not a finding of compliance: whether a stop or station meets the law is for a planner to judge.",
  ];
  return { kind: "points", features, dataset: gis.cite(GTFS), totals, warnings, gaps: { stops: notAccessible.slice(0, 30), stations: stationsNotAccessible } };
}

type Shelter = { id: string; status: string; at: [number, number] };

// The City's transit shelter nearest each stop, within some metres.
export function stopShelters(gis: Gis, stops: Feature[], metres = SHELTER_METRES): Made & { gaps: { stops: string[] } } {
  const points = stopsOf(stops);
  const shelters = gis
    .read<{ features: Feature<Point>[] }>(gis.dataset(SHELTERS).file)
    .features.map((f): Shelter => ({ id: String(f.properties?.id), status: String(f.properties?.status), at: f.geometry.coordinates as [number, number] }));
  let sheltered = 0;
  let removed = 0;
  const without: string[] = [];
  const features: Feature[] = points.map((stop) => {
    const at = stop.geometry.coordinates as [number, number];
    const closest = shelters
      .filter((s) => Math.abs(s.at[0] - at[0]) < 0.001 && Math.abs(s.at[1] - at[1]) < 0.001)
      .map((s) => ({ s, m: metresBetween(at, s.at) }))
      .filter(({ m }) => m <= metres)
      .sort((a, b) => a.m - b.m || a.s.id.localeCompare(b.s.id))[0];
    if (closest?.s.status === "Existing") sheltered += 1;
    else {
      if (closest) removed += 1;
      without.push(`${String(stop.properties?.name)} (${String(stop.properties?.code)})`);
    }
    return {
      type: "Feature",
      properties: {
        code: stop.properties?.code,
        name: stop.properties?.name,
        shelter: closest ? closest.s.id : "none",
        ...(closest ? { shelterStatus: closest.s.status, shelterMetres: round(closest.m) } : {}),
      },
      geometry: stop.geometry,
    };
  });
  const total = points.length;
  const totals: Record<string, Total> = {
    stops: { value: total, unit: "stops", label: "Stops" },
    sheltered: { value: sheltered, unit: "stops", label: `Stops with a City transit shelter within ${metres} m` },
    shelteredShare: { value: share(sheltered, total), unit: "%", label: `Share of the stops with a City transit shelter within ${metres} m` },
    shelterRemoved: { value: removed, unit: "stops", label: `Stops whose nearest shelter within ${metres} m is temporarily removed` },
  };
  const warnings = [
    `A shelter is matched to a stop by distance, within ${metres} m: the City's shelters aren't linked to TTC stops, so one across a street or at the next stop can be matched wrongly, and a stop with no shelter in this data may have one the TTC or a mall owns.`,
    "The data says nothing on whether a shelter, its pad or the path to it is accessible.",
  ];
  return { kind: "points", features, dataset: gis.cite(SHELTERS), totals, warnings, gaps: { stops: without.slice(0, 30) } };
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, "Use lowercase letters, numbers, dots and dashes");
const name = { id: slug.optional(), title: z.string().min(1).max(80).optional() };
export const AccessRequest = z.object({ layer: slug, ...name });
export const ShelterRequest = z.object({
  layer: slug,
  // How close a shelter must be to count as a stop's.
  metres: z.number().min(5).max(60).optional(),
  ...name,
});

export function accessLayer(service: Service, actor: string, studyId: string, input: z.output<typeof AccessRequest>) {
  const source = service.studyLayer(studyId, input.layer);
  const made = service.gisCall(() => stopAccess(service.gis, source.features));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? `${source.layer.id}-access`.slice(0, 63),
      title: input.title ?? `Wheelchair boarding at ${source.layer.title}`,
      color: "#1d4ed8",
      derivedFrom: [source.layer.id],
      operation: { name: "stop_accessibility", params: { layer: source.layer.id } },
    },
    ["stops", "accessible", "notAccessible", "noInformation", "stationsNotAccessible"],
    source.layer.title,
  );
  return { ...saved, gaps: made.gaps };
}

export function shelterLayer(service: Service, actor: string, studyId: string, input: z.output<typeof ShelterRequest>) {
  const source = service.studyLayer(studyId, input.layer);
  const metres = input.metres ?? SHELTER_METRES;
  const made = service.gisCall(() => stopShelters(service.gis, source.features, metres));
  const saved = service.saveLayer(
    actor,
    studyId,
    made,
    {
      id: input.id ?? `${source.layer.id}-shelters${metres === SHELTER_METRES ? "" : `-${metres}m`}`.slice(0, 63),
      title: input.title ?? `Shelters at ${source.layer.title}`,
      color: "#0f766e",
      derivedFrom: [source.layer.id],
      operation: { name: "stop_shelters", params: { layer: source.layer.id, metres } },
    },
    ["sheltered", "shelterRemoved"],
    source.layer.title,
  );
  return { ...saved, gaps: made.gaps };
}

export const ACCESS_ROUTES: SkillRoute[] = [
  {
    path: "/v1/studies/:id/gis/stop-access",
    tool: "stop_accessibility",
    summary: "Each stop's GTFS wheelchair_boarding, for a layer of TTC stops, saved as a layer with counts recorded as figures citing the GTFS",
    description:
      "Inventory a layer of TTC stops, such as route_stops makes, from the TTC's GTFS (ttc-gtfs): how many it marks wheelchair accessible, not accessible or with no information, and which stations have a platform marked not accessible, listing the stops and stations marked not accessible. An inventory, not a finding of compliance. Saves the stops as a layer and records the counts as figures.",
    body: AccessRequest,
    run: (service, actor, studyId, body: z.output<typeof AccessRequest>) => accessLayer(service, actor, studyId, body),
  },
  {
    path: "/v1/studies/:id/gis/stop-shelters",
    tool: "stop_shelters",
    summary: "The City transit shelter nearest each stop of a layer of TTC stops, within some metres, saved as a layer with counts recorded as figures citing the shelters",
    description:
      "For a layer of TTC stops, such as route_stops makes, find the City's transit shelter (toronto-transit-shelters) nearest each stop, within metres (default 25): how many stops have one, how many have only one temporarily removed, and which have none. Matched by distance. Saves the stops as a layer and records the counts as figures.",
    body: ShelterRequest,
    run: (service, actor, studyId, body: z.output<typeof ShelterRequest>) => shelterLayer(service, actor, studyId, body),
  },
];

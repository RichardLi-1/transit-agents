// The gold answers of the safety-audit and active-transportation eval cases, worked
// out with the service's own tools on the committed datasets, the same calls the two
// skills make. Each case's value in cases.jsonl must equal what its steps give here:
// safety-gold.test.ts checks it.
//
// Usage: node evals/safety-gold.ts   prints each case's value, and the hot spot's name
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveLayerRequest, AreaRequest, BufferRequest, FirstLastMileRequest, KsiHotspotsRequest, KsiProfileRequest, KsiTrendRequest, NewStudy, RouteLayerRequest } from "@transit-agents/contracts";
import { activeLayer, firstLastMileLayer } from "../services/api/src/gis-active.ts";
import { ksiHotspotsLayer, ksiProfileLayer, ksiTrendLayer } from "../services/api/src/gis-safety.ts";
import { Service } from "../services/api/src/service.ts";

const ACTOR = "agent:gold";
const STUDY = "gold";

type Totals = Record<string, { value: number }> | undefined;
type Steps = (s: Service) => number;
type Filter = { from?: number; to?: number; involving?: "pedestrian" | "cyclist" | "motorcyclist" };

const stops = (s: Service, route: string) => s.routeLayer(ACTOR, STUDY, "stops", RouteLayerRequest.parse({ route })).layer.id;
const shape = (s: Service, route: string) => s.routeLayer(ACTOR, STUDY, "shape", RouteLayerRequest.parse({ route })).layer.id;
const area = (s: Service, dataset: string, name: string) => s.namedAreaLayer(ACTOR, STUDY, AreaRequest.parse({ dataset, name })).layer.id;
const buffer = (s: Service, layer: string, metres: number) => s.bufferLayer(ACTOR, STUDY, BufferRequest.parse({ layer, metres })).layer.id;
const profile = (s: Service, layer: string, filter: Filter = {}) => ksiProfileLayer(s, ACTOR, STUDY, KsiProfileRequest.parse({ layer, ...filter })).totals as Totals;
const hotspots = (s: Service, layer: string, filter: Filter = {}) => ksiHotspotsLayer(s, ACTOR, STUDY, KsiHotspotsRequest.parse({ layer, ...filter }));
const trend = (s: Service, layer: string, filter: Filter & { split?: number } = {}) => ksiTrendLayer(s, ACTOR, STUDY, KsiTrendRequest.parse({ layer, ...filter })).totals as Totals;
const within = (s: Service, kind: "cycling" | "sidewalks" | "bike-share", layer: string) => activeLayer(s, ACTOR, STUDY, kind, ActiveLayerRequest.parse({ layer })).totals as Totals;
const mile = (s: Service, layer: string, metres: number) => firstLastMileLayer(s, ACTOR, STUDY, FirstLastMileRequest.parse({ layer, metres }));
const value = (totals: Totals, name: string) => {
  const total = totals?.[name];
  if (!total) throw new Error(`No total ${name}`);
  return total.value;
};

// The Don Mills corridor: 50 m either side of the 25 Don Mills route.
const corridor = (s: Service) => buffer(s, shape(s, "25"), 50);
const TEN_YEARS = { from: 2016, to: 2025 };

export const GOLD: Record<string, Steps> = {
  // KSI collisions within 50 m of the 25 Don Mills route, 2016 to 2025.
  "safety-001": (s) => value(profile(s, corridor(s), TEN_YEARS), "collisions"),
  // Pedestrians killed or seriously injured there.
  "safety-002": (s) => value(profile(s, corridor(s), TEN_YEARS), "pedestrianKsi"),
  // KSI collisions at the place with the most along it.
  "safety-003": (s) => value(hotspots(s, corridor(s), TEN_YEARS).totals as Totals, "topCollisions"),
  // KSI collisions in the dark within 400 m of the 52's stops, 2021 to 2025.
  "safety-004": (s) => value(profile(s, buffer(s, stops(s, "52"), 400), { from: 2021, to: 2025 }), "dark"),
  // Change a year in KSI collisions along the corridor, 2016–2020 to 2021–2025.
  "safety-005": (s) => value(trend(s, corridor(s), { ...TEN_YEARS, split: 2021 }), "changePct"),
  // KSI collisions involving a pedestrian in Thorncliffe Park, 2016 to 2025, at or near an intersection.
  "safety-006": (s) => value(profile(s, area(s, "toronto-neighbourhoods", "Thorncliffe Park"), { ...TEN_YEARS, involving: "pedestrian" }), "atIntersection"),
  // People killed in KSI collisions within 400 m of the 54's stops, 2016 to 2025.
  "safety-009": (s) => value(profile(s, buffer(s, stops(s, "54"), 400), TEN_YEARS), "killed"),
  // km of bikeway (cycle tracks, bike lanes, trails) within 400 m of the 25's stops.
  "active-001": (s) => value(within(s, "cycling", buffer(s, stops(s, "25"), 400)), "bikewayKm"),
  // km of separated cycle track there.
  "active-002": (s) => value(within(s, "cycling", buffer(s, stops(s, "25"), 400)), "separatedKm"),
  // Share of street km within 400 m of the 52's stops with no sidewalk on either side.
  "active-003": (s) => value(within(s, "sidewalks", buffer(s, stops(s, "52"), 400)), "noSidewalkShare"),
  // Bike share stations within 400 m of the 504 King's stops.
  "active-004": (s) => value(within(s, "bike-share", buffer(s, stops(s, "504"), 400)), "stations"),
  // The 25's stops with no bike share station within 400 m.
  "active-005": (s) => value(mile(s, stops(s, "25"), 400).bikeShare.totals as Totals, "stopsWithoutBikeShare"),
  // The 54's stops with a bikeway within 400 m.
  "active-006": (s) => value(mile(s, stops(s, "54"), 400).bikeways.totals as Totals, "stopsWithBikeway"),
  // Bike share docks within 800 m of Line 2's stations.
  "active-008": (s) => value(within(s, "bike-share", buffer(s, stops(s, "2"), 800)), "docks"),
  // km of painted bike lane within 400 m of the 504 King's stops.
  "active-010": (s) => value(within(s, "cycling", buffer(s, stops(s, "504"), 400)), "paintedKm"),
};

// What a case's wording must name, worked out the same way: the busiest place.
export function hotspotName(): string {
  return withService((s) => String(hotspots(s, corridor(s), TEN_YEARS).hotspots[0]?.name));
}

function withService<T>(run: (s: Service) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "safety-gold-"));
  const service = new Service(join(dir, "gold.db"));
  try {
    service.openStudy(ACTOR, NewStudy.parse({ id: STUDY, title: "Gold" }));
    return run(service);
  } finally {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Each case's value, each in a study of its own on a fresh service.
export function gold(): Record<string, number> {
  return Object.fromEntries(Object.entries(GOLD).map(([id, steps]) => [id, withService(steps)]));
}

if (import.meta.main) console.log(gold(), hotspotName());

// The gold answers of the spatial eval cases, worked out with the service's own GIS
// tools on the committed datasets, the same calls gis-analyst makes. Each case's value
// in cases.jsonl must equal what its steps give here: spatial-gold.test.ts checks it.
//
// Usage: node evals/spatial-gold.ts   prints each case's value
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AreaRequest, BufferRequest, NewStudy, OverlayRequest, PointsWithinRequest, RouteLayerRequest } from "@transit-agents/contracts";
import { Service } from "../services/api/src/service.ts";

const ACTOR = "agent:gold";
const STUDY = "gold";

type Steps = (s: Service) => number;

const stops = (s: Service, route: string) => s.routeLayer(ACTOR, STUDY, "stops", RouteLayerRequest.parse({ route })).layer.id;
const shape = (s: Service, route: string) => s.routeLayer(ACTOR, STUDY, "shape", RouteLayerRequest.parse({ route })).layer.id;
const area = (s: Service, dataset: string, name: string) => s.namedAreaLayer(ACTOR, STUDY, AreaRequest.parse({ dataset, name })).layer.id;
const buffer = (s: Service, layer: string, metres: number) => s.bufferLayer(ACTOR, STUDY, BufferRequest.parse({ layer, metres })).layer.id;
const overlay = (s: Service, layer: string, dataset: string, variables: string[] = []) =>
  s.overlayLayer(ACTOR, STUDY, OverlayRequest.parse({ layer, dataset, variables })).totals ?? {};
const within = (s: Service, layer: string, dataset: string, filter: { from?: number; to?: number; fatal?: boolean; involving?: string } = {}) =>
  s.pointsWithinLayer(ACTOR, STUDY, PointsWithinRequest.parse({ layer, dataset, ...filter })).totals ?? {};
const value = (totals: Record<string, { value: number }>, name: string) => {
  const total = totals[name];
  if (!total) throw new Error(`No total ${name}`);
  return total.value;
};

export const GOLD: Record<string, Steps> = {
  // Residents within 400 m of the 52's stops.
  "spatial-001": (s) => value(overlay(s, buffer(s, stops(s, "52"), 400), "census-da-2021", ["population"]), "population"),
  // People in low income there. The census counts people, not households.
  "spatial-002": (s) => value(overlay(s, buffer(s, stops(s, "52"), 400), "census-da-2021", ["lowIncome"]), "lowIncome"),
  // KSI collisions within 400 m of the 52's stops, 2021 to 2025.
  "spatial-003": (s) => value(within(s, buffer(s, stops(s, "52"), 400), "toronto-ksi", { from: 2021, to: 2025 }), "collisions"),
  // Of those, the ones where someone was killed.
  "spatial-004": (s) => value(within(s, buffer(s, stops(s, "52"), 400), "toronto-ksi", { from: 2021, to: 2025 }), "fatal"),
  // Neighbourhood Improvement Areas that 400 m around the 52's stops touches.
  "spatial-005": (s) => value(overlay(s, buffer(s, stops(s, "52"), 400), "toronto-nia"), "areas"),
  // Share of commuters within 800 m of the 54's stops who go by transit.
  "spatial-006": (s) => value(overlay(s, buffer(s, stops(s, "54"), 800), "census-da-2021", ["transitShare"]), "transitShare"),
  // Residents within 500 m of the 25 Don Mills route.
  "spatial-007": (s) => value(overlay(s, buffer(s, shape(s, "25"), 500), "census-da-2021", ["population"]), "population"),
  // KSI collisions involving a pedestrian in Thorncliffe Park, 2016 to 2025.
  "spatial-008": (s) => value(within(s, area(s, "toronto-neighbourhoods", "Thorncliffe Park"), "toronto-ksi", { from: 2016, to: 2025, involving: "pedestrian" }), "collisions"),
  // Share of 400 m around the 52's stops that lies in Neighbourhood Improvement Areas.
  "spatial-009": (s) => value(overlay(s, buffer(s, stops(s, "52"), 400), "toronto-nia"), "layerShare"),
  // Seniors' share within 400 m of the 25 Don Mills route's stops.
  "spatial-010": (s) => value(overlay(s, buffer(s, stops(s, "25"), 400), "census-da-2021", ["seniorShare"]), "seniorShare"),
};

// Each case's value, each in a study of its own on a fresh service.
export function gold(): Record<string, number> {
  const dir = mkdtempSync(join(tmpdir(), "spatial-gold-"));
  try {
    const values: Record<string, number> = {};
    for (const [id, steps] of Object.entries(GOLD)) {
      const service = new Service(join(dir, `${id}.db`));
      try {
        service.openStudy(ACTOR, NewStudy.parse({ id: STUDY, title: "Gold" }));
        values[id] = steps(service);
      } finally {
        service.close();
      }
    }
    return values;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(gold());

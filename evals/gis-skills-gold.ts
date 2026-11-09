// The gold answers of the equity-analysis, economic-development and stop-accessibility
// cases, worked out with the service's own GIS tools on the committed datasets, the
// same calls the skills make. Each case's value in cases.jsonl must equal what its
// steps give here: gis-skills-gold.test.ts checks it.
//
// Usage: node evals/gis-skills-gold.ts   prints each case's value
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferRequest, NewStudy, RouteLayerRequest } from "@transit-agents/contracts";
import { accessLayer, AccessRequest, shelterLayer, ShelterRequest } from "../services/api/src/gis-access.ts";
import { EconomyRequest, jobsLayer, zoningLayer } from "../services/api/src/gis-economy.ts";
import { EquityRequest, equityLayer } from "../services/api/src/gis-equity.ts";
import { Service } from "../services/api/src/service.ts";

const ACTOR = "agent:gold";
const STUDY = "gold";

type Totals = Record<string, { value: number }>;
type Steps = (s: Service) => number;

const stops = (s: Service, route: string) => s.routeLayer(ACTOR, STUDY, "stops", RouteLayerRequest.parse({ route })).layer.id;
const buffer = (s: Service, layer: string, metres: number) => s.bufferLayer(ACTOR, STUDY, BufferRequest.parse({ layer, metres })).layer.id;
// 400 m or 800 m round a route's stops, profiled with its stops.
const equity = (s: Service, route: string, metres: number) => {
  const layer = stops(s, route);
  return equityLayer(s, ACTOR, STUDY, EquityRequest.parse({ layer: buffer(s, layer, metres), stops: layer })).totals as Totals;
};
const jobs = (s: Service, route: string, metres: number) => jobsLayer(s, ACTOR, STUDY, EconomyRequest.parse({ layer: buffer(s, stops(s, route), metres) })).totals as Totals;
const zoning = (s: Service, route: string, metres: number) => zoningLayer(s, ACTOR, STUDY, EconomyRequest.parse({ layer: buffer(s, stops(s, route), metres) })).totals as Totals;
const access = (s: Service, route: string) => accessLayer(s, ACTOR, STUDY, AccessRequest.parse({ layer: stops(s, route) })).totals as Totals;
const shelters = (s: Service, route: string) => shelterLayer(s, ACTOR, STUDY, ShelterRequest.parse({ layer: stops(s, route) })).totals as Totals;
const value = (totals: Totals, name: string) => {
  const total = totals[name];
  if (!total) throw new Error(`No total ${name}`);
  return total.value;
};

export const GOLD: Record<string, Steps> = {
  // equity-analysis
  "eq-001": (s) => value(equity(s, "52", 400), "lowIncomeShare"),
  "eq-002": (s) => value(equity(s, "25", 400), "transitShareGap"),
  "eq-003": (s) => value(equity(s, "100", 400), "niaPopulation"),
  "eq-004": (s) => value(equity(s, "54", 400), "stopsNearNia"),
  "eq-005": (s) => value(equity(s, "5", 800), "childShare"),
  "eq-006": (s) => value(equity(s, "100", 400), "seniorShare"),
  // economic-development
  "econ-001": (s) => value(jobs(s, "4", 800), "jobs"),
  "econ-002": (s) => value(jobs(s, "5", 800), "jobs"),
  "econ-003": (s) => value(jobs(s, "5", 800), "jobsPerResident"),
  "econ-004": (s) => value(zoning(s, "100", 400), "employmentShare"),
  "econ-005": (s) => value(zoning(s, "25", 400), "residentialKm2"),
  "econ-006": (s) => value(jobs(s, "4", 800), "atHome"),
  // stop-accessibility
  "acc-001": (s) => value(access(s, "2"), "stationsNotAccessible"),
  "acc-002": (s) => value(access(s, "1"), "stationsNotAccessible"),
  "acc-003": (s) => value(shelters(s, "25"), "sheltered"),
  "acc-004": (s) => value(access(s, "52"), "notAccessible"),
  "acc-005": (s) => value(shelters(s, "100"), "shelteredShare"),
  "acc-006": (s) => value(access(s, "5"), "stationsNotAccessible"),
};

// Each case's value, each in a study of its own on a fresh service.
export function gold(): Record<string, number> {
  const dir = mkdtempSync(join(tmpdir(), "gis-skills-gold-"));
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

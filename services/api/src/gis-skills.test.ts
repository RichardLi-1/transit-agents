// The equity, economic development and stop accessibility tools: on a made-up city
// small enough to check by hand, then on the committed datasets, then through the API.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { NewStudy } from "@transit-agents/contracts";
import type { Feature } from "geojson";
import { createApp, type Actor } from "./app.ts";
import { buffer, Gis, GisError } from "./gis.ts";
import { stationOf, stopAccess, stopShelters } from "./gis-access.ts";
import { jobsWithin, zoningWithin } from "./gis-economy.ts";
import { equityProfile } from "./gis-equity.ts";
import { GIS_SKILL_ROUTES, GIS_SKILL_TOOLS } from "./gis-skills.ts";
import { TOOLS } from "./mcp.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

// Two squares about 1 km a side, a to the west of b, as in gis.test.ts.
const W = -79.4;
const S = 43.7;
const DEG_LON = 1000 / (111_320 * Math.cos((43.7 * Math.PI) / 180));
const DEG_LAT = 1000 / 110_574;
const box = (west: number, east: number) => ({
  type: "Polygon" as const,
  coordinates: [
    [
      [west, S],
      [east, S],
      [east, S + DEG_LAT],
      [west, S + DEG_LAT],
      [west, S],
    ],
  ],
});
const a = box(W, W + DEG_LON);
const b = box(W + DEG_LON, W + 2 * DEG_LON);
const point = (x: number, y = 0.5) => ({ type: "Point" as const, coordinates: [W + x * DEG_LON, S + y * DEG_LAT] });
const feature = (geometry: Feature["geometry"], properties: Record<string, unknown> = {}): Feature => ({ type: "Feature", properties, geometry });

const dir = mkdtempSync(join(tmpdir(), "gis-skills-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const gz = (name: string, value: unknown) => writeFileSync(join(dir, name), gzipSync(JSON.stringify(value)));
const DATASET = { publisher: "Test", licence: "Test licence", licenceUrl: "https://example.test/licence", url: "https://example.test/", retrieved: "2026-11-09", coverage: "Test", notes: "" };
const COUNTS = ["population", "lowIncome", "lowIncomeBase", "commuters", "transit", "ageBase", "age65"];
writeFileSync(
  join(dir, "datasets.json"),
  JSON.stringify([
    { ...DATASET, id: "census-da-2021", title: "Census", file: "census.json.gz", kind: "polygons", variables: Object.fromEntries(COUNTS.map((c) => [c, { label: c, unit: "people" }])) },
    { ...DATASET, id: "toronto-nia", title: "NIAs", file: "nia.json.gz", kind: "polygons" },
    { ...DATASET, id: "ttc-gtfs", title: "GTFS", file: "ttc.json.gz", kind: "points" },
  ]),
);
// A second registry, as scripts/build-gis-skills-data.ts writes one.
writeFileSync(
  join(dir, "datasets-skills.json"),
  JSON.stringify([
    { ...DATASET, id: "statcan-pow-ct-2021", title: "Work", file: "pow.json.gz", kind: "polygons", coverage: "the test CMA", variables: { jobs: { label: "Jobs", unit: "people" }, atHome: { label: "At home", unit: "people" } } },
    { ...DATASET, id: "toronto-zoning-corridor", title: "Zoning", file: "zoning.json.gz", kind: "polygons", coverage: "area a only", bbox: [W, S, W + DEG_LON, S + DEG_LAT] },
    { ...DATASET, id: "toronto-transit-shelters", title: "Shelters", file: "shelters.json.gz", kind: "points" },
  ]),
);
gz("census.json.gz", {
  type: "FeatureCollection",
  features: [
    feature(a, { id: "a", population: 1000, lowIncome: 100, lowIncomeBase: 1000, commuters: 400, transit: 100, ageBase: 1000, age65: 200 }),
    feature(b, { id: "b", population: 3000, lowIncome: 600, lowIncomeBase: 3000, commuters: 1200, transit: 600, ageBase: 3000, age65: 300 }),
  ],
});
gz("census-da-2021-extra.json.gz", { characteristics: { children: 9 }, areas: { a: 100, b: 600 } });
gz("nia.json.gz", { type: "FeatureCollection", features: [feature(b, { id: "1", name: "East" })] });
// Work: a has 1000 who work there, b none, and c, west of a and beyond the census, 300.
gz("pow.json.gz", {
  type: "FeatureCollection",
  features: [
    feature(a, { id: "a", jobs: 1000, atHome: 50 }),
    feature(b, { id: "b", jobs: 0, atHome: 150 }),
    feature(box(W - DEG_LON, W), { id: "c", jobs: 300, atHome: 0 }),
  ],
});
// Area a: its west half zoned residential, its east half employment.
gz("zoning.json.gz", {
  type: "FeatureCollection",
  features: [
    feature(box(W, W + DEG_LON / 2), { zone: "RD", chapter: "Residential", use: "residential" }),
    feature(box(W + DEG_LON / 2, W + DEG_LON), { zone: "E", chapter: "Employment Industrial", use: "employment" }),
  ],
});
// Shelters about 10 m from stop s1, 15 m from s2 (removed), and 40 m from s3.
gz("shelters.json.gz", {
  type: "FeatureCollection",
  features: [
    feature(point(0.21), { id: "SH-1", status: "Existing" }),
    feature(point(0.415), { id: "SH-2", status: "Temporarily Removed" }),
    feature(point(0.64), { id: "SH-3", status: "Existing" }),
  ],
});
gz("ttc-access.json.gz", { stops: { s1: 1, s2: 2 } });
gz("ttc.json.gz", { timetableUntil: "2026-12-21", stops: [], routes: {} });

const gis = new Gis(dir);
const area = (geometry: Feature["geometry"]) => [feature(geometry)];
// The east half of a, and all of b.
const half = area(box(W + DEG_LON / 2, W + 2 * DEG_LON));
const value = (made: { totals?: Record<string, { value: number }> }, name: string) => made.totals?.[name]?.value;

describe("equity_profile", () => {
  it("sets the layer's shares beside the City's from the same census, area-weighted", () => {
    const made = equityProfile(gis, half);
    // a counts half: 50 + 600 in low income of 500 + 3000.
    assert.equal(value(made, "population"), 3500);
    assert.equal(value(made, "lowIncomeShare"), 18.6);
    assert.equal(value(made, "cityLowIncomeShare"), 17.5);
    assert.equal(value(made, "lowIncomeShareGap"), 1.1);
    assert.equal(value(made, "transitShare"), 46.4);
    assert.equal(value(made, "cityTransitShare"), 43.8);
    assert.equal(value(made, "seniorShare"), 11.4);
    assert.equal(value(made, "citySeniorShare"), 12.5);
    assert.equal(value(made, "seniorShareGap"), -1.1);
    assert.equal(value(made, "childShare"), 18.6);
    assert.equal(value(made, "cityChildShare"), 17.5);
    assert.equal(value(made, "cityPopulation"), 4000);
  });

  it("finds the NIAs the layer reaches, and the people living in them", () => {
    const made = equityProfile(gis, half);
    assert.deepEqual(made.nias, [{ name: "East", share: 1 }]);
    assert.equal(value(made, "niaAreas"), 1);
    assert.equal(value(made, "niaLayerShare"), 66.7);
    assert.equal(value(made, "niaPopulation"), 3000);
    assert.equal(value(made, "niaPopulationShare"), 85.7);
  });

  it("counts the stops within 400 m of an NIA, and says the TTC's own count can only be fewer", () => {
    const stops = [feature(point(0.1)), feature(point(0.8)), feature(point(1.5))];
    const made = equityProfile(gis, half, stops);
    assert.equal(value(made, "stops"), 3);
    assert.equal(value(made, "stopsNearNia"), 2);
    assert.match(made.warnings?.join(" ") ?? "", /residential parts of NIAs/);
    assert.match(made.warnings?.join(" ") ?? "", /none says anything about any one person/);
    assert.throws(() => equityProfile(gis, half, half), (e) => e instanceof GisError && e.code === "not_points");
  });

  it("keeps each census area's piece, with its own low-income share, for the map", () => {
    const made = equityProfile(gis, half);
    assert.deepEqual(
      made.features.map((f) => [f.properties?.id, f.properties?.share, f.properties?.lowIncomeShare]),
      [
        ["a", 0.5, 10],
        ["b", 1, 20],
      ],
    );
  });
});

describe("jobs_within", () => {
  it("counts the people who work in the layer beside those who live there", () => {
    const made = jobsWithin(gis, half);
    assert.equal(value(made, "jobs"), 500);
    assert.equal(value(made, "atHome"), 175);
    assert.equal(value(made, "population"), 3500);
    assert.equal(value(made, "jobsPerResident"), 0.14);
    assert.match(made.warnings?.join(" ") ?? "", /COVID-19/);
    assert.equal(made.dataset?.id, "statcan-pow-ct-2021");
  });

  it("sets no jobs per resident where the two datasets cover different land", () => {
    const made = jobsWithin(gis, area(box(W - DEG_LON, W + DEG_LON)));
    assert.equal(value(made, "jobs"), 1300);
    assert.equal(value(made, "population"), 1000);
    assert.equal(value(made, "jobsPerResident"), undefined);
    assert.match(made.warnings?.join(" ") ?? "", /jobs per resident isn't worked out/);
    assert.match(made.warnings?.join(" ") ?? "", /50% of the layer is outside the census areas/);
  });
});

describe("zoning_within", () => {
  it("measures each use's land, and only inside the corridor", () => {
    const made = zoningWithin(gis, area(box(W, W + 2 * DEG_LON)));
    assert.equal(value(made, "corridorShare"), 50);
    assert.equal(value(made, "layerKm2"), 1);
    assert.equal(value(made, "residentialKm2"), 0.5);
    assert.equal(value(made, "residentialShare"), 50);
    assert.equal(value(made, "employmentShare"), 50);
    assert.equal(value(made, "openSpaceShare"), 0);
    assert.match(made.warnings?.[0] ?? "", /^50% of the layer is beyond the Don Mills corridor/);
    assert.match(made.warnings?.join(" ") ?? "", /not what is built/);
  });

  it("refuses a layer wholly beyond the corridor", () => {
    assert.throws(() => zoningWithin(gis, area(b)), (e) => e instanceof GisError && e.code === "outside_coverage");
  });
});

describe("stop_accessibility and stop_shelters", () => {
  const stops = [
    feature(point(0.2), { code: "s1", name: "Alpha Station - Northbound Platform" }),
    feature(point(0.4), { code: "s2", name: "Alpha Station - Southbound Platform" }),
    feature(point(0.6), { code: "s3", name: "Main St at Alpha Station" }),
  ];

  it("counts each stop's GTFS wheelchair_boarding, and the stations with a platform marked not accessible", () => {
    const made = stopAccess(gis, stops);
    assert.deepEqual([value(made, "stops"), value(made, "accessible"), value(made, "notAccessible"), value(made, "noInformation")], [3, 1, 1, 1]);
    assert.equal(value(made, "accessibleShare"), 33.3);
    assert.deepEqual([value(made, "stations"), value(made, "stationsNotAccessible")], [1, 1]);
    assert.deepEqual(made.gaps, { stops: ["Alpha Station - Southbound Platform (s2)"], stations: ["Alpha Station"] });
    assert.deepEqual(made.features.map((f) => f.properties?.wheelchair), ["accessible", "not accessible", "no information"]);
    assert.equal(made.dataset?.id, "ttc-gtfs");
    assert.match(made.warnings?.join(" ") ?? "", /not a finding of compliance/);
    assert.match(made.warnings?.join(" ") ?? "", /nothing about elevators/);
  });

  it("names a station from its platforms, never from a street stop named for one", () => {
    assert.equal(stationOf("Old Mill Station - Eastbound Platform"), "Old Mill Station");
    assert.equal(stationOf("Don Valley Station Eastbound Platform"), "Don Valley Station");
    assert.equal(stationOf("Don Mills Rd at Eglinton Ave East - Don Valley Station"), undefined);
  });

  it("matches the shelter nearest each stop within the distance, and counts removed ones apart", () => {
    const made = stopShelters(gis, stops);
    assert.deepEqual([value(made, "sheltered"), value(made, "shelterRemoved")], [1, 1]);
    assert.deepEqual(
      made.features.map((f) => [f.properties?.shelter, f.properties?.shelterMetres]),
      [
        ["SH-1", 10],
        ["SH-2", 15],
        ["none", undefined],
      ],
    );
    assert.deepEqual(made.gaps.stops, ["Alpha Station - Southbound Platform (s2)", "Main St at Alpha Station (s3)"]);
    assert.equal(value(stopShelters(gis, stops, 50), "sheltered"), 2);
    assert.equal(made.dataset?.id, "toronto-transit-shelters");
  });

  it("needs a layer of stops with their codes", () => {
    assert.throws(() => stopAccess(gis, half), (e) => e instanceof GisError && e.code === "not_stops");
  });
});

describe("on the committed datasets", () => {
  const real = new Gis();
  const s52 = real.routeStops("52").features;

  it("lists every new dataset with its licence", () => {
    const ids = real.datasets().map((d) => d.id);
    for (const id of ["statcan-pow-ct-2021", "toronto-zoning-corridor", "toronto-transit-shelters"]) assert.ok(ids.includes(id), id);
    assert.match(real.dataset("statcan-pow-ct-2021").licence, /Statistics Canada Open Licence/);
    assert.match(real.dataset("toronto-transit-shelters").licence, /Open Government Licence – Toronto/);
  });

  it("gives the 52's catchment the same residents as overlay, with the City beside them", () => {
    const made = equityProfile(real, buffer(s52, 400).features, s52);
    assert.equal(value(made, "population"), real.overlay(buffer(s52, 400).features, "census-da-2021", ["population"]).totals?.population?.value);
    assert.equal(value(made, "cityPopulation"), 2_794_356);
    assert.deepEqual(
      made.nias.map((n) => n.name),
      ["Kingsview Village-The Westway", "Weston", "Rustic"],
    );
    assert.match(made.warnings?.join(" ") ?? "", /these totals are for the part inside Toronto only/);
  });

  it("finds the Line 2 stations the GTFS marks not accessible, and refuses zoning far from the corridor", () => {
    const made = stopAccess(real, real.routeStops("2").features);
    assert.ok(made.gaps.stations.includes("Old Mill Station"));
    assert.throws(() => zoningWithin(real, buffer(s52, 400).features), (e) => e instanceof GisError && e.code === "outside_coverage");
  });
});

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
]);

describe("through the API", () => {
  const setup = () => {
    const service = new Service(":memory:", { gis });
    const app = createApp({ service, webhooks: new Webhooks(service, "https://example.test", async () => new Response("ok")), tokens: TOKENS, access: "token" });
    const call = async (path: string, body: unknown, token = "agent-token") => {
      const response = await app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    service.openStudy("agent:lead", NewStudy.parse({ id: "s", title: "Study" }));
    service.namedAreaLayer("agent:lead", "s", { dataset: "toronto-nia", name: "east" });
    return { service, call };
  };

  it("saves an equity profile as a layer and records its totals as figures citing the census", async () => {
    const { service, call } = setup();
    const { status, body } = await call("/v1/studies/s/gis/equity", { layer: "nia-east" });
    assert.equal(status, 201);
    assert.equal(body.layer.id, "nia-east-equity");
    assert.equal(body.layer.dataset.id, "census-da-2021");
    assert.deepEqual(body.layer.operation, { name: "equity_profile", params: { layer: "nia-east" } });
    assert.equal(body.totals.lowIncomeShare.figure, "nia-east-equity.low-income-share");
    assert.match(body.method, /spread evenly/);
    const figure = service.viewStudy("s").figures.find((f) => f.id === "nia-east-equity.city-low-income-share");
    assert.deepEqual(figure?.basis, { kind: "spatial", layer: "nia-east-equity", total: "cityLowIncomeShare" });
    assert.equal(figure?.value, 17.5);
  });

  it("serves each tool, refuses a viewer, and passes on the tools' refusals", async () => {
    const { call } = setup();
    assert.equal((await call("/v1/studies/s/gis/jobs", { layer: "nia-east" })).body.totals.jobs.value, 0);
    assert.equal((await call("/v1/studies/s/gis/zoning", { layer: "nia-east" })).body.error.code, "outside_coverage");
    assert.equal((await call("/v1/studies/s/gis/stop-access", { layer: "nia-east" })).body.error.code, "not_stops");
    assert.equal((await call("/v1/studies/s/gis/stop-shelters", { layer: "nia-east", metres: 100 })).status, 400);
    assert.equal((await call("/v1/studies/s/gis/equity", { layer: "nia-east" }, "viewer-token")).status, 403);
  });

  it("makes each route an MCP tool, named once", () => {
    assert.equal(GIS_SKILL_ROUTES.length, 5);
    const names = Object.values(TOOLS).map((t) => t.name);
    for (const [key, tool] of Object.entries(GIS_SKILL_TOOLS)) {
      assert.equal(TOOLS[key]?.name, tool.name);
      assert.equal(names.filter((n) => n === tool.name).length, 1);
    }
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { ActiveLayerRequest, FirstLastMileRequest, NewStudy, RouteLayerRequest, BufferRequest } from "@transit-agents/contracts";
import type { Feature, Polygon, Position } from "geojson";
import { Gis, GisError } from "./gis.ts";
import { Active, activeLayer, BIKE_SHARE, CYCLING, firstLastMileLayer, SIDEWALKS } from "./gis-active.ts";
import { Edges, lineMetres, metresNear } from "./gis-layers.ts";
import { ApiError, Service } from "./service.ts";

// A made-up square of about 1 km a side. Metres east and north of its south-west corner.
const W = -79.4;
const S = 43.7;
const DEG_LON = 1000 / (111_320 * Math.cos((43.7 * Math.PI) / 180));
const DEG_LAT = 1000 / 110_574;
const at = (east: number, north: number): Position => [W + (DEG_LON * east) / 1000, S + (DEG_LAT * north) / 1000];
const polygon = (...corners: [number, number][]): Feature<Polygon> => ({
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[...corners.map(([e, n]) => at(e, n)), at(...corners[0] as [number, number])]] },
});
const SQUARE = polygon([0, 0], [1000, 0], [1000, 1000], [0, 1000]);
// An L: the square without its north-east quarter.
const ELL = polygon([0, 0], [1000, 0], [1000, 500], [500, 500], [500, 1000], [0, 1000]);
const near = (actual: number, expected: number, within = 1) => assert.ok(Math.abs(actual - expected) <= within, `${actual} is not within ${within} of ${expected}`);

describe("lines on the ground", () => {
  it("clips a line to an area, entering and leaving as often as it crosses", () => {
    const edges = new Edges(SQUARE);
    // West to east through the middle, starting and ending outside: 1 km inside.
    const [across] = edges.clip([at(-500, 500), at(1500, 500)]);
    near(lineMetres(across as Position[]), 1000);
    // Inside throughout, over two segments.
    const inside = edges.clip([at(100, 100), at(400, 100), at(400, 500)]);
    assert.equal(inside.length, 1);
    near(lineMetres(inside[0] as Position[]), 700);
    assert.deepEqual(edges.clip([at(-500, -500), at(-100, -100)]), []);
    // Across the L at 750 m north: in, out across the notch... only the west half is in.
    const ell = new Edges(ELL);
    const pieces = ell.clip([at(-100, 750), at(1100, 750)]);
    assert.equal(pieces.length, 1);
    near(lineMetres(pieces[0] as Position[]), 500);
    // A line along the bottom of the notch's east side goes in, out and in again.
    const zigzag = ell.clip([at(250, 250), at(750, 750), at(750, 250)]);
    near(zigzag.reduce((n, p) => n + lineMetres(p), 0), Math.hypot(250, 250) + 250, 2);
  });

  it("measures how much of a line is within a distance of a point", () => {
    const centre = at(500, 500);
    near(metresNear([at(0, 500), at(1000, 500)], centre, 400), 800);
    near(metresNear([at(0, 900), at(1000, 900)], centre, 400), 0);
    near(metresNear([at(500, 500), at(500, 1000)], centre, 400), 400);
  });
});

const dir = mkdtempSync(join(tmpdir(), "gis-active-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const gz = (name: string, value: unknown) => writeFileSync(join(dir, name), gzipSync(JSON.stringify(value)));
const DATASET = { publisher: "Test", licence: "Test licence", licenceUrl: "https://example.test/licence", url: "https://example.test/", retrieved: "2026-11-09", coverage: "Test", notes: "" };
writeFileSync(join(dir, "datasets.json"), JSON.stringify([]));
writeFileSync(
  join(dir, "datasets-safety.json"),
  JSON.stringify([
    { ...DATASET, id: CYCLING, title: "Cycling", file: "cycling.json.gz", kind: "lines" },
    { ...DATASET, id: SIDEWALKS, title: "Sidewalks", file: "sidewalks.json.gz", kind: "lines" },
    { ...DATASET, id: BIKE_SHARE, title: "Bike share", file: "bikeshare.json.gz", kind: "points" },
  ]),
);
const line = (type: string, street: string, ...points: Position[]) => ({ type: "Feature", properties: { type, street }, geometry: { type: "MultiLineString", coordinates: [points] } });
gz("cycling.json.gz", {
  type: "FeatureCollection",
  features: [
    line("Cycle Track", "Main St", at(-500, 500), at(1500, 500)), // 1 km inside
    line("Bike Lane", "First Ave", at(200, 0), at(200, 1000)), // 1 km inside
    line("Multi-Use Trail", "Ravine", at(800, 100), at(800, 400)), // 0.3 km
    line("Sharrows", "Second Ave", at(0, 900), at(500, 900)), // 0.5 km
    line("Bike Lane", "Far St", at(3000, 0), at(3000, 1000)), // outside
  ],
});
// [status, road, part...]: each part's points in 1e-5 degrees, as steps from the one before.
const steps = (...points: Position[]) => {
  let [x0, y0] = [0, 0];
  return points.flatMap(([lon, lat]) => {
    const [x, y] = [Math.round((lon as number) * 1e5), Math.round((lat as number) * 1e5)];
    const step = [x - x0, y - y0];
    [x0, y0] = [x, y];
    return step;
  });
};
gz("sidewalks.json.gz", {
  statuses: ["both", "one", "onePartial", "partial", "none", "building"],
  roads: ["Local", "Collector", "Minor Arterial", "Major Arterial"],
  segments: [
    [0, 3, steps(at(0, 500), at(1000, 500))], // both sides, 1 km
    [4, 0, steps(at(500, 0), at(500, 250)), steps(at(500, 250), at(500, 500))], // none, 0.5 km in two parts
    [1, 0, steps(at(900, 0), at(900, 500))], // one side, 0.5 km
    [4, 0, steps(at(5000, 0), at(5000, 500))], // outside
  ],
});
gz("bikeshare.json.gz", {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "1", name: "Main / First", docks: 15 }, geometry: { type: "Point", coordinates: at(200, 500) } },
    { type: "Feature", properties: { id: "2", name: "Ravine", docks: 11 }, geometry: { type: "Point", coordinates: at(800, 300) } },
    { type: "Feature", properties: { id: "3", name: "Far", docks: 19 }, geometry: { type: "Point", coordinates: at(3000, 3000) } },
  ],
});
const gis = new Gis(dir);
const active = new Active(gis);
const values = (totals: Record<string, { value: number }> | undefined) => Object.fromEntries(Object.entries(totals ?? {}).map(([k, v]) => [k, v.value]));

describe("walking and cycling inside an area", () => {
  it("measures the cycling network by group and by the City's type", () => {
    const made = active.cyclingWithin([SQUARE]);
    const t = values(made.totals);
    near(t.separatedKm as number, 1, 0.01);
    near(t.paintedKm as number, 1, 0.01);
    near(t.trailKm as number, 0.3, 0.01);
    near(t.sharedKm as number, 0.5, 0.01);
    near(t.bikewayKm as number, 2.3, 0.01);
    near(t.totalKm as number, 2.8, 0.01);
    assert.deepEqual(Object.keys(made.byType), ["Bike Lane", "Cycle Track", "Sharrows", "Multi-Use Trail"]);
    assert.equal(made.features.length, 4);
    assert.equal(made.dataset?.id, CYCLING);
    assert.ok((made.warnings ?? []).some((w) => w.startsWith("Measured along the street")));
  });

  it("measures streets by their sidewalks, and says the inventory is from 2017", () => {
    const made = active.sidewalksWithin([SQUARE]);
    const t = values(made.totals);
    near(t.streetKm as number, 2, 0.01);
    near(t.bothKm as number, 1, 0.01);
    near(t.noneKm as number, 0.5, 0.01);
    near(t.oneKm as number, 0.5, 0.01);
    near(t.noSidewalkShare as number, 25, 0.1);
    near(t.bothSidesShare as number, 50, 0.1);
    assert.equal(made.features.find((f) => f.properties?.status === "none")?.properties?.sidewalks, "No sidewalk on either side");
    assert.ok((made.warnings ?? []).some((w) => w.includes("2017")));
  });

  it("counts bike share stations and docks", () => {
    assert.deepEqual(values(active.bikeShareWithin([SQUARE]).totals), { stations: 2, docks: 26 });
    assert.deepEqual(values(active.bikeShareWithin([polygon([2000, 2000], [2100, 2000], [2100, 2100])]).totals), { stations: 0, docks: 0 });
  });

  it("finds, for each stop, the nearest station and the bikeways within reach, and the stops with neither", () => {
    const stop = (code: string, e: number, n: number): Feature => ({ type: "Feature", properties: { code, name: `Stop ${code}` }, geometry: { type: "Point", coordinates: at(e, n) } });
    const made = active.firstLastMile([stop("a", 200, 450), stop("b", 600, 950), stop("c", 2000, 2000)], 300);
    assert.deepEqual(values(made.bikeShare.totals), { stops: 3, stopsWithBikeShare: 1, stopsWithoutBikeShare: 2, bikeShareShare: 33.3 });
    assert.deepEqual(values(made.bikeways.totals), { stops: 3, stopsWithBikeway: 1, stopsWithoutBikeway: 2, bikewayShare: 33.3 });
    const a = made.bikeShare.features[0]?.properties;
    assert.equal(a?.nearestStation, "Main / First");
    near(a?.nearestStationM as number, 50);
    // Within 300 m of a: Main St's track, 600 m of it, and First Ave's lane, 600 m.
    near(made.bikeways.features[0]?.properties?.bikewayKmWithin as number, 1.2, 0.02);
    // b is 50 m from Second Ave's sharrows, which aren't a bikeway.
    assert.deepEqual(made.gaps.map((g) => g.code), ["b", "c"]);
    assert.equal(made.bikeShare.dataset?.id, BIKE_SHARE);
    assert.equal(made.bikeways.dataset?.id, CYCLING);
    assert.throws(() => active.firstLastMile([SQUARE], 300), (e: GisError) => e.code === "not_points");
  });
});

describe("the active transportation tools on the service", () => {
  it("saves each result as a layer and records its totals as figures citing the dataset", () => {
    const service = new Service(":memory:", { gis });
    try {
      service.openStudy("agent:t", NewStudy.parse({ id: "s", title: "S" }));
      service.saveLayer("agent:t", "s", { kind: "polygons", features: [SQUARE] }, { id: "square", title: "The square", operation: { name: "test", params: {} } });
      const cycling = activeLayer(service, "agent:t", "s", "cycling", ActiveLayerRequest.parse({ layer: "square" }));
      assert.equal(cycling.layer.id, "square-cycling");
      assert.equal(cycling.layer.kind, "lines");
      const figure = service.viewStudy("s").figures.find((f) => f.id === cycling.totals?.separatedKm?.figure);
      assert.deepEqual(figure?.basis, { kind: "spatial", layer: "square-cycling", total: "separatedKm" });
      assert.equal(activeLayer(service, "agent:t", "s", "sidewalks", ActiveLayerRequest.parse({ layer: "square" })).layer.id, "square-sidewalks");
      assert.equal(activeLayer(service, "agent:t", "s", "bike-share", ActiveLayerRequest.parse({ layer: "square" })).totals?.docks?.value, 26);
      assert.throws(
        () => firstLastMileLayer(service, "agent:t", "s", FirstLastMileRequest.parse({ layer: "square", metres: 400 })),
        (e: ApiError) => e.status === 422 && e.code === "not_points",
      );
    } finally {
      service.close();
    }
  });

  it("works on the committed datasets: a route's stops and the area around them", () => {
    const service = new Service(":memory:");
    try {
      for (const id of [CYCLING, SIDEWALKS, BIKE_SHARE]) assert.equal(service.datasets().find((d) => d.id === id)?.licence, "Open Government Licence – Toronto", id);
      service.openStudy("agent:t", NewStudy.parse({ id: "real", title: "Real" }));
      const stops = service.routeLayer("agent:t", "real", "stops", RouteLayerRequest.parse({ route: "25" })).layer.id;
      const area = service.bufferLayer("agent:t", "real", BufferRequest.parse({ layer: stops, metres: 400 })).layer.id;
      const cycling = activeLayer(service, "agent:t", "real", "cycling", ActiveLayerRequest.parse({ layer: area }));
      assert.ok((cycling.totals?.totalKm?.value as number) > 0);
      const mile = firstLastMileLayer(service, "agent:t", "real", FirstLastMileRequest.parse({ layer: stops, metres: 400 }));
      assert.equal(mile.bikeShare.layer.id, "ttc-25-stops-access-400m-bike-share");
      assert.equal(mile.bikeways.layer.id, "ttc-25-stops-access-400m-bikeways");
      assert.equal((mile.bikeShare.totals?.stopsWithBikeShare?.value as number) + (mile.bikeShare.totals?.stopsWithoutBikeShare?.value as number), mile.bikeShare.totals?.stops?.value);
    } finally {
      service.close();
    }
  });
});

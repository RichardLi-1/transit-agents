import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { Layer, LayerAdded, NewFigure, NewStudy } from "@transit-agents/contracts";
import { area } from "@turf/area";
import type { Feature } from "geojson";
import { createApp, type Actor } from "./app.ts";
import { buffer, Gis, GisError, METHOD } from "./gis.ts";
import { ApiError, Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

// A made-up city of two square areas side by side, each about 1 km a side, with
// collisions in them, so area weighting can be checked by hand.
const W = -79.4;
const S = 43.7;
const DEG_LON = 1000 / (111_320 * Math.cos((43.7 * Math.PI) / 180));
const DEG_LAT = 1000 / 110_574;
const square = (west: number) => ({
  type: "Polygon" as const,
  coordinates: [
    [
      [west, S],
      [west + DEG_LON, S],
      [west + DEG_LON, S + DEG_LAT],
      [west, S + DEG_LAT],
      [west, S],
    ],
  ],
});

const dir = mkdtempSync(join(tmpdir(), "gis-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const gz = (name: string, value: unknown) => writeFileSync(join(dir, name), gzipSync(JSON.stringify(value)));
const DATASET = { publisher: "Test", licence: "Test licence", licenceUrl: "https://example.test/licence", url: "https://example.test/", retrieved: "2026-11-09", coverage: "Test", notes: "" };
writeFileSync(
  join(dir, "datasets.json"),
  JSON.stringify([
    { ...DATASET, id: "census-da-2021", title: "Census", file: "census.json.gz", kind: "polygons", variables: { population: { label: "Population", unit: "people" }, lowIncome: { label: "Low income", unit: "people" }, lowIncomeBase: { label: "Counted", unit: "people" } } },
    { ...DATASET, id: "toronto-nia", title: "NIAs", file: "nia.json.gz", kind: "polygons" },
    { ...DATASET, id: "toronto-ksi", title: "KSI", file: "ksi.json.gz", kind: "points" },
    { ...DATASET, id: "toronto-heritage-corridor", title: "Heritage", file: "heritage.json.gz", kind: "points", bbox: [W, S, W + DEG_LON, S + DEG_LAT] },
  ]),
);
gz("census.json.gz", {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "a", population: 1000, lowIncome: 100, lowIncomeBase: 1000 }, geometry: square(W) },
    { type: "Feature", properties: { id: "b", population: 3000, lowIncome: null, lowIncomeBase: null }, geometry: square(W + DEG_LON) },
  ],
});
gz("nia.json.gz", { type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "1", name: "East" }, geometry: square(W + DEG_LON) }] });
// lon, lat, year, flags: 1 fatal, 2 pedestrian, 4 cyclist.
gz("ksi.json.gz", {
  years: [2020, 2026],
  lastDate: "2026-10-01",
  points: [
    [W + DEG_LON / 2, S + DEG_LAT / 2, 2021, 1 | 2],
    [W + DEG_LON / 4, S + DEG_LAT / 2, 2022, 4],
    [W + DEG_LON * 1.5, S + DEG_LAT / 2, 2023, 0],
    [W + 0.1, S, 2023, 1],
  ],
});
gz("heritage.json.gz", { type: "FeatureCollection", features: [{ type: "Feature", properties: { address: "1 Main St" }, geometry: { type: "Point", coordinates: [W + DEG_LON / 2, S + DEG_LAT / 2] } }] });

const gis = new Gis(dir);
const both: Feature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[W, S], [W + 2 * DEG_LON, S], [W + 2 * DEG_LON, S + DEG_LAT], [W, S + DEG_LAT], [W, S]]] } };
// The west half of area a, and all of b: a counts half.
const half: Feature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[W + DEG_LON / 2, S], [W + 2 * DEG_LON, S], [W + 2 * DEG_LON, S + DEG_LAT], [W + DEG_LON / 2, S + DEG_LAT], [W + DEG_LON / 2, S]]] } };

describe("area weighting", () => {
  it("counts each area in proportion to its land inside the layer", () => {
    const made = gis.overlay([half], "census-da-2021", ["population", "lowIncome", "lowIncomeShare"]);
    assert.equal(made.totals?.population?.value, 500 + 3000);
    assert.equal(made.totals?.lowIncome?.value, 50);
    // A share is the weighted counts' ratio, over areas that have both.
    assert.equal(made.totals?.lowIncomeShare?.value, 10);
    assert.equal(made.totals?.areas?.value, 2);
    assert.deepEqual(made.features.map((f) => f.properties?.share), [0.5, 1]);
    assert.match(made.warnings?.join(" ") ?? "", /1 of 2 areas lack a count asked for/);
  });

  it("keeps the piece of each area inside the layer, which can be overlaid again", () => {
    const pieces = gis.overlay([half], "toronto-nia").features;
    assert.equal(pieces.length, 1);
    assert.equal(gis.overlay(pieces, "census-da-2021", ["population"]).totals?.population?.value, 3000);
  });

  it("says how much of the layer the areas don't cover", () => {
    const wider: Feature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[W - DEG_LON, S], [W + 2 * DEG_LON, S], [W + 2 * DEG_LON, S + DEG_LAT], [W - DEG_LON, S + DEG_LAT], [W - DEG_LON, S]]] } };
    const made = gis.overlay([wider], "census-da-2021", ["population"]);
    assert.equal(made.totals?.population?.value, 4000);
    assert.equal(made.totals?.layerShare?.value, 66.7);
    assert.match(made.warnings?.join(" ") ?? "", /33\.3% of the layer is outside the census areas/);
  });

  it("refuses variables a dataset doesn't have, naming the ones it does", () => {
    assert.throws(() => gis.overlay([both], "census-da-2021", ["income"]), (e) => e instanceof GisError && /has: population, lowIncome, lowIncomeBase, lowIncomeShare/.test(e.message));
    assert.throws(() => gis.overlay([both], "toronto-nia", ["population"]), (e) => e instanceof GisError && /no counts to total/.test(e.message));
  });

  it("needs areas to overlay, not points", () => {
    const stop: Feature = { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [W, S] } };
    assert.throws(() => gis.overlay([stop], "census-da-2021"), (e) => e instanceof GisError && e.code === "not_polygons");
  });

  it("states the weighting and that it assumes even spread", () => {
    assert.match(METHOD, /in proportion to its land inside the layer/);
    assert.match(METHOD, /spread evenly/);
    assert.match(METHOD, /not an exact count/);
  });
});

describe("points within", () => {
  it("counts collisions inside, by years, deaths and who was involved", () => {
    const all = gis.pointsWithin([both], "toronto-ksi");
    assert.equal(all.totals?.collisions?.value, 3);
    assert.equal(all.totals?.fatal?.value, 1);
    assert.equal(all.totals?.pedestrian?.value, 1);
    assert.equal(gis.pointsWithin([both], "toronto-ksi", { from: 2022, to: 2023 }).totals?.collisions?.value, 2);
    assert.equal(gis.pointsWithin([both], "toronto-ksi", { fatal: true }).totals?.collisions?.value, 1);
    assert.equal(gis.pointsWithin([both], "toronto-ksi", { involving: "cyclist" }).totals?.collisions?.value, 1);
  });

  it("says when the last year is partial, and refuses years it doesn't hold", () => {
    assert.match(gis.pointsWithin([both], "toronto-ksi", { from: 2021, to: 2026 }).warnings?.[0] ?? "", /2026 is partial/);
    assert.throws(() => gis.pointsWithin([both], "toronto-ksi", { from: 2010 }), (e) => e instanceof GisError && e.code === "outside_years");
  });

  it("refuses a layer beyond a dataset that covers only part of the city", () => {
    assert.equal(gis.pointsWithin([{ ...both, geometry: square(W) }], "toronto-heritage-corridor").totals?.properties?.value, 1);
    assert.throws(() => gis.pointsWithin([both], "toronto-heritage-corridor"), (e) => e instanceof GisError && e.code === "outside_coverage");
  });
});

describe("buffer", () => {
  it("makes a 400 m circle round a point, within 0.5% of the true area", () => {
    const made = buffer([{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [W, S] } }], 400);
    const circle = Math.PI * 400 * 400;
    assert.ok(Math.abs(area(made.features[0] as Feature) - circle) / circle < 0.005);
  });

  it("counts overlapping circles once", () => {
    const two = [W, W + 0.001].map((lon) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: [lon, S] } }));
    const made = buffer(two, 400);
    assert.equal(made.features.length, 1);
    assert.ok(area(made.features[0] as Feature) < 2 * Math.PI * 400 * 400 * 0.75);
  });
});

describe("the committed datasets", () => {
  const real = new Gis();
  it("cite a publisher, licence, address and retrieval date for every dataset", () => {
    for (const dataset of real.datasets()) {
      assert.ok(dataset.publisher && dataset.licence && dataset.url.startsWith("https://") && /^\d{4}-\d{2}-\d{2}$/.test(dataset.retrieved), dataset.id);
    }
    assert.match(real.dataset("census-da-2021").licence, /Statistics Canada Open Licence/);
    assert.match(real.dataset("toronto-ksi").licence, /Open Government Licence – Toronto/);
  });

  it("hold the City's 2021 population, area by area", () => {
    const toronto: Feature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[-79.7, 43.55], [-79.1, 43.55], [-79.1, 43.9], [-79.7, 43.9], [-79.7, 43.55]]] } };
    assert.equal(real.overlay([toronto], "census-da-2021", ["population"]).totals?.population?.value, 2_794_356);
  });

  it("find a route's stops, and refuse a route it doesn't have", () => {
    assert.ok(real.routeStops("52").features.length > 100);
    assert.throws(() => real.route("9999"), (e) => e instanceof GisError && e.code === "unknown_route");
  });
});

const TOKENS = new Map<string, Actor>([
  ["agent-token", { role: "agent", name: "lead" }],
  ["viewer-token", { role: "viewer", name: "auditor" }],
]);

describe("layers on a study", () => {
  const setup = () => {
    const service = new Service(":memory:", { gis });
    const app = createApp({ service, webhooks: new Webhooks(service, "https://example.test", async () => new Response("ok")), tokens: TOKENS, access: "token" });
    const call = async (method: string, path: string, token = "agent-token", body?: unknown) => {
      const response = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    service.openStudy("agent:lead", NewStudy.parse({ id: "s", title: "Study" }));
    // A polygon layer to start from: area b, whole.
    service.namedAreaLayer("agent:lead", "s", { dataset: "toronto-nia", name: "east" });
    return { service, call };
  };

  it("saves an overlay as a layer, logs it for the map, and records its totals as figures citing the dataset", async () => {
    const { service, call } = setup();
    const { status, body } = await call("POST", "/v1/studies/s/gis/overlay", "agent-token", { layer: "nia-east", dataset: "census-da-2021", variables: ["population"] });
    assert.equal(status, 201);
    assert.equal(body.layer.id, "nia-east-census");
    assert.equal(body.totals.population.value, 3000);
    assert.equal(body.totals.population.figure, "nia-east-census.population");
    assert.match(body.method, /spread evenly/);

    const layers = (await call("GET", "/v1/studies/s/layers", "viewer-token")).body.layers;
    assert.deepEqual(layers.map((l: Layer) => l.id), ["nia-east", "nia-east-census"]);
    for (const layer of layers) Layer.parse(layer);
    assert.deepEqual(layers[1].derivedFrom, ["nia-east"]);
    assert.deepEqual(layers[1].operation, { name: "overlay", params: { layer: "nia-east", dataset: "census-da-2021", variables: ["population"], weighting: "area" } });
    assert.equal(layers[1].dataset.licence, "Test licence");

    const geojson = (await call("GET", "/v1/studies/s/layers/nia-east-census/geojson", "viewer-token")).body;
    assert.equal(geojson.type, "FeatureCollection");
    assert.equal(geojson.features.length, layers[1].featureCount);

    const added = service.log.since(0, 1000).filter((e) => e.type === "activity" && (e.data as { kind: string }).kind === "layer.added");
    assert.deepEqual(added.map((e) => LayerAdded.parse(e.data).layerId), ["nia-east", "nia-east-census"]);

    const figure = service.viewStudy("s").figures.find((f) => f.id === "nia-east-census.population");
    assert.deepEqual(figure?.basis, { kind: "spatial", layer: "nia-east-census", total: "population" });
    assert.equal(figure?.value, 3000);
    assert.equal(service.trace("s", "nia-east-census.population").layer?.dataset?.id, "census-da-2021");
  });

  it("gives back the same layer for the same request, and refuses another made the same id", async () => {
    const { service, call } = setup();
    await call("POST", "/v1/studies/s/gis/buffer", "agent-token", { layer: "nia-east", metres: 100 });
    const before = service.log.head().seq;
    const again = await call("POST", "/v1/studies/s/gis/buffer", "agent-token", { layer: "nia-east", metres: 100 });
    assert.equal(again.body.repeated, true);
    assert.equal(service.log.head().seq, before);
    const clash = await call("POST", "/v1/studies/s/gis/buffer", "agent-token", { layer: "nia-east", metres: 200, id: "nia-east-100m" });
    assert.equal(clash.status, 409);
  });

  it("accepts a spatial figure only with the layer's own total", () => {
    const { service } = setup();
    service.overlayLayer("agent:lead", "s", { layer: "nia-east", dataset: "census-da-2021", variables: ["population"] });
    const figure = (value: number, total = "population") => NewFigure.parse({ id: "people", label: "People", value, basis: { kind: "spatial", layer: "nia-east-census", total } });
    assert.equal(service.addFigure("agent:lead", "s", figure(3000)).value, 3000);
    assert.throws(() => service.addFigure("agent:lead", "s", figure(9999)), (e) => e instanceof ApiError && e.code === "value_mismatch");
    assert.throws(() => service.addFigure("agent:lead", "s", figure(1, "income")), (e) => e instanceof ApiError && e.code === "unknown_total");
  });

  it("summarises a layer with its totals, largest share first, and lists the datasets", async () => {
    const { call } = setup();
    await call("POST", "/v1/studies/s/gis/overlay", "agent-token", { layer: "nia-east", dataset: "census-da-2021", variables: ["population"] });
    const summary = (await call("GET", "/v1/studies/s/layers/nia-east-census", "viewer-token")).body;
    assert.deepEqual(summary.rows.map((r: { id: string; share: number }) => [r.id, r.share]), [["b", 1]]);
    assert.equal(summary.totals.population.figure, "nia-east-census.population");
    assert.ok(summary.areaKm2 > 0.99 && summary.areaKm2 < 1.01);
    const datasets = (await call("GET", "/v1/datasets", "viewer-token")).body.datasets;
    assert.ok(datasets.some((d: { id: string }) => d.id === "toronto-ksi"));
  });

  it("refuses an unknown layer or dataset in the API's words", async () => {
    const { call } = setup();
    const missing = await call("POST", "/v1/studies/s/gis/buffer", "agent-token", { layer: "nope", metres: 100 });
    assert.equal(missing.status, 404);
    const dataset = await call("POST", "/v1/studies/s/gis/overlay", "agent-token", { layer: "nia-east", dataset: "nope" });
    assert.equal(dataset.status, 422);
    assert.equal(dataset.body.error.code, "unknown_dataset");
    assert.equal((await call("POST", "/v1/studies/s/gis/buffer", "viewer-token", { layer: "nia-east", metres: 100 })).status, 403);
  });
});

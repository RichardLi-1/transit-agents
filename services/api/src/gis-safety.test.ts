import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { KsiHotspotsRequest, KsiProfileRequest, KsiTrendRequest, NewStudy, PointsWithinRequest, RouteLayerRequest, BufferRequest } from "@transit-agents/contracts";
import type { Feature } from "geojson";
import { Gis, GisError } from "./gis.ts";
import { KSI_DETAIL, ksiHotspotsLayer, ksiProfileLayer, ksiTrendLayer, modeOf, poissonTest, Safety } from "./gis-safety.ts";
import { ApiError, Service } from "./service.ts";

// A made-up square of about 1 km a side, with collisions in it and one outside.
const W = -79.4;
const S = 43.7;
const DEG_LON = 1000 / (111_320 * Math.cos((43.7 * Math.PI) / 180));
const DEG_LAT = 1000 / 110_574;
const SQUARE: Feature = {
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[W, S], [W + DEG_LON, S], [W + DEG_LON, S + DEG_LAT], [W, S + DEG_LAT], [W, S]]] },
};
const at = (east: number, north: number): [number, number] => [W + (DEG_LON * east) / 1000, S + (DEG_LAT * north) / 1000];
const metresEast = (point: [number, number], m: number): [number, number] => [point[0] + (DEG_LON * m) / 1000, point[1]];

// [lon, lat, year, month, hour, flags, street1, street2, killed x5, serious x5].
// flags: 1 fatal, 2 pedestrian, 4 cyclist, 8 motorcyclist, 16 intersection, 32 mid-block, 64 dark.
const people = (killed: number[], serious: number[]) => [...killed, ...serious];
const CORNER = at(500, 500);
const POINTS = [
  // Four at or within 20 m of the corner of Main and First: a hot spot.
  [...CORNER, 2019, 3, 8, 1 | 2 | 16, 0, 1, ...people([1, 0, 0, 0, 0], [0, 0, 0, 1, 0])],
  [...CORNER, 2020, 6, 17, 2 | 16 | 64, 0, 1, ...people([0, 0, 0, 0, 0], [1, 0, 0, 0, 0])],
  [...CORNER, 2024, 1, 23, 4 | 16 | 64, 1, 0, ...people([0, 0, 0, 0, 0], [0, 1, 0, 0, 0])],
  [...metresEast(CORNER, 20), 2021, 9, 12, 16, 0, 1, ...people([0, 0, 0, 0, 0], [0, 0, 0, 2, 0])],
  // Two at another point, mid-block on Main.
  [...at(200, 800), 2022, 5, 2, 8 | 32, 0, -1, ...people([0, 0, 0, 0, 0], [0, 0, 1, 0, 0])],
  [...at(200, 800), 2026, 2, 16, 2 | 32, 0, -1, ...people([0, 0, 0, 0, 0], [1, 0, 0, 0, 0])],
  // One alone, no place recorded.
  [...at(900, 100), 2018, 7, 10, 0, 2, -1, ...people([0, 0, 0, 0, 0], [0, 0, 0, 1, 0])],
  // Outside the square.
  [...at(1500, 500), 2020, 1, 1, 1 | 2, 0, -1, ...people([1, 0, 0, 0, 0], [0, 0, 0, 0, 0])],
];

const dir = mkdtempSync(join(tmpdir(), "gis-safety-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const DATASET = { publisher: "Test", licence: "Test licence", licenceUrl: "https://example.test/licence", url: "https://example.test/", retrieved: "2026-11-09", coverage: "Test", notes: "" };
writeFileSync(join(dir, "datasets.json"), JSON.stringify([]));
// The safety datasets come from their own file, which the service reads with datasets.json.
writeFileSync(join(dir, "datasets-safety.json"), JSON.stringify([{ ...DATASET, id: KSI_DETAIL, title: "KSI in detail", file: "ksi-detail.json.gz", kind: "points" }]));
writeFileSync(
  join(dir, "ksi-detail.json.gz"),
  gzipSync(JSON.stringify({ years: [2018, 2026], lastDate: "2026-10-22", roadUsers: ["pedestrian", "cyclist", "motorcyclist", "motorist", "other"], streets: ["MAIN ST", "FIRST AVE", "SECOND AVE"], points: POINTS })),
);
const gis = new Gis(dir);
const safety = new Safety(gis);
const values = (totals: Record<string, { value: number }> | undefined) => Object.fromEntries(Object.entries(totals ?? {}).map(([k, v]) => [k, v.value]));

describe("a KSI profile", () => {
  it("counts the collisions inside, by year, road user, severity, place, light and time of day", () => {
    const made = safety.profile([SQUARE], {});
    const t = values(made.totals);
    assert.equal(t.collisions, 7);
    assert.equal(t.fatal, 1);
    assert.equal(t.killed, 1);
    assert.equal(t.seriouslyInjured, 8);
    assert.deepEqual([t.pedestrianKsi, t.cyclistKsi, t.motorcyclistKsi, t.motoristKsi, t.otherKsi], [3, 1, 1, 4, 0]);
    // Each collision under the most vulnerable road user in it, so they add up.
    assert.deepEqual(made.breakdown.byMode, { pedestrian: 3, cyclist: 1, motorcyclist: 1, motorist: 2 });
    assert.deepEqual([t.atIntersection, t.midBlock, t.placeNotRecorded, t.dark], [4, 2, 1, 2]);
    assert.deepEqual(made.breakdown.byTime, { night: 1, morning: 1, midday: 2, afternoon: 2, evening: 1 });
    assert.deepEqual(made.breakdown.byYear, { 2018: 1, 2019: 1, 2020: 1, 2021: 1, 2022: 1, 2023: 0, 2024: 1, 2025: 0, 2026: 1 });
    assert.equal(made.dataset?.id, KSI_DETAIL);
    assert.equal(made.features.length, 7);
    assert.deepEqual(made.features.find((f) => f.properties?.year === 2018)?.properties, {
      year: 2018, month: 7, hour: 10, fatal: false, mode: "motorist", place: "not recorded", dark: false, streets: "SECOND AVE", killed: 0, seriouslyInjured: 1,
    });
  });

  it("says the data is police-reported, the last year partial, and when there are too few to read", () => {
    const warnings = safety.profile([SQUARE], {}).warnings ?? [];
    assert.match(warnings[0] as string, /^Police-reported only/);
    assert.ok(warnings.some((w) => w.startsWith("2026 is partial")));
    assert.ok(warnings.some((w) => w.startsWith("Only 7 collisions: too few")));
    assert.ok(!(safety.profile([SQUARE], { to: 2025 }).warnings ?? []).some((w) => w.includes("partial")));
  });

  it("narrows by years and by who was involved, as points_within does", () => {
    assert.equal(values(safety.profile([SQUARE], { from: 2020, to: 2022 }).totals).collisions, 3);
    assert.equal(values(safety.profile([SQUARE], { involving: "pedestrian" }).totals).collisions, 3);
    assert.equal(values(safety.profile([SQUARE], { involving: "cyclist" }).totals).collisions, 1);
    assert.throws(() => safety.profile([SQUARE], { from: 2010 }), (e: GisError) => e.code === "outside_years" && /2018 to 2026-10-22/.test(e.message));
    assert.throws(() => safety.profile([SQUARE], { from: 2022, to: 2020 }), (e: GisError) => e.code === "bad_years");
  });

  it("files a collision under its most vulnerable road user", () => {
    assert.deepEqual([modeOf(2 | 4), modeOf(4 | 8), modeOf(8), modeOf(1 | 16)], ["pedestrian", "cyclist", "motorcyclist", "motorist"]);
  });
});

describe("KSI hot spots", () => {
  it("joins collisions within the radius into one place, ranks places, and names each by its streets", () => {
    const made = safety.hotspots([SQUARE], {}, 30, 10);
    assert.deepEqual(
      made.features.map((f) => [f.properties?.rank, f.properties?.name, f.properties?.collisions, f.properties?.fatal, f.properties?.years]),
      [
        [1, "FIRST AVE & MAIN ST", 4, 1, "2019–2024"],
        [2, "MAIN ST", 2, 0, "2022–2026"],
      ],
    );
    assert.deepEqual(made.features[0]?.geometry, { type: "Point", coordinates: CORNER });
    assert.deepEqual(values(made.totals), { collisions: 7, places: 2, topCollisions: 4, listedShare: 85.7 });
    assert.ok((made.warnings ?? []).some((w) => w.includes("regression to the mean")));
  });

  it("keeps a collision 20 m away out of a place when the radius is smaller", () => {
    const made = safety.hotspots([SQUARE], {}, 10, 10);
    assert.equal(made.features[0]?.properties?.collisions, 3);
    assert.equal(made.features.length, 2);
  });

  it("lists only as many as asked", () => {
    assert.equal(safety.hotspots([SQUARE], {}, 30, 1).features.length, 1);
  });
});

describe("a KSI trend", () => {
  it("tests two counts exactly", () => {
    assert.ok(Math.abs(poissonTest(10, 5, 10, 5) - 1) < 1e-12);
    // Binomial(25, 1/2): P(X <= 5) twice, (1 + 25 + 300 + 2300 + 12650 + 53130) / 2^25 * 2.
    assert.ok(Math.abs(poissonTest(20, 5, 5, 5) - (2 * 68406) / 2 ** 25) < 1e-12);
    assert.equal(poissonTest(0, 3, 0, 3), 1);
  });

  it("compares a year's collisions before and after a split, against the city's, and says when there are too few", () => {
    const made = safety.trend([SQUARE], { from: 2018, to: 2025, split: 2022 });
    assert.deepEqual(values(made.totals), { before: 4, after: 2, beforePerYear: 1, afterPerYear: 0.5, changePct: -50, pValue: values(made.totals).pValue, cityChangePct: -60 });
    assert.equal(made.test.early, "2018–2021");
    assert.equal(made.test.late, "2022–2025");
    assert.match(String(made.test.reading), /^Too few to tell: 6 collisions/);
    assert.ok(made.features.every((f) => ["2018–2021", "2022–2025"].includes(String(f.properties?.period))));
  });

  it("uses whole years only, and a split with a year on each side", () => {
    assert.throws(() => safety.trend([SQUARE], { to: 2026 }), (e: GisError) => e.code === "partial_year" && /End a trend at 2025/.test(e.message));
    assert.throws(() => safety.trend([SQUARE], { from: 2018, to: 2020, split: 2018 }), (e: GisError) => e.code === "bad_split");
    // By default, the ten whole years to the last, split in half: here 2018 to 2025.
    const made = safety.trend([SQUARE], {});
    assert.equal(made.test.early, "2018–2021");
  });
});

describe("the safety tools on the service", () => {
  it("saves each result as a layer, records the main counts as figures, and refuses in the API's words", () => {
    const service = new Service(":memory:", { gis });
    try {
      service.openStudy("agent:t", NewStudy.parse({ id: "s", title: "S" }));
      // A layer of the square, as named_area would make, saved directly.
      service.saveLayer("agent:t", "s", { kind: "polygons", features: [SQUARE] }, { id: "square", title: "The square", operation: { name: "test", params: {} } });
      const profile = ksiProfileLayer(service, "agent:t", "s", KsiProfileRequest.parse({ layer: "square", to: 2025 }));
      assert.equal(profile.layer.id, "square-ksi-profile-start-2025");
      assert.equal(profile.layer.dataset?.id, KSI_DETAIL);
      assert.equal(profile.totals?.collisions?.value, 6);
      const figure = service.viewStudy("s").figures.find((f) => f.id === profile.totals?.pedestrianKsi?.figure);
      assert.deepEqual(figure?.basis, { kind: "spatial", layer: profile.layer.id, total: "pedestrianKsi" });
      assert.match(figure?.label ?? "", /^Pedestrians killed or seriously injured, 2018–2025, The square$/);

      const spots = ksiHotspotsLayer(service, "agent:t", "s", KsiHotspotsRequest.parse({ layer: "square" }));
      assert.equal(spots.hotspots[0]?.name, "FIRST AVE & MAIN ST");
      const trend = ksiTrendLayer(service, "agent:t", "s", KsiTrendRequest.parse({ layer: "square", split: 2022 }));
      assert.equal(trend.totals?.changePct?.value, -50);
      assert.deepEqual(
        service.layers("s").map((l) => l.id),
        ["square", "square-ksi-profile-start-2025", "square-ksi-hotspots", "square-ksi-trend-split-2022"],
      );
      // The same request again gives the same layer.
      assert.equal(ksiProfileLayer(service, "agent:t", "s", KsiProfileRequest.parse({ layer: "square", to: 2025 })).layer.id, profile.layer.id);
      assert.throws(
        () => ksiTrendLayer(service, "agent:t", "s", KsiTrendRequest.parse({ layer: "square", to: 2026 })),
        (e: ApiError) => e.status === 422 && e.code === "partial_year",
      );
      assert.throws(() => ksiProfileLayer(service, "agent:t", "s", KsiProfileRequest.parse({ layer: "nope" })), (e: ApiError) => e.status === 404);
    } finally {
      service.close();
    }
  });
});

describe("the committed KSI detail", () => {
  it("is listed with its licence, and counts the same collisions as toronto-ksi", () => {
    const service = new Service(":memory:");
    try {
      const listed = service.datasets().find((d) => d.id === KSI_DETAIL);
      assert.equal(listed?.licence, "Open Government Licence – Toronto");
      assert.ok(service.datasets().some((d) => d.id === "toronto-ksi"), "datasets.json is still read");
      service.openStudy("agent:t", NewStudy.parse({ id: "real", title: "Real" }));
      const stops = service.routeLayer("agent:t", "real", "stops", RouteLayerRequest.parse({ route: "52" })).layer.id;
      const area = service.bufferLayer("agent:t", "real", BufferRequest.parse({ layer: stops, metres: 400 })).layer.id;
      for (const filter of [{ from: 2021, to: 2025 }, { from: 2016, to: 2025, involving: "pedestrian" as const }]) {
        const detail = ksiProfileLayer(service, "agent:t", "real", KsiProfileRequest.parse({ layer: area, ...filter }));
        const plain = service.pointsWithinLayer("agent:t", "real", PointsWithinRequest.parse({ layer: area, dataset: "toronto-ksi", ...filter }));
        assert.equal(detail.totals?.collisions?.value, plain.totals?.collisions?.value);
        assert.equal(detail.totals?.fatal?.value, plain.totals?.fatal?.value);
      }
    } finally {
      service.close();
    }
  });
});

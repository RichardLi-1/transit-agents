import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIXTURE_GEOJSON, FIXTURE_LAYERS } from "./layers.fixture.ts";
import { area, cameraFor, colorOf, creditOf, fileName, PALETTE, placesOf, search, shapesOf } from "./layers.ts";
import { toPoint } from "./projection.ts";

describe("a layer's shapes", () => {
  it("puts each point in the map's metres, as the network is", () => {
    const shapes = shapesOf(FIXTURE_GEOJSON["don-mills-stops"]);
    assert.equal(shapes.points.length, 12);
    assert.deepEqual(shapes.points.slice(0, 2), toPoint(43.7255, -79.3378));
    assert.deepEqual([shapes.lines.length, shapes.polygons.length], [0, 0]);
  });

  it("winds each outer ring anticlockwise and each hole clockwise, whichever way they came", () => {
    const square = [
      [-79.4, 43.7],
      [-79.4, 43.71],
      [-79.39, 43.71],
      [-79.39, 43.7],
      [-79.4, 43.7],
    ];
    const hole = [
      [-79.398, 43.702],
      [-79.392, 43.702],
      [-79.392, 43.708],
      [-79.398, 43.708],
      [-79.398, 43.702],
    ];
    const { polygons } = shapesOf({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [square, hole] } }] });
    const [outer, inner] = polygons[0] ?? [];
    assert.ok(outer && area(outer) > 0);
    assert.ok(inner && area(inner) < 0);
  });

  it("takes multi-part geometry and collections apart, and skips what has no place", () => {
    const shapes = shapesOf({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[-79.4, 43.7], [-79.3, 43.8]], [[-79.4, 43.7]]] } },
        { type: "Feature", geometry: { type: "GeometryCollection", geometries: [{ type: "MultiPoint", coordinates: [[-79.4, 43.7], [Number.NaN, 43.7]] }] } },
        { type: "Feature", geometry: null },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [[[-79.4, 43.7], [-79.3, 43.7]]] } },
      ],
    });
    assert.equal(shapes.lines.length, 1);
    assert.equal(shapes.points.length, 2);
    assert.equal(shapes.polygons.length, 0);
    assert.deepEqual(shapesOf(null), { points: [], lines: [], polygons: [] });
  });
});

describe("a layer's look", () => {
  it("keeps the service's colour, or takes the next from the palette", () => {
    assert.equal(colorOf({ color: "#D1495B" }, 0), "d1495b");
    assert.equal(colorOf({ color: "red" }, 1), PALETTE[1]);
    assert.equal(colorOf({}, PALETTE.length), PALETTE[0]);
  });

  it("credits a dataset's publisher and licence, and nothing for a derived layer", () => {
    const [stops, buffer] = FIXTURE_LAYERS;
    assert.equal(creditOf(stops!), "Toronto Transit Commission, Open Government Licence – Toronto");
    assert.equal(creditOf(buffer!), null);
  });

  it("names its file after its title", () => {
    assert.equal(fileName({ id: "x", title: "Stops, 400 m buffer" }), "stops-400-m-buffer.geojson");
    assert.equal(fileName({ id: "x", title: "…" }), "x.geojson");
  });
});

describe("searching the layers", () => {
  const places = placesOf(FIXTURE_LAYERS.map((layer) => ({ layer, collection: FIXTURE_GEOJSON[layer.id] ?? null })));

  it("finds each named feature, at a point's own place or a shape's middle", () => {
    const stop = places.find((p) => p.label === "Science Centre" && p.layer === "Don Mills Rd stops");
    assert.deepEqual(stop?.at, toPoint(43.7255, -79.3378));
    const buffer = places.find((p) => p.label === "Science Centre" && p.layer === "Stops, 400 m buffer");
    assert.ok(buffer && Math.hypot(buffer.at[0] - (stop?.at[0] ?? 0), buffer.at[1] - (stop?.at[1] ?? 0)) < 1);
    // Areas named only by a code aren't places to search for.
    assert.ok(!places.some((p) => p.layer === "Dissemination areas in buffer"));
  });

  it("matches every word, names that start with them first", () => {
    assert.deepEqual(
      search(places, "lawrence north").map((p) => p.label),
      ["Lawrence Ave E (north side)", "Lawrence Ave E (north side)"],
    );
    assert.equal(search(places, "ave e")[0]?.label, "Lawrence Ave E");
    assert.deepEqual(search(places, "  "), []);
    assert.equal(search(places, "e", 3).length, 3);
  });
});

describe("zooming to a layer", () => {
  it("centres on its box, near enough to fill the map, facing the way the map does", () => {
    const camera = cameraFor([-79.3472, 43.7255, -79.3378, 43.7752], -0.3);
    const [x0, y0] = toPoint(43.7255, -79.3472);
    const [x1, y1] = toPoint(43.7752, -79.3378);
    assert.ok(Math.abs(camera.x - (x0 + x1) / 2) < 1e-6 && Math.abs(camera.y - (y0 + y1) / 2) < 1e-6);
    assert.equal(camera.bearing, -0.3);
    assert.ok(camera.distance > 5000 && camera.distance < 20000, String(camera.distance));
  });

  it("stands back from a single point, and never further than the city", () => {
    assert.equal(cameraFor([-79.4, 43.7, -79.4, 43.7]).distance, 1500);
    assert.equal(cameraFor([-80, 43, -78, 45]).distance, 60000);
  });
});

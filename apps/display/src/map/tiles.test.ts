// The aerial photos' tiles: where each lies on the map's ground, and which the
// camera sees, at what zoom.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cameraView, type Camera } from "./engine.ts";
import { toLatLon, toPoint } from "./ground.ts";
import { children, columnOf, cornersOf, GRID, GRID_INDICES, inCity, latOf, lonOf, MAX_ZOOM, MIN_ZOOM, parent, rootTiles, rowOf, tileGrid, tilesInView, tilesOver, uvWithin, zoomFor } from "./tiles.ts";
import { OVERVIEW } from "./views.ts";

const near = (actual: number, expected: number, within: number) => assert.ok(Math.abs(actual - expected) <= within, `${actual} is not within ${within} of ${expected}`);

// Don Mills Road at Eglinton, which the study line passes.
const DON_MILLS: [number, number] = [43.7258, -79.3415];

describe("an aerial photo tile", () => {
  it("is found by latitude and longitude, as Web Mercator numbers them", () => {
    const [lat, lon] = DON_MILLS;
    const x = Math.floor(columnOf(lon, 16));
    const y = Math.floor(rowOf(lat, 16));
    assert.deepEqual([x, y], [18324, 23899]);
    assert.ok(lonOf(x, 16) <= lon && lon < lonOf(x + 1, 16));
    assert.ok(latOf(y, 16) >= lat && lat > latOf(y + 1, 16));
  });

  it("lies on the map's ground where its corners' latitudes and longitudes do", () => {
    const tile = { z: 16, x: 18324, y: 23892 };
    const [nw, ne, se, sw] = cornersOf(tile) as [[number, number], [number, number], [number, number], [number, number]];
    assert.deepEqual(nw, toPoint(latOf(tile.y, 16), lonOf(tile.x, 16)));
    // About 440 m across at zoom 16 in Toronto, and as tall: north up, east right.
    near(ne[0] - nw[0], 440, 5);
    near(nw[1] - sw[1], 440, 5);
    near(se[0], ne[0], 1e-6);
    const [lat, lon] = toLatLon(nw);
    near(lat, latOf(tile.y, 16), 1e-9);
    near(lon, lonOf(tile.x, 16), 1e-9);
  });

  it("is laid as a grid, row by row from the north-west, its photo's top row at v = 0", () => {
    const tile = { z: 14, x: 4580, y: 5973 };
    const grid = tileGrid(tile);
    assert.equal(grid.length, (GRID + 1) ** 2 * 4);
    const [nw, , se] = cornersOf(tile) as [[number, number], [number, number], [number, number]];
    assert.deepEqual(Array.from(grid.slice(0, 4)), [Math.fround(nw[0]), Math.fround(nw[1]), 0, 0]);
    assert.deepEqual(Array.from(grid.slice(-4)), [Math.fround(se[0]), Math.fround(se[1]), 1, 1]);
    assert.equal(GRID_INDICES.length, GRID * GRID * 6);
    assert.ok(Math.max(...GRID_INDICES) === (GRID + 1) ** 2 - 1);
  });

  it("shows the part of an ancestor's photo it covers while its own loads", () => {
    const tile = { z: 16, x: 18325, y: 23894 };
    const grand = parent(parent(tile));
    assert.deepEqual(grand, { z: 14, x: 4581, y: 5973 });
    assert.deepEqual(uvWithin(tile, grand), [0.25, 0.25, 0.25, 0.5]);
    assert.deepEqual(children(grand)[3], { z: 15, x: 9163, y: 11947 });
  });

  it("is asked for only over the city, from zoom 10 to 18, as the service serves", () => {
    const roots = rootTiles();
    assert.ok(roots.length >= 1 && roots.length <= 9);
    assert.ok(roots.every((tile) => tile.z === MIN_ZOOM && inCity(tile)));
    assert.equal(inCity({ z: 16, x: 18324, y: 23899 }), true);
    assert.equal(inCity({ z: 16, x: 18324, y: 25000 }), false);
    assert.equal(inCity({ z: 19, x: 36648, y: 47784 }), false);
  });
});

describe("the tiles the camera sees", () => {
  const view = (camera: Camera) => {
    const width = 3848;
    const height = 2000;
    const { eye, viewProjection } = cameraView(camera, width / height);
    return tilesInView(viewProjection, eye, camera.distance * 2.6, width, height);
  };

  it("cover the overview with tiles of the city, finer near the camera than toward the horizon, and not too many", () => {
    const tiles = view(OVERVIEW);
    assert.ok(tiles.length > 8 && tiles.length <= 120, `${tiles.length} tiles`);
    assert.ok(tiles.every(inCity));
    const zooms = tiles.map((tile) => tile.z);
    assert.ok(Math.max(...zooms) > Math.min(...zooms), "one zoom for the whole tilted view");
    const keys = tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("come to the finest zoom up close, over what the camera looks at", () => {
    const [x, y] = toPoint(...DON_MILLS);
    const tiles = view({ x, y, distance: 1500, pitch: 0.4, bearing: 0 });
    assert.ok(tiles.some((tile) => tile.z >= MAX_ZOOM - 1), `finest ${Math.max(...tiles.map((t) => t.z))}`);
    const under = tiles.filter((tile) => {
      const [nw, , se] = cornersOf(tile) as [[number, number], [number, number], [number, number]];
      return nw[0] <= x && x <= se[0] && se[1] <= y && y <= nw[1];
    });
    assert.equal(under.length, 1, "one tile under the camera's target");
  });

  it("are none where the city has no photos", () => {
    const [x, y] = toPoint(43.2, -79.4);
    assert.deepEqual(view({ x, y, distance: 2000, pitch: 0.2, bearing: 0 }), []);
  });
});

describe("the flat map's tiles", () => {
  it("are at the zoom nearest a photo pixel to a device pixel", () => {
    // A device pixel to a metre is zoom 17 in Toronto; a tenth of one, 13.
    assert.equal(zoomFor(1), 17);
    assert.equal(zoomFor(0.1), 13);
    assert.equal(zoomFor(0.0001), MIN_ZOOM);
    assert.equal(zoomFor(100), MAX_ZOOM);
  });

  const around = (centre: [number, number], half: [number, number]): [number, number][] => [
    [centre[0] - half[0], centre[1] + half[1]],
    [centre[0] + half[0], centre[1] + half[1]],
    [centre[0] + half[0], centre[1] - half[1]],
    [centre[0] - half[0], centre[1] - half[1]],
  ];

  it("cover the box the canvas shows, and only the city's", () => {
    // Zoom 16: about 0.58 device pixels to a metre.
    const tiles = tilesOver(around(toPoint(...DON_MILLS), [1000, 600]), 2 ** 16 / 113_190);
    assert.ok(tiles.length >= 9 && tiles.length <= 30, `${tiles.length} tiles`);
    assert.ok(tiles.every((tile) => tile.z === 16 && inCity(tile)));
    assert.ok(tiles.some((tile) => tile.x === 18324 && tile.y === 23899));
  });

  it("cover a box too large for that zoom whole, a zoom or more coarser", () => {
    const tiles = tilesOver(around(toPoint(...DON_MILLS), [15_000, 9_000]), 1);
    const zooms = new Set(tiles.map((tile) => tile.z));
    assert.equal(zooms.size, 1);
    assert.ok([...zooms][0] as number < 17);
    assert.ok(tiles.length > 9 && tiles.length <= 140, `${tiles.length} tiles`);
  });
});

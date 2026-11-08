import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STUDIES } from "../../../../clients/seed-data.ts";
import type { Camera, Point } from "./engine.ts";
import { projector, toPoint, ViewFeed, type View } from "./projection.ts";
import { VIEWS } from "./views.ts";

const LAWRENCE = VIEWS["lawrence-sunnybrook"] as Camera;
const tilted = (camera: Camera, width = 1920, height = 1080): View => ({ kind: "tilted", camera, width, height });
const near = (actual: Point | null, expected: Point, tolerance = 0.5) => {
  assert.ok(actual, "expected a point on screen");
  assert.ok(Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) <= tolerance, `${actual} is not near ${expected}`);
};

describe("projector", () => {
  it("puts the point the camera looks at in the middle of the canvas", () => {
    near(projector(tilted(LAWRENCE))([LAWRENCE.x, LAWRENCE.y]), [960, 540]);
    near(projector(tilted(LAWRENCE, 412, 533))([LAWRENCE.x, LAWRENCE.y]), [206, 266.5]);
  });

  it("puts the nearer ground lower on the screen, as a tilted camera sees it", () => {
    const project = projector(tilted({ x: 0, y: 0, distance: 10000, pitch: 1.1, bearing: 0 }));
    const nearer = project([0, -2000]) as Point;
    const farther = project([0, 2000]) as Point;
    assert.ok(nearer[1] > 540 && farther[1] < 540);
    // Facing north, east is to the right.
    assert.ok((project([2000, 0]) as Point)[0] > 960);
  });

  it("gives nothing for a point behind the camera", () => {
    assert.equal(projector(tilted({ x: 0, y: 0, distance: 10000, pitch: 1.1, bearing: 0 }))([0, -40000]), null);
  });

  it("matches the flat map's framing", () => {
    const project = projector({ kind: "flat", centre: [1000, 2000], middle: [300, 350], scale: 0.05, width: 800, height: 600 });
    near(project([1000, 2000]), [300, 350]);
    // East is right and north is up.
    near(project([3000, 3000]), [400, 300]);
  });

  it("shows each replay need on screen, on its study's line, from where that study is viewed", () => {
    const studies = JSON.parse(readFileSync(join(import.meta.dirname, "../../public/data/studies.json"), "utf8")) as Record<string, { lines: Point[][]; proposed?: Point[][] }>;
    const needs = STUDIES.flatMap(({ study, needs }) => needs.map((need) => ({ study: study.id, need })));
    assert.ok(needs.length >= 2);
    for (const { study, need } of needs) {
      // A desktop screen, and the map's part of a phone's.
      for (const [width, height] of [
        [1920, 1080],
        [1440, 900],
        [1366, 768],
        [1280, 720],
        [412, 533],
      ] as const) {
        const project = projector(tilted(VIEWS[study] as Camera, width, height));
        const pin = project(toPoint(need.lat, need.lon));
        assert.ok(pin && pin[0] > 0 && pin[0] < width && pin[1] > 0 && pin[1] < height, `${need.id} is off a ${width}x${height} screen at ${pin}`);
        // On a laptop, above the time bar along the bottom, about 115 px tall.
        if (width > 860) assert.ok(pin[1] < height - 130, `${need.id} is under the time bar on a ${width}x${height} screen, at ${pin}`);
        const vertices = [...(studies[study]?.lines ?? []), ...(studies[study]?.proposed ?? [])].flat().map((p) => project(p) as Point);
        const closest = Math.min(...vertices.map((v) => Math.hypot(v[0] - pin[0], v[1] - pin[1])));
        assert.ok(closest < 2, `${need.id} is ${closest.toFixed(1)} px from its line`);
      }
    }
  });
});

describe("ViewFeed", () => {
  it("hands a new listener the latest view, then each one after", () => {
    const feed = new ViewFeed();
    const seen: View[] = [];
    const first = tilted(LAWRENCE);
    feed.set(first);
    const stop = feed.subscribe((view) => seen.push(view));
    const second = tilted(LAWRENCE, 412, 533);
    feed.set(second);
    stop();
    feed.set(first);
    assert.deepEqual(seen, [first, second]);
  });
});

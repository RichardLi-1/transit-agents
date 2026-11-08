import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Camera, Point } from "./engine.ts";
import { flatScale } from "./flat.ts";
import {
  anchorOf,
  boundsOf,
  ease,
  frameOf,
  glide,
  GLIDE_MS,
  groundAt,
  isNotch,
  isPinch,
  keepInside,
  limit,
  LIMITS,
  move,
  notchZoom,
  pinchScale,
  releaseVelocity,
  scrollChange,
  SmoothScroll,
  STOPPED,
  wheelPixels,
  wrap,
  type Frame,
  type Sample,
} from "./gestures.ts";
import { projector, type View } from "./projection.ts";
import { VIEWS } from "./views.ts";

const LAWRENCE = VIEWS["lawrence-sunnybrook"] as Camera;
const NORTH: Camera = { x: 0, y: 0, distance: 10_000, pitch: 1.1, bearing: 0 };

const tilted = (camera: Camera, width = 1920, height = 1080): Frame => ({ camera, width, height });
const flat = (camera: Camera, middle: Point = [780, 615], width = 1920, height = 1080): Frame => ({ camera: { ...camera, pitch: 0 }, width, height, middle });

// The view the page pins cards with, so these check against the renderer's own maths.
const viewOf = (frame: Frame): View => {
  const { camera, width, height, middle } = frame;
  if (!middle) return { kind: "tilted", camera, width, height };
  return { kind: "flat", centre: [camera.x, camera.y], middle, scale: flatScale(camera.distance, height), bearing: camera.bearing, width, height };
};
const screenOf = (frame: Frame, ground: Point) => projector(viewOf(frame))(ground);

const near = (actual: Point | null, expected: Point, tolerance = 0.01) => {
  assert.ok(actual, "expected a point on screen");
  const off = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
  assert.ok(off <= tolerance, `${actual} is ${off} from ${expected}`);
};

const FRAMES: [string, Frame][] = [
  ["a tilted camera facing north", tilted(NORTH)],
  ["the Lawrence study's view", tilted(LAWRENCE)],
  ["a phone's map", tilted({ ...LAWRENCE, bearing: 2.4, pitch: 0.6 }, 412, 533)],
  ["a flat map", flat({ ...NORTH, bearing: 0 })],
  ["a turned flat map", flat({ ...NORTH, bearing: -0.9 })],
];
// Points on the lower two thirds of the screen, well below the horizon.
const POINTS = (frame: Frame): Point[] => [
  [frame.width / 2, frame.height / 2],
  [frame.width * 0.1, frame.height * 0.9],
  [frame.width * 0.8, frame.height * 0.4],
  [frame.width * 0.3, frame.height * 0.6],
];

describe("groundAt", () => {
  for (const [name, frame] of FRAMES) {
    it(`finds the ground the renderer draws under each pixel, for ${name}`, () => {
      for (const pixel of POINTS(frame)) near(screenOf(frame, groundAt(frame, pixel)), pixel);
    });
  }

  it("holds the ground near the horizon at a reach, never past it", () => {
    const frame = tilted({ ...NORTH, pitch: LIMITS.steepest });
    const eye: Point = [0, -NORTH.distance * Math.sin(LIMITS.steepest)];
    for (const y of [0, 10, 40]) {
      const ground = groundAt(frame, [960, y]);
      const reach = Math.hypot(ground[0] - eye[0], ground[1] - eye[1]);
      assert.ok(reach <= 4 * NORTH.distance + 1, `${reach} m away at y ${y}`);
      assert.ok(ground[1] > 0, "still ahead of the camera");
    }
  });
});

describe("dragging", () => {
  for (const [name, frame] of FRAMES) {
    it(`keeps the grabbed ground under the pointer, for ${name}`, () => {
      const from: Point = [frame.width * 0.4, frame.height * 0.7];
      const to: Point = [frame.width * 0.55, frame.height * 0.6];
      const grabbed = groundAt(frame, from);
      const camera = move(frame, { from, to });
      near(screenOf({ ...frame, camera }, grabbed), to);
      assert.equal(camera.distance, frame.camera.distance);
      assert.equal(camera.bearing, frame.camera.bearing);
    });
  }
});

describe("wheel", () => {
  it("counts lines and pages in pixels", () => {
    assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false }, 900), [0, 120]);
    assert.deepEqual(wheelPixels({ deltaX: -1, deltaY: 0, deltaMode: 2, ctrlKey: false }, 900), [-900, 0]);
    assert.deepEqual(wheelPixels({ deltaX: 4, deltaY: -12.5, deltaMode: 0, ctrlKey: false }, 900), [4, -12.5]);
  });

  it("pans a trackpad's scroll by the ground in the middle of the map", () => {
    for (const [, frame] of FRAMES) {
      const middle = anchorOf(frame);
      const [dx, dy] = wheelPixels({ deltaX: 18, deltaY: -40, deltaMode: 0, ctrlKey: false }, frame.height);
      const under = groundAt(frame, middle);
      const camera = move(frame, scrollChange(frame, [dx, dy]));
      // The middle moved with the fingers, as content does.
      near(screenOf({ ...frame, camera }, under), [middle[0] - 18, middle[1] + 40]);
    }
  });

  it("scrolls a tilted map at one speed wherever the pointer rests", () => {
    // Panned by the ground under the pointer, 10 px at Sherbourne moved the middle
    // 39 px with the pointer near the top, and 4 px near the bottom.
    const frame = tilted(VIEWS["sherbourne-castle-frank"] as Camera);
    const change = scrollChange(frame, [0, -10]);
    assert.deepEqual(change.from, [960, 540]);
    const camera = move(frame, change);
    near(screenOf({ ...frame, camera }, groundAt(frame, [960, 540])), [960, 550]);
  });

  it("moves the camera the way it faces, by the ground's size in pixels", () => {
    const frame = flat({ ...NORTH, bearing: 0 });
    const metresPerPixel = 1 / flatScale(NORTH.distance, frame.height);
    const middle = frame.middle as Point;
    const north = move(frame, { from: middle, to: [middle[0], middle[1] + 100] });
    assert.ok(Math.abs(north.x) < 1e-6);
    assert.ok(Math.abs(north.y - 100 * metresPerPixel) < 1e-6);
    const east = move(flat({ ...NORTH, bearing: Math.PI / 2 }), { from: middle, to: [middle[0], middle[1] + 100] });
    assert.ok(Math.abs(east.x - 100 * metresPerPixel) < 1e-6 && Math.abs(east.y) < 1e-6);
    // Tilted, the same scroll covers more ground toward the horizon.
    const near = move(tilted(NORTH), { from: [960, 900], to: [960, 1000] });
    const far = move(tilted(NORTH), { from: [960, 300], to: [960, 400] });
    assert.ok(far.y > near.y && near.y > 0);
  });

  it("tells a mouse wheel's notches from a trackpad", () => {
    const wheel = (deltaX: number, deltaY: number, deltaMode = 0, wheelDeltaY?: number) => ({ deltaX, deltaY, deltaMode, ctrlKey: false, wheelDeltaY });
    // Firefox counts a wheel in lines; Chrome on Windows in 100 pixels, 120 in the legacy delta.
    assert.equal(isNotch(wheel(0, 3, 1)), true);
    assert.equal(isNotch(wheel(0, 100, 0, -120)), true);
    assert.equal(isNotch(wheel(0, 4.000244140625, 0, -120)), true);
    // Chrome and Safari on a Mac give a trackpad's legacy delta as three times its delta.
    assert.equal(isNotch(wheel(0, 40, 0, -120)), false);
    assert.equal(isNotch(wheel(0, 1.5, 0, -4)), false);
    // Sideways, or with nothing to go on, it pans.
    assert.equal(isNotch(wheel(6, 100, 0, -120)), false);
    assert.equal(isNotch(wheel(0, 100)), false);
  });

  it("zooms a notch by a steady step, never nothing and never a leap", () => {
    assert.ok(Math.abs(Math.exp(notchZoom(100)) - 1.32) < 0.01);
    assert.ok(notchZoom(-100) < 0);
    assert.equal(notchZoom(1), Math.LN2 / 8);
    assert.equal(notchZoom(5000), Math.LN2 / 2);
  });
});

describe("smooth scrolling", () => {
  // Two seconds of a trackpad's events, each 12 px, at 60 a second but up to 6 ms
  // off time, as they come, shown at 60 frames a second.
  const scroll = (eventsPerSecond: number) => {
    let seed = 7;
    const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 12 - 6;
    const times = Array.from({ length: eventsPerSecond * 2 }, (_, i) => 100 + (i * 1000) / eventsPerSecond + jitter()).sort((a, b) => a - b);
    const smooth = new SmoothScroll();
    const steps: number[] = [];
    let total = 0;
    let next = 0;
    for (let now = 0; now < 3000; now += 1000 / 60) {
      while (next < times.length && (times[next] as number) <= now) smooth.push(times[next++] as number, [0, 720 / eventsPerSecond]);
      const [x, y] = smooth.take(now);
      assert.equal(x, 0);
      total += y;
      if (now > 160 && now < 2050) steps.push(y);
    }
    return { steps: steps.sort((a, b) => a - b), total, pending: smooth.pending };
  };

  for (const rate of [60, 90]) {
    it(`moves the map every frame by about the same, from ${rate} events a second off time`, () => {
      const { steps, total, pending } = scroll(rate);
      const at = (share: number) => steps[Math.floor(steps.length * share)] as number;
      // Without smoothing, frames here go 0, 12 and 24 px, or 8 and 16.
      assert.ok(at(0) > 4, `slowest frame ${at(0)} px`);
      assert.ok(at(0.05) > 6 && at(0.95) < 18, `${at(0.05)} to ${at(0.95)} px`);
      // And all of the scroll arrives, soon after the fingers stop.
      assert.ok(Math.abs(total - 1440) < 1e-6);
      assert.equal(pending, false);
    });
  }

  it("shows a lone event within two frames", () => {
    const smooth = new SmoothScroll();
    smooth.push(1000, [30, -10]);
    const first = smooth.take(1010);
    const second = smooth.take(1026);
    near([first[0] + second[0], first[1] + second[1]], [30, -10], 1e-9);
    assert.equal(smooth.pending, false);
  });
});

describe("pinch", () => {
  it("is a wheel with Ctrl held whose steps are small", () => {
    assert.equal(isPinch({ deltaX: 0, deltaY: -3.2, deltaMode: 0, ctrlKey: true }), true);
    assert.equal(isPinch({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true }), false);
    assert.equal(isPinch({ deltaX: 0, deltaY: -3.2, deltaMode: 0, ctrlKey: false }), false);
    // Fingers apart send a negative delta, and bring the camera nearer.
    assert.ok(pinchScale(-10) < 1 && pinchScale(10) > 1);
    assert.ok(Math.abs(pinchScale(10) * pinchScale(-10) - 1) < 1e-12);
  });

  for (const [name, frame] of FRAMES) {
    it(`keeps the ground under the pointer as it zooms, for ${name}`, () => {
      for (const at of POINTS(frame)) {
        for (const scale of [pinchScale(-30), pinchScale(25), 0.5, 1.8]) {
          const under = groundAt(frame, at);
          const camera = move(frame, { from: at, to: at, scale });
          assert.ok(Math.abs(camera.distance - frame.camera.distance * scale) < 1e-6);
          near(screenOf({ ...frame, camera }, under), at);
        }
      }
    });
  }

  it("turns and zooms two fingers around their midpoint, which drags too", () => {
    const frame = tilted(LAWRENCE);
    const from: Point = [700, 700];
    const to: Point = [760, 650];
    const under = groundAt(frame, from);
    const camera = move(frame, { from, to, scale: 0.8, turn: 0.3 });
    near(screenOf({ ...frame, camera }, under), to);
    assert.ok(Math.abs(wrap(camera.bearing - LAWRENCE.bearing - 0.3)) < 1e-12);
  });

  it("stops at the nearest and farthest, without drifting the ground under the pointer", () => {
    for (const distance of [LIMITS.nearest, LIMITS.farthest]) {
      const frame = tilted({ ...NORTH, distance });
      const at: Point = [400, 800];
      const camera = move(frame, { from: at, to: at, scale: distance === LIMITS.nearest ? 0.5 : 2 });
      assert.equal(camera.distance, distance);
      assert.ok(Math.abs(camera.x) < 1e-6 && Math.abs(camera.y) < 1e-6);
    }
    // Part of the way to a limit, then held there.
    const almost = move(tilted({ ...NORTH, distance: 1600 }), { from: [960, 540], to: [960, 540], scale: 0.5 });
    assert.equal(almost.distance, LIMITS.nearest);
  });
});

describe("turning and tilting", () => {
  it("turns and tilts around the centre, which stays put", () => {
    const frame = tilted(LAWRENCE);
    const camera = move(frame, { from: [960, 540], to: [960, 540], turn: -0.5, tilt: -0.2 });
    assert.ok(Math.abs(camera.x - LAWRENCE.x) < 1e-6 && Math.abs(camera.y - LAWRENCE.y) < 1e-6);
    assert.ok(Math.abs(camera.pitch - (LAWRENCE.pitch - 0.2)) < 1e-12);
  });

  it("holds the tilt within its limits, and a flat map never tilts", () => {
    assert.equal(move(tilted(NORTH), { from: [960, 540], to: [960, 540], tilt: 3 }).pitch, LIMITS.steepest);
    assert.equal(move(tilted(NORTH), { from: [960, 540], to: [960, 540], tilt: -3 }).pitch, LIMITS.flattest);
    assert.equal(move(flat(NORTH), { from: [780, 615], to: [780, 615], tilt: 1 }).pitch, 0);
  });

  it("keeps the bearing within a turn either way", () => {
    assert.ok(Math.abs(wrap(3 * Math.PI + 0.1) - (-Math.PI + 0.1)) < 1e-12);
    assert.ok(Math.abs(wrap(-0.3) + 0.3) < 1e-12);
    const spun = move(tilted(NORTH), { from: [960, 540], to: [960, 540], turn: 7 });
    assert.ok(spun.bearing >= -Math.PI && spun.bearing <= Math.PI);
  });
});

describe("limits", () => {
  it("stops at a limit and never jumps to one", () => {
    assert.equal(limit(5, 4, 0, 10), 5);
    assert.equal(limit(12, 9, 0, 10), 10);
    assert.equal(limit(-2, 1, 0, 10), 0);
    // A value already outside, as a study's view may be, comes back in but goes no farther out.
    assert.equal(limit(13, 12, 0, 10), 12);
    assert.equal(limit(11, 12, 0, 10), 11);
    assert.equal(limit(-6, -5, 0, 10), -5);
  });

  it("keeps the camera's centre over the network", () => {
    const network = { coordinates: new Int16Array([-100, 50, 200, -25, 10, 300]), polylines: [], routes: [], unitMetres: 2 };
    const bounds = boundsOf(network);
    assert.deepEqual(bounds, { minX: -200, minY: -50, maxX: 400, maxY: 600 });
    const inside = { ...NORTH, x: 100, y: 100 };
    // Out past the east edge: stopped where the step met it, then on along it.
    assert.deepEqual(keepInside({ ...inside, x: 900, y: -80 }, inside, bounds), { ...inside, x: 400, y: 32.5 });
    assert.deepEqual(keepInside({ ...inside, x: 120 }, inside, bounds), { ...inside, x: 120 });
    assert.deepEqual(keepInside({ ...inside, x: 900 }, inside, null), { ...inside, x: 900 });
    // A study's view outside comes back in, but goes no farther out.
    const outside = { ...NORTH, x: 600, y: 100 };
    assert.equal(keepInside({ ...outside, x: 650 }, outside, bounds).x, 600);
    assert.equal(keepInside({ ...outside, x: 550 }, outside, bounds).x, 550);
  });

  it("stops a scroll straight into an edge, though the camera is turned", () => {
    // At Sherbourne's bearing, against the north edge. Clamping x and y apart
    // let the blocked part leak sideways, and the map slid 35 km west.
    const bounds = { minX: -40_000, minY: -20_000, maxX: 40_000, maxY: 23_186 };
    let camera: Camera = { x: 21_390, y: 23_186, distance: 60_000, pitch: 1.18, bearing: -0.25 };
    for (let i = 0; i < 45; i++) {
      const frame = tilted(camera);
      camera = keepInside(move(frame, scrollChange(frame, [0, -40])), camera, bounds);
    }
    assert.ok(Math.abs(camera.x - 21_390) < 1e-6, `slid to x ${camera.x}`);
    assert.equal(camera.y, 23_186);
    // Coming up to the edge, it stops on it, not short of it.
    const below = { ...camera, y: 23_000 };
    assert.equal(keepInside(move(tilted(below), scrollChange(tilted(below), [0, -400])), below, bounds).y, 23_186);
  });

  it("slides along an edge as far as the scroll went sideways", () => {
    const bounds = { minX: -40_000, minY: -20_000, maxX: 40_000, maxY: 23_186 };
    const camera: Camera = { x: 0, y: 23_186, distance: 20_000, pitch: 1.18, bearing: -0.25 };
    const frame = tilted(camera);
    const free = move(frame, scrollChange(frame, [60, 0]));
    const held = keepInside(free, camera, bounds);
    assert.equal(held.y, 23_186);
    // Right, as the camera faces, is a little north of east here, so the edge
    // holds that part back and the rest goes east.
    assert.ok(held.x > 0.9 * (free.x - camera.x), `${held.x} of ${free.x}`);
  });
});

describe("gliding", () => {
  it("slows by e every GLIDE_MS, and goes GLIDE_MS times its speed in all", () => {
    let velocity: Point = [1200, -500];
    let travelled: Point = [0, 0];
    for (let t = 0; t < GLIDE_MS; t += 1000 / 60) {
      const frame = glide(velocity, 1000 / 60);
      travelled = [travelled[0] + frame.step[0], travelled[1] + frame.step[1]];
      velocity = frame.velocity;
    }
    near(velocity, [1200 / Math.E, -500 / Math.E], 15);
    for (let i = 0; i < 600; i++) {
      const frame = glide(velocity, 1000 / 60);
      travelled = [travelled[0] + frame.step[0], travelled[1] + frame.step[1]];
      velocity = frame.velocity;
    }
    near(travelled, [1.2 * GLIDE_MS, -0.5 * GLIDE_MS], 0.5);
  });

  it("goes as far at 120 frames a second as at 60", () => {
    // Half a second either way.
    const run = (perSecond: number) => {
      const dt = 1000 / perSecond;
      let velocity: Point = [900, 0];
      let x = 0;
      for (let i = 0; i < perSecond / 2; i++) {
        const frame = glide(velocity, dt);
        x += frame.step[0];
        velocity = frame.velocity;
      }
      return x;
    };
    assert.ok(Math.abs(run(60) - run(120)) < 0.01);
  });

  it("eases notches and keys at the same pace at any frame rate", () => {
    const left = (dt: number, frames: number) => (1 - ease(dt, 80)) ** frames;
    assert.ok(Math.abs(left(1000 / 60, 6) - left(1000 / 120, 12)) < 1e-12);
  });

  it("flings at the speed the pointer let go at, only if it was moving", () => {
    const samples = (speed: number, until: number): Sample[] => Array.from({ length: 10 }, (_, i) => ({ t: until - 90 + i * 10, x: (speed * (until - 90 + i * 10)) / 1000, y: 0 }));
    near(releaseVelocity(samples(1000, 1000), 1004), [1000, 0], 1);
    // Held still before letting go: no glide.
    assert.deepEqual(releaseVelocity(samples(1000, 1000), 1080), [0, 0]);
    // A creep is no fling.
    assert.deepEqual(releaseVelocity(samples(30, 1000), 1004), [0, 0]);
    // A wild flick is capped.
    near(releaseVelocity(samples(20_000, 1000), 1004), [4000, 0], 1);
    assert.deepEqual(releaseVelocity([], 0), [0, 0]);
    assert.ok(STOPPED < 60);
  });
});

describe("frameOf", () => {
  it("reads a flat map's report as a camera looking straight down", () => {
    const frame = frameOf({ kind: "flat", centre: [500, -200], middle: [700, 600], scale: 0.05, bearing: 0.4, width: 1920, height: 1080 });
    assert.deepEqual(frame.middle, [700, 600]);
    assert.equal(frame.camera.pitch, 0);
    assert.equal(frame.camera.bearing, 0.4);
    // Back to the same scale: the ground 100 m east of the centre is 5 px right of the middle, turned.
    const pixel = projector({ kind: "flat", centre: [500, -200], middle: [700, 600], scale: 0.05, bearing: 0.4, width: 1920, height: 1080 })([600, -200]);
    near(groundAt(frame, pixel as Point), [600, -200], 1e-6);
  });
});

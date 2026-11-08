// The maths of moving the map by hand: where a point on the screen lands on the
// ground, and how each gesture moves the camera so the ground follows the hand.
// Pure functions, so they test without a browser.
import { FIELD_OF_VIEW, type Camera, type NetworkData, type Point } from "./engine.ts";
import { flatScale } from "./flat.ts";
import type { View } from "./projection.ts";

// The map as a gesture sees it: the camera and the canvas size in CSS pixels. A
// flat map has no tilt, and says where on the canvas it draws the camera's centre.
export type Frame = { camera: Camera; width: number; height: number; middle?: Point };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

// How near and far the camera may be, in metres, and how far it may tilt from
// looking straight down, in radians. Steeper than this, the top of the screen
// shows past the horizon.
export const LIMITS = { nearest: 1500, farthest: 60_000, flattest: 0.1, steepest: 1.25 };

// Near the horizon one pixel spans kilometres, so the ground a gesture holds is
// never farther from the eye than this many camera distances.
const REACH = 4;

const TAN = Math.tan(FIELD_OF_VIEW / 2);

export const flatDistance = (scale: number, height: number) => height / (2 * scale * TAN);

export function frameOf(view: View): Frame {
  if (view.kind === "tilted") return { camera: view.camera, width: view.width, height: view.height };
  const { centre, middle, scale, bearing = 0, width, height } = view;
  const camera = { x: centre[0], y: centre[1], distance: flatDistance(scale, height), pitch: 0, bearing };
  return { camera, width, height, middle };
}

// The point a gesture turns and zooms around when it has no pointer: the camera's centre.
export const anchorOf = (frame: Frame): Point => frame.middle ?? [frame.width / 2, frame.height / 2];

// The ground under a point on the screen. Above the horizon, and near it, the
// ground is held at the reach, so a gesture there moves the map smoothly.
export function groundAt(frame: Frame, [sx, sy]: Point): Point {
  const { camera, width, height, middle } = frame;
  const { x, y, distance, pitch, bearing } = camera;
  const forward: Point = [Math.sin(bearing), Math.cos(bearing)];
  const right: Point = [forward[1], -forward[0]];
  if (middle) {
    const scale = flatScale(distance, height);
    const across = (sx - middle[0]) / scale;
    const up = (middle[1] - sy) / scale;
    return [x + right[0] * across + forward[0] * up, y + right[1] * across + forward[1] * up];
  }
  // The ray through the pixel, from the same eye and axes as the renderer's lookAt.
  const sin = Math.sin(pitch);
  const cos = Math.cos(pitch);
  const a = ((2 * sx) / width - 1) * (width / height) * TAN;
  const u = (1 - (2 * sy) / height) * TAN;
  const dx = forward[0] * sin + right[0] * a + cos * forward[0] * u;
  const dy = forward[1] * sin + right[1] * a + cos * forward[1] * u;
  const depth = Math.max(cos - sin * u, (cos * Math.hypot(dx, dy)) / REACH);
  const along = (distance * cos) / depth;
  return [x - forward[0] * distance * sin + dx * along, y - forward[1] * distance * sin + dy * along];
}

// The camera moved sideways so that `ground` shows at `screen`. Moving sideways
// moves all the ground alike, so this is exact.
export function place(frame: Frame, camera: Camera, ground: Point, screen: Point): Camera {
  const at = groundAt({ ...frame, camera }, screen);
  return { ...camera, x: camera.x + ground[0] - at[0], y: camera.y + ground[1] - at[1] };
}

// Keeps a value inside its limits without ever jumping to them: a value already
// outside, as a study's view may be, can come back in but not go farther out.
export function limit(next: number, previous: number, low: number, high: number): number {
  if (next > high) return Math.max(high, Math.min(next, previous));
  if (next < low) return Math.min(low, Math.max(next, previous));
  return next;
}

export const wrap = (angle: number) => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));

// One step of a gesture: the ground under `from` moves to `to`, while the camera
// comes nearer or farther by `scale`, turns by `turn` and tilts by `tilt`. A
// drag, a scroll, a pinch and a turn are all this.
export type Change = { from: Point; to: Point; scale?: number; turn?: number; tilt?: number };

export function move(frame: Frame, { from, to, scale = 1, turn = 0, tilt = 0 }: Change): Camera {
  const { camera } = frame;
  const ground = groundAt(frame, from);
  const next: Camera = {
    ...camera,
    distance: limit(camera.distance * scale, camera.distance, LIMITS.nearest, LIMITS.farthest),
    bearing: wrap(camera.bearing + turn),
    pitch: frame.middle ? camera.pitch : limit(camera.pitch + tilt, camera.pitch, LIMITS.flattest, LIMITS.steepest),
  };
  return place(frame, next, ground, to);
}

// A trackpad's scroll moves the map's middle as far as the fingers went. The
// fingers aren't on the map, so where the pointer rests shouldn't matter, and on a
// tilted map the ground near the horizon would move many times farther.
export function scrollChange(frame: Frame, [dx, dy]: Point): Change {
  const at = anchorOf(frame);
  return { from: at, to: [at[0] - dx, at[1] - dy] };
}

// The share of a step from `p` by `d` that stays inside the bounds, or comes back
// toward them from outside.
function reach(p: Point, d: Point, bounds: Bounds): number {
  let share = 1;
  const axes: [number, number, number, number][] = [
    [p[0], d[0], bounds.minX, bounds.maxX],
    [p[1], d[1], bounds.minY, bounds.maxY],
  ];
  for (const [at, by, low, high] of axes) {
    if (by > 0) share = Math.min(share, (Math.max(high, at) - at) / by);
    if (by < 0) share = Math.min(share, (Math.min(low, at) - at) / by);
  }
  return Math.max(share, 0);
}

// The camera's centre stays over the network. A step that would leave it stops at
// the edge, and only the part of it that went sideways, as the camera faces, goes
// on along the edge. So a scroll straight into an edge stops there, rather than
// sliding off at the angle the camera is turned.
export function keepInside(next: Camera, previous: Camera, bounds: Bounds | null): Camera {
  if (!bounds) return next;
  const from: Point = [previous.x, previous.y];
  const d: Point = [next.x - previous.x, next.y - previous.y];
  const share = reach(from, d, bounds);
  if (share >= 1) return next;
  const edge: Point = [from[0] + d[0] * share, from[1] + d[1] * share];
  const right: Point = [Math.cos(previous.bearing), -Math.sin(previous.bearing)];
  const across = (d[0] * right[0] + d[1] * right[1]) * (1 - share);
  return {
    ...next,
    x: limit(edge[0] + right[0] * across, edge[0], bounds.minX, bounds.maxX),
    y: limit(edge[1] + right[1] * across, edge[1], bounds.minY, bounds.maxY),
  };
}

export function boundsOf(data: NetworkData): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const { coordinates, unitMetres } = data;
  for (let i = 0; i + 1 < coordinates.length; i += 2) {
    const x = (coordinates[i] as number) * unitMetres;
    const y = (coordinates[i + 1] as number) * unitMetres;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}

// Wheels -----------------------------------------------------------------

export type Wheel = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; wheelDeltaY?: number };

const LINE = 40;

// A wheel event's movement in CSS pixels, whether it counted pixels, lines or pages.
export function wheelPixels(event: Wheel, page: number): Point {
  const unit = event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? page : 1;
  return [event.deltaX * unit, event.deltaY * unit];
}

// Whether a wheel event came from a mouse wheel's notches rather than a trackpad.
// Browsers don't say, so this reads the numbers: lines or pages are a wheel, and
// so is movement along one axis that Chrome and Safari don't report as a
// trackpad's, whose legacy delta is three times its delta. Anything doubtful
// counts as a trackpad, so it pans, which never surprises.
export function isNotch(event: Wheel): boolean {
  if (event.deltaMode !== 0) return true;
  if (event.deltaX !== 0 || event.deltaY === 0 || !event.wheelDeltaY) return false;
  return Math.abs(event.wheelDeltaY + 3 * event.deltaY) >= 3;
}

// A pinch arrives as a wheel event with ctrlKey, its deltaY the log of the scale
// in hundredths, so a pinch tracks the fingers. A mouse wheel with Ctrl held
// moves in whole notches of 50 pixels or more, or in lines.
export const isPinch = (event: Wheel) => event.ctrlKey && event.deltaMode === 0 && Math.abs(event.deltaY) < 50;

// How much nearer or farther a pinch takes the camera.
export const pinchScale = (deltaY: number) => Math.exp(Math.max(-50, Math.min(50, deltaY)) / 100);

// How far one notch of a wheel zooms, as the log of the change in distance: about
// 1.3 times for a typical 100 pixel notch. A notch never does nothing, and never
// leaps.
export function notchZoom(pixels: number): number {
  const size = Math.min(Math.max(Math.abs(pixels) * (Math.LN2 / 250), Math.LN2 / 8), Math.LN2 / 2);
  return Math.sign(pixels) * size;
}

// A trackpad's events come about as often as frames but not in step with them,
// so one frame may get two and the next none. Each event's movement is spread
// over the time since the one before, and each frame takes the scroll as it stood
// a little before, so the map moves at the fingers' pace, frame by frame, that
// little behind.
const SCROLL_LAG_MS = 20;
// The longest an event's movement is spread over, so a scroll that starts or
// resumes after a pause doesn't creep.
const SCROLL_SPREAD_MS = 25;

export class SmoothScroll {
  private events: { start: number; end: number; d: Point; taken: number }[] = [];
  private last = -Infinity;

  push(t: number, d: Point) {
    this.events.push({ start: t - Math.min(t - this.last, SCROLL_SPREAD_MS), end: t, d, taken: 0 });
    this.last = t;
  }

  // The movement to show in the frame drawn at `now`.
  take(now: number): Point {
    const target = now - SCROLL_LAG_MS;
    const out: Point = [0, 0];
    for (const e of this.events) {
      const share = e.end <= e.start ? (target >= e.end ? 1 : 0) : Math.min(Math.max((target - e.start) / (e.end - e.start), 0), 1);
      if (share <= e.taken) continue;
      out[0] += e.d[0] * (share - e.taken);
      out[1] += e.d[1] * (share - e.taken);
      e.taken = share;
    }
    this.events = this.events.filter((e) => e.taken < 1);
    return out;
  }

  get pending() {
    return this.events.length > 0;
  }

  clear() {
    this.events = [];
  }
}

// Easing and gliding -----------------------------------------------------

// How much of what is left to do a frame of `dt` milliseconds does, easing to a
// stop over about `tau`, whatever the frame rate.
export const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

// A flung map slows like a puck on ice. Its speed falls by e every GLIDE_MS, so
// it goes GLIDE_MS times its speed in all.
export const GLIDE_MS = 325;
// Slower than this, in pixels a second, it has stopped.
export const STOPPED = 20;
// Faster than this, a fling is taken as this.
const FASTEST = 4000;

// One frame of a glide: how far it moves, and its speed after.
export function glide(velocity: Point, dt: number): { step: Point; velocity: Point } {
  const kept = Math.exp(-dt / GLIDE_MS);
  const travel = (GLIDE_MS / 1000) * (1 - kept);
  return { step: [velocity[0] * travel, velocity[1] * travel], velocity: [velocity[0] * kept, velocity[1] * kept] };
}

export type Sample = { t: number; x: number; y: number };

// The pointer's speed as it let go, in pixels a second, over its last 100 ms.
// Held still before letting go, it has none.
export function releaseVelocity(samples: Sample[], now: number): Point {
  const last = samples.at(-1);
  if (!last || now - last.t > 50) return [0, 0];
  const first = samples.find((s) => last.t - s.t <= 100) ?? last;
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return [0, 0];
  const velocity: Point = [(last.x - first.x) / dt, (last.y - first.y) / dt];
  const speed = Math.hypot(...velocity);
  if (speed < STOPPED * 3) return [0, 0];
  return speed > FASTEST ? [(velocity[0] / speed) * FASTEST, (velocity[1] / speed) * FASTEST] : velocity;
}

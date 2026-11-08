// Moves the map under the hand, as a map app does: drag, scroll, pinch and turn,
// with a trackpad, a mouse, touch or the keyboard. Input gathers between frames
// and moves the camera once a frame, so the worker hears one message a frame
// however fast events come.
import type { Camera, Point } from "./engine.ts";
import {
  anchorOf,
  ease,
  glide,
  isNotch,
  isPinch,
  keepInside,
  move,
  notchZoom,
  pinchScale,
  releaseVelocity,
  scrollChange,
  SmoothScroll,
  STOPPED,
  wheelPixels,
  type Bounds,
  type Change,
  type Frame,
  type Sample,
} from "./gestures.ts";

// Radians a pixel of dragging turns or tilts the camera.
const TURN_PER_PIXEL = (0.8 * Math.PI) / 180;
const TILT_PER_PIXEL = (0.5 * Math.PI) / 180;
// Two fingers twist this far before the map turns, so a pinch alone doesn't.
const TWIST = 0.12;
// One key press: pixels of pan, the log of the zoom, and radians of turn and tilt.
const KEY_PAN = 100;
const KEY_ZOOM = Math.LN2 / 2;
const KEY_TURN = Math.PI / 12;
const KEY_TILT = 0.1;
// Wheel notches and keys ease in over about this many milliseconds.
const EASE_MS = 80;
// After this long without moving the map, the next gesture starts from where the
// map says it is, which a flight or a reset may have changed since.
const QUIET_MS = 250;
// Wheel events further apart than this begin a new scroll.
const SCROLL_GAP_MS = 300;

// Drags start on the map itself. Wheels and pinches count over the cards pinned
// to it too, so a card sliding under the pointer never stops a scroll, and a
// pinch over one zooms the map, not the page.
const SURFACE = "canvas";
const OVER = "canvas, .pin";

// A step the keys and the map's buttons take: pan, zoom, turn or tilt.
export type Step = "left" | "right" | "up" | "down" | "in" | "out" | "turn-left" | "turn-right" | "tilt-up" | "tilt-down";

const KEYS: Record<string, Step> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", "+": "in", "=": "in", "-": "out", _: "out" };
// With Shift, the arrows turn and tilt.
const SHIFTED: Record<string, Step> = { ...KEYS, ArrowLeft: "turn-left", ArrowRight: "turn-right", ArrowUp: "tilt-up", ArrowDown: "tilt-down" };

export type ControlsOptions = {
  // The map as it last reported itself, or null before it has.
  frame: () => Frame | null;
  // The canvas showing, whose top left corner is the frame's origin.
  surface: () => HTMLElement | null;
  // Called in a frame, so the map may draw at once.
  move: (camera: Camera) => void;
  // Back to the study's view.
  home: () => void;
  // Told when the user moves the map from where the page put it, and when that ends.
  onMoved?: (moved: boolean) => void;
};

type Pointer = { from: Point; to: Point; turn: boolean; samples: Sample[] };
type GestureEvent = UIEvent & { scale: number; rotation: number; clientX: number; clientY: number };

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const spread = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const angle = (a: Point, b: Point) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const turned = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const offset = (p: Point, d: Point): Point => [p[0] + d[0], p[1] + d[1]];
const SMALL = 1e-3;

export class MapControls {
  moved = false;
  bounds: Bounds | null = null;
  private readonly options: ControlsOptions;
  // The camera as these controls last moved it, and when.
  private camera: Camera | null = null;
  private movedAt = -Infinity;
  private frameId = 0;
  private lastFrame = 0;
  private readonly pointers = new Map<number, Pointer>();
  // The last movement of a pointer that let go before a frame took it.
  private released: { from: Point; to: Point } | null = null;
  private twist = { total: 0, turning: false };
  private scroll = { pan: new SmoothScroll(), last: -Infinity, notch: false };
  // A pinch or twist of the fingers, taken whole on the next frame.
  private pinch = { scale: 1, turn: 0, at: [0, 0] as Point };
  private safari: { scale: number; rotation: number } | null = null;
  // Notches and keys, taken a little each frame. With no point, around the centre.
  private eased = { zoom: 0, at: null as Point | null, pan: [0, 0] as Point, turn: 0, tilt: 0 };
  private gliding: { at: Point; velocity: Point } | null = null;

  constructor(options: ControlsOptions) {
    this.options = options;
  }

  // Listens on the map's container, which holds the canvases and the cards.
  attach(container: HTMLElement): () => void {
    const over = (target: EventTarget | null, selector: string) => target instanceof Element && container.contains(target) && target.closest(selector) !== null;
    const onWheel = (event: WheelEvent) => over(event.target, OVER) && this.wheel(event);
    const onGesture = (event: Event) => over(event.target, OVER) && this.gesture(event as GestureEvent);
    const onDown = (event: PointerEvent) => over(event.target, SURFACE) && this.down(event);
    const onMove = (event: PointerEvent) => this.pointerMove(event);
    const onUp = (event: PointerEvent) => this.up(event);
    const onKey = (event: KeyboardEvent) => over(event.target, SURFACE) && this.key(event);
    const onMenu = (event: Event) => over(event.target, SURFACE) && event.preventDefault();
    const listeners: [string, EventListener, AddEventListenerOptions?][] = [
      ["wheel", onWheel as EventListener, { passive: false }],
      ["gesturestart", onGesture],
      ["gesturechange", onGesture],
      ["gestureend", onGesture],
      ["pointerdown", onDown as EventListener],
      ["pointermove", onMove as EventListener],
      ["pointerup", onUp as EventListener],
      ["pointercancel", onUp as EventListener],
      ["lostpointercapture", onUp as EventListener],
      ["keydown", onKey as EventListener],
      ["contextmenu", onMenu],
    ];
    for (const [type, listener, options] of listeners) container.addEventListener(type, listener, options);
    return () => {
      for (const [type, listener] of listeners) container.removeEventListener(type, listener);
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    };
  }

  // Stops whatever the hand set going, and forgets that the map was moved.
  settle() {
    this.camera = null;
    this.pointers.clear();
    this.drop();
    if (this.moved) {
      this.moved = false;
      this.options.onMoved?.(false);
    }
  }

  // Drops input not yet taken.
  private drop() {
    this.released = null;
    this.gliding = null;
    this.scroll.pan.clear();
    this.pinch = { scale: 1, turn: 0, at: [0, 0] };
    this.eased = { zoom: 0, at: null, pan: [0, 0], turn: 0, tilt: 0 };
  }

  // Back to the study's view.
  reset() {
    this.settle();
    this.options.home();
  }

  private wheel(event: WheelEvent) {
    event.preventDefault();
    this.gliding = null;
    const at: Point = [event.clientX, event.clientY];
    const wheel = {
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      wheelDeltaY: (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
    };
    const [dx, dy] = wheelPixels(wheel, this.options.frame()?.height ?? window.innerHeight);
    if (event.ctrlKey) {
      // Safari pinches with gesture events instead.
      if (this.safari) return;
      if (isPinch(wheel)) {
        this.pinch.scale *= pinchScale(dy);
        this.pinch.at = at;
      } else this.zoomBy(notchZoom(dy), at);
    } else {
      // A scroll keeps the kind its first event showed, unless a later one shows a trackpad.
      const fresh = event.timeStamp - this.scroll.last > SCROLL_GAP_MS;
      const notch = isNotch(wheel);
      this.scroll.notch = fresh ? notch : this.scroll.notch && notch;
      this.scroll.last = event.timeStamp;
      if (this.scroll.notch && dy !== 0) this.zoomBy(notchZoom(dy), at);
      else {
        // When the fingers moved, on the clock frames use. Some browsers count
        // event times from another start; those count from now.
        const t = Math.abs(event.timeStamp - performance.now()) < 1000 ? Math.min(event.timeStamp, performance.now()) : performance.now();
        this.scroll.pan.push(t, [dx, dy]);
      }
    }
    this.input();
  }

  private zoomBy(log: number, at: Point | null) {
    this.eased.zoom += log;
    this.eased.at = at;
  }

  // Safari's trackpad pinch, and its two-finger turn.
  private gesture(event: GestureEvent) {
    event.preventDefault();
    // On a touch screen the pointers already carry the pinch.
    if (this.pointers.size) return;
    if (event.type === "gesturestart") {
      this.safari = { scale: 1, rotation: 0 };
      this.twist = { total: 0, turning: false };
      this.gliding = null;
      return;
    }
    if (event.type === "gestureend" || !this.safari) {
      this.safari = null;
      return;
    }
    if (event.scale > 0) this.pinch.scale *= this.safari.scale / event.scale;
    this.pinch.turn += this.twisted(-((event.rotation - this.safari.rotation) * Math.PI) / 180);
    this.pinch.at = [event.clientX, event.clientY];
    this.safari = { scale: event.scale || this.safari.scale, rotation: event.rotation };
    this.input();
  }

  // Turns only once the fingers have twisted past a threshold, then follows them
  // from there, so the map never jumps.
  private twisted(delta: number): number {
    if (this.twist.turning) return delta;
    this.twist.total += delta;
    if (Math.abs(this.twist.total) > TWIST) this.twist.turning = true;
    return 0;
  }

  private down(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2) return;
    // Held, so the drag goes on outside the map. The browser focuses the map as
    // the button goes down, so the keys work next, with no focus ring for a click.
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    this.gliding = null;
    const at: Point = [event.clientX, event.clientY];
    const turn = event.pointerType !== "touch" && (event.button === 2 || event.shiftKey || event.ctrlKey);
    this.pointers.set(event.pointerId, { from: at, to: at, turn, samples: [] });
    this.regroup();
    this.input();
  }

  private pointerMove(event: PointerEvent) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    pointer.to = [event.clientX, event.clientY];
    pointer.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    while ((pointer.samples[0]?.t ?? Infinity) < event.timeStamp - 150) pointer.samples.shift();
    this.input();
  }

  private up(event: PointerEvent) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    this.pointers.delete(event.pointerId);
    if (!this.pointers.size && !pointer.turn) {
      this.released = { from: pointer.from, to: pointer.to };
      const velocity: Point = event.type === "pointerup" && !reduced() ? releaseVelocity(pointer.samples, event.timeStamp) : [0, 0];
      if (velocity[0] || velocity[1]) this.gliding = { at: pointer.to, velocity };
    }
    this.regroup();
    this.input();
  }

  // When a finger joins or leaves, each one starts afresh from where it is.
  private regroup() {
    for (const pointer of this.pointers.values()) {
      pointer.from = pointer.to;
      pointer.samples = [];
    }
    this.twist = { total: 0, turning: false };
  }

  private key(event: KeyboardEvent) {
    // Space stays with the time bar, and browser shortcuts with the browser.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Home") {
      event.preventDefault();
      this.reset();
      return;
    }
    const step = (event.shiftKey ? SHIFTED : KEYS)[event.key];
    if (!step) return;
    event.preventDefault();
    this.nudge(step);
  }

  // One step of the map, as a key press or one of the map's buttons makes.
  nudge(step: Step) {
    const e = this.eased;
    if (step === "left") e.pan[0] += KEY_PAN;
    else if (step === "right") e.pan[0] -= KEY_PAN;
    else if (step === "up") e.pan[1] += KEY_PAN;
    else if (step === "down") e.pan[1] -= KEY_PAN;
    else if (step === "in") this.zoomBy(-KEY_ZOOM, null);
    else if (step === "out") this.zoomBy(KEY_ZOOM, null);
    else if (step === "turn-left") e.turn -= KEY_TURN;
    else if (step === "turn-right") e.turn += KEY_TURN;
    else if (step === "tilt-up") e.tilt += KEY_TILT;
    else e.tilt -= KEY_TILT;
    this.gliding = null;
    this.input();
  }

  private input() {
    this.frameId ||= requestAnimationFrame(this.tick);
  }

  private easing() {
    const e = this.eased;
    return e.zoom !== 0 || e.pan[0] !== 0 || e.pan[1] !== 0 || e.turn !== 0 || e.tilt !== 0;
  }

  private readonly tick = (now: number) => {
    this.frameId = 0;
    const dt = Math.min(Math.max(now - (this.lastFrame || now - 16), 0), 64);
    this.lastFrame = now;
    const report = this.options.frame();
    const surface = this.options.surface();
    // Before the map shows, there is nothing to move.
    if (!report || !surface) return this.drop();
    const rect = surface.getBoundingClientRect();
    const local = ([x, y]: Point): Point => [x - rect.left, y - rect.top];

    // While the hand moves the map, go on from where these controls put it, which
    // a worker may not have reported yet. After a pause, from where the map says.
    const start = this.camera && now - this.movedAt < QUIET_MS ? this.camera : report.camera;
    let frame: Frame = { ...report, camera: start };
    const step = (change: Change) => {
      frame = { ...frame, camera: move(frame, change) };
    };
    const centre = anchorOf(frame);

    // Fingers and buttons. One drags, or turns and tilts; two pinch, twist and drag.
    const held = [...this.pointers.values()];
    const [a, b] = held;
    if (this.released) {
      step({ from: local(this.released.from), to: local(this.released.to) });
      this.released = null;
    }
    if (a && b) {
      const from = spread(a.from, b.from);
      const to = spread(a.to, b.to);
      const turn = this.twisted(-turned(angle(a.from, b.from), angle(a.to, b.to)));
      step({ from: local(midpoint(a.from, b.from)), to: local(midpoint(a.to, b.to)), scale: from > 0 && to > 0 ? from / to : 1, turn });
    } else if (a?.turn) {
      step({ from: centre, to: centre, turn: (a.to[0] - a.from[0]) * TURN_PER_PIXEL, tilt: (a.from[1] - a.to[1]) * TILT_PER_PIXEL });
    } else if (a) {
      step({ from: local(a.from), to: local(a.to) });
    }
    for (const pointer of held) pointer.from = pointer.to;

    // A trackpad's scroll pans the middle of the map by as much.
    const pan = this.scroll.pan.take(now);
    if (pan[0] || pan[1]) step(scrollChange(frame, pan));

    // A pinch zooms and turns around the point between the fingers.
    if (this.pinch.scale !== 1 || this.pinch.turn) {
      const at = local(this.pinch.at);
      step({ from: at, to: at, scale: this.pinch.scale, turn: this.pinch.turn });
      this.pinch = { scale: 1, turn: 0, at: this.pinch.at };
    }

    // Notches and keys ease in, or with less motion asked for, jump.
    const k = reduced() ? 1 : ease(dt, EASE_MS);
    const take = (left: number) => (Math.abs(left) < SMALL ? left : left * k);
    const e = this.eased;
    if (e.zoom) {
      const zoom = take(e.zoom);
      const at = e.at ? local(e.at) : centre;
      step({ from: at, to: at, scale: Math.exp(zoom) });
      e.zoom -= zoom;
    }
    if (e.pan[0] || e.pan[1] || e.turn || e.tilt) {
      const pan: Point = [Math.abs(e.pan[0]) < 0.5 ? e.pan[0] : e.pan[0] * k, Math.abs(e.pan[1]) < 0.5 ? e.pan[1] : e.pan[1] * k];
      const turn = take(e.turn);
      const tilt = take(e.tilt);
      step({ from: centre, to: offset(centre, pan), turn, tilt });
      e.pan = [e.pan[0] - pan[0], e.pan[1] - pan[1]];
      e.turn -= turn;
      e.tilt -= tilt;
    }

    // A flung map glides on, slowing.
    if (this.gliding) {
      const { step: travel, velocity } = glide(this.gliding.velocity, dt);
      const at = local(this.gliding.at);
      step({ from: at, to: offset(at, travel) });
      this.gliding.velocity = velocity;
      if (Math.hypot(...velocity) < STOPPED) this.gliding = null;
    }

    const next = keepInside(frame.camera, start, this.bounds);
    const changed = (Object.keys(next) as (keyof Camera)[]).some((key) => Math.abs(next[key] - start[key]) > 1e-9);
    if (changed) {
      this.camera = next;
      this.movedAt = now;
      this.options.move(next);
      if (!this.moved) {
        this.moved = true;
        this.options.onMoved?.(true);
      }
    }
    if (this.gliding || this.easing() || this.scroll.pan.pending) this.frameId = requestAnimationFrame(this.tick);
  };
}

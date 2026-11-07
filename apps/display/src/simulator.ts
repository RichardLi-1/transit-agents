// Runs the display's clock outside the UI tree, so a moving map doesn't re-render
// the page sixty times a second.
import { SPEEDS } from "./time.ts";

type Listener = (ms: number) => void;

export class Simulator {
  private ms = Date.now();
  private start = Date.now();
  private end = Date.now();
  private speedIndex = 3;
  private running = false;
  private frame = 0;
  private lastTick = 0;
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<() => void>();

  get now() {
    return this.ms;
  }
  get first() {
    return this.start;
  }
  get last() {
    return this.end;
  }
  get playing() {
    return this.running;
  }
  get speed() {
    return SPEEDS[this.speedIndex] as (typeof SPEEDS)[number];
  }

  // True at the present moment, when the map can show real vehicles.
  get live() {
    return !this.running && Math.abs(this.ms - Date.now()) < 120_000;
  }

  setEnd(end: number) {
    this.start = Date.now();
    this.end = Math.max(end, this.start);
    this.seek(Math.min(Math.max(this.ms, this.start), this.end));
    this.notifyState();
  }

  seek(ms: number) {
    this.ms = Math.min(Math.max(ms, this.start), this.end);
    for (const listener of this.listeners) listener(this.ms);
  }

  backToNow() {
    this.pause();
    this.seek(Date.now());
    this.notifyState();
  }

  play() {
    if (this.running) return;
    if (this.ms >= this.end) this.seek(this.start);
    this.running = true;
    this.lastTick = performance.now();
    this.frame = requestAnimationFrame(this.tick);
    this.notifyState();
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.notifyState();
  }

  toggle() {
    if (this.running) this.pause();
    else this.play();
  }

  cycleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
    this.notifyState();
  }

  private readonly tick = (time: number) => {
    const elapsed = (time - this.lastTick) / 1000;
    this.lastTick = time;
    this.seek(this.ms + elapsed * this.speed.rate * 1000);
    if (this.ms >= this.end) {
      this.pause();
      return;
    }
    if (this.running) this.frame = requestAnimationFrame(this.tick);
  };

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeState(listener: () => void) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private notifyState() {
    for (const listener of this.stateListeners) listener();
  }
}

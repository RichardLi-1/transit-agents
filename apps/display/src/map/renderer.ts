// One interface for the map, wherever it runs: in a worker when the browser can
// hand a canvas to one, otherwise on the main thread.
import type { Camera, LayerShapes, NetworkData, Point, TiltedView } from "./engine.ts";
import { MapEngine } from "./engine.ts";
import type { GlassRect, Rgb } from "./glass.ts";

export interface MapRenderer {
  setNetwork(data: NetworkData): void;
  // `color` is the line's colour as hex, such as "0082c9". Always given, so no
  // caller can leave a study in the wrong colour.
  setStudyLines(lines: Point[][], proposed: Point[][], color: string): void;
  setStudyFailing(failing: boolean): void;
  setVehicles(data: Float32Array): void;
  setClock(dayType: number | null, hour: number): void;
  // `now`: the caller is in a frame, and the map may draw in it.
  setCamera(camera: Partial<Camera>, now?: boolean): void;
  flyTo(camera: Camera, duration: number): void;
  drawStudyLine(duration: number): void;
  resize(width: number, height: number, ratio: number): void;
  // Light or dark, as the page is.
  setTheme(dark: boolean): void;
  // An agent's layers: all of them, then which to draw, bottom first.
  setLayers(layers: LayerShapes[]): void;
  showLayers(ids: string[]): void;
  // The TTC network under everything, or the layers alone.
  setNetworkShown(shown: boolean): void;
  // The glass panes over the map, in CSS pixels from the canvas's top left, and
  // the page's ground: the map blurs itself under them, and says so by `version`
  // once it has (glass.ts).
  setGlassRects(rects: GlassRect[], ground: Rgb, version: number): void;
}

type Message = "lost" | { view: TiltedView } | { glass: number };

class WorkerRenderer implements MapRenderer {
  private readonly worker: Worker;

  constructor(canvas: HTMLCanvasElement, onLost: () => void, onView: (view: TiltedView) => void, onGlass: (version: number) => void) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<Message>) => {
      const { data } = event;
      if (data === "lost") onLost();
      else if ("glass" in data) onGlass(data.glass);
      else onView(data.view);
    };
    this.worker.postMessage({ method: "init", args: [offscreen] }, [offscreen]);
  }

  private call(method: string, ...args: unknown[]) {
    this.worker.postMessage({ method, args });
  }

  setNetwork(data: NetworkData) {
    this.call("setNetwork", data);
  }
  setStudyLines(lines: Point[][], proposed: Point[][], color: string) {
    this.call("setStudyLines", lines, proposed, color);
  }
  setStudyFailing(failing: boolean) {
    this.call("setStudyFailing", failing);
  }
  setVehicles(data: Float32Array) {
    this.call("setVehicles", data);
  }
  setClock(dayType: number | null, hour: number) {
    this.call("setClock", dayType, hour);
  }
  setCamera(camera: Partial<Camera>) {
    this.call("setCamera", camera);
  }
  flyTo(camera: Camera, duration: number) {
    this.call("flyTo", camera, duration);
  }
  drawStudyLine(duration: number) {
    this.call("drawStudyLine", duration);
  }
  resize(width: number, height: number, ratio: number) {
    this.call("resize", width, height, ratio);
  }
  setTheme(dark: boolean) {
    this.call("setTheme", dark);
  }
  setLayers(layers: LayerShapes[]) {
    this.call("setLayers", layers);
  }
  showLayers(ids: string[]) {
    this.call("showLayers", ids);
  }
  setNetworkShown(shown: boolean) {
    this.call("setNetworkShown", shown);
  }
  setGlassRects(rects: GlassRect[], ground: Rgb, version: number) {
    this.call("setGlassRects", rects, ground, version);
  }
}

// onView hears where the camera is, whenever it moves; onGlass, which glass panes
// the map has blurred, by their version.
export function createRenderer(canvas: HTMLCanvasElement, onLost: () => void, onView: (view: TiltedView) => void, onGlass: (version: number) => void = () => {}): MapRenderer {
  if ("transferControlToOffscreen" in canvas && typeof Worker !== "undefined") {
    return new WorkerRenderer(canvas, onLost, onView, onGlass);
  }
  const engine = new MapEngine(canvas);
  engine.onGlass = onGlass;
  // Here nothing carries the report across threads, so hold it for the draw,
  // unless the map drew at once. A report held back never undoes a newer one.
  let reports = 0;
  engine.onView = (view, drawn) => {
    const report = ++reports;
    if (drawn) onView(view);
    else requestAnimationFrame(() => report === reports && onView(view));
  };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    onLost();
  });
  return engine;
}

// One interface for the map, wherever it runs: in a worker when the browser can
// hand a canvas to one, otherwise on the main thread.
import type { Camera, NetworkData, Point, TiltedView } from "./engine.ts";
import { MapEngine } from "./engine.ts";

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
}

class WorkerRenderer implements MapRenderer {
  private readonly worker: Worker;

  constructor(canvas: HTMLCanvasElement, onLost: () => void, onView: (view: TiltedView) => void) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<"lost" | { view: TiltedView }>) => {
      if (event.data === "lost") onLost();
      else onView(event.data.view);
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
}

// onView hears where the camera is, whenever it moves.
export function createRenderer(canvas: HTMLCanvasElement, onLost: () => void, onView: (view: TiltedView) => void): MapRenderer {
  if ("transferControlToOffscreen" in canvas && typeof Worker !== "undefined") {
    return new WorkerRenderer(canvas, onLost, onView);
  }
  const engine = new MapEngine(canvas);
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

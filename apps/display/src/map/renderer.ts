// One interface for the map, wherever it runs: in a worker when the browser can
// hand a canvas to one, otherwise on the main thread.
import type { Camera, NetworkData, Point } from "./engine.ts";
import { MapEngine } from "./engine.ts";

export interface MapRenderer {
  setNetwork(data: NetworkData): void;
  setStudyLines(lines: Point[][]): void;
  setStudyFailing(failing: boolean): void;
  setVehicles(data: Float32Array): void;
  setClock(dayType: number | null, hour: number): void;
  setCamera(camera: Partial<Camera>): void;
  flyTo(camera: Camera, duration: number): void;
  drawStudyLine(duration: number): void;
  resize(width: number, height: number, ratio: number): void;
}

class WorkerRenderer implements MapRenderer {
  private readonly worker: Worker;

  constructor(canvas: HTMLCanvasElement, onLost: () => void) {
    const offscreen = canvas.transferControlToOffscreen();
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event) => {
      if (event.data === "lost") onLost();
    };
    this.worker.postMessage({ method: "init", args: [offscreen] }, [offscreen]);
  }

  private call(method: string, ...args: unknown[]) {
    this.worker.postMessage({ method, args });
  }

  setNetwork(data: NetworkData) {
    this.call("setNetwork", data);
  }
  setStudyLines(lines: Point[][]) {
    this.call("setStudyLines", lines);
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

export function createRenderer(canvas: HTMLCanvasElement, onLost: () => void): MapRenderer {
  if ("transferControlToOffscreen" in canvas && typeof Worker !== "undefined") {
    return new WorkerRenderer(canvas, onLost);
  }
  const engine = new MapEngine(canvas);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    onLost();
  });
  return engine;
}

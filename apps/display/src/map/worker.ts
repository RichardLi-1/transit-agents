// Runs the map renderer off the main thread. Compiling shaders can take a second
// on a slow or software GPU, and here that never blocks the page.
import { MapEngine } from "./engine.ts";

type Call = { method: string; args: unknown[] };

let engine: MapEngine | null = null;

self.onmessage = (event: MessageEvent<Call>) => {
  const { method, args } = event.data;
  if (method === "init") {
    const canvas = args[0] as OffscreenCanvas;
    canvas.addEventListener("webglcontextlost", (lost) => {
      lost.preventDefault();
      self.postMessage("lost");
    });
    try {
      engine = new MapEngine(canvas);
    } catch {
      self.postMessage("lost");
    }
    return;
  }
  const target = engine as unknown as Record<string, (...a: unknown[]) => void> | null;
  target?.[method]?.(...args);
};

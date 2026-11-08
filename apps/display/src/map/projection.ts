// Where a point on the ground shows on the page, for whichever map is drawing. It
// uses the renderer's own maths, so anything pinned to the map stays on it.
import { cameraView, type Point, type TiltedView } from "./engine.ts";
import type { FlatView } from "./flat.ts";

export type View = ({ kind: "tilted" } & TiltedView) | ({ kind: "flat" } & FlatView);

// The same origin and scale as scripts/build-transit-data.ts, so a latitude and
// longitude land on the network's metres.
const ORIGIN = { lat: 43.7, lon: -79.4 };
export const toPoint = (lat: number, lon: number): Point => [
  (lon - ORIGIN.lon) * 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180),
  (lat - ORIGIN.lat) * 110_574,
];

// Returns a function from ground metres to CSS pixels from the map's top left. It
// gives null for a point behind the camera.
export function projector(view: View): (point: Point) => Point | null {
  if (view.kind === "flat") {
    const { centre, middle, scale } = view;
    return ([x, y]) => [middle[0] + (x - centre[0]) * scale, middle[1] - (y - centre[1]) * scale];
  }
  const { width, height } = view;
  const m = cameraView(view.camera, width / height).viewProjection;
  const at = (i: number) => m[i] as number;
  return ([x, y]) => {
    // Column-major, and the ground is at z = 0.
    const w = at(3) * x + at(7) * y + at(15);
    if (w <= 0) return null;
    const ndcX = (at(0) * x + at(4) * y + at(12)) / w;
    const ndcY = (at(1) * x + at(5) * y + at(13)) / w;
    return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
  };
}

// Holds the latest view and passes each new one on, so pins can follow the camera
// without the page rendering again for every frame of a flight.
export class ViewFeed {
  view: View | null = null;
  private readonly listeners = new Set<(view: View) => void>();

  set(view: View) {
    this.view = view;
    for (const listener of this.listeners) listener(view);
  }

  subscribe(listener: (view: View) => void): () => void {
    this.listeners.add(listener);
    if (this.view) listener(this.view);
    return () => void this.listeners.delete(listener);
  }
}

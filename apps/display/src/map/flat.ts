// A flat map for when WebGL is missing or lost. No tilt or fog: just the network,
// the study line and its vehicles, so the display is never blank.
import type { NetworkData, Point } from "./engine.ts";

// How the flat map frames the ground: the point on the ground at the middle of the
// clear part of the canvas, where that middle is, and CSS pixels per metre. Sizes
// and places on screen are in CSS pixels.
export type FlatView = { centre: Point; middle: Point; scale: number; width: number; height: number };

export class FlatMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly onView: (view: FlatView) => void;
  private network: NetworkData | null = null;
  private lines: Point[][] = [];
  private proposed: Point[][] = [];
  private vehicles: ArrayLike<number> = [];
  private failing = false;
  private reported = "";

  constructor(canvas: HTMLCanvasElement, onView: (view: FlatView) => void = () => {}) {
    this.canvas = canvas;
    this.onView = onView;
  }

  setNetwork(data: NetworkData) {
    this.network = data;
    this.draw();
  }

  setStudyLines(lines: Point[][], proposed: Point[][] = []) {
    this.lines = lines;
    this.proposed = proposed;
    this.draw();
  }

  setStudyFailing(failing: boolean) {
    this.failing = failing;
    this.draw();
  }

  setVehicles(data: ArrayLike<number>) {
    this.vehicles = data;
    this.draw();
  }

  draw() {
    const context = this.canvas.getContext("2d");
    const data = this.network;
    if (!context || !data) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = (this.canvas.width = Math.round(this.canvas.clientWidth * ratio));
    const height = (this.canvas.height = Math.round(this.canvas.clientHeight * ratio));
    context.clearRect(0, 0, width, height);

    // Frame the study line if there is one, otherwise the whole network, in the part
    // of the canvas that the page's panels leave clear.
    const style = getComputedStyle(this.canvas);
    const top = Math.min((parseFloat(style.getPropertyValue("--map-top")) || 0) * ratio, height / 2);
    const right = Math.min((parseFloat(style.getPropertyValue("--map-right")) || 0) * ratio, width / 2);
    const points = [...this.lines, ...this.proposed].flat();
    const xs = points.length ? points.map((p) => p[0]) : [-25000, 20000];
    const ys = points.length ? points.map((p) => p[1]) : [-12000, 14000];
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min((width - right) / ((maxX - minX) * 1.4 || 1), (height - top) / ((maxY - minY) * 1.4 || 1));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const middle: Point = [(width - right) / 2, top + (height - top) / 2];
    const toScreen = (x: number, y: number): Point => [middle[0] + (x - cx) * scale, middle[1] - (y - cy) * scale];
    const view: FlatView = {
      centre: [cx, cy],
      middle: [middle[0] / ratio, middle[1] / ratio],
      scale: scale / ratio,
      width: width / ratio,
      height: height / ratio,
    };
    const key = `${cx} ${cy} ${view.middle} ${view.scale} ${view.width} ${view.height}`;
    if (key !== this.reported && width && height) {
      this.reported = key;
      this.onView(view);
    }

    context.lineWidth = ratio;
    context.strokeStyle = "rgba(110, 115, 125, 0.45)";
    context.beginPath();
    for (const line of data.polylines) {
      for (let i = 0; i < line.count; i++) {
        const at = (line.start + i) * 2;
        const [x, y] = toScreen((data.coordinates[at] as number) * data.unitMetres, (data.coordinates[at + 1] as number) * data.unitMetres);
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
    }
    context.stroke();

    context.lineWidth = 5 * ratio;
    context.lineJoin = "round";
    // Proposed segments are dashed in the line's colour, as on the 3D map.
    context.strokeStyle = this.failing ? "#4d525c" : "#b03488";
    const strokes: [Point[][], number[]][] = [
      [this.lines, []],
      [this.proposed, [10 * ratio, 6 * ratio]],
    ];
    for (const [lines, dash] of strokes) {
      context.setLineDash(dash);
      for (const line of lines) {
        context.beginPath();
        line.forEach(([x, y], i) => {
          const [sx, sy] = toScreen(x, y);
          if (i === 0) context.moveTo(sx, sy);
          else context.lineTo(sx, sy);
        });
        context.stroke();
      }
    }
    context.setLineDash([]);

    for (let i = 0; i < this.vehicles.length; i += 3) {
      const [x, y] = toScreen(this.vehicles[i] as number, this.vehicles[i + 1] as number);
      context.beginPath();
      context.arc(x, y, 5 * ratio, 0, Math.PI * 2);
      if (this.vehicles[i + 2]) {
        context.fillStyle = "#b03488";
        context.fill();
      } else {
        context.lineWidth = 2 * ratio;
        context.strokeStyle = "#b03488";
        context.stroke();
      }
    }
  }
}

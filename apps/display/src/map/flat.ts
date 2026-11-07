// A flat map for when WebGL is missing or lost. No tilt or fog: just the network,
// the study line and its vehicles, so the display is never blank.
import type { NetworkData, Point } from "./engine.ts";

export class FlatMap {
  private readonly canvas: HTMLCanvasElement;
  private network: NetworkData | null = null;
  private lines: Point[][] = [];
  private vehicles: ArrayLike<number> = [];
  private failing = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setNetwork(data: NetworkData) {
    this.network = data;
    this.draw();
  }

  setStudyLines(lines: Point[][]) {
    this.lines = lines;
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

    // Frame the study line if there is one, otherwise the whole network.
    const points = this.lines.length ? this.lines.flat() : [];
    const xs = points.length ? points.map((p) => p[0]) : [-25000, 20000];
    const ys = points.length ? points.map((p) => p[1]) : [-12000, 14000];
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min(width / ((maxX - minX) * 1.4 || 1), height / ((maxY - minY) * 1.4 || 1));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const toScreen = (x: number, y: number): Point => [width / 2 + (x - cx) * scale, height / 2 - (y - cy) * scale];

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
    context.strokeStyle = this.failing ? "#4d525c" : "#b03488";
    for (const line of this.lines) {
      context.beginPath();
      line.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        if (i === 0) context.moveTo(sx, sy);
        else context.lineTo(sx, sy);
      });
      context.stroke();
    }

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

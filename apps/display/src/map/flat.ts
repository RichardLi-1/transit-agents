// A flat map for when WebGL is missing or lost. No tilt or fog: just the network,
// the study line and its vehicles, so the display is never blank.
import { FIELD_OF_VIEW, isRail, type Camera, type LayerShapes, type NetworkData, type NetworkRoute, type Point } from "./engine.ts";
import type { GlassRect, Rgb } from "./glass.ts";
import { cornersOf, tilesOver, tileUrl } from "./tiles.ts";
import { LINE_COLORS } from "./views.ts";

// How the flat map frames the ground: the point on the ground at the middle of the
// clear part of the canvas, where that middle is, CSS pixels per metre, and which
// way is up, as a compass bearing in radians. Sizes and places on screen are in
// CSS pixels.
export type FlatView = { centre: Point; middle: Point; scale: number; bearing?: number; width: number; height: number };

// Pixels per metre at the centre: what a camera looking straight down from this
// distance would see there.
export const flatScale = (distance: number, height: number) => height / (2 * distance * Math.tan(FIELD_OF_VIEW / 2));

export class FlatMap {
  private readonly canvas: HTMLCanvasElement;
  private readonly onView: (view: FlatView) => void;
  private network: NetworkData | null = null;
  private lines: Point[][] = [];
  private proposed: Point[][] = [];
  private color = "#b03488";
  private vehicles: ArrayLike<number> = [];
  private failing = false;
  private reported = "";
  // Where the user has moved the map. Until then it frames the study.
  private camera: Camera | null = null;

  constructor(canvas: HTMLCanvasElement, onView: (view: FlatView) => void = () => {}) {
    this.canvas = canvas;
    this.onView = onView;
  }

  setNetwork(data: NetworkData) {
    this.network = data;
    this.draw();
  }

  // Light or dark, as the page is: the casings take the ground's colour.
  private dark = false;
  setTheme(dark: boolean) {
    this.dark = dark;
    this.draw();
  }

  setStudyLines(lines: Point[][], proposed: Point[][], color: string) {
    this.lines = lines;
    this.proposed = proposed;
    this.color = `#${color}`;
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

  private layers = new Map<string, LayerShapes>();
  private shownLayers: string[] = [];
  private networkShown = true;

  setLayers(layers: LayerShapes[]) {
    this.layers = new Map(layers.map((layer) => [layer.id, layer]));
    this.draw();
  }

  showLayers(ids: string[]) {
    this.shownLayers = ids;
    this.draw();
  }

  setNetworkShown(shown: boolean) {
    this.networkShown = shown;
    this.draw();
  }

  // The flat map draws no glass: it never says it has, so the page's CSS blurs the
  // panes, and pauses while the map moves, as a canvas redrawn on the main thread
  // has no frame to spare.
  setGlassRects(_rects: GlassRect[], _ground: Rgb, _version: number) {}

  // The ground as aerial photos, or plain: the same tiles as the tilted map's, at
  // the zoom nearest a photo pixel to a device pixel, each laid by its corners.
  private imageryShown = false;
  private readonly photos = new Map<string, HTMLImageElement>();
  setImagery(shown: boolean) {
    this.imageryShown = shown;
    this.draw();
  }

  private photo(url: string): HTMLImageElement {
    let image = this.photos.get(url);
    if (image) {
      // Most lately drawn last, so the oldest go first.
      this.photos.delete(url);
    } else {
      image = new Image();
      image.decoding = "async";
      image.onload = () => this.drawSoon();
      image.src = url;
    }
    this.photos.set(url, image);
    // More than a view needs (tilesOver's limit), so a view never drops its own.
    for (const old of this.photos.keys()) {
      if (this.photos.size <= 240) break;
      this.photos.delete(old);
    }
    return image;
  }

  // Once a frame however many photos arrive in it.
  private soon = 0;
  private drawSoon() {
    if (!this.soon) {
      this.soon = requestAnimationFrame(() => {
        this.soon = 0;
        this.draw();
      });
    }
  }

  // Null frames the study again. There is no tilt.
  setCamera(camera: Camera | null) {
    this.camera = camera && { ...camera };
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
    const left = Math.min((parseFloat(style.getPropertyValue("--map-left")) || 0) * ratio, width / 4);
    const right = Math.min((parseFloat(style.getPropertyValue("--map-right")) || 0) * ratio, width / 4);
    const points = [...this.lines, ...this.proposed].flat();
    const xs = points.length ? points.map((p) => p[0]) : [-25000, 20000];
    const ys = points.length ? points.map((p) => p[1]) : [-12000, 14000];
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min((width - left - right) / ((maxX - minX) * 1.4 || 1), (height - top) / ((maxY - minY) * 1.4 || 1));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const middle: Point = [left + (width - left - right) / 2, top + (height - top) / 2];
    const { camera } = this;
    const centre: Point = camera ? [camera.x, camera.y] : [cx, cy];
    const zoom = camera ? flatScale(camera.distance, height) : scale;
    const bearing = camera?.bearing ?? 0;
    const cos = Math.cos(bearing);
    const sin = Math.sin(bearing);
    const toScreen = (x: number, y: number): Point => {
      const dx = x - centre[0];
      const dy = y - centre[1];
      return [middle[0] + (dx * cos - dy * sin) * zoom, middle[1] - (dx * sin + dy * cos) * zoom];
    };
    const view: FlatView = {
      centre,
      middle: [middle[0] / ratio, middle[1] / ratio],
      scale: zoom / ratio,
      bearing,
      width: width / ratio,
      height: height / ratio,
    };
    const key = `${centre} ${view.middle} ${view.scale} ${bearing} ${view.width} ${view.height}`;
    if (key !== this.reported && width && height) {
      this.reported = key;
      this.onView(view);
    }

    if (this.imageryShown) {
      // The ground under the canvas's corners, the screen's mapping undone.
      const ground = ([sx, sy]: Point): Point => {
        const [ex, ey] = [(sx - middle[0]) / zoom, -(sy - middle[1]) / zoom];
        return [centre[0] + ex * cos + ey * sin, centre[1] - ex * sin + ey * cos];
      };
      const box = [ground([0, 0]), ground([width, 0]), ground([width, height]), ground([0, height])];
      for (const tile of tilesOver(box, zoom)) {
        const image = this.photo(tileUrl(tile));
        if (!image.complete || !image.naturalWidth) continue;
        const [nw, ne, , sw] = cornersOf(tile).map(([x, y]) => toScreen(x, y)) as [Point, Point, Point, Point];
        // A hair over a tile's size, so no seam shows between neighbours.
        context.setTransform((ne[0] - nw[0]) / 256, (ne[1] - nw[1]) / 256, (sw[0] - nw[0]) / 256, (sw[1] - nw[1]) / 256, nw[0], nw[1]);
        context.drawImage(image, 0, 0, 256.6, 256.6);
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      if (this.dark) {
        context.fillStyle = "rgba(0, 0, 0, 0.22)";
        context.fillRect(0, 0, width, height);
      }
    }

    // Buses and streetcars in TTC Red, thin; rail lines in their own colours on a
    // casing of the ground's colour, with round joins, as on the tilted map. Over
    // the photos the buses dim, so the rail lines lead.
    const trace = (line: (typeof data.polylines)[number]) => {
      context.beginPath();
      for (let i = 0; i < line.count; i++) {
        const at = (line.start + i) * 2;
        const [x, y] = toScreen((data.coordinates[at] as number) * data.unitMetres, (data.coordinates[at + 1] as number) * data.unitMetres);
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    };
    context.lineCap = "round";
    context.lineJoin = "round";
    const ground = this.dark ? "#161618" : "#ffffff";
    if (this.networkShown) {
      context.lineWidth = ratio;
      context.strokeStyle = this.imageryShown ? "rgba(218, 37, 29, 0.25)" : "rgba(218, 37, 29, 0.4)";
      const rail = data.polylines.filter((line) => isRail(data.routes[line.route] as NetworkRoute));
      for (const line of data.polylines) if (!rail.includes(line)) trace(line);
      for (const [width, casing] of [
        [7, true],
        [4, false],
      ] as const) {
        context.lineWidth = width * ratio;
        for (const line of rail) {
          const route = data.routes[line.route] as NetworkRoute;
          context.strokeStyle = casing ? ground : `#${LINE_COLORS[route.id] ?? route.color}`;
          trace(line);
        }
      }
    }

    // An agent's layers: polygons filled by winding, so overlaps unite and holes stay open.
    const shown = this.shownLayers.flatMap((id) => this.layers.get(id) ?? []);
    const stroke = (points: Point[], close = false) => {
      points.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        if (i === 0) context.moveTo(sx, sy);
        else context.lineTo(sx, sy);
      });
      if (close) context.closePath();
    };
    for (const layer of shown) {
      if (!layer.polygons.length) continue;
      context.beginPath();
      for (const polygon of layer.polygons) for (const ring of polygon) stroke(ring, true);
      context.globalAlpha = 0.26;
      context.fillStyle = `#${layer.color}`;
      context.fill("nonzero");
      context.globalAlpha = 1;
      context.lineWidth = 1.75 * ratio;
      context.strokeStyle = `#${layer.color}`;
      context.stroke();
    }

    context.lineWidth = 7 * ratio;
    // Proposed segments are dashed in the line's colour, as on the 3D map.
    context.strokeStyle = this.failing ? "#4d525c" : this.color;
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

    for (const layer of shown) {
      for (const [width, color] of [
        [7, ground],
        [4, `#${layer.color}`],
      ] as const) {
        context.lineWidth = width * ratio;
        context.strokeStyle = color;
        for (const line of layer.lines) {
          context.beginPath();
          stroke(line);
          context.stroke();
        }
      }
      context.fillStyle = `#${layer.color}`;
      context.strokeStyle = ground;
      context.lineWidth = 2 * ratio;
      for (let i = 0; i + 1 < layer.points.length; i += 2) {
        const [x, y] = toScreen(layer.points[i] as number, layer.points[i + 1] as number);
        context.beginPath();
        context.arc(x, y, 5.5 * ratio, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }

    for (let i = 0; i < this.vehicles.length; i += 3) {
      const [x, y] = toScreen(this.vehicles[i] as number, this.vehicles[i + 1] as number);
      context.beginPath();
      context.arc(x, y, 5 * ratio, 0, Math.PI * 2);
      if (this.vehicles[i + 2]) {
        context.fillStyle = this.color;
        context.fill();
      } else {
        context.lineWidth = 2 * ratio;
        context.strokeStyle = this.color;
        context.stroke();
      }
    }
  }
}

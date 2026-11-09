// What the road safety and active transportation GIS tools share: the study layer
// they start from, the service's refusals, and distances and lines on the ground.
// Distances are in metres on a flat projection around Toronto, which over a few
// kilometres is within a fraction of a percent of the true distance.
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import type { Layer } from "@transit-agents/contracts";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { GisError } from "./gis.ts";
import { ApiError, type Service } from "./service.ts";

export type Area = Feature<Polygon | MultiPolygon>;

// A study's layer and its features, or the service's 404 naming the layers there are.
export function sourceLayer(service: Service, studyId: string, layerId: string): { layer: Layer; features: Feature[] } {
  const { features } = service.layerGeojson(studyId, layerId);
  const layer = service.layers(studyId).find((l) => l.id === layerId) as Layer;
  return { layer, features };
}

// A GIS refusal as the API's: 422 with its code, so a model can correct itself.
export function refusing<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof GisError) throw new ApiError(422, error.code, error.message);
    throw error;
  }
}

// A layer id made from others, within the 63 characters an id may have.
export const layerId = (...parts: (string | number | undefined | false)[]) =>
  parts
    .filter((p) => p !== undefined && p !== false && p !== "")
    .join("-")
    .toLowerCase()
    .slice(0, 63)
    .replace(/[.-]+$/, "");

export const round = (n: number, places = 0) => Math.round(n * 10 ** places) / 10 ** places;

const M_LAT = 110_574;
const M_LON = 111_320 * Math.cos((43.7 * Math.PI) / 180);

// Metres between two points.
export const metres = (a: Position, b: Position) => Math.hypot(((b[0] as number) - (a[0] as number)) * M_LON, ((b[1] as number) - (a[1] as number)) * M_LAT);

// A line's length in metres.
export const lineMetres = (line: Position[]) => line.reduce((sum, point, i) => (i ? sum + metres(line[i - 1] as Position, point) : 0), 0);

// How much of a line lies within `radius` metres of a point.
export function metresNear(line: Position[], centre: Position, radius: number): number {
  let total = 0;
  const local = ([lon, lat]: Position): [number, number] => [((lon as number) - (centre[0] as number)) * M_LON, ((lat as number) - (centre[1] as number)) * M_LAT];
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = local(line[i - 1] as Position);
    const [bx, by] = local(line[i] as Position);
    const dx = bx - ax;
    const dy = by - ay;
    const a = dx * dx + dy * dy;
    if (!a) continue;
    // Where the segment, a + t (b - a), is inside the circle: a quadratic in t.
    const b = 2 * (ax * dx + ay * dy);
    const c = ax * ax + ay * ay - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc <= 0) continue;
    const t0 = Math.max(0, (-b - Math.sqrt(disc)) / (2 * a));
    const t1 = Math.min(1, (-b + Math.sqrt(disc)) / (2 * a));
    if (t1 > t0) total += (t1 - t0) * Math.sqrt(a);
  }
  return total;
}

// Where segment p→q crosses segment r→s, as a share of the way along p→q, or nothing.
function crossing(p: Position, q: Position, r: Position, s: Position): number | undefined {
  const [px, py, qx, qy, rx, ry, sx, sy] = [p[0], p[1], q[0], q[1], r[0], r[1], s[0], s[1]] as number[] as [number, number, number, number, number, number, number, number];
  const d = (qx - px) * (sy - ry) - (qy - py) * (sx - rx);
  if (!d) return undefined;
  const t = ((rx - px) * (sy - ry) - (ry - py) * (sx - rx)) / d;
  const u = ((rx - px) * (qy - py) - (ry - py) * (qx - px)) / d;
  return t > 0 && t < 1 && u >= 0 && u <= 1 ? t : undefined;
}

// An area's edges, in a grid of about 200 m cells, so a line meets only those near it.
export class Edges {
  private readonly cells = new Map<string, [Position, Position][]>();
  private static readonly CELL = 0.002;
  readonly area: Area;
  constructor(area: Area) {
    this.area = area;
    const polygons = area.geometry.type === "Polygon" ? [area.geometry.coordinates] : area.geometry.coordinates;
    for (const ring of polygons.flat()) {
      for (let i = 1; i < ring.length; i++) {
        const edge: [Position, Position] = [ring[i - 1] as Position, ring[i] as Position];
        for (const key of this.keys(edge[0], edge[1])) {
          const list = this.cells.get(key) ?? [];
          list.push(edge);
          this.cells.set(key, list);
        }
      }
    }
  }

  private keys(a: Position, b: Position): string[] {
    const cell = (n: number) => Math.floor(n / Edges.CELL);
    const keys: string[] = [];
    for (let x = cell(Math.min(a[0] as number, b[0] as number)); x <= cell(Math.max(a[0] as number, b[0] as number)); x++) {
      for (let y = cell(Math.min(a[1] as number, b[1] as number)); y <= cell(Math.max(a[1] as number, b[1] as number)); y++) keys.push(`${x},${y}`);
    }
    return keys;
  }

  // The parts of a line inside the area.
  clip(line: Position[]): Position[][] {
    const pieces: Position[][] = [];
    let current: Position[] | undefined;
    for (let i = 1; i < line.length; i++) {
      const p = line[i - 1] as Position;
      const q = line[i] as Position;
      const cuts = new Set<number>([0, 1]);
      const seen = new Set<[Position, Position]>();
      for (const key of this.keys(p, q)) {
        for (const edge of this.cells.get(key) ?? []) {
          if (seen.has(edge)) continue;
          seen.add(edge);
          const t = crossing(p, q, edge[0], edge[1]);
          if (t !== undefined) cuts.add(t);
        }
      }
      const ts = [...cuts].sort((a, b) => a - b);
      const at = (t: number): Position => [(p[0] as number) + ((q[0] as number) - (p[0] as number)) * t, (p[1] as number) + ((q[1] as number) - (p[1] as number)) * t];
      for (let k = 1; k < ts.length; k++) {
        const [t0, t1] = [ts[k - 1] as number, ts[k] as number];
        if (t1 - t0 < 1e-12) continue;
        if (booleanPointInPolygon(at((t0 + t1) / 2), this.area)) {
          if (!current) {
            current = [at(t0)];
            pieces.push(current);
          }
          current.push(at(t1));
        } else current = undefined;
      }
    }
    return pieces.map((piece) => piece.map(([lon, lat]) => [round(lon as number, 6), round(lat as number, 6)]));
  }
}

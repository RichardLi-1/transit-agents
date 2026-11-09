// Map layers an agent adds to a study, such as stops, a buffer around them or the
// census areas it touches: what the service says of each, and its GeoJSON turned
// into the map's metres, for both renderers to draw.
import { FIELD_OF_VIEW, type Camera, type LayerShapes, type Point } from "./engine.ts";
import { toPoint } from "./projection.ts";

// GET /v1/studies/:id/layers, as the service lists them.
export type Layer = {
  id: string;
  title: string;
  kind: "points" | "lines" | "polygons";
  color?: string;
  featureCount: number;
  // West, south, east, north, in degrees.
  bbox: [number, number, number, number];
  dataset?: { id: string; title: string; publisher: string; licence: string; url: string; retrieved: string };
  derivedFrom?: string[];
  operation?: { name: string; params: Record<string, unknown> };
  createdBy: string;
  at: string;
};

type Position = number[];
export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "MultiPoint"; coordinates: Position[] }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "GeometryCollection"; geometries: Geometry[] };
export type Feature = { type: "Feature"; geometry: Geometry | null; properties?: Record<string, unknown> | null };
export type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

// A layer as the map draws it, in metres: points as x, y pairs, lines, and
// polygons as rings, each outer ring anticlockwise and each hole clockwise, so a
// fill by winding unites overlapping shapes and leaves holes empty.
export type Shapes = Omit<LayerShapes, "id" | "color">;

// For a layer the service gives no colour: distinct, and dark enough to read on white.
export const PALETTE = ["d1495b", "3f7cac", "7b4fa0", "2a8c7e", "c46f12", "5c6b2e"];

// The layer's colour as hex without the #, its own if it has a usable one.
export function colorOf(layer: Pick<Layer, "color">, index: number): string {
  const own = /^#([0-9a-f]{6})$/i.exec(layer.color ?? "")?.[1];
  return (own ?? PALETTE[index % PALETTE.length] ?? "d1495b").toLowerCase();
}

const at = (position: Position): Point | null => {
  const [lon, lat] = position;
  return typeof lon === "number" && typeof lat === "number" && Number.isFinite(lon) && Number.isFinite(lat) ? toPoint(lat, lon) : null;
};
const path = (positions: Position[]) => positions.map(at).filter((p): p is Point => p !== null);

// Twice the signed area: positive for a ring that runs anticlockwise.
export function area(ring: Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i] as Point;
    const [x1, y1] = ring[(i + 1) % ring.length] as Point;
    sum += x0 * y1 - x1 * y0;
  }
  return sum;
}

const wound = (ring: Point[], anticlockwise: boolean) => ((area(ring) > 0) === anticlockwise ? ring : [...ring].reverse());

function polygon(rings: Position[][]): Point[][] {
  return rings.map((ring, i) => wound(path(ring), i === 0)).filter((ring) => ring.length >= 3);
}

export function shapesOf(collection: FeatureCollection | null | undefined): Shapes {
  const shapes: Shapes = { points: [], lines: [], polygons: [] };
  const add = (geometry: Geometry | null | undefined) => {
    if (!geometry) return;
    switch (geometry.type) {
      case "Point": {
        const p = at(geometry.coordinates);
        if (p) shapes.points.push(...p);
        return;
      }
      case "MultiPoint":
        for (const p of path(geometry.coordinates)) shapes.points.push(...p);
        return;
      case "LineString": {
        const line = path(geometry.coordinates);
        if (line.length > 1) shapes.lines.push(line);
        return;
      }
      case "MultiLineString":
        for (const coordinates of geometry.coordinates) add({ type: "LineString", coordinates });
        return;
      case "Polygon": {
        const rings = polygon(geometry.coordinates);
        if (rings.length) shapes.polygons.push(rings);
        return;
      }
      case "MultiPolygon":
        for (const coordinates of geometry.coordinates) add({ type: "Polygon", coordinates });
        return;
      case "GeometryCollection":
        for (const part of geometry.geometries) add(part);
        return;
    }
  };
  for (const feature of collection?.features ?? []) add(feature?.geometry);
  return shapes;
}

// The camera that frames a layer's box, looking at it a little tilted, from the
// way the map faces now.
export function cameraFor(bbox: Layer["bbox"], bearing = 0): Camera {
  const [west, south, east, north] = bbox;
  const [x0, y0] = toPoint(south, west);
  const [x1, y1] = toPoint(north, east);
  // A single point, or a small layer, still shows its streets around it.
  const span = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 600);
  const distance = Math.min(Math.max((span * 1.35) / (2 * Math.tan(FIELD_OF_VIEW / 2)), 1500), 60000);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, distance, pitch: 0.55, bearing };
}

// A named place in a layer, for the map's search.
export type Place = { label: string; layer: string; at: Point };

// A feature's name, if it has one, from the properties GIS data names things by.
function nameOf(feature: Feature): string | null {
  const properties = feature.properties ?? {};
  for (const key of ["name", "title", "label", "stop_name", "NAME", "Name"]) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// Each named feature's place: a point's own, or the middle of a shape's extent.
export function placesOf(layers: { layer: Pick<Layer, "title">; collection: FeatureCollection | null }[]): Place[] {
  const places: Place[] = [];
  for (const { layer, collection } of layers) {
    for (const feature of collection?.features ?? []) {
      const label = nameOf(feature);
      if (!label) continue;
      const shapes = shapesOf({ type: "FeatureCollection", features: [feature] });
      const points: Point[] = [];
      for (let i = 0; i + 1 < shapes.points.length; i += 2) points.push([shapes.points[i] as number, shapes.points[i + 1] as number]);
      points.push(...shapes.lines.flat(), ...shapes.polygons.flat(2));
      if (!points.length) continue;
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      places.push({ label, layer: layer.title, at: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] });
    }
  }
  return places;
}

// The places whose names hold every word asked for, best first: a name that
// starts with the words before one that only has them.
export function search(places: Place[], query: string, limit = 8): Place[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const found = places.filter((place) => words.every((word) => place.label.toLowerCase().includes(word)));
  const starts = (place: Place) => (place.label.toLowerCase().startsWith(words[0] as string) ? 0 : 1);
  return found.sort((a, b) => starts(a) - starts(b) || a.label.localeCompare(b.label)).slice(0, limit);
}

// The words a visible layer's data asks to be credited with.
export function creditOf(layer: Layer): string | null {
  const { dataset } = layer;
  if (!dataset) return null;
  return [dataset.publisher || dataset.title, dataset.licence].filter(Boolean).join(", ");
}

// A layer's GeoJSON as a file to save, named after its title.
export const fileName = (layer: Pick<Layer, "id" | "title">) =>
  `${(layer.title || layer.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || layer.id}.geojson`;

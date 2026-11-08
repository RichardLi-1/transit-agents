// Draft alignments built only from real street corridors: never drawn free-hand.
// A line starts at the Ontario Line's northern end, Don Valley station (Science
// Centre in the business cases), follows each named street along a TTC route's
// shape from the network data, turns where one street's shape meets the next,
// and stops at a real station or interchange. A street the data has no shape for,
// a turn where the shapes don't meet, or a terminus off the last street is refused.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type LonLat = [number, number];

const ORIGIN = { lat: 43.7, lon: -79.4 };
const METRES_PER_DEG_LAT = 110_574;
const METRES_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

// Don Valley station, as the study's line ends.
export const START: LonLat = [-79.338694, 43.721443];

// How far a line may jump onto a street, turn between two streets' shapes, or end
// short of its terminus. Wider than a road, narrower than a block.
const SNAP_METRES = 150;

// Each street, and the TTC route whose shape runs along it.
export const CORRIDORS: Record<string, { route: string; label: string }> = {
  "don-mills-road": { route: "25", label: "Don Mills Road" },
  "leslie-street": { route: "51", label: "Leslie Street" },
  "eglinton-avenue-east": { route: "5", label: "Eglinton Avenue East" },
  "lawrence-avenue-east": { route: "54", label: "Lawrence Avenue East" },
  "sheppard-avenue-east": { route: "85", label: "Sheppard Avenue East" },
  "victoria-park-avenue": { route: "24", label: "Victoria Park Avenue" },
};

// The real stations and interchanges a line may end at, where they meet the street.
export const TERMINI: Record<string, { name: string; at: LonLat; interchange: string }> = {
  "don-mills-station": { name: "Don Mills station", at: [-79.34724, 43.77504], interchange: "Line 4 Sheppard" },
  "leslie-station": { name: "Leslie station", at: [-79.364165, 43.771662], interchange: "Line 4 Sheppard" },
  "lawrence-don-mills": { name: "Lawrence and Don Mills", at: [-79.342894, 43.735215], interchange: "54 Lawrence East" },
  "fairview-mall": { name: "Fairview Mall", at: [-79.34518, 43.77606], interchange: "Line 4 at Don Mills station, and its bus terminal" },
  "sheppard-victoria-park": { name: "Sheppard and Victoria Park", at: [-79.323029, 43.775281], interchange: "24 Victoria Park and 85 Sheppard East" },
};

// What an alignment's cost and stations come from in the study: the precedent's
// cost per km and its contingency, the optimism bias rule, and the planner-set
// length and stations, whose ratio is the station spacing.
export const ALIGNMENT_COST = {
  perKm: "ol-cost-per-km",
  contingency: "ol-contingency",
  optimismBias: "metrolinx.optimism-bias-ibc",
  length: "ontario-north.length-km",
  stations: "ontario-north.new-stations",
};

export const slugOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/\bave\b\.?/g, "avenue")
    .replace(/\bst\b\.?/g, "street")
    .replace(/\brd\b\.?/g, "road")
    .replace(/\be\b\.?$/g, "east")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

type Point = [number, number];
const toMetres = ([lon, lat]: LonLat): Point => [(lon - ORIGIN.lon) * METRES_PER_DEG_LON, (lat - ORIGIN.lat) * METRES_PER_DEG_LAT];
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const toLonLat = ([x, y]: Point): LonLat => [round6(x / METRES_PER_DEG_LON + ORIGIN.lon), round6(y / METRES_PER_DEG_LAT + ORIGIN.lat)];
const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lengthOf = (line: Point[]) => line.reduce((sum, p, i) => (i ? sum + distance(line[i - 1] as Point, p) : 0), 0);

export class AlignmentError extends Error {}

export type Network = { shapes: Map<string, Point[][]> };

// Every route's shapes, in metres, from the display's network data.
export function loadNetwork(dir = join(import.meta.dirname, "../../../apps/display/public/data")): Network {
  const meta = JSON.parse(readFileSync(join(dir, "network.json"), "utf8")) as {
    unitMetres: number;
    routes: { id: string }[];
    polylines: { route: number; start: number; count: number }[];
  };
  const bytes = readFileSync(join(dir, "network.bin"));
  const coordinates = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  const shapes = new Map<string, Point[][]>();
  for (const { route, start, count } of meta.polylines) {
    const id = meta.routes[route]?.id as string;
    const line = Array.from({ length: count }, (_, i): Point => [
      (coordinates[(start + i) * 2] as number) * meta.unitMetres,
      (coordinates[(start + i) * 2 + 1] as number) * meta.unitMetres,
    ]);
    shapes.set(id, [...(shapes.get(id) ?? []), line]);
  }
  return { shapes };
}

// Where a point falls on a line: the segment, how far along it, and how far off.
type Spot = { at: number; point: Point; off: number };
function project(line: Point[], p: Point): Spot {
  let best: Spot = { at: 0, point: line[0] as Point, off: Infinity };
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1] as Point, line[i] as Point];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const point: Point = [a[0] + dx * t, a[1] + dy * t];
    const off = distance(p, point);
    if (off < best.off) best = { at: i - 1 + t, point, off };
  }
  return best;
}

// The part of a line between two spots on it, in travel order.
function between(line: Point[], from: Spot, to: Spot): Point[] {
  const forward = from.at <= to.at;
  const [lo, hi] = forward ? [from, to] : [to, from];
  const inner = line.slice(Math.floor(lo.at) + 1, Math.ceil(hi.at));
  const part = [lo.point, ...inner, hi.point];
  return forward ? part : part.reverse();
}

// Where the line turns from one street's shape onto the next: of the places the
// shapes meet, the one that makes the line shortest, from where it is on the first
// to where it is heading on the second. Shapes that run together for a stretch,
// as two buses on one street do, meet all along it.
function junction(a: Point[], b: Point[], from: Spot, toward: Point): { onA: Spot; onB: Spot } | undefined {
  const candidates: { onA: Spot; onB: Spot }[] = [];
  for (const p of b) {
    const onA = project(a, p);
    if (onA.off <= SNAP_METRES) candidates.push({ onA, onB: project(b, onA.point) });
  }
  for (const p of a) {
    const onB = project(b, p);
    if (onB.off <= SNAP_METRES) candidates.push({ onA: project(a, onB.point), onB });
  }
  const target = project(b, toward);
  const cost = ({ onA, onB }: { onA: Spot; onB: Spot }) => lengthOf(between(a, from, onA)) + lengthOf(between(b, onB, target));
  return candidates.sort((x, y) => cost(x) - cost(y))[0];
}

// The longest of a route's shapes, which runs its whole way.
function shapeFor(network: Network, street: string): { line: Point[]; label: string } {
  const corridor = CORRIDORS[slugOf(street)];
  const line = corridor && [...(network.shapes.get(corridor.route) ?? [])].sort((x, y) => y.length - x.length)[0];
  if (!corridor || !line) {
    throw new AlignmentError(`No route shape runs along "${street}". Streets with one: ${Object.values(CORRIDORS).map((c) => c.label).join(", ")}`);
  }
  return { line, label: corridor.label };
}

export type Alignment = { line: LonLat[]; lengthKm: number; follows: string; terminus: (typeof TERMINI)[string] };

// The line from Don Valley station along each street in turn to the terminus.
export function snapAlignment(network: Network, corridor: string[], terminus: string): Alignment {
  const end = Object.entries(TERMINI).find(([key, t]) => key === slugOf(terminus) || slugOf(t.name) === slugOf(terminus))?.[1];
  if (!end) throw new AlignmentError(`"${terminus}" is not a station or interchange the line can end at. Termini: ${Object.values(TERMINI).map((t) => t.name).join(", ")}`);
  if (!corridor.length) throw new AlignmentError("Name at least one street for the line to follow");
  const streets = corridor.map((street) => shapeFor(network, street));
  let here = project((streets[0] as { line: Point[] }).line, toMetres(START));
  if (here.off > SNAP_METRES) throw new AlignmentError(`${streets[0]?.label} doesn't pass Don Valley station: the line can't start on it`);
  const points: Point[] = [toMetres(START)];
  for (const [i, { line, label }] of streets.entries()) {
    const next = streets[i + 1];
    let stop: Spot;
    let onNext: Spot | undefined;
    if (next) {
      const meet = junction(line, next.line, here, toMetres(end.at));
      if (!meet) throw new AlignmentError(`${label} and ${next.label} don't meet in the route data: the line can't turn there`);
      [stop, onNext] = [meet.onA, meet.onB];
    } else {
      stop = project(line, toMetres(end.at));
      if (stop.off > SNAP_METRES) throw new AlignmentError(`${end.name} isn't on ${label}: the line can't end there`);
    }
    points.push(...between(line, here, stop));
    if (onNext) here = onNext;
  }
  points.push(toMetres(end.at));
  // Drop repeats where legs join.
  const line = points.filter((p, i) => i === 0 || distance(points[i - 1] as Point, p) > 1);
  return {
    // Ending exactly at the terminus, as the catalogue places it.
    line: [...line.slice(0, -1).map(toLonLat), end.at],
    lengthKm: Math.round(lengthOf(line) / 100) / 10,
    follows: streets.map((s) => s.label).join(", "),
    terminus: end,
  };
}

// A point on a line, this share of the way along it.
export function along(line: LonLat[], share: number): LonLat {
  const points = line.map(toMetres);
  let left = lengthOf(points) * share;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1] as Point, points[i] as Point];
    const step = distance(a, b);
    if (left <= step) return toLonLat([a[0] + ((b[0] - a[0]) * left) / (step || 1), a[1] + ((b[1] - a[1]) * left) / (step || 1)]);
    left -= step;
  }
  return line.at(-1) as LonLat;
}

// The network, read once, when an alignment is first asked for.
let network: Network | undefined;
export const cachedNetwork = () => (network ??= loadNetwork());

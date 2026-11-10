// Aerial photos on the map: which tiles the camera sees, at what zoom, and where
// each lies on the map's ground. The photos are Web Mercator tiles, 256 pixels
// square, from the service (services/api/src/imagery.ts); the map is in metres
// (ground.ts). So each tile is laid as a small grid, each vertex where its
// latitude and longitude fall, which bends it the little the two differ.
import { GROUND_LATITUDE, toLatLon, toPoint } from "./ground.ts";

type Point = [number, number];
export type Tile = { z: number; x: number; y: number };

// As the service serves them: from zoom 10, where the City's tiles start, to 18,
// where a pixel is about 0.43 m in Toronto, a device pixel at the map's nearest.
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 18;

// What the City's photos cover, in Web Mercator metres.
const EXTENT = { xmin: -8869931.9307, ymin: 5395816.8838, xmax: -8802055.8621, ymax: 5451532.5866 };
const HALF_WORLD = 20037508.342789244;

export const tileKey = ({ z, x, y }: Tile) => `${z}/${x}/${y}`;
export const tileUrl = (tile: Tile) => `/v1/tiles/imagery/${tileKey(tile)}`;

export const lonOf = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export const latOf = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
// The tile column and row a longitude and latitude fall in, as fractions.
export const columnOf = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
export const rowOf = (lat: number, z: number) => {
  const phi = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * 2 ** z;
};

// Whether the City has photos in a tile, as the service decides.
export function inCity({ z, x, y }: Tile): boolean {
  if (z < MIN_ZOOM || z > MAX_ZOOM) return false;
  const size = (2 * HALF_WORLD) / 2 ** z;
  const left = -HALF_WORLD + x * size;
  const top = HALF_WORLD - y * size;
  return left < EXTENT.xmax && left + size > EXTENT.xmin && top > EXTENT.ymin && top - size < EXTENT.ymax;
}

// The tiles at the coarsest zoom that cover the city.
export function rootTiles(): Tile[] {
  const z = MIN_ZOOM;
  const column = (m: number) => Math.floor(((m + HALF_WORLD) / (2 * HALF_WORLD)) * 2 ** z);
  const row = (m: number) => Math.floor(((HALF_WORLD - m) / (2 * HALF_WORLD)) * 2 ** z);
  const tiles: Tile[] = [];
  for (let x = column(EXTENT.xmin); x <= column(EXTENT.xmax); x++) {
    for (let y = row(EXTENT.ymax); y <= row(EXTENT.ymin); y++) tiles.push({ z, x, y });
  }
  return tiles;
}

export const children = ({ z, x, y }: Tile): Tile[] => [
  { z: z + 1, x: 2 * x, y: 2 * y },
  { z: z + 1, x: 2 * x + 1, y: 2 * y },
  { z: z + 1, x: 2 * x, y: 2 * y + 1 },
  { z: z + 1, x: 2 * x + 1, y: 2 * y + 1 },
];

export const parent = ({ z, x, y }: Tile): Tile => ({ z: z - 1, x: Math.floor(x / 2), y: Math.floor(y / 2) });

// A point of a tile, u across and v down it, in the map's metres.
const pointOf = ({ z, x, y }: Tile, u: number, v: number): Point => toPoint(latOf(y + v, z), lonOf(x + u, z));

// Its corners: north-west, north-east, south-east, south-west.
export const cornersOf = (tile: Tile): Point[] => [pointOf(tile, 0, 0), pointOf(tile, 1, 0), pointOf(tile, 1, 1), pointOf(tile, 0, 1)];

// Each tile is a grid this many cells across.
export const GRID = 8;

// A tile's vertices, row by row from the north-west: x and y in metres, then u
// and v in the photo, v down from its top row.
export function tileGrid(tile: Tile): Float32Array {
  const out = new Float32Array((GRID + 1) * (GRID + 1) * 4);
  let i = 0;
  for (let row = 0; row <= GRID; row++) {
    for (let column = 0; column <= GRID; column++) {
      const [u, v] = [column / GRID, row / GRID];
      const [px, py] = pointOf(tile, u, v);
      out.set([px, py, u, v], i);
      i += 4;
    }
  }
  return out;
}

// Two triangles for every cell of the grid.
export const GRID_INDICES = (() => {
  const out: number[] = [];
  const at = (row: number, column: number) => row * (GRID + 1) + column;
  for (let row = 0; row < GRID; row++) {
    for (let column = 0; column < GRID; column++) out.push(at(row, column), at(row, column + 1), at(row + 1, column), at(row + 1, column), at(row, column + 1), at(row + 1, column + 1));
  }
  return new Uint16Array(out);
})();

// Where in an ancestor's photo a tile lies, as the scale and offset of its u and
// v, so a tile still loading shows its ancestor's pixels meanwhile.
export function uvWithin(tile: Tile, ancestor: Tile): [number, number, number, number] {
  const n = 2 ** (tile.z - ancestor.z);
  return [1 / n, 1 / n, (tile.x - ancestor.x * n) / n, (tile.y - ancestor.y * n) / n];
}

// A tile is split while its edge spans more than this many device pixels on
// screen, so a photo's pixel is never stretched past two device pixels, a CSS
// pixel on a sharp screen: half the tiles of a pixel for a pixel, as sharp to see.
const SPLIT_PX = 512;

// The tiles a tilted camera sees, each at the zoom that gives about a photo pixel
// to a CSS pixel: finer near the camera, coarser toward the horizon, none past
// `far` metres from the eye, where the ground has faded out. The tile largest on
// screen is split first, so with at most `limit` tiles the nearest are the sharpest.
export function tilesInView(viewProjection: Float32Array, eye: [number, number, number], far: number, width: number, height: number, limit = 120): Tile[] {
  const m = (i: number) => viewProjection[i] as number;
  const project = ([x, y]: Point) => [m(0) * x + m(4) * y + m(12), m(1) * x + m(5) * y + m(13), m(3) * x + m(7) * y + m(15)] as const;
  // How long a tile's longest edge is on screen, or null if it can't be seen.
  const measure = (tile: Tile): { tile: Tile; edge: number } | null => {
    const corners = cornersOf(tile);
    const clip = corners.map(project);
    // Wholly off one side of the screen, or behind the eye.
    if (clip.every(([cx, , w]) => cx > w) || clip.every(([cx, , w]) => cx < -w) || clip.every(([, cy, w]) => cy > w) || clip.every(([, cy, w]) => cy < -w) || clip.every(([, , w]) => w <= 0)) return null;
    // Wholly beyond the fog.
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const dx = Math.max(Math.min(...xs) - eye[0], 0, eye[0] - Math.max(...xs));
    const dy = Math.max(Math.min(...ys) - eye[1], 0, eye[1] - Math.max(...ys));
    if (Math.hypot(dx, dy, eye[2]) > far) return null;
    // A tile reaching behind the eye is split until it doesn't.
    if (clip.some(([, , w]) => w <= 1e-6)) return { tile, edge: Infinity };
    const screen: Point[] = clip.map(([cx, cy, w]) => [((cx / w + 1) / 2) * width, ((1 - cy / w) / 2) * height]);
    const edges = screen.map((p, i) => {
      const q = screen[(i + 1) % 4] as Point;
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    });
    return { tile, edge: Math.max(...edges) };
  };
  const shown = rootTiles().flatMap((tile) => measure(tile) ?? []);
  for (;;) {
    let largest = -1;
    shown.forEach(({ tile, edge }, i) => {
      if (tile.z < MAX_ZOOM && edge > SPLIT_PX && (largest < 0 || edge > (shown[largest] as { edge: number }).edge)) largest = i;
    });
    if (largest < 0) break;
    const finer = children((shown[largest] as { tile: Tile }).tile).filter(inCity).flatMap((tile) => measure(tile) ?? []);
    if (shown.length - 1 + finer.length > limit) break;
    shown.splice(largest, 1, ...finer);
  }
  return shown.map(({ tile }) => tile);
}

// The zoom whose photo pixel is closest to a device pixel, at `scale` device
// pixels to a metre, as the flat map draws.
export function zoomFor(scale: number): number {
  const z = Math.round(Math.log2(156543.03392804097 * Math.cos((GROUND_LATITUDE * Math.PI) / 180) * scale));
  return Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
}

// The tiles over a box of the ground, given as points in metres, at the zoom
// nearest a photo pixel to a device pixel at `scale` device pixels to a metre,
// or as much coarser as keeps them to `limit`, so the box is always covered whole.
export function tilesOver(points: Point[], scale: number, limit = 140): Tile[] {
  const corners = points.map(toLatLon);
  const lats = corners.map((c) => c[0]);
  const lons = corners.map((c) => c[1]);
  for (let z = zoomFor(scale); z >= MIN_ZOOM; z--) {
    const [x0, x1] = [Math.floor(columnOf(Math.min(...lons), z)), Math.floor(columnOf(Math.max(...lons), z))];
    const [y0, y1] = [Math.floor(rowOf(Math.max(...lats), z)), Math.floor(rowOf(Math.min(...lats), z))];
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > limit && z > MIN_ZOOM) continue;
    const tiles: Tile[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (inCity({ z, x, y })) tiles.push({ z, x, y });
    return tiles;
  }
  return [];
}

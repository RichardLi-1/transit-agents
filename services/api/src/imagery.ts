// Aerial photos for the map: the City of Toronto's orthoimagery, its most recent
// year, under the Open Government Licence – Toronto, which lets anyone copy,
// adapt and pass it on with credit. The display loads nothing from other sites
// (its policy is default-src 'self'), so the service fetches each tile from the
// City the first time it's asked for, keeps it on disk, and serves it from there
// after. Only tiles over the city, at the zooms the map draws, are fetched, so
// the service is no open proxy. The City's service needs no key.

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CITY = "https://gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho/MapServer/tile";

export const IMAGERY = {
  // Web Mercator tiles, 256 pixels square. The City serves them from zoom 10; at
  // 18 a pixel is about 0.43 m in Toronto, a device pixel at the map's nearest.
  minZoom: 10,
  maxZoom: 18,
  // What the City's service covers, in Web Mercator metres.
  extent: { xmin: -8869931.9307, ymin: 5395816.8838, xmax: -8802055.8621, ymax: 5451532.5866 },
  credit: "Imagery © City of Toronto, Open Government Licence – Toronto",
};

const HALF_WORLD = 20037508.342789244;

// Whether tile z/x/y is one the map may ask for: at a zoom it draws, over the city.
export function inCity(z: number, x: number, y: number): boolean {
  if (![z, x, y].every(Number.isInteger) || z < IMAGERY.minZoom || z > IMAGERY.maxZoom) return false;
  const size = (2 * HALF_WORLD) / 2 ** z;
  const left = -HALF_WORLD + x * size;
  const top = HALF_WORLD - y * size;
  const { xmin, ymin, xmax, ymax } = IMAGERY.extent;
  return left < xmax && left + size > xmin && top > ymin && top - size < ymax;
}

// A tile's type, from its first bytes: the City sends JPEG, or PNG where it's partly empty.
export function typeOf(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  return null;
}

export type Tile = { body: Uint8Array; type: string };

export class ImageryTiles {
  private readonly dir: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  // Each tile being fetched, so many asking at once fetch it once.
  private readonly pending = new Map<string, Promise<Tile | null>>();
  // Tiles the City has none of, for a while, so a gap isn't asked for again and again.
  private readonly missing = new Map<string, number>();
  // The most the cache keeps on disk. It shares the disk with the log, so past this it
  // stops keeping tiles and passes each one through instead: it never fills the disk.
  private readonly maxBytes: number;
  private kept: Promise<number> | null = null;

  constructor(
    dir: string,
    { fetcher = fetch, timeoutMs = 10_000, maxBytes = 400 * 1024 * 1024 }: { fetcher?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
  ) {
    this.dir = dir;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  // What the cache holds, counted once from disk, then added to as tiles are kept.
  private size(): Promise<number> {
    this.kept ??= total(this.dir);
    return this.kept;
  }

  // The tile, from disk or else from the City, or null where there is none.
  async get(z: number, x: number, y: number): Promise<Tile | null> {
    if (!inCity(z, x, y)) return null;
    const key = `${z}/${x}/${y}`;
    const path = join(this.dir, String(z), String(x), String(y));
    const kept = await readFile(path).catch(() => null);
    const type = kept && typeOf(kept);
    if (kept && type) return { body: kept, type };
    if ((this.missing.get(key) ?? 0) > Date.now()) return null;
    let fetching = this.pending.get(key);
    if (!fetching) {
      fetching = this.fetch(key, path).finally(() => this.pending.delete(key));
      this.pending.set(key, fetching);
    }
    return fetching;
  }

  private async fetch(key: string, path: string): Promise<Tile | null> {
    const [z, x, y] = key.split("/");
    const response = await this.fetcher(`${CITY}/${z}/${y}/${x}`, { signal: AbortSignal.timeout(this.timeoutMs) }).catch(() => null);
    const body = response?.ok ? new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0))) : null;
    const type = body && typeOf(body);
    if (!body || !type) {
      // Not there, or the City didn't answer: ask again in a few minutes.
      if (this.missing.size > 10_000) this.missing.clear();
      this.missing.set(key, Date.now() + 5 * 60_000);
      return null;
    }
    if ((await this.size()) + body.byteLength > this.maxBytes) return { body, type };
    // Written whole and then moved into place, so a reader never sees half a tile.
    await mkdir(join(path, ".."), { recursive: true });
    const partial = `${path}.${process.pid}.part`;
    await writeFile(partial, body);
    await rename(partial, path);
    this.kept = this.size().then((bytes) => bytes + body.byteLength);
    return { body, type };
  }
}

// The bytes in a folder and everything under it; none if it isn't there yet.
async function total(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isFile()) bytes += (await stat(join(entry.parentPath, entry.name)).catch(() => null))?.size ?? 0;
  }
  return bytes;
}

// Aerial photo tiles: only the city's, fetched from the City once and kept.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createApp, type Actor } from "./app.ts";
import { IMAGERY, ImageryTiles, inCity, typeOf } from "./imagery.ts";
import { Service } from "./service.ts";
import { Webhooks } from "./webhooks.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

// Downtown Toronto at zoom 14, and a tile in the lake far off.
const DOWNTOWN = [14, 4576, 5983] as const;

describe("imagery tiles", () => {
  it("are asked for only over the city, at the zooms the map draws", () => {
    assert.ok(inCity(...DOWNTOWN));
    assert.ok(inCity(10, 286, 373));
    assert.equal(inCity(9, 143, 186), false);
    assert.equal(inCity(19, 9152, 11966), false);
    assert.equal(inCity(14, 4576, 6100), false);
    assert.equal(inCity(14, 4576.5, 5983), false);
    assert.equal(IMAGERY.maxZoom, 18);
  });

  it("know a tile's type by its first bytes", () => {
    assert.equal(typeOf(JPEG), "image/jpeg");
    assert.equal(typeOf(PNG), "image/png");
    assert.equal(typeOf(new TextEncoder().encode("<html>")), null);
  });

  it("fetch each tile from the City once, keep it on disk, and serve it from there after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagery-"));
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return new Response(JPEG, { status: 200 });
    }) as unknown as typeof fetch;
    const tiles = new ImageryTiles(dir, { fetcher });
    const [first, again] = await Promise.all([tiles.get(...DOWNTOWN), tiles.get(...DOWNTOWN)]);
    assert.deepEqual(first?.type, "image/jpeg");
    assert.deepEqual(again?.body, JPEG);
    assert.deepEqual(asked, ["https://gis.toronto.ca/arcgis/rest/services/basemap/cot_ortho/MapServer/tile/14/5983/4576"]);
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, "14/4576/5983"))), JPEG);
    const fresh = new ImageryTiles(dir, { fetcher });
    assert.equal((await fresh.get(...DOWNTOWN))?.type, "image/jpeg");
    assert.equal(asked.length, 1);
  });

  it("stop keeping tiles once the cache is full, and pass them through instead", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagery-"));
    let asked = 0;
    const fetcher = (async () => {
      asked++;
      return new Response(JPEG, { status: 200 });
    }) as unknown as typeof fetch;
    const tiles = new ImageryTiles(dir, { fetcher, maxBytes: JPEG.byteLength });
    const [z, x, y] = DOWNTOWN;
    assert.equal((await tiles.get(z, x, y))?.type, "image/jpeg");
    assert.equal((await tiles.get(z, x + 1, y))?.type, "image/jpeg");
    assert.ok(existsSync(join(dir, `${z}/${x}/${y}`)));
    assert.ok(!existsSync(join(dir, `${z}/${x + 1}/${y}`)));
    // The one it couldn't keep is fetched again each time it's asked for.
    await tiles.get(z, x + 1, y);
    assert.equal(asked, 3);
  });

  it("serve nothing for a tile off the city, or one the City has none of, and don't ask again at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagery-"));
    let asked = 0;
    const fetcher = (async () => {
      asked++;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const tiles = new ImageryTiles(dir, { fetcher });
    assert.equal(await tiles.get(14, 4576, 6100), null);
    assert.equal(asked, 0);
    assert.equal(await tiles.get(...DOWNTOWN), null);
    assert.equal(await tiles.get(...DOWNTOWN), null);
    assert.equal(asked, 1);
  });

  it("give up on the City after the timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagery-"));
    const fetcher = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const tiles = new ImageryTiles(dir, { fetcher, timeoutMs: 20 });
    assert.equal(await tiles.get(...DOWNTOWN), null);
  });
});

describe("the imagery route", () => {
  const service = new Service(":memory:");
  const tokens = new Map<string, Actor>([["agent-token", { role: "agent", name: "lead" }]]);
  const imagery = { get: async (z: number, x: number, y: number) => (inCity(z, x, y) ? { body: JPEG, type: "image/jpeg" } : null) };
  const app = createApp({ service, webhooks: new Webhooks(service), tokens, access: "token", imagery });

  it("serves a tile to anyone, as the map's other images are, for the browser to keep", async () => {
    const response = await app.request("/v1/tiles/imagery/14/4576/5983");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.match(response.headers.get("cache-control") ?? "", /max-age=\d+/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), JPEG);
  });

  it("has nothing off the city, or for what isn't a tile", async () => {
    assert.equal((await app.request("/v1/tiles/imagery/14/4576/6100")).status, 404);
    assert.equal((await app.request("/v1/tiles/imagery/14/abc/5983")).status, 404);
    const without = createApp({ service, webhooks: new Webhooks(service), tokens, access: "token" });
    assert.equal((await without.request("/v1/tiles/imagery/14/4576/5983")).status, 404);
  });
});

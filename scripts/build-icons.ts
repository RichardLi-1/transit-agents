// Draws the display's app icons: the study's magenta line on white, as a transit
// map draws a line, with a stop at each end. No text, so it reads at any size.
//
// Usage: node scripts/build-icons.ts
// Writes apps/display/public/icons: icon-192.png and icon-512.png, a white tile
// with room around it, and maskable-512.png, white to every edge with the line
// inside the circle a mask may cut to.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dirname, "../apps/display/public/icons");

type Point = [number, number];
type Colour = [number, number, number, number];

const WHITE: Colour = [255, 255, 255, 255];
const MAGENTA: Colour = [176, 52, 136, 255];
// A faint edge, so a white tile shows on white.
const EDGE: Colour = [233, 233, 233, 255];
const CLEAR: Colour = [0, 0, 0, 0];

// The line, in a unit square: along, a bend at 45 degrees, then up, as the
// Ontario Line runs east and turns north.
const LINE: Point[] = [
  [0.16, 0.79],
  [0.48, 0.79],
  [0.84, 0.43],
  [0.84, 0.21],
];
const WIDTH = 0.13;
const STOP = 0.105;
const STOP_RING = 0.05;

function toSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const length = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

// Inside a rounded square of half-size `half` and corner `radius`, centred at 0.5:
// below zero, and how far from its edge.
function roundedSquare([x, y]: Point, half: number, radius: number): number {
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// The colour at a point of the icon. `mark` places the line's unit square in the
// icon's, at an offset and a scale.
function colourAt(point: Point, tile: { half: number; radius: number; edge: number } | null, mark: { at: number; scale: number }): Colour {
  if (tile) {
    const inside = roundedSquare(point, tile.half, tile.radius);
    if (inside > 0) return CLEAR;
    if (inside > -tile.edge) return EDGE;
  }
  const p: Point = [(point[0] - mark.at) / mark.scale, (point[1] - mark.at) / mark.scale];
  for (const end of [LINE[0] as Point, LINE.at(-1) as Point]) {
    const distance = Math.hypot(p[0] - end[0], p[1] - end[1]);
    if (distance <= STOP - STOP_RING) return WHITE;
    if (distance <= STOP) return MAGENTA;
  }
  for (let i = 1; i < LINE.length; i++) if (toSegment(p, LINE[i - 1] as Point, LINE[i] as Point) <= WIDTH / 2) return MAGENTA;
  return WHITE;
}

// Each pixel is the average of a grid of samples, so edges are smooth.
function draw(size: number, tile: Parameters<typeof colourAt>[1], mark: Parameters<typeof colourAt>[2]): Uint8Array {
  const SAMPLES = 4;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Colour weighted by how opaque each sample is, so a clear corner adds no colour.
      const sum: Colour = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [r, g, b, a] = colourAt([(x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size], tile, mark);
          sum[0] += r * a;
          sum[1] += g * a;
          sum[2] += b * a;
          sum[3] += a;
        }
      }
      const at = (y * size + x) * 4;
      const alpha = sum[3];
      pixels.set(alpha ? [sum[0] / alpha, sum[1] / alpha, sum[2] / alpha].map(Math.round) : [0, 0, 0], at);
      pixels[at + 3] = Math.round(alpha / SAMPLES ** 2);
    }
  }
  return pixels;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// An 8-bit RGBA PNG.
function png(size: number, pixels: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", new Uint8Array())]);
}

mkdirSync(OUT, { recursive: true });
// A tile with the room around it that app icons have, its line well inside it.
const TILE = { half: 0.41, radius: 0.185, edge: 0.006 };
for (const size of [192, 512]) writeFileSync(join(OUT, `icon-${size}.png`), png(size, draw(size, TILE, { at: 0.17, scale: 0.66 })));
// The line within the middle 60%, inside the circle of 80% any mask keeps.
writeFileSync(join(OUT, "maskable-512.png"), png(512, draw(512, null, { at: 0.2, scale: 0.6 })));
console.log("icons written to", OUT);

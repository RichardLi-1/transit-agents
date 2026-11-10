// The glass over the map, blurred by the map itself. A pane's CSS backdrop-filter
// makes the browser blur what's under it again on every frame the map moves, and
// with a dozen panes over the map that is the GPU's biggest cost in a drag. So on
// the Map tab the renderer draws the map a second time, at a quarter of its
// resolution, blurs that under each pane, and lays it inside the pane's round or
// squircle corners as it draws the map (blur.ts); the pane above keeps its fill,
// rim and sheen, and the browser blurs nothing. This file is the maths the page
// and the renderer share.

export type Rgb = [number, number, number];

// A CSS frost, such as blur(8px) saturate(200%) brightness(1.06).
export type Frost = { blur: number; saturate: number; brightness: number };

// A pane in CSS pixels from the map canvas's top left, its corner radii clockwise
// from the top left, its corners' exponent (2 a quarter circle, 4 a squircle), its
// frost, and its own opacity, through which the map shows unblurred, as it would
// under a translucent pane with a backdrop-filter.
export type GlassRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  radii: [number, number, number, number];
  corner: number;
  frost: Frost;
  opacity: number;
};

// The panes that float over the map as glass, by the frost styles.css gives them.
// Not the engagement cards: they move with the map, and turn near-opaque while it
// moves; nor menus and toasts, which lie over words as often as over the map.
export const GLASS_PANES = [
  { selector: ".rail", frost: "--frost" },
  { selector: ".chat", frost: "--frost" },
  { selector: ".workspace-head .tabs", frost: "--frost-chip" },
  { selector: '.app[data-tab="map"] .workspace-head h1', frost: "--frost-chip" },
  { selector: ".map-toolbar .tool", frost: "--frost-chip" },
  { selector: ".map-search", frost: "--frost-chip" },
  { selector: ".layers-panel", frost: "--frost-chip" },
  { selector: ".map-buttons", frost: "--frost-chip" },
  { selector: ".map-notes", frost: "--frost-chip" },
  { selector: ".time", frost: "--frost-chip" },
] as const;

const number = (text: string) => {
  const value = parseFloat(text);
  return text.trim().endsWith("%") ? value / 100 : value;
};

// A frost token's blur, saturation and brightness, or null for none or no blur.
export function parseFrost(text: string): Frost | null {
  const blur = /blur\(\s*([\d.]+)px\s*\)/.exec(text);
  if (!blur) return null;
  const saturate = /saturate\(\s*([\d.]+%?)\s*\)/.exec(text);
  const brightness = /brightness\(\s*([\d.]+%?)\s*\)/.exec(text);
  return {
    blur: parseFloat(blur[1] as string),
    saturate: saturate ? number(saturate[1] as string) : 1,
    brightness: brightness ? number(brightness[1] as string) : 1,
  };
}

// A colour as computed styles give it, rgb() or #rrggbb, in 0 to 1.
export function parseRgb(text: string): Rgb | null {
  const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(text.trim());
  if (hex) return [parseInt(hex[1] as string, 16) / 255, parseInt(hex[2] as string, 16) / 255, parseInt(hex[3] as string, 16) / 255];
  return null;
}

// A computed corner radius, such as "26px", "999px", "50%" or "10px 20px", in pixels.
// An elliptical corner takes its smaller radius.
export function parseRadius(text: string, width: number, height: number): number {
  const [h = "0", v = h] = text.trim().split(/\s+/);
  const along = (part: string, side: number) => (part.endsWith("%") ? (parseFloat(part) / 100) * side : parseFloat(part) || 0);
  return Math.max(0, Math.min(along(h, width), along(v, height)));
}

// Radii too large for their box shrink together, as CSS shrinks them, so 999px on
// a 40px button is a 20px circle. Clockwise from the top left.
export function fitRadii(radii: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const [tl, tr, br, bl] = radii;
  const scale = Math.min(1, width / (tl + tr || 1), width / (bl + br || 1), height / (tl + bl || 1), height / (tr + br || 1));
  return [tl * scale, tr * scale, br * scale, bl * scale];
}

// A computed corner-shape as the exponent of its superellipse, |x|^n + |y|^n = 1
// in the corner's box: round is 2, squircle (superellipse(2)) is 4, and
// superellipse(K) is 2^K. Square and bevel are kept just short of their extremes,
// and the concave shapes, which no pane has, are drawn round.
export function parseCorner(text: string): number {
  const shape = text.trim().split(/\s+(?![^(]*\))/)[0] ?? "";
  const k = /^superellipse\(\s*(-?[\d.]+|infinity)\s*\)$/.exec(shape)?.[1];
  const exponent = shape === "squircle" ? 4 : shape === "square" || k === "infinity" ? 64 : shape === "bevel" ? 1 : k !== undefined ? 2 ** Number(k) : 2;
  return Number.isFinite(exponent) && exponent >= 1 ? Math.min(Math.max(exponent, 1.5), 64) : 2;
}

export type Box = { left: number; top: number; width: number; height: number };

// A pane's border box on the page, as a rect on the canvas, whose top left may be
// off the window: the map reaches past its left edge.
export function rectOf(box: Box, canvas: Pick<Box, "left" | "top">, radii: [number, number, number, number], frost: Frost, opacity = 1, corner = 2): GlassRect {
  return {
    x: box.left - canvas.left,
    y: box.top - canvas.top,
    width: box.width,
    height: box.height,
    radii: fitRadii(radii, box.width, box.height),
    corner,
    frost,
    opacity,
  };
}

// A pane in the canvas's device pixels, with WebGL's origin at the bottom left: its
// edges, its centre and half size, and its radii in the order the shader's
// rounded box takes them (top right, bottom right, top left, bottom left).
export type DeviceRect = {
  left: number;
  bottom: number;
  right: number;
  top: number;
  center: [number, number];
  half: [number, number];
  radii: [number, number, number, number];
};

export function deviceRect(rect: GlassRect, ratio: number, canvasHeight: number): DeviceRect {
  const left = rect.x * ratio;
  const right = (rect.x + rect.width) * ratio;
  const top = canvasHeight - rect.y * ratio;
  const bottom = canvasHeight - (rect.y + rect.height) * ratio;
  const [tl, tr, br, bl] = rect.radii.map((r) => r * ratio) as [number, number, number, number];
  return { left, bottom, right, top, center: [(left + right) / 2, (bottom + top) / 2], half: [(right - left) / 2, (top - bottom) / 2], radii: [tr, br, tl, bl] };
}

// The signed distance, in pixels, from p to a box at the origin with half size b,
// negative inside, its corners superellipses of exponent n: the length past the
// corner's inner box in the n-norm, over that norm's gradient, so the edge is a
// pixel wide all round. At n = 2 it is the exact distance to a quarter circle. The
// composite shader's cornerBox, to the letter.
export function cornerBox(p: [number, number], b: [number, number], radii: [number, number, number, number], n = 2): number {
  const pair = p[0] > 0 ? [radii[0], radii[1]] : [radii[2], radii[3]];
  const r = (p[1] > 0 ? pair[0] : pair[1]) as number;
  const qx = Math.abs(p[0]) - b[0] + r;
  const qy = Math.abs(p[1]) - b[1] + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const m = Math.max(ox, oy);
  if (m <= 0) return Math.max(qx, qy) - r;
  const norm = m * ((ox / m) ** n + (oy / m) ** n) ** (1 / n);
  const slope = Math.hypot((ox / norm) ** (n - 1), (oy / norm) ** (n - 1));
  return (norm - r) / slope;
}

export const CORNER_BOX_GLSL = `
float cornerBox(vec2 p, vec2 b, vec4 r, float n) {
  r.xy = (p.x > 0.0) ? r.xy : r.zw;
  r.x = (p.y > 0.0) ? r.x : r.y;
  vec2 q = abs(p) - b + r.x;
  vec2 o = max(q, 0.0);
  float m = max(o.x, o.y);
  if (m <= 0.0) return max(q.x, q.y) - r.x;
  vec2 u = o / m;
  float norm = m * pow(pow(u.x, n) + pow(u.y, n), 1.0 / n);
  return (norm - r.x) / length(pow(o / norm, vec2(n - 1.0)));
}`;

// How many device pixels a texel of the blur spans: two CSS pixels, so a quarter
// of the canvas's width at a ratio of 2. Always even, so each texel averages whole
// pairs of pixels.
export const lowResFactor = (ratio: number) => Math.max(2, 2 * Math.round(ratio));

// A CSS blur's standard deviation in texels of the blur, less what shrinking the
// map and stretching the blur back already soften.
export function lowSigma(blurCss: number, ratio: number, factor: number): number {
  const sigma = (blurCss * ratio) / factor;
  return Math.sqrt(Math.max(sigma * sigma - 0.25, 0.25));
}

export const MAX_TAPS = 24;

// A Gaussian as a few texture reads: the centre, then pairs of texels read as one,
// between them, so the GPU's filtering does half the sums. Weights for each side.
export function gaussian(sigma: number): { offsets: number[]; weights: number[] } {
  const radius = Math.min(Math.max(1, Math.ceil(sigma * 3)), 2 * (MAX_TAPS - 1));
  const raw = Array.from({ length: radius + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = raw.reduce((sum, w, i) => sum + (i ? 2 * w : w), 0);
  const w = raw.map((v) => v / total);
  const offsets = [0];
  const weights = [w[0] as number];
  for (let i = 1; i <= radius; i += 2) {
    const a = w[i] as number;
    const b = w[i + 1] ?? 0;
    offsets.push((i * a + (i + 1) * b) / (a + b));
    weights.push(a + b);
  }
  return { offsets, weights };
}

// The glass the map blurs itself: the panes it measures, their rects in the
// canvas's pixels, the shape it cuts them to, and the blur it gives them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cornerBox, deviceRect, fitRadii, gaussian, GLASS_PANES, lowResFactor, lowSigma, MAX_TAPS, parseCorner, parseFrost, parseRadius, parseRgb, rectOf } from "./glass.ts";

const near = (actual: number, expected: number, within = 1e-6) => assert.ok(Math.abs(actual - expected) <= within, `${actual} is not within ${within} of ${expected}`);

describe("the frost", () => {
  it("reads the frost tokens, light and dark, and none for the solid panes of more contrast", () => {
    assert.deepEqual(parseFrost("blur(8px) saturate(200%) brightness(1.06)"), { blur: 8, saturate: 2, brightness: 1.06 });
    assert.deepEqual(parseFrost(" blur(6px) saturate(170%) brightness(0.92)"), { blur: 6, saturate: 1.7, brightness: 0.92 });
    assert.deepEqual(parseFrost("blur(24px) saturate(1.8)"), { blur: 24, saturate: 1.8, brightness: 1 });
    assert.equal(parseFrost("none"), null);
    assert.equal(parseFrost("saturate(200%)"), null);
  });

  it("reads the page's ground as computed styles give it", () => {
    assert.deepEqual(parseRgb("rgb(242, 241, 238)"), [242 / 255, 241 / 255, 238 / 255]);
    assert.deepEqual(parseRgb("rgba(22, 22, 24, 1)"), [22 / 255, 22 / 255, 24 / 255]);
    assert.deepEqual(parseRgb("#161618"), [0x16 / 255, 0x16 / 255, 0x18 / 255]);
    assert.equal(parseRgb("canvas"), null);
  });
});

describe("a pane's rect", () => {
  it("reads computed radii in pixels, percentages and ellipses included", () => {
    assert.equal(parseRadius("26px", 392, 980), 26);
    assert.equal(parseRadius("50%", 40, 40), 20);
    assert.equal(parseRadius("10px 20px", 100, 100), 10);
    assert.equal(parseRadius("0px", 10, 10), 0);
  });

  it("shrinks radii too large for the box together, as CSS does, so a pill is round at its ends", () => {
    assert.deepEqual(fitRadii([999, 999, 999, 999], 40, 40), [20, 20, 20, 20]);
    assert.deepEqual(fitRadii([999, 999, 999, 999], 200, 44), [22, 22, 22, 22]);
    assert.deepEqual(fitRadii([32, 32, 32, 32], 392, 980), [32, 32, 32, 32]);
    assert.deepEqual(fitRadii([0, 0, 26, 26], 300, 30), [0, 0, 26, 26]);
    assert.deepEqual(fitRadii([0, 0, 26, 26], 300, 13), [0, 0, 13, 13]);
  });

  it("is placed from the canvas's top left, which lies off the window to the left", () => {
    const frost = { blur: 8, saturate: 2, brightness: 1.06 };
    const rect = rectOf({ left: 10, top: 10, width: 68, height: 980 }, { left: -324, top: 0 }, [32, 32, 32, 32], frost, 1, 4);
    assert.deepEqual(rect, { x: 334, y: 10, width: 68, height: 980, radii: [32, 32, 32, 32], corner: 4, frost, opacity: 1 });
  });

  it("goes to device pixels with WebGL's origin at the bottom left, its radii in the shader's order", () => {
    const frost = { blur: 6, saturate: 2, brightness: 1.06 };
    const rect = { x: 100, y: 20, width: 40, height: 30, radii: [1, 2, 3, 4] as [number, number, number, number], corner: 2, frost, opacity: 1 };
    const box = deviceRect(rect, 2, 2000);
    assert.deepEqual([box.left, box.right, box.top, box.bottom], [200, 280, 1960, 1900]);
    assert.deepEqual(box.center, [240, 1930]);
    assert.deepEqual(box.half, [40, 30]);
    // Top right, bottom right, top left, bottom left: CSS's 2, 3, 1 and 4, doubled.
    assert.deepEqual(box.radii, [4, 6, 2, 8]);
  });
});

describe("the shape the blur is cut to", () => {
  const half: [number, number] = [100, 50];
  const radii: [number, number, number, number] = [20, 20, 20, 20];

  it("is the box's edge along its sides, negative inside and positive out", () => {
    near(cornerBox([0, 50], half, radii), 0);
    near(cornerBox([100, 0], half, radii), 0);
    near(cornerBox([0, 0], half, radii), -50);
    near(cornerBox([0, 53], half, radii), 3);
    near(cornerBox([0, 53], half, radii, 4), 3);
  });

  it("rounds a corner as a quarter circle when round, the exact distance to it", () => {
    // The corner's centre is at (80, 30).
    const out = Math.SQRT1_2 * 25;
    near(cornerBox([80 + out, 30 + out], half, radii), 5);
    near(cornerBox([80 + Math.SQRT1_2 * 20, 30 + Math.SQRT1_2 * 20], half, radii), 0);
  });

  it("follows a squircle's |x|⁴ + |y|⁴ = r⁴ when squircle, so its corners reach further out than a circle's", () => {
    const corner = 20 / 2 ** 0.25;
    near(cornerBox([80 + corner, 30 + corner], half, radii, 4), 0, 1e-9);
    // Where the circle's corner is, a squircle still covers.
    assert.ok(cornerBox([80 + Math.SQRT1_2 * 20, 30 + Math.SQRT1_2 * 20], half, radii, 4) < -1);
    // Its edge is about a pixel wide everywhere, so it smooths over a pixel there too.
    const step = cornerBox([80 + corner + Math.SQRT1_2, 30 + corner + Math.SQRT1_2], half, radii, 4);
    near(step, 1, 0.05);
  });

  it("reads each pane's corner shape, round or squircle, as the browser draws it", () => {
    assert.equal(parseCorner("round"), 2);
    assert.equal(parseCorner(""), 2);
    assert.equal(parseCorner("squircle"), 4);
    assert.equal(parseCorner("superellipse(2)"), 4);
    assert.equal(parseCorner("superellipse(3)"), 8);
    assert.equal(parseCorner("superellipse(infinity)"), 64);
    assert.equal(parseCorner("square"), 64);
    assert.equal(parseCorner("bevel"), 1.5);
    assert.equal(parseCorner("scoop"), 2);
    assert.equal(parseCorner("squircle round squircle round"), 4);
  });
});

describe("the blur", () => {
  it("works on a texel to every two CSS pixels, an even number of device pixels", () => {
    assert.equal(lowResFactor(1), 2);
    assert.equal(lowResFactor(2), 4);
    assert.equal(lowResFactor(1.5), 4);
    assert.equal(lowResFactor(3), 6);
  });

  it("takes the CSS blur's deviation in texels, less the softening the small map adds", () => {
    near(lowSigma(8, 2, 4), Math.sqrt(15.75));
    near(lowSigma(6, 2, 4), Math.sqrt(8.75));
    near(lowSigma(0.5, 1, 2), 0.5);
  });

  it("weighs its texture reads as a Gaussian that sums to one, its spread the deviation asked for", () => {
    for (const sigma of [1.5, 3, 4, 8]) {
      const { offsets, weights } = gaussian(sigma);
      assert.equal(offsets[0], 0);
      assert.ok(offsets.length <= MAX_TAPS);
      assert.ok(offsets.every((o, i) => i === 0 || o > (offsets[i - 1] as number)));
      near(weights.reduce((sum, w, i) => sum + (i ? 2 * w : w), 0), 1, 1e-9);
      const variance = weights.reduce((sum, w, i) => sum + 2 * w * (offsets[i] as number) ** 2, 0);
      near(Math.sqrt(variance), sigma, sigma * 0.05);
    }
    assert.equal(gaussian(4).offsets.length, 7);
  });
});

describe("which panes the map blurs", () => {
  const css = readFileSync(join(import.meta.dirname, "../styles.css"), "utf8");
  const selectors = GLASS_PANES.map(({ selector }) => selector);

  it("are the panes that float over the map as glass, by the frost each has, all but the cards that move with it", () => {
    const glass = css.slice(css.indexOf("@supports ((-webkit-backdrop-filter"));
    const rule = (token: string) => {
      const match = new RegExp(`\\n  ([^{}]+)\\{\\n    background: var\\(--glass[-a-z]*\\);\\n    -webkit-backdrop-filter: var\\(${token}\\);`).exec(glass);
      return (match?.[1] ?? "").split(",").map((s) => s.trim().replace("::before", ""));
    };
    const byToken = (token: string) => GLASS_PANES.filter((pane) => pane.frost === token).map((pane) => pane.selector);
    assert.deepEqual(rule("--frost").sort(), byToken("--frost").sort());
    assert.deepEqual(rule("--frost-chip").filter((s) => s !== ".need").sort(), byToken("--frost-chip").sort());
  });

  it("lose their CSS blur once marked, and only they do", () => {
    const marked = /:is\(([^)]+)\)\[data-gpu-glass\] \{/.exec(css)?.[1]?.split(",").map((s) => s.trim());
    assert.deepEqual([".rail", ...(marked ?? [])].sort(), [...selectors].sort());
    assert.match(css, /\.rail\[data-gpu-glass\]::before,/);
  });

  it("keep their blur while the map moves, as the others pause theirs", () => {
    assert.match(css, /:root\[data-moving\]\s+:is\([^)]*\.need[^)]*\.toast[^)]*\):not\(\[data-gpu-glass\]\)/);
    assert.match(css, /:root\[data-moving\] \.rail:not\(\[data-gpu-glass\]\)::before/);
  });
});

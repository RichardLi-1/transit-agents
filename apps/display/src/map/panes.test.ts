// The page's side of the glass the map blurs: which panes it measures, and when a
// pane gives up its CSS blur, with a page made of stand-ins.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { GlassRect, Rgb } from "./glass.ts";
import { GlassPanes, MARK, measure } from "./panes.ts";

type Style = Record<string, string>;
type Fake = { box: { left: number; top: number; width: number; height: number }; style: Style; attributes: Map<string, string> };

const pane = (left: number, top: number, width: number, height: number, style: Style = {}) => ({
  box: { left, top, width, height },
  style: { borderTopLeftRadius: "999px", borderTopRightRadius: "999px", borderBottomRightRadius: "999px", borderBottomLeftRadius: "999px", opacity: "1", visibility: "visible", "corner-shape": "round", ...style },
  attributes: new Map<string, string>(),
});

const element = (fake: Fake) => ({
  getBoundingClientRect: () => fake.box,
  setAttribute: (name: string, value: string) => fake.attributes.set(name, value),
  removeAttribute: (name: string) => fake.attributes.delete(name),
  fake,
});

// A page: its panes by selector, the canvas, the root's frost tokens and the ground.
function page(panes: Record<string, Fake[]>, { frost = "blur(8px) saturate(200%) brightness(1.06)", chip = "blur(6px) saturate(200%) brightness(1.06)", plain = false } = {}) {
  const canvas = element(pane(-324, 0, 1924, 1000));
  const root = { style: { "--frost": frost, "--frost-chip": chip } };
  const body = { style: { backgroundColor: "rgb(242, 241, 238)" } };
  const elements = new Map(Object.entries(panes).map(([selector, fakes]) => [selector, fakes.map(element)]));
  const doc = {
    documentElement: root,
    body,
    querySelectorAll: (selector: string) => elements.get(selector) ?? [],
    querySelector: () => null,
    defaultView: { matchMedia: () => ({ matches: plain, addEventListener() {}, removeEventListener() {} }) },
  };
  const styleOf = (target: unknown) => {
    const style = (target as { style?: Style; fake?: Fake }).fake?.style ?? (target as { style: Style }).style;
    return { ...style, getPropertyValue: (name: string) => style[name] ?? "" };
  };
  return { doc: doc as unknown as Document, canvas: canvas as unknown as Element, styleOf, elements };
}

const saved: Record<string, unknown> = {};
let frames: (() => void)[] = [];
// How many times a size was watched afresh: each reports at once, and would measure again.
let observed = 0;
const flush = () => {
  const run = frames;
  frames = [];
  for (const frame of run) frame();
};

beforeEach(() => {
  for (const name of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "MutationObserver"]) saved[name] = (globalThis as Record<string, unknown>)[name];
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = (callback: () => void) => frames.push(callback);
  g.cancelAnimationFrame = () => {};
  observed = 0;
  g.ResizeObserver = class {
    observe() {
      observed++;
    }
    unobserve() {}
    disconnect() {}
  };
  g.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[name] = value;
  frames = [];
});

describe("measuring the glass panes", () => {
  it("measures each pane shown, from the canvas's top left, with its frost, corners and opacity", () => {
    const { doc, canvas, styleOf } = page({
      ".chat": [pane(1198, 10, 392, 980, { borderTopLeftRadius: "32px", borderTopRightRadius: "32px", borderBottomRightRadius: "32px", borderBottomLeftRadius: "32px", "corner-shape": "squircle" })],
      ".map-toolbar .tool": [pane(98, 84, 40, 40), pane(146, 84, 40, 40, { opacity: "0.55" })],
    });
    globalThis.getComputedStyle = styleOf as unknown as typeof getComputedStyle;
    const { rects, ground } = measure(doc, canvas);
    assert.deepEqual(ground, [242 / 255, 241 / 255, 238 / 255]);
    assert.deepEqual(
      rects.map((r) => [r.x, r.y, r.width, r.height, r.radii[0], r.corner, r.frost.blur, r.opacity]),
      [
        [1522, 10, 392, 980, 32, 4, 8, 1],
        [422, 84, 40, 40, 20, 2, 6, 1],
        [470, 84, 40, 40, 20, 2, 6, 0.55],
      ],
    );
  });

  it("skips what isn't shown: the search while hidden, and anything hidden from view", () => {
    const { doc, canvas, styleOf } = page({
      ".map-search": [pane(0, 0, 0, 0)],
      ".layers-panel": [pane(98, 140, 120, 40, { visibility: "hidden" })],
      ".map-buttons": [pane(1150, 84, 42, 116)],
    });
    globalThis.getComputedStyle = styleOf as unknown as typeof getComputedStyle;
    assert.deepEqual(
      measure(doc, canvas).rects.map((r) => r.x),
      [1474],
    );
  });

  it("measures nothing where the frost is none, as with more contrast", () => {
    const { doc, canvas, styleOf } = page({ ".chat": [pane(1198, 10, 392, 980)], ".map-buttons": [pane(1150, 84, 42, 116)] }, { frost: "none", chip: "none" });
    globalThis.getComputedStyle = styleOf as unknown as typeof getComputedStyle;
    assert.deepEqual(measure(doc, canvas).rects, []);
  });
});

describe("handing the panes to the map", () => {
  const setup = (options: { plain?: boolean } = {}) => {
    const built = page({ ".chat": [pane(1198, 10, 392, 980)], ".map-buttons": [pane(1150, 84, 42, 116)] }, options);
    globalThis.getComputedStyle = built.styleOf as unknown as typeof getComputedStyle;
    const sent: { rects: GlassRect[]; ground: Rgb; version: number }[] = [];
    const glass = new GlassPanes(built.doc);
    glass.attach(built.canvas, (rects, ground, version) => {
      sent.push({ rects, ground, version });
      return true;
    });
    const marked = () => [...built.elements.values()].flat().filter((e) => e.fake.attributes.has(MARK)).length;
    return { glass, sent, marked, built };
  };

  it("sends the panes once the map shows, and marks them only when the map says it has drawn them", () => {
    const { glass, sent, marked } = setup();
    glass.setShown(true);
    flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.rects.length, 2);
    assert.equal(marked(), 0);
    glass.drawn((sent[0]?.version ?? 0) - 1);
    assert.equal(marked(), 0, "a stale version marks nothing");
    glass.drawn(sent[0]?.version ?? 0);
    assert.equal(marked(), 2);
  });

  it("sends nothing again while the panes stay where they are, and watches each only once", () => {
    const { glass, sent } = setup();
    glass.setShown(true);
    flush();
    const watched = observed;
    glass.setShown(true);
    flush();
    assert.equal(sent.length, 1);
    // The canvas and the two panes; watching them again would measure again, every frame.
    assert.equal(watched, 3);
    assert.equal(observed, watched);
  });

  it("gives the browser the blur back before the map stops, behind another tab", () => {
    const { glass, sent, marked } = setup();
    glass.setShown(true);
    flush();
    glass.drawn(sent[0]?.version ?? 0);
    glass.setShown(false);
    flush();
    assert.equal(marked(), 0);
    assert.deepEqual(sent.at(-1)?.rects, []);
  });

  it("leaves the blur to the browser for anyone who asks for less transparency or more contrast", () => {
    const { glass, sent, marked } = setup({ plain: true });
    glass.setShown(true);
    flush();
    glass.drawn(sent.at(-1)?.version ?? 0);
    assert.equal(marked(), 0);
    assert.ok(sent.every((s) => s.rects.length === 0));
  });
});

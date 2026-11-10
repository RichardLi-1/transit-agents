// Measures the glass panes over the map and gives them to the renderer, which
// blurs the map under them itself (glass.ts). A pane loses its CSS backdrop-filter,
// by data-gpu-glass, only once the renderer says it has drawn that pane's blur, so
// no frame shows a pane unblurred; and gets it back the moment the map stops
// drawing it: behind another tab, on the flat map, or for anyone who asks for less
// transparency, more contrast or forced colours, whose panes are solid anyway.
// Panes move only when the layout does, so they're measured then, not every frame.
import { GLASS_PANES, parseCorner, parseFrost, parseRadius, parseRgb, rectOf, type GlassRect, type Rgb } from "./glass.ts";

export type SendGlass = (rects: GlassRect[], ground: Rgb, version: number) => boolean;

export const MARK = "data-gpu-glass";

const PLAIN = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"];
// What changes size as panes inside it come, go or move.
const CONTAINERS = [".app", ".workspace-head", ".map-top", ".map-foot"];
// What changes often and moves no pane: the chat's words and the cards on the map.
const QUIET = ".chat *, .needs, .needs *, .toasts, .toasts *";

// Each pane on the page now, with its rect on the canvas.
export function measure(doc: Document, canvas: Element): { rects: GlassRect[]; panes: Element[]; ground: Rgb } {
  const root = getComputedStyle(doc.documentElement);
  const frosts = { "--frost": parseFrost(root.getPropertyValue("--frost")), "--frost-chip": parseFrost(root.getPropertyValue("--frost-chip")) };
  const origin = canvas.getBoundingClientRect();
  const rects: GlassRect[] = [];
  const panes: Element[] = [];
  for (const { selector, frost: token } of GLASS_PANES) {
    const frost = frosts[token];
    if (!frost) continue;
    for (const pane of doc.querySelectorAll(selector)) {
      const box = pane.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = getComputedStyle(pane);
      if (style.visibility === "hidden") continue;
      const radius = (corner: string) => parseRadius(corner, box.width, box.height);
      const radii: GlassRect["radii"] = [radius(style.borderTopLeftRadius), radius(style.borderTopRightRadius), radius(style.borderBottomRightRadius), radius(style.borderBottomLeftRadius)];
      rects.push(rectOf(box, origin, radii, frost, Number(style.opacity) || 0, parseCorner(style.getPropertyValue("corner-shape"))));
      panes.push(pane);
    }
  }
  return { rects, panes, ground: parseRgb(getComputedStyle(doc.body).backgroundColor) ?? [1, 1, 1] };
}

export class GlassPanes {
  private canvas: Element | null = null;
  private send: SendGlass | null = null;
  private shown = false;
  private version = 0;
  private sent = "";
  private measured: Element[] = [];
  private marked: Element[] = [];
  private frame = 0;
  private stop: (() => void) | null = null;
  private resizes: ResizeObserver | null = null;

  private readonly doc: Document;

  constructor(doc: Document = document) {
    this.doc = doc;
  }

  // Whether the map is what lies under the panes, sharp and drawn by the GPU.
  setShown(shown: boolean) {
    this.shown = shown;
    this.schedule();
  }

  private wanted() {
    const view = this.doc.defaultView;
    return this.shown && Boolean(this.canvas && this.send) && !PLAIN.some((query) => view?.matchMedia(query).matches);
  }

  attach(canvas: Element, send: SendGlass): () => void {
    this.canvas = canvas;
    this.send = send;
    const view = this.doc.defaultView as Window;
    const schedule = () => this.schedule();
    this.resizes = new ResizeObserver(schedule);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !(record.target instanceof Element && record.target.matches(QUIET)))) schedule();
    });
    mutations.observe(this.doc.querySelector(".app") ?? this.doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden", "open", "data-tab"] });
    // Light or dark: the frost and the ground change with it.
    mutations.observe(this.doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const queries = PLAIN.map((query) => view.matchMedia(query));
    for (const query of queries) query.addEventListener("change", schedule);
    this.stop = () => {
      mutations.disconnect();
      for (const query of queries) query.removeEventListener("change", schedule);
    };
    this.schedule();
    return () => this.detach();
  }

  private detach() {
    this.stop?.();
    this.resizes?.disconnect();
    this.watched.clear();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.unmark();
    this.canvas = null;
    this.send = null;
  }

  private schedule() {
    if (!this.frame && this.canvas) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.update();
      });
    }
  }

  private unmark() {
    for (const pane of this.marked) pane.removeAttribute(MARK);
    this.marked = [];
  }

  // Watches these for a change of size, and nothing else. Only what's new is
  // watched afresh, as a new watch reports at once, which would measure again.
  private watched = new Set<Element>();
  private watch(elements: Element[]) {
    const now = new Set(elements);
    for (const element of this.watched) if (!now.has(element)) this.resizes?.unobserve(element);
    for (const element of now) if (!this.watched.has(element)) this.resizes?.observe(element);
    this.watched = now;
  }

  private update() {
    const { canvas, send } = this;
    if (!canvas || !send) return;
    if (!this.wanted()) {
      // The browser blurs again before the map stops, so no frame goes unblurred.
      this.unmark();
      this.measured = [];
      if (this.sent !== "none" && send([], [1, 1, 1], ++this.version)) this.sent = "none";
      return;
    }
    const { rects, panes, ground } = measure(this.doc, canvas);
    this.watch([canvas, ...panes, ...CONTAINERS.flatMap((selector) => [...this.doc.querySelectorAll(selector)])]);
    const key = JSON.stringify([rects, ground]);
    if (key === this.sent) return;
    this.measured = panes;
    if (send(rects, ground, ++this.version)) this.sent = key;
  }

  // The renderer has drawn the blur under the panes of this version.
  drawn(version: number) {
    if (version !== this.version || !this.wanted()) return;
    for (const pane of this.marked) if (!this.measured.includes(pane)) pane.removeAttribute(MARK);
    for (const pane of this.measured) pane.setAttribute(MARK, "");
    this.marked = this.measured;
  }
}

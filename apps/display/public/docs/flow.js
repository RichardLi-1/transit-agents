// The diagram on /docs/: a planner's question goes to the lead, which fans it out to
// up to four specialists at once; each picks up a skill and calls the service's tools;
// cited pages come back and gather into one short answer, which a planner decides on.
// Drawn here, wide on a large screen and tall on a phone, and played once, about seven
// seconds, when it first comes into view. With reduced motion it shows the end, still.
// Its words are for the eye only: the figure's caption says it all to a screen reader.

const NS = "http://www.w3.org/2000/svg";
const SKILLS = ["ttc-standards", "gtfs-analyst", "gis-analyst", "consultation"];
// Where each specialist's evidence comes from: a page of a plan, or a dataset.
const CITES = ["p. 115", "p. 14", "dataset", "p. 116"];
const TOOLS = ["read_page", "search_sources", "list_rules", "record_figure"];

const figure = document.getElementById("flow");
const replay = figure.querySelector(".replay");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const roomy = matchMedia("(min-width: 860px)");

// Easing: a spring, overshooting and settling, where the browser can draw one.
const springs = CSS.supports("animation-timing-function", "linear(0, 1)");
function spring(damping) {
  if (!springs) return "cubic-bezier(.34, 1.56, .64, 1)";
  const w = 11;
  const wd = w * Math.sqrt(1 - damping * damping);
  const points = [];
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    points.push(1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t)));
  }
  points[64] = 1;
  return `linear(${points.map((p) => +p.toFixed(4)).join(", ")})`;
}
const BOUNCE = spring(0.42);
const SPRING = spring(0.62);
const EASE = "cubic-bezier(.2, .7, .2, 1)";
const smooth = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

// Each layout: where everything sits, in the drawing's own units.
function chipRow(x, y, h, widths, gap) {
  return widths.map((w, i) => ({ x: x + widths.slice(0, i).reduce((sum, v) => sum + v + gap, 0), y, w, h, text: CITES[i] }));
}

function wide() {
  return {
    w: 1200,
    h: 620,
    size: { label: 23, small: 19, chip: 18, card: 17, tool: 16 },
    tick: 7,
    ask: { x: 30, y: 52, w: 330, h: 74, text: [195, 97] },
    askLine: [[360, 89], [418, 89], [440, 170], [440, 246]],
    lead: { cx: 440, cy: 300, r: 54 },
    specialists: [80, 214, 348, 482].map((cy) => ({
      box: { x: 600, y: cy - 44, w: 290, h: 88 },
      label: [622, cy - 12],
      chip: { x: 618, y: cy + 2, w: 206, h: 34 },
      fan: [[494, 300], [556, 300], [540, cy], [600, cy]],
      tool: [[890, cy], [990, cy]],
    })),
    service: {
      box: { x: 990, y: 36, w: 180, h: 490 },
      label: [1080, 104],
      tools: TOOLS.map((text, i) => ({ x: 1004, y: 186 + i * 66, w: 152, h: 38, text })),
    },
    answer: {
      box: { x: 30, y: 380, w: 384, h: 124 },
      bars: [{ x: 58, y: 408, w: 310, h: 13 }, { x: 58, y: 432, w: 210, h: 13 }],
      chips: chipRow(58, 460, 30, [76, 64, 88, 76], 8),
      at: [222, 442],
    },
    answerLine: [[440, 354], [440, 414], [436, 442], [414, 442]],
    planner: { box: { x: 30, y: 538, w: 300, h: 72 }, check: { cx: 70, cy: 574, r: 23 }, label: [106, 582] },
    plannerLine: [[180, 504], [180, 538]],
    card: { w: 86, h: 52 },
  };
}

function tall() {
  return {
    w: 600,
    h: 1040,
    tall: true,
    size: { label: 29, small: 24, chip: 24, card: 22 },
    tick: 8,
    ask: { x: 106, y: 18, w: 476, h: 84, text: [344, 70] },
    askLine: [[106, 60], [86, 60], [84, 96], [84, 138]],
    lead: { cx: 84, cy: 196, r: 58 },
    specialists: [322, 436, 550, 664].map((cy) => ({
      box: { x: 168, y: cy - 48, w: 290, h: 96 },
      label: [188, cy - 14],
      chip: { x: 184, y: cy + 2, w: 258, h: 38 },
      fan: [[84, 254], [84, cy - 36], [116, cy], [168, cy]],
      tool: [[458, cy], [504, cy]],
    })),
    service: { box: { x: 504, y: 268, w: 80, h: 450 }, label: [544, 493], rotate: true, tools: [] },
    answer: {
      box: { x: 18, y: 752, w: 564, h: 150 },
      bars: [{ x: 50, y: 786, w: 470, h: 16 }, { x: 50, y: 814, w: 320, h: 16 }],
      chips: chipRow(50, 846, 38, [104, 88, 116, 104], 10),
      at: [300, 827],
    },
    answerLine: [[84, 254], [84, 752]],
    planner: { box: { x: 18, y: 944, w: 380, h: 84 }, check: { cx: 64, cy: 986, r: 27 }, label: [106, 996] },
    plannerLine: [[200, 902], [200, 944]],
    card: { w: 108, h: 64 },
  };
}

function el(name, attributes, parent) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

function words(parent, [x, y], size, text, attributes = {}) {
  const node = el("text", { x, y, "font-size": size, ...attributes }, parent);
  node.textContent = text;
  return node;
}

function box(parent, { x, y, w, h }, attributes, round = h / 2) {
  return el("rect", { x, y, width: w, height: h, rx: round, ...attributes }, parent);
}

const path = (p) => (p.length === 2 ? `M${p[0]} L${p[1]}` : `M${p[0]} C${p[1]} ${p[2]} ${p[3]}`);

function bezier([a, b, c, d], t) {
  const u = 1 - t;
  return [0, 1].map((i) => u * u * u * a[i] + 3 * u * u * t * b[i] + 3 * u * t * t * c[i] + t * t * t * d[i]);
}

const at = ([x, y], scale = 1) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;

// Draws the layout, and lists what moves when: [element, keyframes, timing]. Unmoved,
// the drawing is its last frame, so with reduced motion nothing needs to play.
function draw(L) {
  const svg = el("svg", { viewBox: `0 0 ${L.w} ${L.h}`, class: `flow${L.tall ? " tall" : ""}`, "aria-hidden": "true", focusable: "false" });
  const lines = el("g", {}, svg);
  const nodes = el("g", {}, svg);
  const movers = el("g", {}, svg);
  const show = [];
  const play = (element, keyframes, delay, duration, easing = EASE) => show.push([element, keyframes, { delay, duration, easing, fill: "backwards" }]);
  const pop = (element, from, delay, duration = 700, easing = BOUNCE) =>
    play(element, [{ opacity: 0, transform: from }, { opacity: 1, transform: "none" }], delay, duration, easing);
  const line = (points, delay, duration, extra = "") => {
    const node = el("path", { d: path(points), class: `line ${extra}`, pathLength: 1 }, lines);
    const frame = (offset) => ({ strokeDasharray: "1 1", strokeDashoffset: offset, opacity: 1 });
    play(node, [{ ...frame(1), opacity: 0 }, { ...frame(0.96), offset: 0.04 }, frame(0)], delay, duration);
    return node;
  };

  // The question, and the lead it goes to.
  const ask = el("g", { class: "pop" }, nodes);
  box(ask, L.ask, { class: "ask" });
  words(ask, L.ask.text, L.size.label, "Does the change pass?", { "text-anchor": "middle" });
  pop(ask, "translate(0px, 14px) scale(.7)", 0);
  line(L.askLine, 280, 520);

  const lead = el("g", { class: "pop" }, nodes);
  el("circle", { cx: L.lead.cx, cy: L.lead.cy, r: L.lead.r, class: "ink" }, lead);
  words(lead, [L.lead.cx, L.lead.cy + L.size.label * 0.36], L.size.label, "Lead", { "text-anchor": "middle", class: "on" });
  pop(lead, "scale(.4)", 600);
  const ring = el("circle", { cx: L.lead.cx, cy: L.lead.cy, r: L.lead.r, class: "ring pop gone" }, nodes);
  play(ring, [{ opacity: 0.5, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.9)" }], 780, 900);

  // The service, with the tools the specialists call.
  const service = el("g", { class: "pop" }, nodes);
  box(service, L.service.box, { class: "service" }, L.tall ? 30 : 34);
  const [sx, sy] = L.service.label;
  words(service, [sx, sy + 8], L.size.label, "Service", {
    "text-anchor": "middle",
    class: "strong",
    ...(L.service.rotate ? { transform: `rotate(-90 ${sx} ${sy})` } : {}),
  });
  const lit = L.service.tools.map((pill) => {
    box(service, pill, { class: "chip" });
    const middle = [pill.x + pill.w / 2, pill.y + pill.h / 2 + L.size.tool * 0.36];
    words(service, middle, L.size.tool, pill.text, { "text-anchor": "middle" });
    const on = el("g", { class: "gone" }, service);
    box(on, pill, { class: "chip-on" });
    words(on, middle, L.size.tool, pill.text, { "text-anchor": "middle", class: "on" });
    return on;
  });
  pop(service, "translate(18px, 0px) scale(.94)", 1600, 700, SPRING);

  // The specialists, each with its skill, calling the service's tools.
  L.specialists.forEach((s, i) => {
    line(s.fan, 980 + i * 90, 460);
    const tool = el("path", { d: path(s.tool), class: "line dots" }, lines);
    play(tool, [{ opacity: 0 }, { opacity: 1 }], 2250 + i * 70, 300);

    const node = el("g", { class: "pop" }, nodes);
    box(node, s.box, { class: "node" }, 22);
    words(node, s.label, L.size.small, "Specialist", { class: "muted" });
    pop(node, "translate(-18px, 0px) scale(.92)", 1160 + i * 90, 700, SPRING);

    const chip = el("g", { class: "pop" }, nodes);
    box(chip, s.chip, { class: "chip" });
    words(chip, [s.chip.x + s.chip.w / 2, s.chip.y + s.chip.h / 2 + L.size.chip * 0.36], L.size.chip, SKILLS[i], { "text-anchor": "middle", "font-weight": 500 });
    pop(chip, "translate(0px, -34px) scale(1.15) rotate(-6deg)", 1820 + i * 130, 760);

    for (let k = 0; k < 3; k++) {
      const start = 2500 + i * 140 + k * 360;
      const tick = el("circle", { cx: 0, cy: 0, r: L.tick, class: "tick move gone" }, movers);
      const [from, to] = s.tool;
      play(
        tick,
        [
          { offset: 0, opacity: 0, transform: at(from) },
          { offset: 0.12, opacity: 1, transform: at(from) },
          { offset: 0.5, opacity: 1, transform: at(to, 0.7) },
          { offset: 0.88, opacity: 1, transform: at(from) },
          { offset: 1, opacity: 0, transform: at(from) },
        ],
        start,
        480,
        "linear",
      );
      const pill = lit[(i + k) % 4];
      if (pill) play(pill, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], start + 200, 360, "linear");
    }

    // A page with its citation comes back, and joins the others in the answer.
    const card = el("g", { class: "move gone" }, movers);
    const { w, h } = L.card;
    box(card, { x: -w / 2, y: -h / 2, w, h }, { class: "node" }, 8);
    box(card, { x: -w / 2 + 10, y: -h / 2 + 9, w: w * 0.5, h: 4 }, { class: "bar" }, 2);
    words(card, [0, h / 2 - L.size.card * 0.6], L.size.card, CITES[i], { "text-anchor": "middle", class: "strong" });
    const start = [s.box.x - w / 2 - 8, s.box.y + s.box.h / 2];
    const end = L.answer.at;
    const route = [start, [start[0] - 90, start[1] + (L.tall ? 60 : 0)], [end[0] + 120, end[1] - 80], end];
    const frames = [{ offset: 0, opacity: 0, transform: at(start, 0.5) }, { offset: 0.18, opacity: 1, transform: at(start) }];
    for (let j = 1; j <= 18; j++) {
      const t = smooth(j / 18);
      frames.push({ offset: 0.18 + (0.82 * j) / 18, opacity: j === 18 ? 0 : 1, transform: at(bezier(route, t), 1 - 0.4 * t) });
    }
    play(card, frames, 4100 + i * 130, 1150, "linear");
  });

  // One short answer, every figure cited, and the planner who decides.
  line(L.answerLine, 4800, 420);
  const answer = el("g", { class: "pop" }, nodes);
  box(answer, L.answer.box, { class: "node" }, L.tall ? 34 : 30);
  for (const bar of L.answer.bars) box(answer, bar, { class: "bar" });
  pop(answer, "translate(0px, 16px) scale(.8)", 5150, 760);
  L.answer.chips.forEach((c, j) => {
    const chip = el("g", { class: "pop" }, nodes);
    box(chip, c, { class: "chip" });
    words(chip, [c.x + c.w / 2, c.y + c.h / 2 + L.size.card * 0.36], L.size.card, c.text, { "text-anchor": "middle", "font-weight": 500 });
    pop(chip, "scale(.4)", 5450 + j * 80, 600);
  });

  line(L.plannerLine, 5850, 260);
  const planner = el("g", { class: "pop" }, nodes);
  box(planner, L.planner.box, { class: "node" });
  words(planner, L.planner.label, L.size.label, "Planner decides", { class: "strong" });
  pop(planner, "translate(0px, 12px) scale(.85)", 6000, 700, SPRING);
  const { cx, cy, r } = L.planner.check;
  const badge = el("circle", { cx, cy, r, class: "ink pop" }, nodes);
  pop(badge, "scale(.3)", 6200, 700);
  const check = el("path", { d: `M${cx - 0.48 * r} ${cy + 0.02 * r} l${0.31 * r} ${0.31 * r} l${0.57 * r} ${-0.62 * r}`, class: "check", pathLength: 1 }, nodes);
  play(check, [{ strokeDasharray: "1 1", strokeDashoffset: 1 }, { strokeDasharray: "1 1", strokeDashoffset: 0 }], 6400, 380);

  return { svg, show };
}

let show = [];
let running = [];
let played = false;

function stop() {
  for (const animation of running) animation.cancel();
  running = [];
}

// Starts it, or with `held`, sets it at its first frame to wait until it's seen.
function start(held = false) {
  stop();
  running = show.map(([element, keyframes, timing]) => element.animate(keyframes, timing));
  if (held) for (const animation of running) animation.pause();
}

function render() {
  stop();
  figure.querySelector("svg")?.remove();
  const drawn = draw(roomy.matches ? wide() : tall());
  figure.insertBefore(drawn.svg, replay);
  show = drawn.show;
  replay.hidden = still.matches;
  if (!still.matches && !played) start(true);
}

render();

const seen = new IntersectionObserver(
  (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    seen.disconnect();
    played = true;
    for (const animation of running) animation.play();
  },
  { threshold: 0.35 },
);
seen.observe(figure);

replay.addEventListener("click", () => {
  played = true;
  start();
});
roomy.addEventListener("change", render);
still.addEventListener("change", () => {
  played = true;
  render();
});

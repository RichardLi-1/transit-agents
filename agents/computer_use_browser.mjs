// The screen for computer_use.py: one page in Chrome for Testing, driven by Playwright.
//
//   node agents/computer_use_browser.mjs '{"page": "apps/legacy-mock/index.html"}'
//
// It reads one JSON command a line on stdin and answers each with one JSON line on
// stdout, starting with {"ready": true, "screen": {...}} once the page is up.
// Coordinates are CSS pixels on the screen the model sees.
//
// The page is served at its app's own origin, http://legacy-app.test/ unless
// options.origin says another, from its file, and nothing else loads: every request
// to another origin is refused, a new window is closed, and the page is put back if
// it's ever left. Options: page, origin, width, height (1920x1080),
// headed, pace (move and type at a speed people can follow), record (an .mp4 path,
// written with ffmpeg) and captions (a strip under the screen, kept out of the
// screenshots). CHROME_PATH picks the browser; otherwise it's Playwright's Chrome
// for Testing, or the newest one in Playwright's cache.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

const FPS = 25;
const CAPTION_HEIGHT = 72;
const SIDE_WIDTH = 320;
// The app is laid out as at least this wide and scaled to fit beside the transcript:
// squeezed narrower, the mock apps cut off their left side and Gemini gets lost.
const LAYOUT_WIDTH = 1440;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const options = JSON.parse(process.argv[2] ?? "{}");
const ORIGIN = new URL(options.origin ?? "http://legacy-app.test").origin;
const HOME = `${ORIGIN}/`;
const width = options.width ?? 1920;
const height = options.height ?? 1080;
const pace = Boolean(options.pace);
// A recording has captions under the screen. A window people watch live has a
// transcript down its right side instead: what Gemini says at each step.
const reserved = options.record && options.captions ? CAPTION_HEIGHT : 0;
const side = options.headed && !options.record && options.captions ? SIDE_WIDTH : 0;
const screen = { width: width - side, height: height - reserved };
const html = readFileSync(options.page, "utf8");

function out(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const own = chromium.executablePath();
  if (existsSync(own)) return own;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : process.platform === "win32"
        ? join(process.env.LOCALAPPDATA ?? homedir(), "ms-playwright")
        : join(homedir(), ".cache", "ms-playwright"));
  const builds = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
    : [];
  const app = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const inside = [`chrome-mac-arm64/${app}`, `chrome-mac-x64/${app}`, "chrome-linux64/chrome", "chrome-win64/chrome.exe"];
  for (const build of builds) {
    for (const path of inside) if (existsSync(join(cache, build, path))) return join(cache, build, path);
  }
  throw new Error("No Chrome for Testing found. Set CHROME_PATH, or run npx playwright-core install chromium.");
}

// The pointer, drawn on the page: a recording shows no real one. It never takes a
// click, and the captions sit below the part of the screen the model sees.
function decorate({ reserved, side, layout, x, y }) {
  const draw = () => {
    if (document.getElementById("computer-use-layer")) return;
    if (reserved) document.documentElement.style.setProperty("--reserved-bottom", `${reserved}px`);
    // Scaled so the app keeps the layout it has at LAYOUT_WIDTH; the layer undoes it.
    const zoom = side ? Math.min(1, (innerWidth - side) / layout) : 1;
    if (side) {
      document.documentElement.style.zoom = String(zoom);
      document.documentElement.style.setProperty("--reserved-right", `${side / zoom}px`);
    }
    const host = document.createElement("div");
    host.id = "computer-use-layer";
    host.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:2147483647;zoom:${1 / zoom}`;
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .pointer { position: fixed; left: 0; top: 0; width: 26px; height: 26px; will-change: transform; filter: drop-shadow(1px 2px 1px rgb(0 0 0 / 0.35)); }
      .ring { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: -22px 0 0 -22px; border: 3px solid #1a73e8; border-radius: 50%; opacity: 0; }
      .ring.on { animation: ring 0.45s ease-out; }
      @keyframes ring { from { transform: var(--at) scale(0.3); opacity: 0.9; } to { transform: var(--at) scale(1.2); opacity: 0; } }
      .strip { position: fixed; left: 0; right: 0; bottom: 0; height: ${reserved}px; display: ${reserved ? "flex" : "none"}; align-items: center; gap: 28px;
        padding: 0 32px; background: #101317; color: #f4f6f8; font: 22px/1.25 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .who { font-weight: 600; white-space: nowrap; }
      .text { flex: 1; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
      .meta { color: #b6bdc6; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .side { position: fixed; top: 0; right: 0; bottom: 0; width: ${side}px; display: ${side ? "flex" : "none"}; flex-direction: column;
        background: #ffffff; color: #111111; border-left: 1px solid #d0d0d6; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
      .side h2 { margin: 0; padding: 16px 18px 12px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #111111; border-bottom: 1px solid #e2e2e6; }
      .log { flex: 1; overflow-y: auto; padding: 10px 18px 18px; display: flex; flex-direction: column; gap: 10px; }
      .line { display: grid; gap: 2px; }
      .line .m { color: #5f5f66; font-size: 12px; font-variant-numeric: tabular-nums; }
      .line.new { animation: in .35s ease-out; }
      .line.ask { color: #8a4b00; font-weight: 600; }
      @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    </style>
    <div class="side"><h2>Gemini</h2><div class="log"></div></div>
    <div class="strip"><span class="who"></span><span class="text"></span><span class="meta"></span></div>
    <div class="ring"></div>
    <svg class="pointer" viewBox="0 0 26 26" aria-hidden="true"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.6 15 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.documentElement.append(host);
    const pointer = root.querySelector(".pointer");
    const ring = root.querySelector(".ring");
    const place = (px, py) => (pointer.style.transform = `translate(${px}px, ${py}px)`);
    place(x, y);
    addEventListener("mousemove", (event) => place(event.clientX, event.clientY), true);
    addEventListener(
      "mousedown",
      (event) => {
        ring.style.setProperty("--at", `translate(${event.clientX}px, ${event.clientY}px)`);
        ring.classList.remove("on");
        void ring.offsetWidth;
        ring.classList.add("on");
      },
      true,
    );
    const log = root.querySelector(".log");
    let last = "";
    window.__computerUseCaption = ({ who = "", text = "", meta = "" }) => {
      if (side && text && text !== last) {
        last = text;
        const line = document.createElement("div");
        line.className = `line new${/confirm|asks/i.test(text) ? " ask" : ""}`;
        line.innerHTML = '<span class="m"></span><span class="t"></span>';
        line.querySelector(".m").textContent = meta || who;
        line.querySelector(".t").textContent = text;
        log.append(line);
        log.scrollTop = log.scrollHeight;
      }
      root.querySelector(".who").textContent = who;
      root.querySelector(".text").textContent = text;
      root.querySelector(".meta").textContent = meta;
    };
  };
  if (document.documentElement) draw();
  addEventListener("DOMContentLoaded", draw);
}

async function startRecording(page, path) {
  const ffmpeg = spawn(
    process.env.FFMPEG || "ffmpeg",
    ["-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "-",
      "-vf", "scale=out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-movflags", "+faststart", path],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  if (ffmpeg.pid === undefined) throw new Error("Recording needs ffmpeg on the PATH, or FFMPEG set to it.");
  const exited = new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", resolve);
  });
  exited.catch(() => {});
  ffmpeg.stdin.on("error", () => {});
  let latest = null;
  let written = 0;
  const started = Date.now();
  // A screenshot for the model sends a frame of just its part of the screen: that one is skipped.
  const onFrame = ({ data, viewportWidth, viewportHeight }) => {
    if (viewportWidth === width && viewportHeight === height) latest = data;
  };
  await page.screencast.start({ size: { width, height }, quality: 92, onFrame });
  // Frames come only when the page changes, so the last one is repeated to keep time.
  const tick = () => {
    if (!latest) return;
    const due = Math.floor(((Date.now() - started) * FPS) / 1000);
    for (; written < due; written++) ffmpeg.stdin.write(latest);
  };
  const timer = setInterval(tick, 1000 / FPS);
  return async () => {
    tick();
    clearInterval(timer);
    await page.screencast.stop().catch(() => {});
    ffmpeg.stdin.end();
    const code = await exited;
    if (code !== 0) throw new Error(`ffmpeg couldn't write ${path} (exit ${code})`);
    return path;
  };
}

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: !options.headed,
  // A window people watch opens at the top left, where it fits a laptop screen.
  ...(options.headed ? { args: ["--window-position=0,0"] } : {}),
});
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  acceptDownloads: false,
  serviceWorkers: "block",
});
const blocked = [];
await context.route("**/*", (route) => {
  const url = route.request().url();
  if (url === HOME) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
  if (url.startsWith(`${ORIGIN}/`)) return route.fulfill({ status: 404, body: "" });
  blocked.push(url);
  return route.abort("blockedbyclient");
});
let pointer = { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
await context.addInitScript(decorate, { reserved, side, layout: LAYOUT_WIDTH, ...pointer });
const page = await context.newPage();
context.on("page", (other) => other !== page && other.close().catch(() => {}));
page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
let left = 0;
let restoring = Promise.resolve();
page.on("framenavigated", (frame) => {
  if (frame !== page.mainFrame() || frame.url() === HOME) return;
  left += 1;
  restoring = page.goto(HOME).then(
    () => {},
    () => {},
  );
});
await page.goto(HOME);
const stopRecording = options.record ? await startRecording(page, options.record) : null;

async function moveTo(x, y) {
  if (pace) {
    // Eased, so a recording shows where the pointer goes.
    const steps = Math.max(10, Math.min(36, Math.round(Math.hypot(x - pointer.x, y - pointer.y) / 30)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.mouse.move(pointer.x + (x - pointer.x) * eased, pointer.y + (y - pointer.y) * eased);
      await sleep(16);
    }
  } else {
    await page.mouse.move(x, y);
  }
  pointer = { x, y };
}

const commands = {
  async screenshot() {
    await sleep(pace ? 700 : 150); // let the app finish what the action started
    await restoring;
    const png = await page.screenshot({ clip: { x: 0, y: 0, ...screen }, type: "png" });
    return { png: png.toString("base64"), url: page.url() };
  },
  async click({ x, y, button = "left", count = 1 }) {
    await moveTo(x, y);
    await page.mouse.click(x, y, { button, clickCount: count, delay: pace ? 60 : 0 });
  },
  async move({ x, y }) {
    await moveTo(x, y);
  },
  async down({ x, y, button = "left" }) {
    if (x !== undefined) await moveTo(x, y);
    await page.mouse.down({ button });
  },
  async up({ x, y, button = "left" }) {
    if (x !== undefined) await moveTo(x, y);
    await page.mouse.up({ button });
  },
  async drag({ x1, y1, x2, y2 }) {
    await moveTo(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 20 });
    pointer = { x: x2, y: y2 };
    await page.mouse.up();
  },
  async scroll({ x, y, dx = 0, dy = 0 }) {
    await moveTo(x, y);
    await page.mouse.wheel(dx, dy);
  },
  async type({ text, enter = false, clear = false }) {
    const editing = await page.evaluate(() => {
      const field = document.activeElement;
      return Boolean(field && (field.isContentEditable || /^(INPUT|TEXTAREA)$/.test(field.tagName)));
    });
    if (clear && editing) {
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
    }
    await page.keyboard.type(text, { delay: pace ? 90 : 0 });
    if (enter) await page.keyboard.press("Enter");
  },
  async press({ keys }) {
    await page.keyboard.press(keys, { delay: pace ? 60 : 0 });
  },
  async keydown({ key }) {
    await page.keyboard.down(key);
  },
  async keyup({ key }) {
    await page.keyboard.up(key);
  },
  async wait({ seconds = 1 }) {
    await sleep(seconds * 1000);
  },
  async caption(caption) {
    await page.evaluate((shown) => window.__computerUseCaption?.(shown), caption);
  },
  // For the harness and tests, never the model: what the app saved, its evaluation if
  // it has one, and what was refused. Each mock app reports through its own object.
  async state() {
    await restoring;
    await page
      .waitForFunction(() => !(window.tripScheduler ?? window.signalSim)?.busy?.(), null, { timeout: 5000 })
      .catch(() => {});
    const app = await page.evaluate(() => {
      const mock = window.tripScheduler ?? window.signalSim;
      if (!mock) return {};
      return { changes: mock.changes(), unsaved: mock.unsaved(), ...(mock.evaluation ? { evaluation: mock.evaluation() } : {}) };
    });
    return { url: page.url(), blocked, left, ...app };
  },
  async box({ selector }) {
    return { box: await page.locator(selector).first().boundingBox() };
  },
  // For the harness, never the model: which of the app's writes, by its manifest's
  // selectors, the element at each point belongs to, and the focused one. A point that
  // is null means where the pointer is. The drawn pointer takes no clicks, so it's never hit.
  async writes({ points = [], selectors = {} }) {
    await restoring;
    const at = points.map((point) => (point ? { x: point[0], y: point[1] } : pointer));
    return page.evaluate(
      ({ at, selectors }) => {
        const which = (element) => {
          if (!element) return null;
          for (const [name, list] of Object.entries(selectors)) if (list.some((selector) => element.closest(selector))) return name;
          return null;
        };
        return { at: at.map(({ x, y }) => which(document.elementFromPoint(x, y))), focused: which(document.activeElement) };
      },
      { at, selectors },
    );
  },
};

let closed = false;
async function close() {
  if (closed) return null;
  closed = true;
  let video = null;
  try {
    if (stopRecording) video = await stopRecording();
  } finally {
    await browser.close().catch(() => {});
  }
  return video;
}

out({ ready: true, url: HOME, screen });
try {
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const { id, do: action, ...args } = JSON.parse(line);
    try {
      if (action === "close") {
        out({ id, ok: true, video: await close() });
        break;
      }
      if (!Object.hasOwn(commands, action)) throw new Error(`No command ${action}`);
      out({ id, ok: true, ...(await commands[action](args)) });
    } catch (error) {
      out({ id, ok: false, error: String(error?.message ?? error).split("\n")[0] });
    }
  }
} finally {
  // Also when the agent goes away without saying close: the recording is kept.
  await close().catch((error) => console.error(String(error?.message ?? error)));
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}

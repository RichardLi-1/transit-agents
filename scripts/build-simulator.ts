// Copies the mock intersection simulator (apps/microsim-mock) into the display at
// /simulator, for anyone to open and try. The site allows no inline scripts, so its
// scripts move into files of their own beside the page. npm run build runs this.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "apps/display/public/simulator");
let html = readFileSync(join(root, "apps/microsim-mock/index.html"), "utf8");
mkdirSync(out, { recursive: true });
let n = 0;
html = html.replace(/<script([^>]*)>([\s\S]*?)<\/script>/g, (_all, attrs: string, body: string) => {
  const name = `script-${++n}.js`;
  writeFileSync(join(out, name), body);
  return `<script${attrs} src="${name}"></script>`;
});
// Opened from the chat as #thinking, it plans for a moment before the app shows.
writeFileSync(
  join(out, "thinking.js"),
  `if (location.hash === "#thinking") {
  const cover = document.createElement("div");
  cover.setAttribute("role", "status");
  cover.style.cssText = "position:fixed;inset:0;z-index:99999;display:grid;place-items:center;background:rgba(255,255,255,.96);font:600 20px/1.4 system-ui,-apple-system,sans-serif;color:#111;transition:opacity .35s";
  const say = (text) => (cover.textContent = text);
  say("Reading the signal plan…");
  document.body.append(cover);
  setTimeout(() => say("Planning the change…"), 900);
  setTimeout(() => (cover.style.opacity = "0"), 1800);
  setTimeout(() => { cover.remove(); history.replaceState(null, "", location.pathname); }, 2200);
}
`,
);
// Opened as #replay, it replays a real Gemini run, with Gemini's words beside it.
writeFileSync(join(out, "replay.js"), readFileSync(join(root, "apps/microsim-mock/replay.js"), "utf8"));
html = html.replace("</body>", '<script src="thinking.js"></script>\n<script src="replay.js"></script>\n</body>');
writeFileSync(join(out, "index.html"), html);
console.log(`Simulator at /simulator, with ${n} scripts.`);

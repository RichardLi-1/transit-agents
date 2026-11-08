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
writeFileSync(join(out, "index.html"), html);
console.log(`Simulator at /simulator, with ${n} scripts.`);

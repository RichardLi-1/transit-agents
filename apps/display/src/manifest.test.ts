// The display as an app Chrome can install: its manifest, linked from the page,
// and the icons scripts/build-icons.ts draws, each the size the manifest says.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const display = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(display, "public/manifest.webmanifest"), "utf8"));

// A PNG's width and height, from its header.
function sizeOf(path: string): string {
  const bytes = readFileSync(join(display, "public", path));
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", path);
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe("the app manifest", () => {
  it("names the app Transit Agents, opening the display in a window of its own", () => {
    assert.equal(manifest.name, "Transit Agents");
    assert.equal(manifest.short_name, "Transit Agents");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.display, "standalone");
    assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/);
    assert.match(manifest.background_color, /^#[0-9a-f]{6}$/);
  });

  it("has icons at 192 and 512 px, and a maskable one, each the size it says", () => {
    const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
    for (const icon of icons) {
      assert.equal(icon.type, "image/png");
      assert.equal(sizeOf(icon.src), icon.sizes, icon.src);
    }
    const sizes = (purpose: string) => icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
    assert.deepEqual(sizes("any"), ["192x192", "512x512"]);
    assert.deepEqual(sizes("maskable"), ["512x512"]);
  });

  it("is linked from the display's page", () => {
    assert.match(readFileSync(join(display, "index.html"), "utf8"), /<link rel="manifest" href="\/manifest.webmanifest" \/>/);
  });
});

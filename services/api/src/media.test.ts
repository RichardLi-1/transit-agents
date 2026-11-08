import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { byteRange, MediaStore, sniff } from "./media.ts";
import { SAMPLE as FILES } from "./sample-media.ts";

describe("sniff", () => {
  it("knows PNG, JPEG, WebP and MP4 by their first bytes", () => {
    assert.equal(sniff(FILES.png), "image/png");
    assert.equal(sniff(FILES.jpeg), "image/jpeg");
    assert.equal(sniff(FILES.webp), "image/webp");
    assert.equal(sniff(FILES.mp4), "video/mp4");
  });

  it("knows nothing else: not SVG, HTML, GIF, a HEIC image, an empty file or a cut-off one", () => {
    for (const file of [FILES.svg, FILES.html, FILES.gif, FILES.heic, new Uint8Array(), FILES.png.subarray(0, 4), FILES.mp4.subarray(0, 10)]) {
      assert.equal(sniff(file), undefined);
    }
  });
});

describe("byteRange", () => {
  it("reads the one range a browser asks for", () => {
    assert.deepEqual(byteRange("bytes=0-", 100), [0, 99]);
    assert.deepEqual(byteRange("bytes=10-19", 100), [10, 19]);
    assert.deepEqual(byteRange("bytes=-30", 100), [70, 99]);
    assert.deepEqual(byteRange("bytes=90-500", 100), [90, 99]);
    assert.deepEqual(byteRange("bytes=-500", 100), [0, 99]);
  });

  it("sends the whole file for no range, several ranges, or one it can't read", () => {
    for (const header of [undefined, "", "bytes=-", "bytes=0-1,5-6", "bytes=20-10", "items=0-5", "bytes=a-b"]) {
      assert.equal(byteRange(header, 100), undefined, header);
    }
  });

  it("sends nothing for a range past the end", () => {
    assert.equal(byteRange("bytes=100-", 100), null);
    assert.equal(byteRange("bytes=-0", 100), null);
  });
});

describe("MediaStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transit-media-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps each file once, under its hash, with nothing left half-written", () => {
    const store = new MediaStore(join(dir, "media"));
    const sha = "b".repeat(64);
    store.put(sha, FILES.png);
    store.put(sha, FILES.png);
    assert.deepEqual(readdirSync(store.directory), [sha]);
    assert.deepEqual(new Uint8Array(readFileSync(store.path(sha) as string)), FILES.png);
    assert.equal(store.path("c".repeat(64)), undefined);
  });

  it("makes its folder again if it was removed while the service ran", () => {
    const store = new MediaStore(join(dir, "media"));
    rmSync(store.directory, { recursive: true });
    store.put("d".repeat(64), FILES.png);
    assert.deepEqual(readdirSync(store.directory), ["d".repeat(64)]);
  });

  it("names files only by a hash, so no name can reach outside its folder", () => {
    const store = new MediaStore(join(dir, "media"));
    assert.throws(() => store.path("../log.db"), /not a sha256/);
    assert.throws(() => store.put("../x", FILES.png), /not a sha256/);
  });
});

// Small whole files for tests: the smallest real PNG, and the least of each other
// kind that the service takes as whole. And files it refuses.
import { crc32 } from "node:zlib";
import { sniff } from "./media.ts";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)))));

export const SAMPLE = {
  png: new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xd9]),
  webp: bytes("RIFF", [0x1a, 0, 0, 0], "WEBPVP8L", [0x0d, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0]),
  mp4: bytes([0, 0, 0, 0x1c], "ftypisom", [0, 0, 2, 0], "isomiso2mp41", [0, 0, 0, 8], "moov", [0, 0, 0, 8], "free"),
  svg: bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  html: bytes("<!doctype html><script>alert(1)</script>"),
  heic: bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0], "mif1heic"),
  gif: bytes("GIF89a", [1, 0, 1, 0, 0, 0, 0]),
};

// A whole PNG or MP4 of the given size: the PNG with a private chunk before its
// end, the MP4 with a free box after its movie.
export function padded(file: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  if (sniff(file) === "video/mp4") {
    out.set(file);
    view.setUint32(file.length, size - file.length);
    out.set(Buffer.from("free"), file.length + 4);
    return out;
  }
  if (sniff(file) !== "image/png") throw new Error("Pads only a PNG or an MP4");
  const end = file.length - 12;
  const length = size - file.length - 12;
  out.set(file.subarray(0, end));
  view.setUint32(end, length);
  out.set(Buffer.from("prVt"), end + 4);
  view.setUint32(end + 8 + length, crc32(out.subarray(end + 4, end + 8 + length)));
  out.set(file.subarray(end), size - 12);
  return out;
}

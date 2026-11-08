// Generated images and videos. Each file is kept once, named by the sha256 of its
// bytes, and written whole or not at all. The log never holds the bytes: it names
// the hash, so a file can't change without the log disagreeing with it.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { MediaType } from "@transit-agents/contracts";

const SHA256 = /^[0-9a-f]{64}$/;

export const isSha256 = (id: string) => SHA256.test(id);

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

// Brands an MP4 file names first. HEIC and AVIF images share the format, so the
// brand tells them apart.
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "dash", "mmp4", "MSNV"]);

// What a file is, from its first bytes. Anything else, SVG and HTML included, is
// undefined.
export function sniff(bytes: Uint8Array): MediaType | undefined {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && MP4_BRANDS.has(ascii(bytes, 8, 12))) return "video/mp4";
  return undefined;
}

// Whether a file is whole: its structure runs from its first byte to its last,
// so nothing else rides along after it. A PNG's chunks, each with a good CRC, end
// with IEND. A JPEG ends with its end-of-image marker. A WebP's RIFF size is its
// length. An MP4's boxes cover it, and one is the movie (moov).
export function isWhole(bytes: Uint8Array, type: MediaType): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") {
    let at = 8;
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at);
      const end = at + 12 + length;
      if (end > bytes.length || crc32(bytes.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) return false;
      if (ascii(bytes, at + 4, at + 8) === "IEND") return end === bytes.length;
      at = end;
    }
    return false;
  }
  if (type === "image/jpeg") return bytes.length >= 4 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (type === "image/webp") return bytes.length >= 12 && view.getUint32(4, true) + 8 === bytes.length;
  let at = 0;
  let movie = false;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) return false;
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > bytes.length) return false;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = bytes.length - at;
    if (size < header || at + size > bytes.length) return false;
    movie ||= ascii(bytes, at + 4, at + 8) === "moov";
    at += size;
  }
  return movie;
}

type Part = { data: Uint8Array; filename?: string; type?: string };

// The parts of a multipart/form-data body, by name. Each part's bytes are a view
// of the body, never a copy, so a large file is held in memory once. undefined
// when the body isn't such a form.
export function formParts(body: Uint8Array, contentType: string): Map<string, Part> | undefined {
  const boundary = /^multipart\/form-data\s*;.*\bboundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  const mark = boundary?.[1] ?? boundary?.[2];
  if (!mark) return undefined;
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const next = Buffer.from(`\r\n--${mark}`);
  const parts = new Map<string, Part>();
  let at = buffer.indexOf(`--${mark}`);
  if (at < 0) return undefined;
  at += mark.length + 2;
  for (;;) {
    // "--" after a boundary ends the form.
    if (buffer[at] === 0x2d && buffer[at + 1] === 0x2d) return parts;
    if (buffer[at] !== 0x0d || buffer[at + 1] !== 0x0a) return undefined;
    const headersEnd = buffer.indexOf("\r\n\r\n", at);
    const end = headersEnd < 0 ? -1 : buffer.indexOf(next, headersEnd + 4);
    if (end < 0) return undefined;
    const headers = buffer.toString("utf8", at + 2, headersEnd);
    const disposition = /^content-disposition:\s*form-data\s*;(.*)$/im.exec(headers)?.[1] ?? "";
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) return undefined;
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
    const type = /^content-type:\s*([^\r\n;]+)/im.exec(headers)?.[1]?.trim();
    parts.set(name, { data: body.subarray(headersEnd + 4, end), ...(filename !== undefined ? { filename } : {}), ...(type ? { type } : {}) });
    at = end + next.length;
  }
}

export class MediaStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  private pathOf(sha256: string) {
    if (!isSha256(sha256)) throw new Error(`"${sha256}" is not a sha256`);
    return join(this.directory, sha256);
  }

  // A file that is already there holds these bytes, so it is left alone. A new one
  // appears under its name only once it is complete.
  put(sha256: string, bytes: Uint8Array) {
    const path = this.pathOf(sha256);
    if (existsSync(path)) return;
    const partial = `${path}.${randomUUID()}.partial`;
    writeFileSync(partial, bytes, { flag: "wx" });
    renameSync(partial, path);
  }

  remove(sha256: string) {
    rmSync(this.pathOf(sha256), { force: true });
  }

  path(sha256: string): string | undefined {
    const path = this.pathOf(sha256);
    return existsSync(path) ? path : undefined;
  }
}

// The one range of bytes a Range header asks for, as a browser asks to play or
// seek a video: "bytes=0-", "bytes=500-999" or "bytes=-500". undefined means send
// the whole file, as for a header that names several ranges or can't be read.
// null means the range is past the end, so nothing can be sent.
export function byteRange(header: string | undefined, size: number): [start: number, end: number] | undefined | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  const [, first = "", last = ""] = match;
  if (!first) {
    const suffix = Number(last);
    return suffix === 0 ? null : [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(first);
  if (last && Number(last) < start) return undefined;
  if (start >= size) return null;
  return [start, last ? Math.min(Number(last), size - 1) : size - 1];
}

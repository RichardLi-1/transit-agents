// Prepares the source documents for the demo: the text of every page, for checking
// quotes, and an image of each cited page with the quote's position on it.
//
// Usage: node scripts/build-sources.ts <source-id>=<pdf> ...
//   e.g. ttc-anp-2026=anp-2026.pdf ttc-standards-2024=service-standards-2024.pdf
// Only the sources named are rebuilt. The others keep their pages and highlights.
// Needs Poppler (pdftotext, pdftoppm) and cwebp.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCES } from "../clients/seed-data.ts";
import { citedQuotes } from "./cited-pages.ts";

const USAGE = "Usage: build-sources.ts <source-id>=<pdf> ...";
const PDFS: Record<string, string> = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf("=");
    if (at < 1) throw new Error(USAGE);
    return [arg.slice(0, at), arg.slice(at + 1)];
  }),
);
const unknown = Object.keys(PDFS).filter((id) => !SOURCES.some((s) => s.id === id));
if (!Object.keys(PDFS).length || unknown.length) throw new Error(`${USAGE}${unknown.length ? `. No source ${unknown.join(", ")}` : ""}`);

const root = join(import.meta.dirname, "..");
const FIXTURES = join(root, "clients/fixtures");
const PUBLIC = join(root, "apps/display/public/sources");
const DPI = 120;
// A page of text is smallest kept whole; a page with a photo or a map, at this quality.
const QUALITY = 75;

const text = (args: string[]) => execFileSync("pdftotext", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

for (const source of SOURCES) {
  const pdf = PDFS[source.id];
  if (!pdf) continue;
  const pages = text(["-layout", pdf, "-"])
    .split("\f")
    .map((body, i) => ({ page: i + 1, text: body.trimEnd() }))
    .filter((p) => p.text);
  writeFileSync(join(FIXTURES, `${source.id}.pages.json`), JSON.stringify(pages));
  console.log(source.id, pages.length, "pages");
}

type Word = { x0: number; y0: number; x1: number; y1: number; word: string };
const clean = (w: string) => w.toLowerCase().replace(/[^a-z0-9$.]/g, "").replace(/\.$/, "");

function wordsOn(pdf: string, page: number) {
  const xml = text(["-bbox", "-f", String(page), "-l", String(page), pdf, "-"]);
  const size = /<page width="([\d.]+)" height="([\d.]+)"/.exec(xml);
  const words: Word[] = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
    x0: Number(m[1]),
    y0: Number(m[2]),
    x1: Number(m[3]),
    y1: Number(m[4]),
    word: clean(m[5] as string),
  }));
  return { width: Number(size?.[1]), height: Number(size?.[2]), words };
}

// Finds the first run of words matching the quote.
function locate(words: Word[], quote: string) {
  const wanted = quote.split(/\s+/).map(clean).filter(Boolean);
  for (let start = 0; start < words.length; start++) {
    let i = 0;
    while (i < wanted.length && words[start + i]?.word === wanted[i]) i++;
    if (i === wanted.length) return words.slice(start, start + wanted.length);
  }
  // Table cells come back column by column, so read along the row instead.
  for (const first of words.filter((w) => w.word === wanted[0])) {
    const row = words.filter((w) => Math.abs(w.y0 - first.y0) < 3 && w.x0 >= first.x0).sort((a, b) => a.x0 - b.x0);
    if (wanted.every((word, i) => row[i]?.word === word)) return row.slice(0, wanted.length);
  }
  return undefined;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
// The number a word starts with, as in "$9504", "30minute" or "seven".
const numberIn = (word: string) => (WORDS.includes(word) ? WORDS.indexOf(word) : parseFloat(word.replace(/^\$/, "")));

// The word holding the figure itself: the last in the quote, as a table row's
// figure is its last cell, so a row's other columns aren't taken for it.
const figureWord = (words: Word[], value: number) => words.findLast((w) => Math.abs(numberIn(w.word) - Math.abs(value)) < 1e-9);

// The page in grey, as WebP: lossless or at QUALITY, whichever is smaller.
function renderPage(pdf: string, page: number, out: string) {
  const work = mkdtempSync(join(tmpdir(), "transit-page-"));
  try {
    const png = join(work, "page");
    execFileSync("pdftoppm", ["-r", String(DPI), "-f", String(page), "-l", String(page), "-singlefile", "-gray", "-png", pdf, png]);
    const whole = join(work, "whole.webp");
    const lossy = join(work, "lossy.webp");
    execFileSync("cwebp", ["-quiet", "-lossless", "-m", "6", `${png}.png`, "-o", whole]);
    execFileSync("cwebp", ["-quiet", "-q", String(QUALITY), "-m", "6", "-sharp_yuv", `${png}.png`, "-o", lossy]);
    renameSync(statSync(whole).size <= statSync(lossy).size ? whole : lossy, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

type Box = [number, number, number, number];

// Highlights are keyed by source, page and quote. Those of the sources being
// rebuilt are made again, with their page images; the rest are kept as they are.
// `cell` boxes the figure's own number within the quote.
type Highlights = Record<string, { page: number; boxes: Box[]; cell?: Box }>;
const highlightsFile = join(PUBLIC, "highlights.json");
const kept: Highlights = existsSync(highlightsFile) ? JSON.parse(readFileSync(highlightsFile, "utf8")) : {};
const highlights: Highlights = Object.fromEntries(Object.entries(kept).filter(([key]) => !Object.hasOwn(PDFS, key.slice(0, key.indexOf("|")))));
for (const id of Object.keys(PDFS)) rmSync(join(PUBLIC, id), { recursive: true, force: true });

const rendered = new Set<string>();
let located = 0;
let missed = 0;
for (const citation of citedQuotes()) {
  const pdf = PDFS[citation.contextId];
  if (!pdf) continue;
  const directory = join(PUBLIC, citation.contextId);
  mkdirSync(directory, { recursive: true });
  const key = `${citation.contextId}/${citation.page}`;
  if (!rendered.has(key)) {
    rendered.add(key);
    renderPage(pdf, citation.page, join(directory, `p${citation.page}.webp`));
  }
  const { width, height, words } = wordsOn(pdf, citation.page);
  const found = locate(words, citation.quote);
  if (!found) {
    console.warn("No position for quote:", citation.contextId, citation.page, citation.quote);
    missed++;
    continue;
  }
  // One box per line of text.
  const lines = new Map<number, Word[]>();
  for (const w of found) {
    const line = Math.round(w.y0);
    lines.set(line, [...(lines.get(line) ?? []), w]);
  }
  const boxes = [...lines.values()].map((line): Box => {
    const x0 = Math.min(...line.map((w) => w.x0));
    const x1 = Math.max(...line.map((w) => w.x1));
    const y0 = Math.min(...line.map((w) => w.y0));
    const y1 = Math.max(...line.map((w) => w.y1));
    return [x0 / width, y0 / height, (x1 - x0) / width, (y1 - y0) / height];
  });
  const cell = citation.value === undefined ? undefined : figureWord(found, citation.value);
  highlights[`${citation.contextId}|${citation.page}|${citation.quote}`] = {
    page: citation.page,
    boxes,
    ...(cell ? { cell: [cell.x0 / width, cell.y0 / height, (cell.x1 - cell.x0) / width, (cell.y1 - cell.y0) / height] } : {}),
  };
  located++;
}
writeFileSync(highlightsFile, JSON.stringify(highlights));
console.log("pages rendered", rendered.size, "quotes located", located, "not located", missed);
if (missed) process.exitCode = 1;
